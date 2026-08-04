ARG VERIFY_BASE_IMAGE=aiws-verify:2.0.0
ARG AIWS_SOURCE_BASE_SHA
ARG AIWS_SOURCE_HEAD_SHA
ARG AIWS_SOURCE_TREE_SHA

FROM ${VERIFY_BASE_IMAGE}
ARG AIWS_SOURCE_BASE_SHA
ARG AIWS_SOURCE_HEAD_SHA
ARG AIWS_SOURCE_TREE_SHA

WORKDIR /app
RUN find /app -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +
COPY . .
COPY --from=aiws-impact-snapshot /impact-snapshot.json /opt/aiws/impact-snapshot.json
ENV AIWS_TEST_BASE_SHA=${AIWS_SOURCE_BASE_SHA} \
    AIWS_TEST_HEAD_SHA=${AIWS_SOURCE_HEAD_SHA} \
    AIWS_SOURCE_TREE_SHA=${AIWS_SOURCE_TREE_SHA} \
    AIWS_IMPACT_SNAPSHOT=/opt/aiws/impact-snapshot.json
RUN corepack pnpm install --offline --frozen-lockfile
RUN node scripts/v23-impact.mjs --audit >/dev/null \
    && node scripts/v22-impact.mjs --audit >/dev/null \
    && node scripts/v21-impact.mjs --audit >/dev/null \
    && node scripts/v20-impact.mjs --audit >/dev/null \
    && node scripts/v18-impact.mjs --audit >/dev/null
CMD ["corepack", "pnpm", "verify"]
