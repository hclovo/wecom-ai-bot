# 零运行时依赖：源码用 Node 原生 type stripping 直接跑，无需 install/编译
FROM node:24-alpine

WORKDIR /app

# 非 root 运行
USER node

COPY --chown=node:node server.ts ./
COPY --chown=node:node lib ./lib/

ENV NODE_ENV=production
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.ts"]
