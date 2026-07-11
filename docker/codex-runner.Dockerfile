FROM node:24-alpine

ARG CODEX_VERSION=0.144.0
RUN npm install -g @openai/codex@${CODEX_VERSION}

WORKDIR /workspace

ENTRYPOINT ["codex"]
