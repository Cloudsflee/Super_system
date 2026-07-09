FROM node:24-alpine

RUN npm install -g @openai/codex@0.143.0

WORKDIR /workspace

ENTRYPOINT ["codex"]
