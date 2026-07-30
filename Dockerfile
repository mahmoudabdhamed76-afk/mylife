FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js mylife.html manifest.webmanifest sw.js icon.svg icon-dark.svg icon-light.svg logo.svg ./
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node","server.js"]
