# syntax=docker/dockerfile:1
# Debian/glibc is required by Cursor CLI. Also includes fonts for SVG rendering.
FROM node:24-bookworm-slim
ARG TARGETARCH
ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
# Cache apt indexes and packages outside the image; Debian's docker-clean
# hook must be disabled so it does not delete the downloaded package cache.
RUN --mount=type=cache,id=wecom-apt-cache-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=wecom-apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i \
        -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
        -e "s|http://deb.debian.org/debian$|${DEBIAN_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80network \
    && apt-get update -o APT::Update::Error-Mode=any \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl bash git fontconfig fonts-noto-cjk
WORKDIR /app
# Install Cursor before app dependencies so lockfile changes do not reinstall it.
USER node
RUN curl -fsS https://cursor.com/install -o /tmp/install-cursor.sh \
    && bash /tmp/install-cursor.sh && rm /tmp/install-cursor.sh \
    && mkdir -p /home/node/.cursor-agent-state && chmod 700 /home/node/.cursor-agent-state
ENV PATH="/home/node/.local/bin:${PATH}"
USER root
COPY package.json package-lock.json ./
# Keep downloaded packages in BuildKit's cache, outside the final image.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
USER node
COPY --chown=node:node server.ts ./
COPY --chown=node:node lib ./lib/
COPY --chown=node:node scripts ./scripts/
ENV NODE_ENV=production
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.ts"]
