# Testing and Evaluation

## Gates

`check`, `test:integration`, `test:e2e`, `test:security`, and `test:release` are first-class gates. `verify` runs every gate in a fixed order and stops at the first failure.

Unit tests cover DAG validation, relation rollback, immutable records, FTS/settings, path policy, Job Spec restrictions, HMAC expiry/replay, and public contracts.

Integration tests cover API idempotency, revision conflicts, execution scheduling, REST/MCP command equivalence, Broker completion, ephemeral credential redaction, SSE connection, review/delivery gates, and database restart.

Browser E2E builds the production bundle and captures six viewports: 360x800, 390x844, 768x1024, 1024x768, 1440x900, and 1920x1080. Screenshots are written to `.ai-workspace/e2e-v3`.

Security tests prove that the App service has neither Docker socket nor Docker CLI. The Broker rejects command, host path, arbitrary volume, environment, privilege, capability, digest drift, and signature replay inputs.

## AI evaluation

Formal model evaluation fixes Brief, repository SHA, model, prompt, and capability set. Each scenario runs three times. When Codex or GitHub is unavailable, the result remains a candidate and is not recorded as a formal pass.

## Performance thresholds

- App startup below 3 seconds on the reference machine
- Broker submission p95 below 500 ms
- event loop lag p95 no greater than 50 ms
- idle App RSS no greater than 512 MB with demonstration data

Acceptance receipts record observed startup and execution status. Release promotion additionally records image digests, source commit/tree, lockfile hash, gate fingerprint, and SBOM path.

`release:rehearse` enforces the startup, Broker submission, event-loop lag, and RSS thresholds against digest-pinned production images. It freezes the temporary source volume, compares full file manifests after restore, runs SQLite integrity and foreign-key checks, starts the restored volume, and executes the generated rehearsal rollback.
