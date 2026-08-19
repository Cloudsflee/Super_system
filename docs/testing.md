# Testing and Evaluation

Status: supporting test policy for V3-Clean implementation phases. The detailed
phase-to-gate mapping is in [`architecture/v3-clean-development-plan.md`](architecture/v3-clean-development-plan.md);
this document does not promote a Catalog item by itself.

## Gates

`check`, `test`, `test:integration`, `test:e2e`, `test:security`, and `test:release`
are first-class gates. `verify` runs every gate in a fixed order and stops at the
first failure. Clean-baseline and importer phases add dedicated schema, mapping,
checkpoint, CAS and rollback suites before their Catalog rows can move beyond
`scaffolded`.

Unit tests cover DAG validation, relation rollback, immutable records, FTS/settings, path policy, Job Spec restrictions, HMAC expiry/replay, and public contracts.

Integration tests cover API v2 idempotency and conflicts, revision locks,
operation scheduling/recovery, REST/MCP/Gateway result equivalence and audit
parity, Broker/Host/Bridge completion, ephemeral credential redaction, parsed SSE
frames with `Last-Event-ID` replay and JSON replay equivalence, Context FTS, CAS
hashes, Git Diff, Review gates, ACL/Exchange isolation, importer checkpoint/resume,
and database restart.

Browser E2E builds the production bundle, drives the unique browser journey from Setup through project creation, Brief/DAG/Context Pack, Execution/SSE, Git Diff, Review, Draft PR, Assets, Audit, and Settings, then captures the final Execution state at six viewports: 360x800, 390x844, 768x1024, 1024x768, 1440x900, and 1920x1080. It fails on page errors, console errors, or sibling layout overlap. Screenshots are written to `.ai-workspace/e2e-v3`.

Security tests resolve Compose as structured JSON, build and probe a production App
image to prove it has neither Docker socket nor Docker CLI, and exercise signed
Broker/Gateway HTTP requests. The boundaries reject command, host path, arbitrary
volume, environment, privilege, capability, digest drift, body tampering, scope
escape and signature replay inputs; credentials are redacted in Job Specs,
operations, events, audit, CAS and Evidence.

## AI evaluation

Formal model evaluation fixes Brief, repository SHA, model, prompt, capability set
and policy revision. Each scenario runs three times. When Codex, GitHub, Gateway,
Runner or parser dependencies are unavailable, the result remains a candidate and
is not recorded as a formal pass.

## Performance thresholds

- App startup below 3 seconds on the reference machine
- Broker submission p95 below 500 ms
- event loop lag p95 no greater than 50 ms
- idle App RSS no greater than 512 MB with demonstration data

Acceptance receipts record observed startup and execution status. Codex and GitHub capability probes are mandatory for a formal promotion: when either is unavailable, rehearsal writes a `candidate` receipt and promotion exits before stopping the current service. Release promotion additionally records image digests, source commit/tree, lockfile hash, gate fingerprint, and SBOM path.

`release:rehearse` enforces the startup, Broker submission, event-loop lag, RSS,
temporary-volume import, CAS manifest, event replay and rollback thresholds against
digest-pinned production images. It freezes source volumes, compares full manifests
after restore, runs SQLite integrity/foreign-key/ACL checks, starts the restored
clean volume, and executes the generated rehearsal rollback. A green test run is
not a cutover receipt until an actual deployment rollback has also passed.

## Phase gate rule

Every phase records baseline and modified commands, literal outputs, exit statuses,
input hashes and a rollback receipt. A failure keeps the affected capability at
its current status and blocks dependent phases. A schema or interface stub alone is
never sufficient for `implemented`.
