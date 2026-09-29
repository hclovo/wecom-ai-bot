# Node 原生 TypeScript + PostgreSQL 驱动，不需要编译
FROM node:24-alpine
RUN apk add --no-cache fontconfig font-noto-cjk
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
USER node
COPY --chown=node:node server.ts ./
COPY --chown=node:node lib ./lib/
COPY --chown=node:node scripts ./scripts/
ENV NODE_ENV=production
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.ts"]
