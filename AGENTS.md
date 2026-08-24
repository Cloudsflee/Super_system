# Repository Agent Rules

These rules apply to every change in the workspace. The architecture documents
under docs/architecture/ are the source of truth for V3-Clean.

## Fixed priorities

1. Preserve the V3-Clean clean-break decisions and the complete V2.3
   capability matrix.
2. Preserve data integrity, permission boundaries, revision/CAS checks,
   redaction, and rollback receipts.
3. Preserve the user's existing worktree changes; inspect and compose with
   them.
4. Keep public contracts, schema ownership, tests, UI, adapters, and Evidence
   synchronized.
5. Optimize implementation speed only after the first four priorities hold.

## Scope of this phase

Decision `D-035` activates P6 Runner/Execution/Checkpoint/Replay over the
verified P5 baseline at `54381746da0f01fd60da2e11ed247f2ed2f11c8b`.
This phase may update the synchronized P6
surface:

- forward-only `006-runner-execution-checkpoint-replay`, schema ownership,
  Clean Runner and Execution services, dispatcher, registry, contracts, and
  focused P6 tests;
- the Clean Broker entrypoint, Docker/Host/Windows Bridge adapters, signed Job
  Spec/receipt protocol, restart reconciliation, and independent probes;
- the component-level Execution and Runner Profiles Web slice plus default
  Clean E2E, using `/api/v2` only;
- architecture documents, testing policy, layered Catalogs, package gates,
  immutable P6 Evidence, and rollback receipts required by GS-001 through
  GS-007;
- this file.

Decision `D-032` governs layered-gate receipt hygiene: a fully successful
wrapper is stdout-only, while a Clean failure or Historical advisory failure
is appended to the ignored local `.ai-workspace/gate-receipts/` store. Local
receipts are diagnostic evidence only; Catalog status promotion continues to
use the immutable final `verification.json` receipt.

P1/P2/P3/P4/P5 migrations and verified Evidence are read-only. Parser,
complete Outcome evaluation, real GitHub Delivery, offline/cross-origin
behavior, production cutover, and release-level Web/E2E remain outside P6.

## Required preflight

Before editing, print a compact record in the task update and keep it in the
change receipt:

~~~text
Target:
目标:
Non-target:
非目标:
Forbidden:
禁止项:
Reuse:
复用项:
Delete/retire:
删除/退役:
Acceptance commands:
验收命令:
Rollback artifact:
回滚工件:
~~~

The record must name the active object, the last confirmed result, and the next
action. Re-read related files and check git status before making edits.

## V3-Clean invariants

- V3-Clean is the only runtime.
- The public business API is /api/v2.
- The runtime loads only the v3-clean schema family and clean baseline.
- Historical V1-V6 migrations, V2.3 code, old databases, and old CAS roots are
  importer fixtures, never startup imports.
- There is one owner for every table, command, event, and permission decision.
- There is one generic operations ledger, event stream, cursor model, and CAS
  model. Assist has no separate operation ledger.
- Aggregate state, revision/CAS check, attempt, operation link, head, and event
  update in one transaction.
- Imported credentials remain metadata with rebind_required until a new proof.
- Project ACL, Team/Actor membership, Exchange grant, MCP allowlist, importer,
  replay, and Evidence queries use the same authorization predicate.
- Docker/Host runner, Windows Bridge, MCP Gateway, and all registered parser
  families are first-class capabilities.
- Audio/video, PPTX, and generic archive parsing are included in the target
  scope.

## Forbidden runtime patterns

Architecture gates reject:

- /api/v1 route registration or a legacy facade;
- old runtime imports, state compatibility branches, native-version flags, or
  session forks;
- legacy_compat, native_v5, native_v6, ASSIST_NATIVE_V6, or equivalent
  runtime switches;
- assist_operations or a second operation/event/CAS model;
- per-domain shadow heads that can diverge from aggregate_heads;
- dual writes, shared old/new write volumes, or online importer writes;
- Gateway business persistence or Docker socket access;
- secrets, tokens, cookies, full prompts, or host absolute paths in public or
  Evidence envelopes;
- hand-edited Catalog status without matching behavior, UI, integration, and
  Evidence receipts;
- claiming a command ran without its literal output and exit status.

## Ownership and editing

Use the existing module, repository, registry, and adapter patterns. Add a new
abstraction only when it removes a real ownership or transaction ambiguity.
Keep unrelated worktree changes intact. Use apply_patch for manual file edits.
Use structured parsers for JSON, SQLite, manifests, and route inventories.
Prefer ASCII in new files unless a source contract requires another charset.

## Acceptance gates

Every implementation phase must run the relevant subset of:

~~~text
pnpm check
pnpm test
pnpm test:integration
pnpm test:security
pnpm test:e2e
pnpm test:release
pnpm verify
~~~

The architecture/documentation phase additionally checks:

~~~text
rg -n "V3-Clean|v3-clean|/api/v2|V23-L[0-7]|REC-D" docs/architecture AGENTS.md
git diff --check
git status --short --branch
~~~

Later phases add clean-baseline migration tests, importer inspect/dry-run/run/
resume/verify/cutover tests, route/MCP parity tests, redaction scans, and
actual rollback verification. A failing gate leaves the related Catalog entry
at its current status.

## Gate synchronization contract

The following stable rules are one cross-phase contract. They apply whenever a
phase changes a test plan or any gate surface; updating a test plan alone is not
a complete change.

| ID | Requirement |
| --- | --- |
| GS-001 | A change to tests, gate commands, routes, schemas, ownership, phase scope, status rules, or receipt shapes MUST trigger gate-sync review. |
| GS-002 | The phase plan, testing policy, package/CI commands, gate implementation, tests, Catalog/matrix, and Evidence references MUST update atomically. |
| GS-003 | Every governed inventory MUST be bidirectional and MUST reject missing, stale, duplicate, and orphan entries. |
| GS-004 | Every Git-visible non-build path MUST be classified; every new governance file MUST declare an owner and phase and be registered in the Catalog. |
| GS-005 | Only final verified, non-provisional receipts MAY promote status; failed and checkpoint receipts remain immutable. |
| GS-006 | Rollback verification MUST include a runnable dry-run and an isolated actual apply with byte-exact comparison. |
| GS-007 | Any gate failure MUST freeze the affected Catalog status and block dependent phases. |

The synchronized P1 governance command inventory is:

~~~text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm test:p1
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm verify
~~~

The additive P3 implementation inventory is:

~~~text
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
~~~

The additive P3.1 implementation inventory is:

~~~text
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
~~~

The additive P4 implementation inventory is:

~~~text
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
~~~

The additive P5 implementation inventory is:

~~~text
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
~~~

The additive P6 implementation inventory is:

~~~text
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
~~~

P3.1 uses `feature-catalog.index.json` with disjoint Clean and historical
layers (`feature-catalog.clean.json` and `feature-catalog.historical.json`).
`scripts/catalog-loader.mjs` is the validation owner; the root
`feature-catalog.json` remains a compatibility aggregate for P1 governance
tests and carries the same index references. `scripts/e2e.mjs` is the active
Clean journey, while `scripts/e2e-legacy.mjs` and `fixture:legacy:*` commands
are explicit historical fixtures.
The immutable R5 source-hash replay is owned by
`fixture:legacy:integration`; `pnpm test` skips only that named Historical
assertion and retains all other unit and Clean Web tests.

Layered gate success emits the structured
`aiws.v3-clean.layered-gate-result.v2` summary without touching Git-visible
Evidence. Failed Clean and Historical runs append complete redacted command
outputs under `.ai-workspace/gate-receipts/` with exclusive file creation;
these local receipts never promote a Catalog row.

P4 advances the active schema to `user_version=4`; HTTP, MCP HTTP, stdio, and
Gateway share `CleanCommandDispatcher`. The four P4 ids are Clean-only after a
final verified receipt, yielding 13 Clean and 14 Historical rows while the
total remains 27. Formal Evidence is
`docs/evidence/v3-clean-p4-context-mcp-20260820/`; local failed attempts remain
append-only and never promote status.
An explicit corrective P4 Evidence supersession preserves the prior verified
top-level files under `attempts/superseded-final-<run-id>-*` and records
`supersedes_run_id`; an ordinary rerun still rejects a verified final.

P5 advances the active schema to `user_version=5`. Assist, Files, Terminal,
and Bridge retain the shared operation/event/head/CAS model, while the Windows
Bridge remains an independent loopback process without business persistence.
The final Assist probe must lease a provider credential into a zeroable Buffer
inside an isolated `CODEX_HOME` and complete a real fixed-response turn with
contiguous events, an assistant item, terminal tool results, and
`turn/completed`. Missing credentials or incomplete output produce only a
provisional candidate attempt and freeze Catalog promotion.
The six P5 ids are Clean-only after a final verified, non-provisional receipt,
yielding 19 Clean and 8 Historical rows while the total remains 27. Formal
Evidence is `docs/evidence/v3-clean-p5-assist-terminal-20260820/`; failed
attempts remain append-only and never promote status.

P6 advances the active schema to `user_version=6`. Runner owns profiles, Job
Specs, and terminal receipts; Execution owns executions, pinned inputs, task
attempts, stage checkpoints, and the one-to-one generic-event projection.
Docker, Host, and Windows Bridge use the same signed `runner.job-spec.v2` and
`runner.receipt.v2` contracts. The seven stages are `prepare`, `context`,
`run`, `check`, `review`, `finalize`, and `deliver`; the last stage produces a
delivery-ready handoff manifest and does not perform GitHub Delivery.
The two P6 ids are Clean-only after a final verified, non-provisional receipt,
yielding 21 Clean and 6 Historical rows while the total remains 27. Frontend
and Outcome remain `scaffolded`. Formal Evidence is
`docs/evidence/v3-clean-p6-runner-execution-20260824/`; failed attempts remain
append-only and never promote status. Rollback restores v5 SQLite, CAS, Vault,
workspace, Broker, and Bridge snapshots in isolation with byte-exact checks.

## Capability status

Use the fixed progression planned -> scaffolded -> implemented -> verified ->
released. Status is derived from receipts:

- scaffolded: schema/contract/interface exists;
- implemented: domain behavior plus applicable behavior/UI tests and Evidence;
- verified: integration or independent external probe receipt;
- released: temporary-volume publish and actual rollback receipt.

The V2.3 L0-L7 catalog is an acceptance input, not a status shortcut. Every
catalog id and every current feature-catalog entry must have a bidirectional
matrix row and a concrete test/Evidence link.

## Rollback and reporting

For workspace-backed modifications, preserve a hash of the original, work on a
copy, and report four verifiable artifacts: modified artifact, patch/diff,
verification record with baseline and modified commands/outputs/statuses, and a
runnable rollback receipt. Reopen and execute each artifact before completion.

Final updates state the changed files, checks run, literal failures (if any),
and remaining worktree changes. Do not claim a release when only a scaffold or
document exists.
