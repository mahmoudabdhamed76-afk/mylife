FROM node:22-alpine
WORKDIR /app

# ننسخ كل حاجة — كده أي ملف ناقص أو جديد مش هيكسر البناء
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node","server.js"]
