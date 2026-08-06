# Testing and Evaluation

## Gates

`check`, `test:integration`, `test:e2e`, `test:security`, and `test:release` are first-class gates. `verify` runs every gate in a fixed order and stops at the first failure.

Unit tests cover DAG validation, relation rollback, immutable records, FTS/settings, path policy, Job Spec restrictions, HMAC expiry/replay, and public contracts.

Integration tests cover API idempotency and conflicts, revision locks, execution scheduling/recovery, REST/MCP result equivalence and audit parity, Broker completion, ephemeral credential redaction, parsed SSE frames with `Last-Event-ID` replay, Context FTS, CAS hashes, Git Diff, the separate create/merge Review gates, and database restart.

Browser E2E builds the production bundle, drives the unique browser journey from Setup through project creation, Brief/DAG/Context Pack, Execution/SSE, Git Diff, Review, Draft PR, Assets, Audit, and Settings, then captures the final Execution state at six viewports: 360x800, 390x844, 768x1024, 1024x768, 1440x900, and 1920x1080. It fails on page errors, console errors, or sibling layout overlap. Screenshots are written to `.ai-workspace/e2e-v3`.

Security tests resolve Compose as structured JSON, build and probe a production App image to prove it has neither Docker socket nor Docker CLI, and exercise signed Broker HTTP requests. The Broker rejects command, host path, arbitrary volume, environment, privilege, capability, digest drift, body tampering, and signature replay inputs; credentials are redacted in returned Job Specs.

## AI evaluation

Formal model evaluation fixes Brief, repository SHA, model, prompt, and capability set. Each scenario runs three times. When Codex or GitHub is unavailable, the result remains a candidate and is not recorded as a formal pass.

## Performance thresholds

- App startup below 3 seconds on the reference machine
- Broker submission p95 below 500 ms
- event loop lag p95 no greater than 50 ms
- idle App RSS no greater than 512 MB with demonstration data

Acceptance receipts record observed startup and execution status. Codex and GitHub capability probes are mandatory for a formal promotion: when either is unavailable, rehearsal writes a `candidate` receipt and promotion exits before stopping the current service. Release promotion additionally records image digests, source commit/tree, lockfile hash, gate fingerprint, and SBOM path.

`release:rehearse` enforces the startup, Broker submission, event-loop lag, and RSS thresholds against digest-pinned production images. It freezes the temporary source volume, compares full file manifests after restore, runs SQLite integrity and foreign-key checks, starts the restored volume, and executes the generated rehearsal rollback.
