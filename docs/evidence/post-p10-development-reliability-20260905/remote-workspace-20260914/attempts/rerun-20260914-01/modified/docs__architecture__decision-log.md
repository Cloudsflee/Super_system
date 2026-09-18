# V3-Clean Decision Log

Status: accepted for the architecture phase.
Decision owners: product architecture and platform engineering.
Last reviewed: 2026-08-29.

This log is the change-control source for the clean-break documents. A later
proposal must name the decision id it changes, show affected capability rows,
and include migration, test, and rollback impact before implementation starts.

## Accepted decisions

| ID | Decision | Rationale | Consequence |
| --- | --- | --- | --- |
| D-001 | V3-Clean is the only runtime | one state model and one permission path reduce drift | historical runtime code is archive evidence |
| D-002 | Public API is /api/v2 | the clean break permits a coherent envelope and revision protocol | clients migrate as a single cut |
| D-003 | A clean baseline starts schema family v3-clean at user_version 1 | V1-V6 migrations contain incompatible ownership and shadow state | importer is the only path for historical data |
| D-004 | V2.3 commit e18dc0b is read-only behavior evidence | it is the last complete V2.3 capability source | source worktree is never imported at runtime |
| D-005 | Current V3 data is a second offline importer input | useful work and Evidence must survive the break | both source manifests and hashes are required |
| D-006 | No API/runtime compatibility branch | dual behavior keeps ambiguous contracts alive | archived addresses return a retired-route receipt |
| D-007 | No dual writes or shared write volume | atomic cutover is easier to verify and roll back | old and new volumes are isolated |
| D-008 | One owner per table, command, and event | ownership prevents cross-domain mutation races | registry and architecture gates enforce uniqueness |
| D-009 | One canonical aggregate state plus generic head/revision snapshots | a single head source removes pointer drift | per-domain shadow head tables are not created |
| D-010 | Generic operations, events, and CAS cover every long task | Assist, execution, projection, and delivery need identical replay semantics | assist_operations is not a clean runtime table |
| D-011 | CAS uses canonical bytes and SHA-256 | content identity must be host/path independent | absolute paths stay in adapter receipts only |
| D-012 | All project-scoped reads and writes share one authorization predicate | HTTP/MCP/import/replay must expose the same boundary | Exchange grants only narrow an existing permission |
| D-013 | Team, Actor, membership, project ACL, Exchange, and Gateway return as first-class capabilities | cumulative V2.3 behavior depends on multi-subject access | identity is restored before project features |
| D-014 | Gateway is a forwarding boundary | durable business state belongs to the API and repositories | Gateway has no Docker socket and no business tables |
| D-015 | Credentials import as metadata and external references | secrets must be rotated or rebound at the destination | every imported credential starts rebind_required |
| D-016 | Docker, Host, Windows Bridge, and MCP Gateway are formal adapters | V2.3 workflows rely on all execution transports | each adapter has a signed receipt and isolated profile |
| D-017 | All listed parser families are in scope, including audio/video, PPTX, and archives | the clean target removes earlier parser exclusions | parser workers return explicit unsupported/invalid states |
| D-018 | Parser output creates Evidence, not a human verdict | automated extraction and human quality judgment are distinct | Outcome requires configured policy and human review where applicable |
| D-019 | Import is offline, checkpointed, and one-time | online migration would mix source writes and target writes | inspect/dry-run/run/verify/cutover are separate receipts |
| D-020 | Semantic conflicts fail the complete batch | silent source preference can lose business meaning | merge manifest decisions are explicit and hashed |
| D-021 | Pure technical id collisions use deterministic remapping | repeatability matters for foreign-key closure | import_id_map records algorithm and mapping hash |
| D-022 | Rollback restores a deployment artifact | clean runtime must stay clean after rollback | old API/runtime is not re-enabled inside V3-Clean |
| D-023 | Catalog status is evidence-derived | a schema stub is not a shipped capability | scaffolded rows require behavior/UI/Evidence gates |
| D-024 | V2.3 L0-L7 cases are mandatory acceptance inputs | governance, parser, lifecycle, security, performance, and release all matter | capability matrix links every catalog id to V3 tests |
| D-025 | Every mutation requires Idempotency-Key; lifecycle updates require expected revision | retries and concurrent actors need deterministic outcomes | missing metadata is a boundary validation error |
| D-026 | SSE and JSON replay are equivalent views of durable events | clients need reliable reconnect and offline replay | one event cursor and one redaction policy serve both |
| D-027 | No secret, token, prompt, or host path enters API/event/audit/CAS/Evidence | receipts must be safe to retain and inspect | redaction is a pre-commit check |
| D-028 | Release requires temporary-volume verification and actual rollback | image-only checks do not prove data safety | release receipt names both target and rollback behavior |
| D-029 | P2 identity and ACL use forward-only `002-identity-acl` over the frozen `001-clean-baseline` | actor/session, Team membership, project ACL, and credential metadata need one owner and one revision ledger without introducing a Project business table early | P2 upgrades clean volumes `1 -> 2`, reads Exchange grants for narrowing only, and leaves the P1 Evidence immutable |
| D-030 | P3 Project/Workflow uses forward-only `003-project-workflow` over the frozen P1/P2 migrations | Project, Brief, Repository, Workflow, Generation, Critic, and requirement scaffolding need owned aggregates with one operations/events/CAS/head model | P3 upgrades clean volumes `0/1/2 -> 3`; the active process entrypoint defaults to target version 3 while explicit lower targets remain fixture-only; Project owns projects/intakes/briefs/requirements, Repository owns connection/target/line/workspace/lock records, Workflow owns workflow/generation/proposal records, and Critic owns immutable critic receipts; deterministic repository/generator/critic adapters prove the boundary without claiming real provider state; revision CAS, retry lineage, single-writer fencing, and restart recovery are mandatory; P1/P2 Evidence stays immutable and P3 receipts live under `docs/evidence/v3-clean-p3-project-workflow-20260819/` |
| D-031 | P3.1 is a forward-only Clean debt burn-down and gate-synchronization phase | Domain facades can remain stable while ownership, ledger entrypoints, default Web/E2E entrypoints, Catalog layers, and receipt publication are made explicit | No new schema/table/migration/API version is introduced; Project/Repository/Workflow/Outcome and Identity owners delegate to the shared operations/events/aggregate-head/idempotency services; active Web/E2E use `/api/v2` and historical suites run only through explicit fixture commands; Clean and historical Catalogs are disjoint; failed/checkpoint Evidence is append-only and isolated rollback is byte-exact; P1/P2/P3 Evidence and four P3 status rows remain unchanged except for synchronized references |
| D-032 | Layered gate receipt hygiene keeps routine verification Git-stable | Successful daily gates should not create Git-visible Evidence files while failures remain auditable | `aiws.v3-clean.layered-gate-result.v2` is stdout-only with `receipt: null` on success; Clean failures remain blocking and Historical failures remain advisory, each appending redacted output under `.ai-workspace/gate-receipts/` with exclusive `wx`; only immutable final P3.1 `verification.json` can promote Catalog status; the hygiene Evidence records migration hashes and isolated rollback |
| D-033 | P4 uses forward-only `004-context-projection-mcp`, one dispatcher, and an independent stateless Gateway | Context projection is a rebuildable CAS-backed derivative while every transport must preserve one schema, authorization, operation/event ledger, and redaction decision | The active runtime advances `0/1/2/3 -> 4`; Context owns source/node/version/edge/policy/selection/pack, Projection owns job/index snapshot, MCP owns client, Exchange owns request/grant, and Gateway owns forwarding receipt; policy history and projection events use generic revisions/events with no shadow heads; REST, MCP HTTP, stdio, and Gateway call `CleanCommandDispatcher`; `apps/gateway` has no SQLite/CAS/domain repository or Docker access; both-side Exchange approval only narrows Team/Project ACL; final Evidence lives under `docs/evidence/v3-clean-p4-context-mcp-20260820/` and alone promotes the four P4 Catalog rows |
| D-034 | P5 uses forward-only `005-assist-files-terminal-bridge`, one shared ledger, and an independent loopback Windows Bridge | Assist, Files, Terminal, and Bridge need recoverable human-in-the-loop behavior without reviving historical operation/head/CAS models | The active runtime advances `0/1/2/3/4 -> 5`; Assist owns sessions/turns/messages/goals/references and approval/input/proposal records, Files owns attachments/files/change batches, Terminal owns PTY sessions and its one-to-one generic-event projection, and Bridge owns pairing/transfers; provider threads/items remain opaque and credentials stay in memory/Vault/DPAPI; the final provider receipt requires a zeroable credential lease and a real fixed-response turn with contiguous events, assistant output, terminal tools, and `turn/completed`, while missing credentials or incomplete output remain provisional; all mutations use idempotency and expected revision; active Web uses `/api/v2`; final Evidence lives under `docs/evidence/v3-clean-p5-assist-terminal-20260820/`, promotes five rows to verified and Attachments to implemented, yielding Clean/Historical 19/8 |
| D-035 | P6 uses forward-only `006-runner-execution-checkpoint-replay`, one generic ledger, and signed Runner boundaries | Docker, Host, and Windows Bridge execution need deterministic scheduling, restart reconciliation, pause/resume, and immutable replay without reviving historical Broker or execution contracts | The active runtime advances `0/1/2/3/4/5 -> 6`; Runner owns profiles, immutable Job Specs, and signed terminal receipts, while Execution owns pinned inputs, executions, task attempts, immutable generation/stage checkpoints, and a one-to-one projection of generic events; `prepare -> context -> run -> check -> review -> finalize -> deliver` uses one operations/events/aggregate-head/CAS model, with `deliver` producing only a delivery-ready handoff manifest; Docker/Host/Bridge share `runner.job-spec.v2` and `runner.receipt.v2`, timestamp/nonce/body-hash HMAC transport, bounded resources, and zeroed credential leases; Runner profile mutations remain REST/Web-only while Execution and read-only inventory preserve REST/Web/MCP/Gateway parity; final Evidence under `docs/evidence/v3-clean-p6-runner-execution-20260824/` requires non-provisional Docker, Host, Bridge, restart, browser, performance, migration, redaction, and isolated byte-exact v5 rollback receipts, promotes Runner and Execution to verified, yields Clean/Historical 21/6, and leaves Frontend/Outcome scaffolded |
| D-036 | P7 uses forward-only `007-evidence-quality-parser-outcome`, one CAS/event/head model, and an isolated signed Parser boundary | Execution outputs need an immutable, replayable chain from managed bytes through deterministic checks and explicit human judgment without allowing parser output to become a verdict | The active runtime advances `0/1/2/3/4/5/6 -> 7`; Parser owns format registrations and terminal run lineage, Evidence owns assets, immutable versions/blobs/relations/attestations/traces/digests/code changes/test results, Quality owns run/report/generic-event projection/human decisions, Outcome owns immutable evaluations and grant/revoke waiver records, and Project retains `outcome_requirements`; all mutations retain the shared operations/events/event-cursors/aggregate-head/CAS transaction model; Docker workers exchange signed `parser.job.v1` and `parser.receipt.v1` through the Clean Broker with a fixed image digest, quotas, nonce/HMAC transport, restart reconciliation, and no API Docker socket; deterministic reports are advisory while human decisions and waivers require an active session proof and project approval; final Evidence under `docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/` requires non-provisional parser, CAS-tamper, Quality/Outcome, restart, browser, performance, migration, redaction, and isolated byte-exact v6 rollback receipts, promotes Evidence, Quality, Outcome, and Attachments to verified, yields Clean/Historical 23/4/27, and leaves Frontend scaffolded |
| D-039 | P10 is the final business-parity and governance phase | V2.3 business semantics and Web journeys need one fixed, auditable mapping without preserving historical interface shapes | P10 advances schema `8 -> 9` with `009-final-business-parity-governance`, maps all fixed V2.3 inputs into 19 Clean business groups, keeps the released Catalog at `27/0/27`, excludes production cutover, and freezes P0-P10 decisions, migrations, and Evidence after a final non-provisional receipt; later work is ordinary feature or performance development and must continue `audit:parity` plus `pnpm verify` without creating another governance phase |

## Source and evidence references

- V2.3 version/schema/protocol: package metadata, state migration, and
  tests/v23/catalog.json at e18dc0b.
- Cumulative multi-actor, Exchange, MCP, repository, delivery, context,
  execution, and UI behavior: the V2.3 route registry, feature modules, and
  historical v18-v22 catalogs at e18dc0b.
- Current V3 status and Evidence: feature-catalog.json and docs/evidence/**.
- Clean entity and transaction rules: clean-schema.md.
- Import phases and mapping: import-contract.md.
- HTTP, MCP, and event rules: api-v2-contract.md.
- Top-level scope and forbidden patterns: v3-clean-break.md.

## Change procedure

1. Open a decision proposal with an immutable id, owner, and affected contract
   sections.
2. Update the capability matrix first, including API, command, event, table,
   state, UI, dependency, test, and Evidence columns.
3. Add schema diff, import mapping, API compatibility, permission, and rollback
   impact.
4. Run document consistency checks and the architecture gate in AGENTS.md.
5. Obtain architecture approval and append an accepted/rejected entry; never
   edit an old decision's rationale or receipt.

## Rejected patterns

The following proposals are automatically returned for revision because they
conflict with accepted decisions:

- keep the old session or API branch active;
- add a compatibility flag with a disabled default;
- write both old and clean operation tables;
- let a Gateway store project data or mount Docker;
- copy old secret material and mark it active;
- treat an old schema as a normal startup migration;
- select a source silently when semantic fields differ;
- raise a Catalog status before its evidence receipt exists.

## D-037 - Activate P8 Delivery, Deployment, Importer, and Operations (2026-08-25)

P8 uses verified commit `4ee1a436b2f810354602308d733fbee7423f3cf0` as its fixed P7 baseline and applies only forward migration `008-delivery-deployment-importer-operations` (`PRAGMA user_version = 8`). Delivery owns immutable policies, deliveries, PR intents, and one-to-one generic-event projections. Deployment owns candidates and immutable verification receipts. Importer owns batches, signed checkpoints, deterministic ID maps, and conflicts. Operations owns backup manifests while reusing the single operation/event/head/CAS model.

Importer writes are confined to the offline `apps/importer` package. Runtime exposes only sealed import queries through `/api/v2`. GitHub actions are Draft PR first and use two-phase intent/receipt processing; unknown merge results enter reconcile. A final verified non-provisional receipt may promote the Catalog to `26/1/27`; missing GitHub App or Docker identity freezes it at `23/4/27`.

The published P8 receipt `run-1787846480106` implements and verifies the
closed P8 contract/route inventory, Delivery state machine and raw webhook,
dual-source importer, Deployment/Backup/Restore/Reset, recoverable physical GC,
Operations Web slice, real isolated GitHub delivery, Docker deployment, and
actual v7 rollback. It is `status=verified` with `provisional=false`, so the
three P8 Catalog rows move to Clean and the layered Catalog is `26/1/27`.
The verified P8 boundary is committed and pushed; D-038 below activates P9
without reopening the P8 implementation or Evidence boundary.

## D-038 - Activate P9 Web, Offline, and Release (2026-08-28)

P9 uses pushed commit `423a7b4ca199ff2f11cbef1758802cdad22af8e0` as
its only P8 baseline. Runtime phase and schema version are separate: the active
phase is P9, but startup still loads exactly migrations `001` through `008`,
requires `PRAGMA user_version = 8`, and adds no migration or business table.
P1-P8 migrations and verified Evidence remain immutable.

Operations owns `events.project.replay` and `GET /api/v2/events`. JSON catch-up
and SSE use the same EventService, signed project-scoped cursor, Project ACL,
session principal, and redaction policy. Each event carries
`previous_project_sequence`; SSE reauthorizes on every event and heartbeat.
Cross-origin access uses an exact `AIWS_CLEAN_CORS_ORIGINS` allowlist and never
accepts wildcard, null, path-bearing, or userinfo-bearing origins.

The Web uses a hash router, scoped Query cache, explicit event invalidation,
and an IndexedDB v1 database containing only project cursors and a six-command
low-risk outbox. Protected business responses, credentials, downloads, and CAS
content are never persisted or cached. The Service Worker precaches only the
app shell and treats API, SSE, CAS, downloads, health, and readiness as
NetworkOnly.

Release verification builds a fixed image digest and SBOM, publishes only to
a fresh temporary volume on a dynamic loopback origin, exercises health,
backup/restore hashes, an isolated pointer switch, and an actual rollback to
the byte-exact P8 state. No production cutover is performed. Only a final
verified non-provisional P9 receipt can promote Contracts and the complete
Catalog to `27/0/27`; any incomplete identity, probe, viewport, offline, or
rollback receipt preserves the published P8 `26/1/27` state.

The published P9 receipt `run-1787933538303` is `verified` and
`provisional=false`. It verifies the complete routed Web, project-local
JSON/SSE continuity, the six-command FIFO outbox, app-shell-only PWA, real
external identities, fixed production image and SBOM, dynamic loopback publish,
three viewports, offline cache exclusion, and an isolated actual P8 rollback.
No production pointer or volume was touched. Contracts move into Clean and all
27 rows are `released`, yielding `27/0/27`.

## D-039 - Final business parity and governance closure (2026-08-29)

P10 uses pushed commit `bb55746b7e08cf7ee764d06a8fa23da91ad48e2f`
as its only P9 baseline. It applies forward-only migration
`009-final-business-parity-governance`, advances the active schema to
`PRAGMA user_version = 9` with ledger `[1..9]`, and keeps V3-Clean, `/api/v2`,
the shared authorization predicate, and the single operation/event/CAS/head
model. P1-P9 migrations and verified Evidence are immutable inputs.

Business parity means equivalent domain semantics and complete Web journeys.
It does not require historical URLs, route counts, collection names, or
internal implementation shapes. The immutable V2.3 input is commit
`e18dc0b616fa7ab2b00a6c05db23890ccd940175`, recorded with Git blob ids for
14 L0-L7 cases, 360 route declarations, 98 state collections, 11 primary Web
routes, and seven optimization packages. Every input maps exactly once to one
of 19 business groups as `equivalent`, `consolidated`, `retired_interface`, or
`fixture_only`; a final map contains no `gap` and never uses
`retired_business`.

The migration adds revisioned Brief templates, Workflow Quality policies,
explicit asset selections and advisory model advice, Assist review comments,
and Project/Repository deletion intents. Existing Provider, Brief, Assist, and
Quality rows gain only lifecycle, lineage, and immutable snapshot fields.
Project, Quality, Assist, Repository, and Setup retain domain ownership while
generic operations, events, aggregate heads, CAS, session proof, ACL, and
redaction remain shared platform owners.

Production cutover is not a business-parity requirement and remains excluded.
Release verification uses a dynamic loopback origin, fresh temporary volumes,
an isolated pointer switch, and an actual restore of the complete P9 schema v8
state. Only `status=verified`, `provisional=false`, complete parity mappings,
three viewport receipts, real external probes, and byte-exact rollback may
publish P10 Evidence at
`docs/evidence/v3-clean-p10-final-governance-20260829/`. Catalog membership and
status remain `27/0/27`; route or table counts never promote a capability.

After the final annotated tag `p10-final-governance-20260829`, decisions,
migrations, and Evidence for P0-P10 are frozen. Subsequent product work may add
features and optimize performance, but it continues the parity audit and full
verification gates without opening a new governance phase or reinterpreting
the fixed V2.3 input.

## D-040 - Post-P10 development reliability and dual-channel verification (2026-09-05)

Post-P10 maintenance keeps runtime phase 10, `PRAGMA user_version = 9`, ledger
`[1..9]`, `/api/v2`, and the released `27/0/27` Catalog unchanged. It adds no
governance phase, migration, route, table, production pointer, or production
volume. The P1-P10 Evidence trees remain immutable; maintenance evidence is
independent at
`docs/evidence/post-p10-development-reliability-20260905/` and has no status
promotion authority.

Historical R5 verification now separates source proof from current behavior.
The retained fixture field `source_commit=f26c6950a0bf266b0114f99fc9dc683430da21a3`
is the extraction-base identity. Eleven R5 files did not yet exist at that
commit, so the byte-complete source proof is the immutable descendant
`250bb44f5264fd7f262d2c8e6f5a174b3f58f266`, whose raw Git blobs exactly match
every recorded fixture SHA without rewriting the fixture or its checksum. The
proof uses `git rev-parse` and `git cat-file blob`; an unavailable or mismatched
blob fails as `r5_golden_source_unverifiable:<path>`. A current-tree mismatch is
reported only in `source_drift`, while checksum, privacy, and all six behavior
contracts remain blocking.

All active Gate orchestration uses the shared no-Shell process executor. Node
scripts run through `process.execPath`; Pnpm runs through the Corepack
JavaScript entry under the active Node installation, with a direct `corepack`
fallback. Git and other executables receive argument arrays. The executor owns
bounded capture, live redacted forwarding, workspace/secret redaction,
timestamps, duration, exit status, signal, timeout tree termination, and the
stable errors `gate_command_not_found`, `gate_command_timeout`, and
`gate_command_failed`.

`pnpm verify:dev` is the side-effect-free development channel. It unions
`base...HEAD`, staged, unstaged, and untracked paths; maps them backward through
the layered Catalog; always runs `check`, `scan:clean`, and `git diff --check`;
deduplicates selected commands; and blocks an unclassified path. It never
selects real GitHub, Provider, deletion, Docker publication, or release probes.
Clean failures exit 1. A Historical-only failure exits 0 with top-level
`status=advisory`, preserving D-032.

`pnpm verify` remains the pre-push formal Gate and emits
`aiws.v3-clean.verify-result.v3`. It restores all four recovery governance
commands, validates P5-P9 through their immutable Evidence instead of rerunning
retired probes, and runs only the current P10 Parser, GitHub deletion, and
release probes. A current P10 probe failure is blocking and has no prior-phase
fallback. Web tests run once; the nested `pnpm test` invocation receives the
controlled Unit-only marker, while standalone `pnpm test` still runs Unit plus
Web. Successful Gates are stdout-only; failure or advisory receipts append
under `.ai-workspace/gate-receipts/`.

The Git pre-push entry invokes `verify -- --pre-push`: it checks the exact
pending local HEAD before upload, while a standalone final `verify` continues
to require `upstream=HEAD`. This resolves the before-push/after-push dependency
without skipping any tests or external probes. Only the Evidence checker sees
the pending-head marker; child fixtures do not inherit it. P10 publication
status and Catalog promotion rules remain unchanged.

The formal Gate runs Web tests, Unit tests, layered integration, layered
security, and Web build as one isolated local-validation wave. Historical
security excludes the Clean boundary files. During the formal Gate only, the
expensive production-image boundary test is delegated to the mandatory P10
release probe, which performs the same Docker CLI/socket, runtime dependency,
and component-label checks on the twice-built image. Standalone
`test:security:clean` continues to execute its own image build.

`pnpm development:receipt -- --project-id <id>` is a read-only operations
report over a copied read-only snapshot of `<AIWS_CLEAN_HOME>/data/state.sqlite`.
It validates schema v9, ledger `[1..9]`, project existence, and single command
ownership; reports persisted execution, retry, replay, workflow, context,
human-intervention, failure, and measurable duration data; emits explicit
`null/not_persisted` values instead of estimates; excludes prompts, responses,
secrets, CAS content, and absolute paths; self-hashes canonically; and proves
SQLite, CAS, and Vault byte identity before and after generation.

The measured objectives for this maintenance branch are at most `120000 ms`
for its incremental Gate and at most `360000 ms` for the formal Gate on the
same workstation, compared with the recorded `549714 ms` baseline. Timing is a
maintenance acceptance threshold, not a Catalog status transition.

The remote Workspace maintenance slice keeps the same D-040 boundary. A
shared GitHub App transport serves Repository discovery, P8 Delivery, P10
deletion, and Workspace materialization. It validates the numeric repository
identity, full name, branch HEAD, recursive tree, and blob manifest, then uses
a shell-free shallow clone with a process-only authorization header. Temporary
materialization is hash-checked before atomic publication; refresh failures
leave the prior successful copy readable, and failed refresh operations retain
retry lineage. Actor-owned enabled profiles and active Vault credentials are
required. Coverage is `tests/p10/remote-workspace-auth.test.mjs` with
append-only maintenance receipt artifacts under
`docs/evidence/post-p10-development-reliability-20260905/remote-workspace-20260914/`.
No migration, Catalog status, or formal P10 Evidence byte changes.

## D-041: Real development-loop reliability

The post-P10 development loop keeps one Clean Operation/Event/CAS owner while
making Evidence completion compensating and provider-backed by default. Startup
replays all `execution.completed` events idempotently, advances the Evidence
cursor only through contiguous successful captures, and records redacted failed
receipts for pending work. Phase-10 non-deterministic runtime construction uses
the process workflow adapter and returns `provider_rebind_required` when no
credential lease exists; deterministic generator, critic, repository, and
runner adapters remain explicit fixture inputs. Workflow execution plans are
compiled from `config.execution` with command, path, dependency, capability,
and deadline validation before Runner submission. CAS GC protects all current
Context, Assist/File, Terminal, Execution, Evidence, Delivery, Deployment, and
Backup references and preserves plan fencing and rollback.
