# Testing and Evaluation

Status: supporting test policy for V3-Clean implementation phases. The detailed
phase-to-gate mapping is in [`architecture/v3-clean-development-plan.md`](architecture/v3-clean-development-plan.md);
this document does not promote a Catalog item by itself.

## Gates

`check`, `audit:p1`, `scan:clean`, `test:p1`, `test:p2`, `test:p3`, `test:p31`,
`test`, `test:integration`, `test:e2e`, `test:security`, and `test:release` are
first-class gates. `verify` runs the repository-wide sequence in
that order (with the Web build before E2E) and stops at the first failure.
During P1, only the clean baseline, platform ledger, API v2 operation routes,
replay, CAS, redaction, and startup gates are implementation claims. The older
V1/V6 journey suites below execute against explicit historical fixtures and do
not promote a clean Catalog row.

`audit:p1` classifies every Git-visible, non-build path as active P1,
governance, Evidence, historical fixture, later-phase fixture, supporting
document, or non-product material. It also checks all package-script roles, the
PR template, default process entrypoints, legacy-server import allowlist,
active Markdown links, Catalog/matrix/plan receipt references, and the final
Evidence manifest, governed hash inventory, all-path classification inventory,
and actual rollback record. `scan:clean` includes the same result beside the
runtime dependency scan.

Unit tests cover DAG validation, relation rollback, immutable records, FTS/settings, path policy, Job Spec restrictions, HMAC expiry/replay, and public contracts.

P1 integration tests cover API v2 idempotency and conflicts, revision locks,
operation/event/head atomicity, startup recovery, parsed SSE frames with
`Last-Event-ID`, JSON replay equivalence, CAS hashes, cursor scope, and database
restart. The historical integration coverage gate excludes `apps/api/src/clean/**`
because those files have a dedicated P1 test suite; the gate thresholds remain
85% lines, 70% branches, and 75% functions for the remaining integration graph.
REST/MCP/Gateway equivalence, Context FTS, Git Diff, Review, ACL/
Exchange, importer checkpoint/resume, and external runner behavior remain
planned P2-P9 acceptance suites or historical fixture characterization.

The browser E2E and release suites still characterize the pre-clean V1/V6
journey through an explicit fixture server. They are retained as regression
inputs; P1 does not claim the full Setup-to-Delivery Web workflow is clean.

P1 security tests cover clean route retirement, scope/revision/idempotency
validation, secret/path/token/prompt redaction, CAS tamper, and startup
readiness. Compose, Docker socket, Gateway, parser sandbox, and external
credential probes remain later-phase gates or historical fixture tests.

P2 uses `tests/p2/*.test.mjs` for ordered `001 -> 002` migration, fault
rollback, Actor/Session/Team state machines, role ceilings, explicit-deny
precedence, Exchange narrowing, ProjectScopeResolver isolation, cookie proof
hash/expiry/revoke, concurrent idempotency, Vault atomic writes, fake provider
rebind/probe recovery, and SSE/JSON reauthorization after membership changes.
The delegation security case covers missing and invalid Vault proof,
cross-Team service, user target, valid service/agent delegation, and
`X-Scopes` spoofing. Web component tests cover loading, empty, denied,
revision-conflict, rebind-required, and project ACL allow/deny lifecycle.

P2 does not promote real provider, independent Gateway, complete multi-viewport
Web, offline, or cross-origin behavior. Those remain later-phase claims even
when their historical fixture suites pass.

## P3 Project/Workflow

`test:p3` is the clean P3 gate. It covers forward-only `003-project-workflow`
application from empty, P1, and P2 volumes; checksum/snapshot drift; DDL,
ledger, receipt, commit and restart faults; Project/Intake/Brief lifecycle
CAS; repository source drift, line recovery, workspace single-writer fencing;
Workflow proposal stale protection; generator/critic failure, retry lineage,
cancellation, and second-runtime recovery. Every lifecycle mutation asserts an
expected revision and idempotency key and checks the generic operation/event/
aggregate-head links.

`tests/p3/active-entrypoint.test.mjs` proves that the process entrypoint pins
the active schema and default runtime build to P3, and that `/readyz` reports
`user_version=3`. `tests/p3/http-contract.test.mjs` covers the session-bound
API v2 path, closed contracts, retired API response, operation replay, and ACL
resolver boundary.

The P3 Web slice is `apps/web/src/features/project/ProjectWorkflowPage.tsx`.
Its component tests cover loading, empty/create, denied, revision conflict,
source drift/retry, repository and workflow controls, and assert that every
request uses `/api/v2` rather than `/api/v1`. It is intentionally a component
slice; complete multi-viewport, offline, cross-origin, and release E2E remain
P9 gates.

P3 uses deterministic repository, generator, and critic fixture adapters. Their
receipts prove invocation, hash/revision capture, retry/recovery, and redacted
terminal state only; they do not promote real GitHub/Codex/Gateway capability.
Outcome routes create and list requirement scaffolding only, with no score,
waiver, or human evaluation claim.

The additive P3 command inventory is:

```text
pnpm check
pnpm scan:clean
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm evidence:p3
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration
pnpm test:security
pnpm verify
git diff --check
```

P3 Evidence is immutable at
`docs/evidence/v3-clean-p3-project-workflow-20260819/`; only its final
non-provisional verification receipt may promote the four P3 implementation
rows. That receipt is now `verified` with `provisional=false`; P1/P2 receipts
are parent inputs and are never regenerated.

## P3.1 Clean debt burn-down

P3.1 keeps the P3 wire contracts while making the domain boundaries and shared
transaction ledger explicit. `ProjectWorkflowService` and `IdentityService`
are facades over owner modules; all operation inserts, idempotency records,
operation links, aggregate revisions, event heads, and audit rows use the
single Clean `OperationService`/`EventService` instances. `tests/p31/` covers
ledger parity, owner-to-command mapping, Catalog split validation, immutable
receipt resume, Clean Web entrypoints, and layered gate policy.

The active Web navigation and `scripts/e2e.mjs` use only `/api/v2`; the legacy
journey is retained as `scripts/e2e-legacy.mjs` and runs only through
`fixture:legacy:e2e`. `test:integration` and `test:security` are layered
wrappers: Clean failures are blocking, while historical failures produce an
advisory redacted receipt and do not change Clean Catalog status.

The P3.1 command inventory is:

```text
pnpm check
pnpm scan:clean
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p31
pnpm evidence:p31
pnpm test:integration:clean
pnpm test:security:clean
pnpm fixture:legacy:integration
pnpm fixture:legacy:security
pnpm fixture:legacy:e2e
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
pnpm verify
git diff --check
```

P3.1 receipts are written under
`docs/evidence/v3-clean-p3-1-debt-burn-down-20260820/`; each run has an
append-only `attempts/<run-id>/` directory. A final verified receipt is created
exclusively, and rollback verification records both a dry-run and an isolated
actual apply with `byte_exact_mismatches=[]`. P1/P2/P3 Evidence remains
read-only, and the four existing P3 rows retain their prior status.

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

P8-P9 acceptance receipts will record observed startup and execution status.
Those phases require fresh Codex/GitHub capability probes, image and source
identity, SBOM, temporary-volume import, CAS/event/ACL verification, health
probes, and an actual deployment rollback. The current release scripts and
receipts characterize the pre-clean runtime and cannot promote a clean Catalog
row.

## Phase gate rule

Every phase records baseline and modified commands, literal outputs, exit statuses,
input hashes and a rollback receipt. A failure keeps the affected capability at
its current status and blocks dependent phases. A schema or interface stub alone is
never sufficient for `implemented`.

## Gate synchronization contract

The test plan is not independent from its gates. The following stable rules are
the cross-phase contract shared with `AGENTS.md` and the development plan.

| ID | Requirement |
| --- | --- |
| GS-001 | A change to tests, gate commands, routes, schemas, ownership, phase scope, status rules, or receipt shapes MUST trigger gate-sync review. |
| GS-002 | The phase plan, testing policy, package/CI commands, gate implementation, tests, Catalog/matrix, and Evidence references MUST update atomically. |
| GS-003 | Every governed inventory MUST be bidirectional and MUST reject missing, stale, duplicate, and orphan entries. |
| GS-004 | Every Git-visible non-build path MUST be classified; every new governance file MUST declare an owner and phase and be registered in the Catalog. |
| GS-005 | Only final verified, non-provisional receipts MAY promote status; failed and checkpoint receipts remain immutable. |
| GS-006 | Rollback verification MUST include a runnable dry-run and an isolated actual apply with byte-exact comparison. |
| GS-007 | Any gate failure MUST freeze the affected Catalog status and block dependent phases. |

The P1 command inventory that implements this contract is:

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm test:p1
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm verify
```

Current P1 gate-contract receipt:
`docs/evidence/v3-clean-p1-gate-contract-complete-20260819/verification.json`.

The additive P2 command inventory is:

```text
pnpm check
pnpm scan:clean
pnpm test:p2
pnpm test:p1
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration
pnpm test:security
pnpm verify
git diff --check
```

P2 records literal outputs and rollback application under
`docs/evidence/v3-clean-p2-identity-acl-20260819/`; the P1 receipt above is
read-only input and is not regenerated by P2.
