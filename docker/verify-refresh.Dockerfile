ARG VERIFY_BASE_IMAGE=aiws-verify:2.0.0
FROM ${VERIFY_BASE_IMAGE}

WORKDIR /app
RUN find /app -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +
COPY . .
RUN corepack pnpm install --offline --frozen-lockfile
CMD ["corepack", "pnpm", "verify"]
