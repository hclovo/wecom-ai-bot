# Debian/glibc is required by Cursor CLI. Also includes fonts for SVG rendering.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bash git fontconfig fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
USER node
RUN curl -fsS https://cursor.com/install -o /tmp/install-cursor.sh \
    && bash /tmp/install-cursor.sh && rm /tmp/install-cursor.sh \
    && mkdir -p /home/node/.cursor-agent-state && chmod 700 /home/node/.cursor-agent-state
ENV PATH="/home/node/.local/bin:${PATH}"
COPY --chown=node:node server.ts ./
COPY --chown=node:node lib ./lib/
COPY --chown=node:node scripts ./scripts/
ENV NODE_ENV=production
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.ts"]
