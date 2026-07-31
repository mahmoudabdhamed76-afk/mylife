/* ==========================================================
   My Life — سيرفر التزامن
   Node.js 22+ • صفر مكتبات خارجية • node:sqlite + node:http
   ========================================================== */
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
/* مسار البيانات: Railway بيحدد RAILWAY_VOLUME_MOUNT_PATH تلقائياً لما تركّب Volume،
   فمش محتاج تظبط أي متغير بنفسك. DATA_DIR للتحكم اليدوي، و./data للتشغيل المحلي. */
const DATA_DIR = process.env.DATA_DIR
              || process.env.RAILWAY_VOLUME_MOUNT_PATH
              || join(ROOT, 'data');
const SESSION_DAYS = 90;
/* لو ظبطت REGISTER_CODE، مش هيقدر حد يعمل حساب جديد غير لما يكتب الكود.
   سيبه فاضي = التسجيل مفتوح لأي حد يعرف اللينك. */
const REGISTER_CODE = process.env.REGISTER_CODE || '';
const MAX_BODY = 4 * 1024 * 1024;

await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'mylife.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uname TEXT UNIQUE NOT NULL,
    hash TEXT NOT NULL, salt TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY, uid INTEGER NOT NULL, exp INTEGER NOT NULL,
    FOREIGN KEY(uid) REFERENCES users(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS recs(
    uid INTEGER NOT NULL, kind TEXT NOT NULL, rid TEXT NOT NULL,
    data TEXT NOT NULL, u INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(uid, kind, rid),
    FOREIGN KEY(uid) REFERENCES users(id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS recs_u ON recs(uid, u);
  CREATE TABLE IF NOT EXISTS prof(
    uid INTEGER PRIMARY KEY, data TEXT NOT NULL, u INTEGER NOT NULL,
    FOREIGN KEY(uid) REFERENCES users(id) ON DELETE CASCADE);
`);

const Q = {
  userByName: db.prepare('SELECT * FROM users WHERE uname = ?'),
  addUser:    db.prepare('INSERT INTO users(uname,hash,salt,created) VALUES(?,?,?,?)'),
  addSess:    db.prepare('INSERT INTO sessions(token,uid,exp) VALUES(?,?,?)'),
  getSess:    db.prepare('SELECT uid,exp FROM sessions WHERE token = ?'),
  delSess:    db.prepare('DELETE FROM sessions WHERE token = ?'),
  gcSess:     db.prepare('DELETE FROM sessions WHERE exp < ?'),
  getRec:     db.prepare('SELECT u FROM recs WHERE uid=? AND kind=? AND rid=?'),
  putRec:     db.prepare(`INSERT INTO recs(uid,kind,rid,data,u,del) VALUES(?,?,?,?,?,?)
                          ON CONFLICT(uid,kind,rid) DO UPDATE SET data=excluded.data, u=excluded.u, del=excluded.del`),
  recsSince:  db.prepare('SELECT kind,rid,data,u,del FROM recs WHERE uid=? AND u > ? ORDER BY u LIMIT 20000'),
  getProf:    db.prepare('SELECT data,u FROM prof WHERE uid=?'),
  putProf:    db.prepare(`INSERT INTO prof(uid,data,u) VALUES(?,?,?)
                          ON CONFLICT(uid) DO UPDATE SET data=excluded.data, u=excluded.u`),
  userById:   db.prepare('SELECT id,uname FROM users WHERE id=?')
};

/* ---------- كلمة السر ---------- */
const hashPass = (pass, salt) => scryptSync(pass, salt, 64).toString('hex');
function verifyPass(pass, salt, hash){
  const a = Buffer.from(hashPass(pass, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
const newToken = () => randomBytes(32).toString('hex');

/* ---------- حد المحاولات ---------- */
const hits = new Map();
function tooMany(ip){
  const now = Date.now(), w = 15 * 60 * 1000;
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > w) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  return rec.n > 30;
}

/* ---------- مساعدات ---------- */
const TYPES = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8'
};
const send = (res, code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', ...extra });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

function readBody(req){
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function auth(req){
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return null;
  const s = Q.getSess.get(t);
  if (!s || s.exp < Date.now()) return null;
  return { uid: s.uid, token: t };
}
const KINDS = new Set(['glucose','a1c','weight','bp','meals','water','activity','meds','medLog','shots','labs','fasts']);

/* ---------- المسارات ---------- */
async function api(req, res, path){
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (path === '/api/config') return json(res, 200, { needCode: !!REGISTER_CODE });

  if (path === '/api/register' || path === '/api/login') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    if (tooMany(ip)) return json(res, 429, { error: 'محاولات كتير — استنى شويه' });
    const b = await readBody(req).catch(() => null);
    if (!b) return json(res, 400, { error: 'طلب غير صالح' });
    const uname = String(b.uname || '').trim().toLowerCase();
    const pass = String(b.pass || '');
    if (!/^[a-z0-9._-]{3,32}$/.test(uname)) return json(res, 400, { error: 'اسم المستخدم: ٣–٣٢ حرف إنجليزي/رقم' });
    if (pass.length < 8) return json(res, 400, { error: 'كلمة السر ٨ حروف على الأقل' });

    if (path === '/api/register') {
      if (REGISTER_CODE && String(b.code || '') !== REGISTER_CODE)
        return json(res, 403, { error: 'كود التسجيل غلط' });
      if (Q.userByName.get(uname)) return json(res, 409, { error: 'الاسم مستخدم بالفعل' });
      const salt = randomBytes(16).toString('hex');
      Q.addUser.run(uname, hashPass(pass, salt), salt, Date.now());
    }
    const u = Q.userByName.get(uname);
    if (!u || !verifyPass(pass, u.salt, u.hash)) return json(res, 401, { error: 'اسم المستخدم أو كلمة السر غلط' });
    const token = newToken();
    Q.gcSess.run(Date.now());
    Q.addSess.run(token, u.id, Date.now() + SESSION_DAYS * 864e5);
    return json(res, 200, { token, uname: u.uname });
  }

  const s = auth(req);
  if (!s) return json(res, 401, { error: 'الجلسة انتهت — سجّل دخول تاني' });

  if (path === '/api/me')     return json(res, 200, { uname: Q.userById.get(s.uid).uname });
  if (path === '/api/logout') { Q.delSess.run(s.token); return json(res, 200, { ok: true }); }

  if (path === '/api/sync') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const b = await readBody(req).catch(() => null);
    if (!b) return json(res, 400, { error: 'طلب غير صالح' });
    const since = Number(b.since) || 0;
    const now = Date.now();

    /* استلام تغييرات العميل — الأحدث يفوز */
    const incoming = Array.isArray(b.recs) ? b.recs.slice(0, 20000) : [];
    db.exec('BEGIN');
    try {
      for (const r of incoming) {
        if (!KINDS.has(r.kind) || typeof r.rid !== 'string' || !r.rid || r.rid.length > 64) continue;
        const u = Math.min(Number(r.u) || now, now + 60000);
        const cur = Q.getRec.get(s.uid, r.kind, r.rid);
        if (cur && cur.u >= u) continue;
        Q.putRec.run(s.uid, r.kind, r.rid, JSON.stringify(r.data ?? null), u, r.del ? 1 : 0);
      }
      if (b.prof && typeof b.prof === 'object') {
        const pu = Math.min(Number(b.prof.u) || now, now + 60000);
        const cur = Q.getProf.get(s.uid);
        if (!cur || cur.u < pu) Q.putProf.run(s.uid, JSON.stringify(b.prof.data ?? {}), pu);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: 'فشل الحفظ' }); }

    /* إرجاع كل ما تغيّر على السيرفر بعد since */
    const out = Q.recsSince.all(s.uid, since).map(r => ({
      kind: r.kind, rid: r.rid, u: r.u, del: !!r.del, data: JSON.parse(r.data)
    }));
    const p = Q.getProf.get(s.uid);
    return json(res, 200, {
      now,
      recs: out,
      prof: p && p.u > since ? { data: JSON.parse(p.data), u: p.u } : null
    });
  }
  return json(res, 404, { error: 'not found' });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    if (path === '/healthz') return send(res, 200, 'ok');
    if (path.startsWith('/api/')) return await api(req, res, path);

    let p = decodeURIComponent(path);
    if (p === '/') p = '/mylife.html';
    const safe = normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, safe);
    if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) return send(res, 404, 'not found');
    const ext = extname(file).toLowerCase();
    const etag = `W/"${info.size}-${info.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) return send(res, 304, '');
    send(res, 200, await readFile(file), TYPES[ext] || 'application/octet-stream',
         { etag, 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
  } catch (e) {
    send(res, 500, 'server error');
  }
}).listen(PORT, HOST, () => console.log(`My Life → http://${HOST}:${PORT}  (data: ${DATA_DIR})`));
