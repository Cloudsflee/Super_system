FROM node:24.14.0-alpine3.22

ARG CODEX_VERSION=0.144.0
ARG PLAYWRIGHT_VERSION=1.54.2
ARG ALPINE_FALLBACK_MIRROR=https://mirrors.aliyun.com/alpine
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  AIWS_BROWSER_EXECUTABLE=/usr/bin/chromium-browser
RUN (apk add --no-cache bash build-base chromium curl font-noto-cjk git linux-headers openssh-client python3 ripgrep || (sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_FALLBACK_MIRROR}#g" /etc/apk/repositories && apk add --no-cache bash build-base chromium curl font-noto-cjk git linux-headers openssh-client python3 ripgrep)) \
  && npm install -g @openai/codex@${CODEX_VERSION} playwright@${PLAYWRIGHT_VERSION} \
  && npm cache clean --force

WORKDIR /workspace

ENTRYPOINT ["codex"]
