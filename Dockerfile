FROM node:24-alpine AS workspace-deps
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
COPY packages/git-tools/package.json packages/git-tools/package.json
COPY packages/mcp-bridge/package.json packages/mcp-bridge/package.json
COPY packages/memory-policy/package.json packages/memory-policy/package.json
COPY packages/runner-adapters/package.json packages/runner-adapters/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/system-context/package.json packages/system-context/package.json
RUN corepack pnpm install --frozen-lockfile

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
ARG CODEX_VERSION=0.144.0
ARG ALPINE_FALLBACK_MIRROR=https://mirrors.aliyun.com/alpine
RUN apk add --no-cache chromium freetype harfbuzz nss ttf-freefont || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_FALLBACK_MIRROR}#g" /etc/apk/repositories && apk add --no-cache chromium freetype harfbuzz nss ttf-freefont)
RUN npm install -g @openai/codex@${CODEX_VERSION} && npm cache clean --force
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY . .
CMD ["corepack", "pnpm", "verify"]

FROM node:24-alpine AS production-deps
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
COPY packages/git-tools/package.json packages/git-tools/package.json
COPY packages/mcp-bridge/package.json packages/mcp-bridge/package.json
COPY packages/memory-policy/package.json packages/memory-policy/package.json
COPY packages/runner-adapters/package.json packages/runner-adapters/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/system-context/package.json packages/system-context/package.json
RUN corepack pnpm install --prod --frozen-lockfile --filter ai-workspace-system

FROM node:24-alpine AS gateway-deps
RUN corepack enable
WORKDIR /gateway
COPY apps/mcp-gateway/package.json apps/mcp-gateway/pnpm-lock.yaml apps/mcp-gateway/pnpm-workspace.yaml ./
RUN corepack pnpm install --prod --frozen-lockfile

FROM node:24-alpine AS production
LABEL org.opencontainers.image.title="AI Workspace System" \
      org.opencontainers.image.version="2.0.0"
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
COPY config ./config
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY docker/backup_archive.py /opt/aiws/backup_archive.py
COPY docker/release_volume.mjs ./docker/release_volume.mjs
COPY docker/release-volume-validation.mjs ./docker/release-volume-validation.mjs
COPY docker/v20-upgrade.mjs ./docker/v20-upgrade.mjs
RUN mkdir -p /var/lib/aiws && chmod 0700 /var/lib/aiws
EXPOSE 4317
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/server.mjs"]

FROM node:24-alpine AS mcp-gateway
LABEL org.opencontainers.image.title="AI Workspace MCP Gateway" \
      org.opencontainers.image.version="2.0.0"
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
