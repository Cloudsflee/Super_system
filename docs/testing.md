# Testing and Evaluation

Status: supporting test policy for V3-Clean implementation phases. The detailed
phase-to-gate mapping is in [`architecture/v3-clean-development-plan.md`](architecture/v3-clean-development-plan.md);
this document does not promote a Catalog item by itself.

## Gates

`check`, `audit:p1`, `scan:clean`, `test:p1`, `test:p2`, `test:p3`, `test:p31`,
`test:p4`, `test:p5`, `test:p6`, `test:p7`, `test`, `test:integration`,
`test:e2e`, `test:security`, and `test:release` are first-class gates. `verify`
runs the repository-wide sequence in
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

## Post-P10 development reliability gate

Decision D-040 adds two verification channels without changing the P10 release
or its immutable Evidence. The root package surface has 58 classified scripts.

The daily channel is:

```text
pnpm verify:dev
pnpm verify:dev -- --base <git-ref>
pnpm verify:dev -- --all
pnpm verify:dev -- --explain
```

An explicit `--base` takes precedence. Otherwise the base is the merge-base of
HEAD with the branch upstream, then `origin/main`, then `main`, with `HEAD^`
as the final fallback when those refs are absent. A configured upstream that
is missing, or an existing ref whose merge-base cannot be verified, fails as
`git_base_unverifiable`. Results retain `base`, `base_source`, `head`, and
separate committed, worktree, staged and untracked path lists. Classification
is still mandatory for their union, including newly added tests.

Every development run includes `pnpm check`, `pnpm scan:clean`, and
`git diff --check`. Catalog reverse mapping selects the remaining local tests;
new or unmapped paths fail as `unclassified_changed_path`. Governance changes
select P1, P3.1, P10, parity, and all four recovery commands. Golden changes
select P4, P3.1, and Historical integration. Shared Clean core changes select
P1-P10 plus Clean integration/security. Web router, shell, service-worker, or
Vite changes add build and E2E. The channel excludes live GitHub, Provider,
deletion, Docker publication, and release probes. Duplicate commands are
collapsed while retaining every satisfied Catalog/test reference. The Web
component suite, build checks and isolated performance probes run as one
bounded development wave; E2E remains after repository-sensitive gates because
it owns browser/server resources.

The pre-push formal Gate continues to be `pnpm verify`. Its active inventory is:

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm audit:parity
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p31
pnpm test:p4
pnpm test:p5
pnpm test:p6
pnpm test:p7
pnpm test:p8
pnpm test:p9
pnpm test:p10
pnpm evidence:p5 -- --verify
pnpm evidence:p6 -- --verify
pnpm evidence:p7 -- --verify
pnpm evidence:p8 -- --verify
pnpm evidence:p9 -- --verify
node scripts/v3-clean-p10-parser-probe.mjs
node scripts/v3-clean-p10-github-deletion-probe.mjs
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
node scripts/v3-clean-p10-release-probe.mjs
pnpm test:release
pnpm evidence:p10 -- --verify
git diff --check
```

Gate child environments strip Git hook context variables (`GIT_DIR`,
`GIT_WORK_TREE`, index/prefix/object overrides) before running temporary-clone
and nested test commands. This preserves the exact pending HEAD check while
ensuring `git -C <fixture>` operates on its declared fixture repository.

The single layered integration/security executions satisfy their Clean,
Historical, and combined command references without duplicate test work. The
formal `pnpm test` call is Unit-only because Web already ran; standalone
`pnpm test` remains Unit plus Web. P5-P9 real probes are retired from active
orchestration and replaced by immutable Evidence verification. Only the three
current P10 probes execute, and none has a fallback.

The pre-push hook passes `--pre-push`, binding the current local HEAD before
upload. The standalone formal command requires `upstream=HEAD`; the pre-push
command runs all checks but verifies the pending local HEAD. The marker is
passed only to the final Evidence command, not to child test repositories.

The five independent local validations (Web tests, Unit tests, integration,
security, and build) run concurrently and retain separate command receipts.
Historical security omits `boundary.test.mjs` and `v3-clean-p1.test.mjs`
because the Clean layer owns them. In formal verification the production image
subtest is delegated to the required P10 release probe, which checks Docker CLI
and socket absence, `node-pty`/`ws` availability, and the
`aiws.component=app` label on the reproducible image. Direct
`pnpm test:security:clean` still performs the standalone image build.

`tests/p10/development-reliability.test.mjs` covers argument preservation for
spaces, Chinese paths, and `& | < > ^ % ! ( )`; bounded redaction; stable
process errors; no-Shell source checks; incremental selection; prior Evidence
and current-probe ordering; Unit/Web deduplication; development receipt
metrics; failure classification; canonical SHA; and SQLite/CAS/Vault byte
identity. Historical R5 proof and behavior replay remain under
`tests/unit/recovery-golden.test.mjs` and explicit Historical integration.

Changed test files not covered by a selected phase run explicitly. The daily
channel runs only the static/Compose subset of a changed production-image
boundary test; image execution remains a formal-Gate requirement. When build
is selected, its TypeScript check satisfies the check/typecheck obligation once.
Incremental syntax checks cover changed source files; standalone and formal
checks still inspect every source file. Repository inventories use NUL-delimited
Git output to retain Unicode names and both sides of renames.

Development metrics use exact Clean Registry command ownership, with only the
seven internal execution stages and task-run command projected through the
registered execution owner. Unknown same-prefix commands fail. Failure totals
count each failed generic operation once, not its repeated domain projections;
expired interaction timestamps are not counted as human answers or approvals.
The window selects records created between its endpoints (inclusive), with
status observed at the read-only snapshot. Missing timings remain null.
Generation attempts count immutable rows once, rather than summing ordinal
attempt numbers. Full reruns require multiple started root executions with the
same pinned-input fingerprint; unused draft executions do not count as reruns.
Historical Device Auth cancellation is exercised while the mock waits for user
authorization and waits for asynchronous revocation, independent of CPU load.
The neighboring completed-login test retains the real mock claim path.

Maintenance verification and four-role rollback artifacts are recorded at
`docs/evidence/post-p10-development-reliability-20260905/`. They do not mutate
or supersede P10 Evidence and do not change any Catalog status.

### Remote Workspace transport coverage

The Repository maintenance slice adds
`tests/p10/remote-workspace-auth.test.mjs`. It uses fake fetch and `execFile`
boundaries to verify RS256 claims, Installation-token request order, numeric
repository/full-name/branch/HEAD pins, tree and blob manifest drift, truncation
and quotas, submodule/LFS/link/special-file rejection, and malformed input.
The same suite checks shell-free shallow clone arguments, prompt/config
isolation, absence of credentials from argv, Git metadata removal, and key
zeroization. Runtime coverage exercises actor-owned enabled GitHub profiles,
Vault-only active credentials, create/refresh atomic publication, failed-copy
preservation, lock/execution conflicts, idempotent replay, and retry lineage;
fixture and Local Git routes remain on their existing adapters.

This is post-P10 D-040 maintenance evidence only. It adds no migration, route,
Catalog status, or formal P10 Evidence mutation. The focused acceptance command
is `pnpm test:p10`; the complete maintenance inventory and the four append-only
artifact roles remain unchanged.

### Files, Context, Assist and preparation boundary maintenance

The P1/P2 boundary maintenance slice keeps the v9 schema and the shared
Operation/Event/CAS/ACL owners. Files is the sole owner of workspace indexing
and indexed-file reads; Context receives bytes only through that owner and
returns `files_owner_unavailable` when the owner is absent. Indexing skips
links/reparse/special paths and is bounded to 10,000 files and 100 MiB. Assist
session scope, lifecycle, reference revision/hash bindings, and interaction
project/turn/operation links are rechecked inside their write transactions;
P10 lifecycle and review handlers use the same session predicate. Terminal
open requests require and bind the complete workspace/runtime/cwd/size/session
shape. The Web preparation journey persists
connection/line/workspace selections, matches lines by source fingerprint,
waits up to 120 one-second polls (with an injectable sleep in component tests),
and consumes Files pages at 500 rows up to 10,000 entries while removing stale
selections. Terminal open is a strict closed-shape request: workspace, runtime,
cwd, dimensions, and the nullable Assist session field are all required and
must match the approved request exactly; no legacy defaults are accepted.
E2E and release startup share `scripts/lib/port-lease.mjs`. A lock file and an
OS listener probe are held until readiness, and only pre-side-effect address
failures retry with bounded backoff after complete process/temporary-state
cleanup. `tests/p10/port-lease.test.mjs` is owned by Platform/Testing under
post-P10 D-040, registered in the Clean Catalog, compatibility aggregate and the
P1 gate-sync inventory. It uses real child listeners for collisions, readiness,
bounded retries and process/directory/lock disposal; the formal gate keeps its
existing parallel E2E/release ordering. `tests/p10/development-reliability.test.mjs`
owns real-Git baseline and unclassified-path regressions. The existing P4/P5
and Web suites own the Files/Context/Assist/Terminal and preparation boundaries.

The synchronized focused regression inventory is:

```text
pnpm test:p4
pnpm test:p5
pnpm test:p10
pnpm --filter @aiws/web test
pnpm --filter @aiws/web build
```

These checks are maintenance evidence only. They do not promote Catalog rows,
rewrite migrations, or mutate any P1-P10 formal Evidence receipt.

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
The immutable R5 source-hash replay in `tests/unit/recovery-golden.test.mjs`
runs only in the Historical integration layer. `pnpm test` skips that named
assertion while retaining every other unit test and the Clean Web suite.

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

Formal P3.1 Evidence is written under
`docs/evidence/v3-clean-p3-1-debt-burn-down-20260820/`; each run has an
append-only `attempts/<run-id>/` directory. A final verified receipt is created
exclusively, and rollback verification records both a dry-run and an isolated
actual apply with `byte_exact_mismatches=[]`. Routine layered-gate success
prints only `aiws.v3-clean.layered-gate-result.v2` with `receipt: null`, so
`verify` and pre-push do not dirty the worktree. A Clean failure or Historical
advisory failure appends a complete redacted receipt to
`.ai-workspace/gate-receipts/` using a timestamp/PID name and `wx`; local
receipts are diagnostic only and cannot promote status. P1/P2/P3 Evidence
remains read-only, and the four existing P3 rows retain their prior status.

## P4 Context, MCP, Exchange, and Gateway

P4 advances the active Clean runtime to schema v4 and adds `tests/p4/` for
migration/entrypoint, Context/Projection/CAS, MCP/Exchange/Gateway security,
four-transport dispatcher parity, and governance synchronization. The P3 gate
continues to run its behavior regression files but excludes the read-only P3
entrypoint assertion that intentionally fixes the old active version at 3; the
replacement P4 entrypoint test asserts `user_version=4` and the retired API v1
boundary.

The P4 unit gate preserves the same split: `pnpm test` excludes only the named
R5 source-hash replay, while `fixture:legacy:integration` owns and reports it
as Historical advisory characterization. The package surface remains fixed at
47 scripts after the P6 gate additions.

The fixed P4 command inventory is:

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p31
pnpm test:p4
node scripts/v3-clean-p4-performance.mjs
node scripts/v3-clean-p4-gateway-probe.mjs
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration:clean
pnpm test:security:clean
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
pnpm verify
pnpm evidence:p4
git diff --check
```

Migration cases cover `0/1/2/3 -> 4`, checksum/snapshot drift, DDL/ledger/
receipt/commit faults, restart continuation, prior-row byte identity, FK and
semantic integrity. Context cases cover adapter URI/version stability, cycle
rejection, tombstones, deterministic rebuild hashes, MiniSearch CAS tamper,
policy CAS, source drift, token budget, mandatory evidence, and stale Pack
inputs. Projection cases cover two-worker lease fencing, cancel/retry lineage,
terminal operation/event/head atomicity, and startup recovery.

Authorization cases cross Team/Project, explicit deny, sensitivity, source
allowlist, Exchange both-side approval/expiry/revoke, MCP project/tool allowlist,
SSE cursor scope, and replay-time authorization. REST, MCP Streamable HTTP,
stdio, and the independent Gateway probe must report the same command schema and
normalized result; cross-transport idempotency returns the same business
receipt. Gateway tests cover signature/body tamper, skew, nonce replay,
destination denial, stateless imports, and receipt redaction.

`scripts/e2e.mjs` is the active P4 browser journey. It covers Context projection
cancel/retry, document/history, policy, selection/Pack, one-time client token,
Exchange both-side approval, and three viewports (390x844, 1024x768, 1440x900).
Every viewport records Context and MCP/Exchange screenshots plus horizontal
overflow and visible-control overlap checks. Console/page errors and any
`/api/v1` request fail the gate.

Formal P4 Evidence is append-only under
`docs/evidence/v3-clean-p4-context-mcp-20260820/`. Only a final receipt with
`status=verified` and `provisional=false` promotes the four P4 rows. The
rollback gate must pass source reverse-check and an isolated actual v3
SQLite/CAS restore with `byte_exact_mismatches=[]`.
The SQLite integrity probe opens only a temporary byte copy and removes its
WAL/SHM sidecars in `finally`; the Evidence snapshot and restored target remain
byte-exact inputs.
Catalog validation also compares the final manifest bidirectionally with every
top-level Evidence file and rejects missing, hash-mismatched, or orphan files.
Ordinary reruns reject an existing verified final. An explicit corrective
`--supersede` run preserves every prior top-level byte under
`attempts/superseded-final-<run-id>-*` and records `supersedes_run_id` in the
new verification and manifest.

## P5 Assist, Files, Terminal, and Bridge

P5 advances the active Clean runtime to schema v5 with forward-only
`005-assist-files-terminal-bridge`. `tests/p5/` covers provider protocol and
completion invariants, attachment quarantine/preview, managed workspace change
batches, approval/input pause-resume, terminal redaction/cursor replay and the
independent Windows Bridge pairing/nonce/revoke flow. `terminal_events` is only
a one-to-one projection of the generic event stream; Assist does not create a
second operation ledger. Clean Web coverage in `apps/web/src/test/assist.test.tsx`,
`approvals-p5.test.tsx`, `files-p5.test.tsx`, `terminal.test.tsx`, and
`connections-p5.test.tsx` fixes the `/api/v2` envelopes, expected revisions,
terminal client sequence/reconnect cursor, batch undo, and Bridge revoke flows.

The synchronized P5 inventory is:

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p31
pnpm test:p4
pnpm test:p5
node scripts/v3-clean-p5-performance.mjs
node scripts/v3-clean-p5-assist-probe.mjs
node scripts/v3-clean-p5-bridge-probe.mjs
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration:clean
pnpm test:security:clean
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
pnpm verify
pnpm evidence:p5
git diff --check
```

P5 performance thresholds are Assist event replay p95 <=200 ms, 100-file list
p95 <=150 ms, 10-file review p95 <=500 ms, and 1 MiB terminal replay p95 <=500
ms. The independent provider and Bridge probes are hard gates for a final
non-provisional receipt. The provider probe loads a credential into a zeroable
Buffer, maps it only to the isolated app-server child, and must observe a
contiguous real turn with the fixed response contract, an assistant item, all
tool calls terminal, and `turn/completed`; response content is discarded.
Missing credentials or any incomplete turn exits non-zero and writes only a
provisional candidate attempt. Evidence is append-only at
`docs/evidence/v3-clean-p5-assist-terminal-20260820/`; only that receipt can
promote five D8 rows to `verified` and Attachments to `implemented`. Clean and
Historical layers remain disjoint at 19/8, while Frontend and Outcome remain
`scaffolded`.
After publication, `pnpm verify` invokes `pnpm evidence:p5 -- --verify` to
validate the immutable final receipt, manifest hashes, and layered Catalog
without creating or replacing Evidence files, including reopening the nested
Assist probe receipt and rechecking its real-turn invariants. Publishing a corrective run
continues to require the explicit `pnpm evidence:p5 -- --supersede` option.

## P6 Runner, Execution, Checkpoint, and Replay

P6 advances the active Clean runtime to schema v6 with forward-only
`006-runner-execution-checkpoint-replay`. `tests/p6/` covers upgrades from
`0/1/2/3/4/5`, checksum and snapshot drift, DDL/ledger/receipt/commit rollback,
signed Job Spec and receipt tamper, bounded resources, stable DAG scheduling,
read concurrency, write serialization, all seven stages, pause/resume/cancel,
approval wait, replan, replay generations, restart reconciliation, transport
parity, redaction, and governance synchronization.

The synchronized P6 inventory is:

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p31
pnpm test:p4
pnpm test:p5
pnpm test:p6
node scripts/v3-clean-p6-performance.mjs
node scripts/v3-clean-p6-docker-runner-probe.mjs
node scripts/v3-clean-p6-host-runner-probe.mjs
node scripts/v3-clean-p6-bridge-runner-probe.mjs
node scripts/v3-clean-p6-restart-probe.mjs
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration:clean
pnpm test:security:clean
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
pnpm verify
pnpm evidence:p6
git diff --check
```

P6 performance thresholds are 1000-event replay p95 <=200 ms, 100-task DAG
planning p95 <=150 ms, 100-attempt execution detail p95 <=200 ms, and
checkpoint replay validation p95 <=500 ms. Docker, Host, Windows Bridge, and
Broker restart probes are hard gates and must each report `status=passed`,
`provisional=false`. Restart verification includes a real running container
discovered by label, terminal receipt recovery, persistent Broker identity,
and the `external_result_unknown` pause path.

The Clean browser journey covers Host profile creation/probe, approval wait and
resume, a completed execution, `deliver` replay to generation 2, Execution and
Runner Profiles views, and 390x844, 1024x768, and 1440x900 layouts. Console
errors, HTTP errors, overlap, horizontal overflow, or any `/api/v1` request fail
the gate.

Formal P6 Evidence is append-only at
`docs/evidence/v3-clean-p6-runner-execution-20260824/`. Final promotion requires
`status=verified`, `provisional=false`, all four external/restart probes, the
performance and browser receipts, six migration paths, a redacted manifest,
and a runnable dry-run plus isolated actual rollback. Rollback restores the v5
SQLite ledger `[1,2,3,4,5]`, proves all eight P6 tables absent, and byte-compares
SQLite, CAS, Vault, workspace, Broker, and Bridge components. The final receipt
moves only Runner and Execution into Clean, yielding 21/6/27; Frontend and
Outcome remain `scaffolded`. After publication, `pnpm verify` validates both
immutable P5 and P6 final receipts in phase order without publishing a rerun. A
corrective P6 final still requires the explicit
`pnpm evidence:p6 -- --supersede` option.

## P7 Evidence, Quality, Parser, and Outcome

P7 advances the active Clean runtime to schema v7 with forward-only
`007-evidence-quality-parser-outcome`. `tests/p7/` covers upgrades from
`0/1/2/3/4/5/6`, checksum/snapshot drift, DDL/format-seed/ledger/receipt/commit
fault rollback, 17-table ownership, 32-command parity, immutable asset and
review records, parser protocol/signature/nonce/CAS/output tamper, quotas,
cancel/retry/restart, human-review hash binding, and deterministic Outcome
replay including waiver, revoke, and expiry.

The synchronized P7 inventory is:

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p31
pnpm test:p4
pnpm test:p5
pnpm test:p6
pnpm test:p7
node scripts/v3-clean-p5-performance.mjs
node scripts/v3-clean-p5-assist-probe.mjs
node scripts/v3-clean-p5-bridge-probe.mjs
node scripts/v3-clean-p6-performance.mjs
node scripts/v3-clean-p6-docker-runner-probe.mjs
node scripts/v3-clean-p6-host-runner-probe.mjs
node scripts/v3-clean-p6-bridge-runner-probe.mjs
node scripts/v3-clean-p6-restart-probe.mjs
node scripts/v3-clean-p7-performance.mjs
node scripts/v3-clean-p7-cas-tamper-probe.mjs
node scripts/v3-clean-p7-parser-probe.mjs
node scripts/v3-clean-p7-quality-outcome-probe.mjs
node scripts/v3-clean-p7-restart-probe.mjs
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration:clean
pnpm test:security:clean
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
pnpm verify
pnpm evidence:p7
git diff --check
```

The parser probe builds the fixed Node 24 `parser-worker` image twice with
provenance disabled, requires identical image IDs, and runs actual containers
with no network, a read-only root, all capabilities dropped, no new privileges,
and bounded tmpfs. It covers the 21 registered format families and records real
parse latency without using it as a promotion threshold. Missing Docker,
dependency acquisition failure, a digest mismatch, or any provisional probe
freezes Catalog promotion and leaves an immutable candidate attempt.

P7 performance thresholds are 1000-event Evidence replay p95 <=200 ms,
100-asset lineage query p95 <=200 ms, 16-asset/500-anchor Quality detail p95
<=300 ms, and 100-requirement Outcome evaluation p95 <=200 ms. The Clean
browser journey covers asset capture, parse, attestation, complete human
scoring, Outcome evaluation, waiver/revoke, cursor reconnect, duplicate/partial
events, and Evidence/Quality/Outcome layouts at 390x844, 1024x768, and
1440x900. Console errors, HTTP errors, overlap, horizontal overflow, or any
`/api/v1` request fail the gate.

Formal P7 Evidence is append-only at
`docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/`. Final promotion
requires `status=verified`, `provisional=false`, all five P7 probes, performance
and browser receipts, seven migration paths, a redacted hash-complete manifest,
and a runnable dry-run plus isolated actual rollback. Rollback restores the v6
SQLite ledger `[1,2,3,4,5,6]`, proves all 17 P7 tables absent, and byte-compares
SQLite, CAS, Vault, workspace, Broker, Bridge, and parser snapshots. The final
receipt moves Evidence and Quality into Clean and promotes Evidence, Quality,
Outcome, and Attachments to `verified`, yielding 23/4/27. Frontend remains
`scaffolded`. After publication, `pnpm verify` invokes
`pnpm evidence:p7 -- --verify`; a corrective final requires explicit
`pnpm evidence:p7 -- --supersede`.

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
- P4 Context map p95 no greater than 150 ms for 1000 nodes
- P4 Context search p95 no greater than 250 ms for 1000 nodes
- P4 Context selection p95 no greater than 500 ms for 1000 nodes
- 100 MCP Context reads complete; projection rebuild duration is recorded but
  is not a promotion threshold
- P6 1000-event replay p95 no greater than 200 ms
- P6 100-task DAG planning p95 no greater than 150 ms
- P6 100-attempt detail p95 no greater than 200 ms
- P6 checkpoint replay validation p95 no greater than 500 ms
- P7 1000-event Evidence replay p95 no greater than 200 ms
- P7 100-asset lineage query p95 no greater than 200 ms
- P7 16-asset/500-anchor Quality detail p95 no greater than 300 ms
- P7 100-requirement Outcome evaluation p95 no greater than 200 ms

## P8 additive gate

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p31
pnpm test:p4
pnpm test:p5
pnpm test:p6
pnpm test:p7
pnpm test:p8
node scripts/v3-clean-p5-performance.mjs
node scripts/v3-clean-p5-assist-probe.mjs
node scripts/v3-clean-p5-bridge-probe.mjs
node scripts/v3-clean-p6-performance.mjs
node scripts/v3-clean-p6-docker-runner-probe.mjs
node scripts/v3-clean-p6-host-runner-probe.mjs
node scripts/v3-clean-p6-bridge-runner-probe.mjs
node scripts/v3-clean-p6-restart-probe.mjs
node scripts/v3-clean-p7-performance.mjs
node scripts/v3-clean-p7-cas-tamper-probe.mjs
node scripts/v3-clean-p7-parser-probe.mjs
node scripts/v3-clean-p7-quality-outcome-probe.mjs
node scripts/v3-clean-p7-restart-probe.mjs
node scripts/v3-clean-p8-performance.mjs
node scripts/v3-clean-p8-github-delivery-probe.mjs
node scripts/v3-clean-p8-importer-probe.mjs
node scripts/v3-clean-p8-deployment-rollback-probe.mjs
node scripts/v3-clean-p8-backup-restore-gc-probe.mjs
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration:clean
pnpm test:security:clean
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
pnpm test:release
pnpm verify
pnpm evidence:p8
git diff --check
```

P8 performance keeps the 1000-operation query p95 threshold at 200 ms. The
GitHub probe must verify discovery, branch, Draft PR, checks, ready, merge,
webhook deduplication and reconcile against an isolated fixture repository.
The Deployment probe must build/inspect app, Broker, Runner and Parser images,
export SBOMs, publish on a dynamic loopback port and a fresh volume, and prove
schema v8 health. Importer verifies schema-7 row preservation, schema-23
mapping, secret/path omission, signed 500-row/domain checkpoints and resume.

Formal P8 Evidence is append-only at
`docs/evidence/v3-clean-p8-delivery-deployment-importer-20260825/`. Candidate
and failed runs never promote Catalog rows. Rollback requires a no-write dry-run
and an isolated actual apply restoring v7 ledger `[1..7]`, all seven component
snapshots, no P8 tables, and `byte_exact_mismatches=[]`. The published receipt
`run-1787846480106` is `verified` and non-provisional: the isolated GitHub
fixture completed discovery, Draft PR, ready, merge, webhook deduplication and
reconcile, Docker deployment passed, and Catalog promotion is `26/1/27`.

## P9 additive gate

P9 adds `test:p9` and `evidence:p9` to the P8 inventory. Runtime phase 9 must
report schema v8 and migration ledger `[1..8]`; P9 tests reject a ninth
migration or business table. Focused API tests cover JSON/SSE equivalence,
`Last-Event-ID` precedence, inter-project global sequence holes, true project
gaps, duplicates, project-scoped cursor expiry, redaction, ACL revocation on
events and heartbeat, and exact-origin credentialed CORS including OPTIONS.

Web tests cover scoped Query keys and cache disposal, the six-command offline
allowlist, canonical SHA-256 parity, refresh recovery, per-aggregate FIFO,
three-aggregate concurrency, 409 blocking, explicit rebase/discard lineage,
actor/project isolation, and event-to-query invalidation. PWA tests prove that
the app shell opens offline while `/api/v2`, SSE, CAS, downloads, `/livez`, and
`/readyz` never enter Cache Storage.

The additive commands are `pnpm test:p9` before external probes and
`pnpm evidence:p9 -- --verify` after release/E2E verification. `verify` retains
the full P1-P8 sequence, then runs P9, all required external probes, Web,
integration/security, build, E2E, release, and Evidence verification in that
order. The root package inventory is 53 scripts.
P9 external commands are `node scripts/v3-clean-p9-github-delivery-probe.mjs`
and `node scripts/v3-clean-p9-release-probe.mjs`; both must be non-provisional.

Browser release E2E covers the Project-to-Delivery chain, management views,
manual input, offline/reconnect, duplicate events, stale revision, blocked
import, unknown external results, keyboard focus, WCAG 2.2 AA, and overlap/
overflow/console/HTTP checks at 1440x900, 1024x768, and 390x844.

Formal P9 Evidence is append-only at
`docs/evidence/v3-clean-p9-web-release-20260826/`. It must contain the original
hashes, modified release bundle, patch, literal baseline/modified command
outputs and statuses, fixed image digest, SBOM, exact dynamic CORS origin,
three viewport receipts, and a runnable dry-run plus isolated actual rollback.
The rollback restores schema v8, ledger `[1..8]`, deployment pointer, SQLite,
CAS, Vault, workspace, Broker, Bridge, Parser, and Web bundle with
`byte_exact_mismatches=[]`. Candidate or failed receipts keep `26/1/27`; only
final `verified`, `provisional=false` Evidence may promote `27/0/27`.

Published P9 Evidence is `run-1787933538303`, `status=verified`, and
`provisional=false`. The final browser matrix covers all Project-to-Delivery
and management routes at 1440x900, 1024x768, and 390x844 with zero overlap,
zero horizontal overflow, zero console/HTTP errors, and zero `/api/v1`
requests. The offline receipt contains no API, SSE, CAS, download, health, or
readiness Cache Storage entry. Actual rollback restores schema v8, ledger
`[1..8]`, and all eight component snapshots with no byte mismatch. Catalog is
`27/0/27` and all 27 rows are released.

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

## P10 final parity gate

P10 added `audit:parity`, `test:p10`, and `evidence:p10` to its published
root inventory (56 scripts). D-040 later adds two maintenance commands without
changing P10 Evidence or status. The parity parser reads the immutable V2.3 source
without importing its runtime and verifies 14 L0-L7 cases, 360 route
declarations, 98 collections, 11 Web routes, seven optimization packages, and
19 business groups bidirectionally. Missing, duplicate, stale, orphan,
unexplained, `gap`, or `retired_business` rows fail the gate.

Migration tests cover v0-v8 to v9, checksum/snapshot/DDL/ledger/receipt/commit
faults, foreign keys, terminal immutability, and an isolated byte-exact v8
rollback. Domain tests cover Provider enable/disable/edit/probe, Brief template
revision snapshots, Project blocker recheck and tombstone, two-proof Repository
deletion and reconcile, Assist archive/restore/delete/restore-deleted,
fork/side-thread/review comments, Quality's five-dimension default rubric,
selection/exclusion, isolated advice, human-score separation, one active run,
supersession and stale history.

The P10 parser wrapper runs archive work in a bounded `worker_threads` worker
at fixed digest
`sha256:3c2c0f8f550f4c8a14c33661f1e4e85227aa02e3bd0844a8e1044ed368d202a0`.
It resolves the nested `libarchive.js` worker as a real file URL on Windows and
uses bounded native GZIP expansion. The probe rebuilds the additive P10 image
twice, runs all 21 valid formats in the networkless read-only container, and
also verifies malformed input, signature mismatch, quota, traversal, encrypted
archive, nested bomb, and five-format Windows-host parsing receipts.

Web checks use parameterized project hash deep-links. The browser receipt
executes Provider bind/edit/probe/disable/enable, Brief template revision and
archive, Project tombstone, two-session Repository confirmation/cancel, Assist
metadata/configuration/fork/side-thread/review/lifecycle, five-dimension Quality
and Outcome, then checks keyboard focus, WCAG AA, console/HTTP errors, overlap,
overflow, and the 1440x900, 1024x768, and 390x844 viewports.

The external deletion probe first proves a unique private fixture name absent,
creates only that repository, binds its public id and HEAD, deletes through the
production GitHub App adapter, reconciles absence, and permits cleanup only
when the same repository id is still present. Release verification performs
two byte-identical Docker builds, exports an SPDX SBOM, publishes to a fresh
temporary volume with a dynamic loopback origin, checks the three governance
viewports and offline shell, switches only an isolated pointer, verifies
backup/restore, and applies an actual P9 rollback. It never touches a production
pointer or volume. Final Evidence is
`docs/evidence/v3-clean-p10-final-governance-20260829/`; Catalog remains
`27/0/27` and status is never inferred from interface counts.

## Post-closure Web product regression

The annotated `p10-final-governance-20260829` tag remains the immutable
governance boundary. Ordinary product commits after that tag do not create a
new phase. `evidence:p10 -- --verify` accepts a clean pushed descendant only
when its upstream equals HEAD and the tagged architecture, P1-P10 migrations,
and Evidence remain byte-identical. Catalog implementation/test references may
advance, but the sorted set of all 27 `{id,status}` pairs must remain identical
to the tag (`27 released`, `0 historical`).

The Web regression restores the six-entry hidden drawer and continuous system
and project onboarding without adding a schema or public API. Component tests
cover drawer default/overlay/Escape/focus-trap/focus-restore behavior, account-
scoped completion and GitHub-skip markers, the verified Codex hard gate,
GitHub discovery, secret storage hygiene, existing-project bypass, both Intake
modes, template-backed complete Briefs, refresh recovery, revision conflict,
source drift/retry, and the exact generation -> critic -> proposal apply ->
Brief confirm sequence. `scripts/e2e.mjs` runs the same journey at 1440x900,
1024x768, and 390x844 with WCAG AA, console/HTTP, overflow, overlap, and drawer
receipts. The existing internal governance deep-link remains in the 19-group
acceptance journey but is absent from user navigation.

The synchronized acceptance subset is:

```text
pnpm check
pnpm --filter @aiws/web test
pnpm test:p10
pnpm audit:parity
pnpm test:e2e
pnpm verify
git diff --check
```

Failures leave every Catalog status unchanged. The final P10 Evidence tree is
read-only; local product-change verification and rollback receipts live only
under the ignored `.ai-workspace/change-receipts/` directory.

The pre-push hook sets `AIWS_VERIFY_RUNNING=1` for its outer verification.
`verify.mjs` preserves that marker so Git pushes made by external fixture
probes do not recursively start another repository-wide gate. A normal user
push without the marker still executes the complete `pnpm verify` inventory.

### Post-closure capability restoration details

The post-closure product regression keeps the P10 governance tag, schema v9,
and the `27 released / 0 historical` Catalog unchanged while restoring the
reachable V2.3 business workflows. The Clean session boundary exposes
`POST /api/v2/setup/session` with an exact loopback/same-origin check and a
persistent `HttpOnly; SameSite=Strict` cookie; the Web client retries a stale
session once and reloads the real account scope. Provider setup covers ordered
Codex host discovery (`AIWS_HOST_CODEX_HOME`, `CODEX_HOME`, `~/.codex`), bounded
TOML/JSON parsing, symlink/race checks, Vault import, ChatGPT Device Login,
and cleanup of isolated homes without returning secrets or host paths. GitHub
setup restores the bundled public App identity, Hosted server configuration,
GitHub App Manifest creation, signed installation callbacks, Vault binding,
Profile Probe, and repository discovery through
`GET /api/v2/provider-discovery/github`,
`POST /api/v2/provider-auth/github/manifest`, and
`POST /api/v2/provider-auth/github/installations`. App and Installation ids are
not default user inputs; BYO key entry remains an explicit advanced fallback.

The shell restores parameterized asset/audit/workstream/node/repository and
GitHub-install deep links, a six-entry hidden navigation drawer, focus trapping
and focus restoration for tool drawers, and an offline overlay that keeps the
loaded page and permitted Outbox work available. Project/Identity/Assist,
Workflow, Quality, Outcome, Delivery, and Operations surfaces reuse the existing
Clean owners and generic ledger. `tests/p10/post-closure-restoration.test.mjs`
is the API/security regression for session, discovery, Device Login, redaction,
restart cleanup, and Hosted/Manifest GitHub state, replay, Probe, Vault, and
callback contracts; `apps/web/src/test/setup-flow.test.tsx` and
`apps/web/src/test/post-closure-restoration.test.tsx` add the guided GitHub Web
journey, route/recovery, and sanitization checks alongside the existing suite.
New implementation and test paths are registered in both layered
Catalogs without changing any status or P10 Evidence byte.

The restoration acceptance subset is:

```text
pnpm check
pnpm audit:parity
pnpm recovery:catalog
pnpm --filter @aiws/web typecheck
pnpm --filter @aiws/web test
pnpm test:p2
pnpm test:p3
pnpm test:p10
pnpm build
pnpm test:integration:clean
pnpm test:security:clean
pnpm test:e2e
pnpm test:release
pnpm verify
git diff --check
```

### Real development loop

The development reliability surface is exercised with:

```text
pnpm test:development
node --test tests/p10/real-development-loop.test.mjs
node scripts/v3-clean-real-development-loop.mjs --source <SOURCE_PATH> --project-name <PROJECT_NAME>
pnpm probe:development -- --scenario minimal
pnpm probe:development -- --scenario designsignal
```

The focused checks cover Evidence cursor compensation and receipt joins,
provider-backed workflow generation, server-side critic assessment, execution
plan command/path/DAG validation, and the expanded CAS protection set. A
missing provider lease remains an explicit pending failure and never becomes a
deterministic success. The real loop command requires a clean Git worktree,
imports the local Codex discovery record into its temporary Vault, pins
`gpt-5.6-sol/high`, and writes a redacted final receipt below
`.ai-workspace/real-development-loop/<run_id>/receipts/`.

### Provider boundary hardening (post-P10, Workflow owner)

Generator acceptance uses the complete JSON response, never an extracted
substring. One provider repair is allowed; a second invalid document returns
`provider_output_invalid_json`. Ordinary tasks require nonempty string arrays
for checks and acceptance; invalid contracts return `provider_workflow_invalid`
after the same bounded repair. Workstream containers remain allowed. Credential
leases are zeroed on success and failure. The existing balanced-object helper
is not a provider acceptance boundary.

The registered `tests/p10/real-development-loop.test.mjs` adds strict JSON,
empty/ill-typed contract, retry-count, protocol and cleanup regressions without
changing prior assertions. Commands remain `pnpm test:p10`,
`pnpm test:development`, `pnpm check`, `pnpm verify:dev` and `pnpm verify`.
Catalog path ownership and status stay unchanged; local command records are
diagnostic only, append-only, and never substitute for immutable P10 Evidence.

Critic hardening (Workflow/Critic owner, separate corrective gate-sync review)
checks every expected task/check pair and every Brief requirement. Duplicate,
stale, orphan and malformed rows fail as `critic_failed`; absent mappings reject
even when the provider reports passed. Provider coverage is copied before
deriving missing entries. A provider rejection is never upgraded. Tests assert
that a real provider-Critic call occurred, avoiding structural-rejection false
positives. The existing JSON-repair fixture now explicitly passes its original
Brief to the Critic; its success assertion is unchanged.

### Fail-closed maintenance gates (Platform/Testing owner)

The existing `scripts/lib/gate-process.mjs` owns fixed elapsed-time budgets:
development 120000 ms and formal 360000 ms, without environment or CLI
overrides. Both Gate entrypoints cap each child to the remaining budget and
return failure when the total is exceeded. Receipts add the measured `budget`
object; existing schema ids, commands and D-032 stdout-only success semantics
remain unchanged. Failed runs stay append-only diagnostics, not new Evidence.

Gate acceptance requires the literal zero exit, no signal/timeout/error,
complete capture/timing metadata, untruncated stdout/stderr and successful
redaction. A reported `ok` flag never overrides those checks. Pre-push rejects
Evidence-skipping inputs and unknown bypass arguments. The additive regressions
in `tests/p10/development-reliability.test.mjs` exercise budget overflow,
zero-exit output truncation, incomplete receipts and pre-push input rejection;
its existing advisory fixture now supplies complete process capture metadata.

Verification on an isolated exact HEAD must retain full command streams with
exclusive creation and SHA-256 manifests. Local hashes detect subsequent edits;
they are not an independent signature. Git can skip local hooks, so remote
required checks and protected branches, administered outside the editing
process, remain the independent publication boundary.

The formal runner completes the shared validation wave before starting the
independent P10 release probe. It overlaps cold Docker/image work with the
dynamic E2E journey and reaps the redacted receipt at its declared plan
position. The command, failure semantics and fixed 360000 ms total budget remain
unchanged; an earlier blocking gate still reaps the probe before returning.
