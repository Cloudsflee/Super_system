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

Decision `D-030` activates the P3 Project/Workflow implementation phase over
the verified P1/P2 baseline. This phase may update the synchronized P3 surface:

- `003-project-workflow`, its clean runtime services, registry, contracts, and
  focused tests;
- the component-level Project/Workflow Web slice, using `/api/v2` only;
- the architecture documents, testing policy, Catalog/matrix, package gates,
  and P3 Evidence required by GS-001 through GS-007;
- this file.

P1/P2 migrations and verified Evidence are read-only. P4 and later runtime,
real provider calls, complete Outcome evaluation, and release-level Web/E2E
remain outside P3.

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
