# V3-Clean Decision Log

Status: accepted for the architecture phase.
Decision owners: product architecture and platform engineering.
Last reviewed: 2026-08-24.

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
