# syntax=docker/dockerfile:1

FROM node:24.19.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:24.19.0-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Pi Daemon" \
  org.opencontainers.image.description="Persistent Pi coding-agent sessions with a mobile web UI" \
  org.opencontainers.image.source="https://github.com/SASUKE40/pi-daemon" \
  org.opencontainers.image.licenses="MIT"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client ripgrep \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
  HOME=/home/node \
  PI_DAEMON_BIND_HOST=0.0.0.0 \
  PI_DAEMON_CONFIG_DIR=/home/node/.config/pi-daemon \
  PI_DAEMON_DATA_DIR=/home/node/.local/share/pi-daemon \
  PI_CODING_AGENT_DIR=/home/node/.pi/agent

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public

RUN mkdir -p \
    /home/node/.config/pi-daemon \
    /home/node/.local/share/pi-daemon \
    /home/node/.pi/agent \
    /workspace \
  && chown -R node:node /home/node /workspace

USER node
WORKDIR /workspace

EXPOSE 8504
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8504/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "/app/dist/docker.js"]
