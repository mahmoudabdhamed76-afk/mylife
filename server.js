/* My Life — سيرفر ثابت بدون أي مكتبات خارجية (Node.js 22+) */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',   '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon',
  '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8'
};

const send = (res, code, body, type='text/plain; charset=utf-8', extra={}) => {
  res.writeHead(code, { 'content-type': type, 'x-content-type-options':'nosniff', ...extra });
  res.end(body);
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/healthz') return send(res, 200, 'ok');

    let p = decodeURIComponent(url.pathname);
    if (p === '/' ) p = '/mylife.html';
    // منع الخروج من مجلد المشروع
    const safe = normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, safe);
    if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');

    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) return send(res, 404, 'not found');

    const ext = extname(file).toLowerCase();
    const etag = `W/"${info.size}-${info.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) return send(res, 304, '');

    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=86400';
    send(res, 200, await readFile(file), TYPES[ext] || 'application/octet-stream',
         { etag, 'cache-control': cache });
  } catch (e) {
    send(res, 500, 'server error');
  }
}).listen(PORT, HOST, () => console.log(`My Life → http://${HOST}:${PORT}`));
