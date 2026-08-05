ARG AIWS_SOURCE_BASE_SHA
ARG AIWS_SOURCE_HEAD_SHA
ARG AIWS_SOURCE_TREE_SHA

FROM node:24.14.0-alpine3.22 AS workspace-deps
ARG ALPINE_FALLBACK_MIRROR=https://mirrors.aliyun.com/alpine
RUN apk add --no-cache git python3 make g++ || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_FALLBACK_MIRROR}#g" /etc/apk/repositories && apk add --no-cache git python3 make g++)
RUN corepack enable
ENV npm_config_nodedir=/usr/local
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/mcp-gateway/package.json apps/mcp-gateway/package.json
COPY packages/context-pack/package.json packages/context-pack/package.json
COPY packages/execution-protocol/package.json packages/execution-protocol/package.json
COPY packages/git-tools/package.json packages/git-tools/package.json
COPY packages/mcp-bridge/package.json packages/mcp-bridge/package.json
COPY packages/memory-policy/package.json packages/memory-policy/package.json
COPY packages/runner-adapters/package.json packages/runner-adapters/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/system-context/package.json packages/system-context/package.json
RUN --mount=type=cache,id=aiws-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=aiws-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    npm_config_network_concurrency=8 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=10000 \
    npm_config_fetch_retry_maxtimeout=60000 \
    npm_config_fetch_timeout=30000 \
    corepack pnpm fetch --frozen-lockfile
RUN --mount=type=cache,id=aiws-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=aiws-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack pnpm install --frozen-lockfile --offline

FROM golang:1.24-alpine AS windows-bridge-build
WORKDIR /src
COPY bridge/go.mod bridge/go.sum* ./
RUN go mod download
COPY bridge/ ./
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/aiws-bridge.exe .

FROM scratch AS windows-bridge-export
COPY --from=windows-bridge-build /out/aiws-bridge.exe /aiws-bridge.exe

FROM workspace-deps AS build
COPY . .
RUN corepack pnpm build

FROM workspace-deps AS verify
COPY --from=windows-bridge-build /usr/local/go/bin/gofmt /usr/local/bin/gofmt
ARG CODEX_VERSION=0.144.0
ARG ALPINE_FALLBACK_MIRROR=https://mirrors.aliyun.com/alpine
RUN apk add --no-cache chromium freetype harfbuzz nss ttf-freefont || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_FALLBACK_MIRROR}#g" /etc/apk/repositories && apk add --no-cache chromium freetype harfbuzz nss ttf-freefont)
RUN npm install -g @openai/codex@${CODEX_VERSION} && npm cache clean --force
ARG AIWS_SOURCE_BASE_SHA
ARG AIWS_SOURCE_HEAD_SHA
ARG AIWS_SOURCE_TREE_SHA
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    AIWS_TEST_BASE_SHA=${AIWS_SOURCE_BASE_SHA} \
    AIWS_TEST_HEAD_SHA=${AIWS_SOURCE_HEAD_SHA} \
    AIWS_SOURCE_TREE_SHA=${AIWS_SOURCE_TREE_SHA} \
    AIWS_IMPACT_SNAPSHOT=/opt/aiws/impact-snapshot.json
COPY . .
COPY --from=aiws-impact-snapshot /impact-snapshot.json /opt/aiws/impact-snapshot.json
RUN node scripts/v23-impact.mjs --audit >/dev/null \
    && node scripts/v22-impact.mjs --audit >/dev/null \
    && node scripts/v21-impact.mjs --audit >/dev/null \
    && node scripts/v20-impact.mjs --audit >/dev/null \
    && node scripts/v18-impact.mjs --audit >/dev/null
CMD ["corepack", "pnpm", "verify"]

FROM node:24.14.0-alpine3.22 AS production-deps
ARG ALPINE_FALLBACK_MIRROR=https://mirrors.aliyun.com/alpine
RUN apk add --no-cache python3 make g++ || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_FALLBACK_MIRROR}#g" /etc/apk/repositories && apk add --no-cache python3 make g++)
RUN corepack enable
ENV npm_config_nodedir=/usr/local
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/mcp-gateway/package.json apps/mcp-gateway/package.json
COPY packages/context-pack/package.json packages/context-pack/package.json
COPY packages/execution-protocol/package.json packages/execution-protocol/package.json
COPY packages/git-tools/package.json packages/git-tools/package.json
COPY packages/mcp-bridge/package.json packages/mcp-bridge/package.json
COPY packages/memory-policy/package.json packages/memory-policy/package.json
COPY packages/runner-adapters/package.json packages/runner-adapters/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/system-context/package.json packages/system-context/package.json
RUN --mount=type=cache,id=aiws-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=aiws-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    npm_config_network_concurrency=8 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=10000 \
    npm_config_fetch_retry_maxtimeout=60000 \
    npm_config_fetch_timeout=30000 \
    corepack pnpm fetch --prod --frozen-lockfile
RUN --mount=type=cache,id=aiws-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=aiws-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack pnpm install --prod --frozen-lockfile --offline --filter ai-workspace-system
RUN --mount=type=cache,id=aiws-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=aiws-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack pnpm install --prod --frozen-lockfile --offline --filter @aiws/system-context

FROM node:24.14.0-alpine3.22 AS gateway-deps
RUN corepack enable
WORKDIR /gateway
COPY apps/mcp-gateway/package.json apps/mcp-gateway/pnpm-lock.yaml apps/mcp-gateway/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=aiws-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=aiws-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    npm_config_network_concurrency=8 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=10000 \
    npm_config_fetch_retry_maxtimeout=60000 \
    npm_config_fetch_timeout=30000 \
    corepack pnpm fetch --prod --frozen-lockfile
RUN --mount=type=cache,id=aiws-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=aiws-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack pnpm install --prod --frozen-lockfile --offline

FROM node:24.14.0-alpine3.22 AS production
LABEL org.opencontainers.image.title="AI Workspace System" \
      org.opencontainers.image.version="2.3.0"
ARG ALPINE_FALLBACK_MIRROR=https://mirrors.aliyun.com/alpine
RUN apk add --no-cache bash ca-certificates docker-cli docker-cli-compose git openssh-client python3 tar || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_FALLBACK_MIRROR}#g" /etc/apk/repositories && apk add --no-cache bash ca-certificates docker-cli docker-cli-compose git openssh-client python3 tar)
WORKDIR /app
ENV NODE_ENV=production \
    AIWS_HOME=/var/lib/aiws \
    AIWS_CONTAINERIZED=1 \
    AIWS_BIND_HOST=0.0.0.0 \
    PORT=4317
COPY --from=production-deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY apps/api ./apps/api
COPY packages ./packages
COPY --from=production-deps /app/packages/system-context/node_modules ./packages/system-context/node_modules
COPY config ./config
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY docker/backup_archive.py /opt/aiws/backup_archive.py
COPY docker/release_volume.mjs ./docker/release_volume.mjs
COPY docker/release-volume-v20.mjs ./docker/release-volume-v20.mjs
COPY docker/release-volume-v21.mjs ./docker/release-volume-v21.mjs
COPY docker/release-volume-v21-cli.mjs ./docker/release-volume-v21-cli.mjs
COPY docker/release-volume-v22.mjs ./docker/release-volume-v22.mjs
COPY docker/release-volume-v22-cli.mjs ./docker/release-volume-v22-cli.mjs
COPY docker/release-volume-v23.mjs ./docker/release-volume-v23.mjs
COPY docker/release-volume-v23-cli.mjs ./docker/release-volume-v23-cli.mjs
COPY docker/v23-readiness.mjs ./docker/v23-readiness.mjs
COPY docker/release-volume-validation.mjs ./docker/release-volume-validation.mjs
COPY docker/v20-upgrade.mjs ./docker/v20-upgrade.mjs
COPY docker/v21-upgrade.mjs ./docker/v21-upgrade.mjs
COPY docker/v22-upgrade.mjs ./docker/v22-upgrade.mjs
COPY docker/v23-upgrade.mjs ./docker/v23-upgrade.mjs
RUN node -e "import('./docker/v23-readiness.mjs').then(m=>{if(typeof m.waitForV23Readiness!=='function')process.exit(1)})"
RUN mkdir -p /var/lib/aiws && chmod 0700 /var/lib/aiws
EXPOSE 4317
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/server.mjs"]

FROM node:24.14.0-alpine3.22 AS mcp-gateway
LABEL org.opencontainers.image.title="AI Workspace MCP Gateway" \
      org.opencontainers.image.version="2.3.0"
WORKDIR /app
ENV NODE_ENV=production \
    AIWS_MCP_GATEWAY_HOST=0.0.0.0 \
    AIWS_MCP_GATEWAY_PORT=4319
COPY --from=gateway-deps /gateway/node_modules ./node_modules
COPY package.json ./package.json
COPY apps/mcp-gateway ./apps/mcp-gateway
COPY packages/mcp-bridge ./packages/mcp-bridge
COPY packages/shared ./packages/shared
EXPOSE 4319
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:4319/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/mcp-gateway/server.mjs"]
