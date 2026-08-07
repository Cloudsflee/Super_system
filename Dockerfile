ARG NODE_IMAGE=docker.m.daocloud.io/library/node:24.14.0-alpine3.22
ARG AIWS_VERSION=3.0.0
ARG AIWS_COMMIT=unknown
ARG AIWS_TREE=unknown
ARG AIWS_LOCKFILE_SHA256=unknown
ARG AIWS_GATE_FINGERPRINT=unknown
ARG AIWS_SBOM_SHA256=unknown

FROM ${NODE_IMAGE} AS dependencies
ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
RUN apk add --no-cache python3 make g++ git ca-certificates || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g" /etc/apk/repositories && apk add --no-cache python3 make g++ git ca-certificates)
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/runner-broker/package.json apps/runner-broker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN corepack pnpm install --frozen-lockfile \
      --registry=https://registry.npmmirror.com \
      --fetch-timeout=300000 --fetch-retries=1

FROM dependencies AS build
COPY . .
RUN corepack pnpm --filter @aiws/web build

FROM ${NODE_IMAGE} AS production
ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
ARG AIWS_VERSION
ARG AIWS_COMMIT
ARG AIWS_TREE
ARG AIWS_LOCKFILE_SHA256
ARG AIWS_GATE_FINGERPRINT
ARG AIWS_SBOM_SHA256
LABEL org.opencontainers.image.title="AIWS app" \
      org.opencontainers.image.version="${AIWS_VERSION}" \
      org.opencontainers.image.revision="${AIWS_COMMIT}" \
      aiws.source.tree="${AIWS_TREE}" \
      aiws.source.lockfile-sha256="${AIWS_LOCKFILE_SHA256}" \
      aiws.gate.fingerprint="${AIWS_GATE_FINGERPRINT}" \
      aiws.sbom.sha256="${AIWS_SBOM_SHA256}" \
      aiws.component="app"
RUN apk add --no-cache ca-certificates git || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g" /etc/apk/repositories && apk add --no-cache ca-certificates git)
WORKDIR /app
ENV NODE_ENV=production AIWS_BIND_HOST=0.0.0.0 PORT=4317 AIWS_HOME=/var/lib/aiws AIWS_BROKER_HMAC_SECRET_FILE=/run/secrets/broker_hmac
COPY package.json ./package.json
COPY --from=dependencies /app/node_modules ./node_modules
COPY apps/api ./apps/api
COPY packages/contracts ./packages/contracts
COPY sbom.spdx.json ./sbom.spdx.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /var/lib/aiws && chmod 700 /var/lib/aiws
EXPOSE 4317
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD node -e "fetch('http://127.0.0.1:4317/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/server.mjs"]

FROM ${NODE_IMAGE} AS broker
ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
ARG AIWS_VERSION
ARG AIWS_COMMIT
ARG AIWS_TREE
ARG AIWS_LOCKFILE_SHA256
ARG AIWS_GATE_FINGERPRINT
ARG AIWS_SBOM_SHA256
LABEL org.opencontainers.image.title="AIWS runner broker" \
      org.opencontainers.image.version="${AIWS_VERSION}" \
      org.opencontainers.image.revision="${AIWS_COMMIT}" \
      aiws.source.tree="${AIWS_TREE}" \
      aiws.source.lockfile-sha256="${AIWS_LOCKFILE_SHA256}" \
      aiws.gate.fingerprint="${AIWS_GATE_FINGERPRINT}" \
      aiws.sbom.sha256="${AIWS_SBOM_SHA256}" \
      aiws.component="runner-broker"
RUN apk add --no-cache ca-certificates docker-cli || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g" /etc/apk/repositories && apk add --no-cache ca-certificates docker-cli)
WORKDIR /app
ENV NODE_ENV=production AIWS_BROKER_HOST=0.0.0.0 AIWS_BROKER_PORT=4321 AIWS_BROKER_DATA_ROOT=/var/lib/aiws AIWS_BROKER_HMAC_SECRET_FILE=/run/secrets/broker_hmac
COPY package.json ./package.json
COPY apps/api/src/crypto.mjs apps/api/src/crypto.mjs
COPY apps/api/src/errors.mjs apps/api/src/errors.mjs
COPY apps/api/src/path-policy.mjs apps/api/src/path-policy.mjs
COPY apps/runner-broker/package.json apps/runner-broker/package.json
COPY apps/runner-broker/src apps/runner-broker/src
COPY apps/runner-broker/server.mjs apps/runner-broker/server.mjs
COPY packages/contracts packages/contracts
COPY sbom.spdx.json ./sbom.spdx.json
RUN mkdir -p /var/lib/aiws && chmod 700 /var/lib/aiws
EXPOSE 4321
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 CMD node -e "fetch('http://127.0.0.1:4321/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/runner-broker/server.mjs"]

FROM ${NODE_IMAGE} AS codex-runner
ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
ARG CODEX_CLI_VERSION=0.146.1
ARG CODEX_LINUX_X64_VERSION=0.146.1-linux-x64
ARG TARGETARCH
ARG AIWS_VERSION
ARG AIWS_COMMIT
ARG AIWS_TREE
ARG AIWS_LOCKFILE_SHA256
ARG AIWS_GATE_FINGERPRINT
ARG AIWS_SBOM_SHA256
LABEL org.opencontainers.image.title="AIWS codex runner" \
      org.opencontainers.image.version="${AIWS_VERSION}" \
      org.opencontainers.image.revision="${AIWS_COMMIT}" \
      aiws.source.tree="${AIWS_TREE}" \
      aiws.source.lockfile-sha256="${AIWS_LOCKFILE_SHA256}" \
      aiws.gate.fingerprint="${AIWS_GATE_FINGERPRINT}" \
      aiws.sbom.sha256="${AIWS_SBOM_SHA256}" \
      aiws.component="codex-runner" \
      aiws.codex-cli.version="${CODEX_CLI_VERSION}" \
      aiws.codex-cli.platform-version="${CODEX_LINUX_X64_VERSION}" \
      aiws.codex-cli.platform="x86_64-unknown-linux-musl"
RUN test "${TARGETARCH}" = "amd64" \
    && (apk add --no-cache git ca-certificates gcompat || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g" /etc/apk/repositories && apk add --no-cache git ca-certificates gcompat)) \
    && npm install --global "@openai/codex@${CODEX_CLI_VERSION}" \
      --omit=optional --registry=https://registry.npmmirror.com \
      --fetch-timeout=300000 --fetch-retries=1 \
    && mkdir -p /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64 \
    && wget -q -O /tmp/codex-linux-x64.tgz \
      "https://cdn.npmmirror.com/packages/%40openai/codex/${CODEX_LINUX_X64_VERSION}/codex-${CODEX_LINUX_X64_VERSION}.tgz" \
    && echo "5cf5a95b326018ad7282c50131782c90492bfae4d58ff5ce9e708fd9413db505174d6611604973ed05b5612ddbc6437a29ebf808940a6dd268a55c21fb413f4d  /tmp/codex-linux-x64.tgz" | sha512sum -c - \
    && tar -xzf /tmp/codex-linux-x64.tgz --strip-components=1 \
      -C /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64 \
    && rm /tmp/codex-linux-x64.tgz \
    && test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}"
WORKDIR /runner
COPY apps/runner-broker/codex-runner.mjs ./codex-runner.mjs
COPY apps/runner-broker/src/runner-result.mjs ./src/runner-result.mjs
COPY apps/runner-broker/src/codex-config.mjs ./src/codex-config.mjs
COPY sbom.spdx.json ./sbom.spdx.json
USER 10001:10001
ENTRYPOINT ["node", "/runner/codex-runner.mjs"]
