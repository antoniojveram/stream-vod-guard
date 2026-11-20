FROM node:24-bookworm-slim

ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="Stream VOD Guard" \
      org.opencontainers.image.description="Self-hosted live stream archiver for Twitch and YouTube" \
      org.opencontainers.image.source="https://github.com/antoniojveram/stream-vod-guard" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Europe/Madrid \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      mesa-va-drivers \
      python3 \
      python3-venv \
      ca-certificates \
      curl \
      tini \
    && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
         apt-get install -y --no-install-recommends intel-media-va-driver; \
       fi \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir \
         yt-dlp==2026.10.26 \
         streamlink==8.6.3

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY test ./test

RUN mkdir -p /data /videos \
    && chown -R node:node /app /data /videos

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
