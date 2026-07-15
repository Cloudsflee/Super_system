FROM node:24-alpine

ARG CODEX_VERSION=0.144.0
ARG ALPINE_FALLBACK_MIRROR=https://mirrors.aliyun.com/alpine
RUN (apk add --no-cache bash build-base git linux-headers openssh-client python3 ripgrep || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_FALLBACK_MIRROR}#g" /etc/apk/repositories && apk add --no-cache bash build-base git linux-headers openssh-client python3 ripgrep)) \
  && npm install -g @openai/codex@${CODEX_VERSION} \
  && npm cache clean --force

WORKDIR /workspace

ENTRYPOINT ["codex"]
