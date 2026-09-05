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

Decision `D-039` activates P10 final business parity over the pushed P9 final
boundary at `bb55746b7e08cf7ee764d06a8fa23da91ad48e2f`. The active runtime
phase is P10 and forward-only migration `009-final-business-parity-governance`
advances the schema to `user_version=9` with ledger `[1..9]`. This phase may
update the synchronized P10 surface:

- business-semantic parity for the fixed V2.3 inventory across 19 groups,
  without restoring historical routes or runtime shapes;
- Provider, Brief template, Project/Repository deletion, Assist lifecycle and
  review, Quality readiness/advice/history, and 21-format Parser behavior;
- parameterized `/api/v2` Web journeys, bounded offline behavior, live external
  probes, reproducible temporary-volume release, and isolated actual P9
  rollback;
- architecture documents, testing policy, layered Catalogs, package gates,
  E2E, and immutable P10 Evidence required by GS-001 through GS-007;
- this file.

Decision `D-032` governs layered-gate receipt hygiene: a fully successful
wrapper is stdout-only, while a Clean failure or Historical advisory failure
is appended to the ignored local `.ai-workspace/gate-receipts/` store. Local
receipts are diagnostic evidence only; Catalog status promotion continues to
use the immutable final `verification.json` receipt.

P1/P2/P3/P4/P5/P6/P7/P8/P9 migrations and verified Evidence are read-only;
the P7 freeze remains governed by decision `D-036`.
Production cutover and production-volume mutation remain outside P10. P10
extends Parser, Quality, and Outcome only through D-039 behavior and migration
009; it does not rewrite any P7 or P9 Evidence or rollback receipt.

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

The additive P7 implementation inventory is:

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

P7 advances the active schema to `user_version=7`. Parser owns format
registrations and immutable run attempts; Evidence owns the asset/version/blob/
relation/attestation, trace, digest, code-change, and test-result chain; Quality
owns immutable reports, one-to-one event projections, and human decisions;
Outcome owns immutable evaluation generations and waiver/revoke records.
Docker parsing uses signed `parser.job.v1`, `parser.receipt.v1`, and
`evidence.asset.v2` envelopes with the fixed Node 24 worker digest and bounded
format quotas. The two P7 ids are Clean-only after a final verified,
non-provisional receipt. Evidence, Quality, Outcome, and Attachments are then
`verified`, yielding 23 Clean and 4 Historical rows while the total remains 27;
Frontend remains `scaffolded`. Formal Evidence is
`docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/`; failed attempts
remain append-only and never promote status. Rollback restores v6 SQLite, CAS,
Vault, workspace, Broker, Bridge, and parser snapshots in isolation, proves all
17 P7 tables absent, and performs byte-exact checks.

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

## P8 activation

Decision `D-037` activates P8 over baseline
`4ee1a436b2f810354602308d733fbee7423f3cf0`. The forward-only
`008-delivery-deployment-importer-operations` migration advances the active
runtime to `user_version=8`. Delivery, Deployment, offline Importer, Backup,
Restore, Operations replay, and physical CAS GC reuse the P1-P7 operation,
event, head, authorization, Evidence, Vault, and CAS owners. Import mutation is
CLI-only; runtime `/api/v2/imports` routes are sealed-batch queries. A missing
real GitHub App or Docker identity leaves P8 Evidence provisional and freezes
the Catalog at `23/4/27`; only final non-provisional verification promotes it
to `26/1/27`.

The additive P8 implementation inventory is:

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
node scripts/v3-clean-p9-github-delivery-probe.mjs
node scripts/v3-clean-p9-release-probe.mjs
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
~~~

The current published P8 receipt is `run-1787846480106` with
`status=verified` and `provisional=false`. It includes the real GitHub App
fixture delivery and Docker deployment receipts, plus an isolated actual v7
rollback, so the Catalog is promoted to `26/1/27`. The P8 boundary is now
committed and pushed; P9 may branch from this commit once D-038 is recorded.

## P9 activation

Decision `D-038` activates P9 over baseline
`423a7b4ca199ff2f11cbef1758802cdad22af8e0`. P9 does not add a migration:
the active runtime phase is 9 while the only supported active schema remains
`user_version=8` and migration ledger `[1..8]`. Development Web origin is
`http://127.0.0.1:5174`; release verification injects an exact dynamic
loopback origin. Production volumes and production pointers are never used.

The additive P9 implementation inventory is:

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
pnpm test:p7
pnpm test:p8
pnpm test:p9
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
pnpm evidence:p9 -- --verify
git diff --check
~~~

P9 formal Evidence is
`docs/evidence/v3-clean-p9-web-release-20260826/`. Only a final receipt with
`status=verified` and `provisional=false`, complete release-row mappings, three
viewport receipts, external probes, and an isolated actual P8 rollback may
promote the Catalog to `27/0/27`. Any missing input freezes the published P8
Catalog at `26/1/27`.

The published P9 receipt is `run-1787933538303` with `status=verified` and
`provisional=false`. It records the real GitHub App, Codex, Gateway, Docker/
Host/Bridge Runner, Parser, fixed-image/SBOM, dynamic-origin browser, offline,
and isolated actual rollback gates. Rollback restores schema v8, ledger
`[1..8]`, all eight component roles, and `byte_exact_mismatches=[]`. Contracts
and Frontend are Clean/released; the final Catalog is `27/0/27`.

## P10 activation and final closure

Decision `D-039` activates P10 over the pushed P9 boundary
`bb55746b7e08cf7ee764d06a8fa23da91ad48e2f`. P10 is the final governance
phase. The active runtime is phase 10 and the active schema is v9 with ledger
`[1..9]`, supplied by forward-only migration
`009-final-business-parity-governance`; later work is ordinary feature and
performance development and does not create another governance phase.

P10 uses business-semantic and Web-journey parity. It does not preserve
historical URL, route-count, table-name, collection-name, or implementation
shape. The read-only V2.3 source is commit
`e18dc0b616fa7ab2b00a6c05db23890ccd940175`, pinned by Git blob hash for 14
L0-L7 cases, 360 route declarations, 98 collections, 11 Web routes, and seven
optimization packages. The parity audit maps every source entry exactly once
to one of 19 fixed business groups with disposition `equivalent`,
`consolidated`, `retired_interface`, or `fixture_only`; final `gap` and
`retired_business` entries are rejected.

P10 adds only its owned Brief template, Quality policy/selection/advice,
Assist review, and Project/Repository deletion-intent records. Existing
Operation, Event, aggregate head, CAS, cursor, ACL, session-proof, Vault, and
redaction owners remain singular. Provider lifecycle uses enabled/disabled
profiles and real adapters by default; fake adapters require explicit test
configuration. Remote deletion requires exact full name, HEAD and revision
snapshots plus two independent session proofs; unknown external results enter
reconcile. Quality retains the five dimensions coverage, accuracy, depth,
consistency, and clarity, keeps advice separate from human scores, and marks
changed inputs stale while retaining immutable history.
Parser registrations use the additive `node24-p10` image at
`sha256:3c2c0f8f550f4c8a14c33661f1e4e85227aa02e3bd0844a8e1044ed368d202a0`;
the P10 probe must rebuild it twice and parse all 21 valid formats in the fixed
container while also passing the Windows archive-wrapper regression.

The additive P10 command inventory is:

~~~text
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
node scripts/v3-clean-p10-parser-probe.mjs
node scripts/v3-clean-p10-github-deletion-probe.mjs
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration:clean
pnpm test:security:clean
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
node scripts/v3-clean-p10-release-probe.mjs
pnpm test:release
pnpm verify
pnpm evidence:p10 -- --verify
git diff --check
~~~

Formal P10 Evidence is append-only at
`docs/evidence/v3-clean-p10-final-governance-20260829/`. Only a final
`verified`, `provisional=false` receipt with complete parity mappings, three
viewport receipts, non-provisional adapter probes, and an isolated actual P9
rollback may close the phase. Rollback restores schema v8, ledger `[1..8]`,
SQLite, CAS, Vault, workspace, Broker, Bridge, Parser, Web, and governance
Catalog snapshots with `byte_exact_mismatches=[]`. Production pointers and
production volumes remain outside P10.

## Post-P10 development reliability maintenance

Decision `D-040` governs maintenance over baseline
`5f2be38845d36236637c7f22a1b4df5611a6175b`. This is not a new governance
phase. Runtime phase 10, `user_version=9`, ledger `[1..9]`, `/api/v2`, and the
released Catalog `27/0/27` remain fixed. All P1-P10 Evidence remains read-only;
maintenance receipts live independently at
`docs/evidence/post-p10-development-reliability-20260905/`.

The active development loop is `pnpm verify:dev`; `pnpm verify` remains the
pre-push formal Gate. Both use `scripts/lib/gate-process.mjs` and must keep
Node/Corepack/Pnpm/Git arguments out of `shell:true`. Development verification
must reject unclassified paths, deduplicate commands, preserve Clean blocking
and Historical advisory semantics, and never select live Provider, GitHub,
deletion, publication, or release probes. Formal verification validates P5-P9
through immutable Evidence and runs only current P10 Parser, GitHub deletion,
and release probes, with no fallback.

Formal Web, Unit, integration, security, and build commands may run as one
bounded parallel wave because they use isolated state. Historical security must
not repeat Clean boundary files. With `AIWS_SECURITY_DEFER_DOCKER=1`, only the
formal Gate delegates the production-image subtest to the mandatory P10 release
probe; standalone Clean security still builds and inspects the image directly.

Historical R5 uses immutable raw blob proof and current behavior replay. The
fixture and its checksum are never refreshed for current drift. An unavailable
or mismatched proof fails as `r5_golden_source_unverifiable:<path>`; current
source differences are reported as `source_drift` and do not bypass checksum,
privacy, or behavior checks.

`pnpm development:receipt -- --project-id <id>` reads a copied snapshot of the
v9 SQLite database in read-only mode. It must prove all operation commands have
one Clean owner, return only persisted metrics, use `null/not_persisted` rather
than estimates, redact prompts/responses/secrets/CAS content/absolute paths,
self-hash canonically, and compare SQLite/CAS/Vault bytes before and after.

The maintenance acceptance inventory is:

~~~text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm audit:parity
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm test:p1
pnpm test:p31
pnpm test:p4
pnpm test:p6
pnpm test:p8
pnpm test:p10
pnpm fixture:legacy:integration
pnpm fixture:legacy:security
pnpm test:integration:clean
pnpm test:security:clean
pnpm verify:dev -- --base 5f2be38845d36236637c7f22a1b4df5611a6175b
pnpm development:receipt -- --project-id <ROUND2_PROJECT_ID> --home <ROUND2_HOME>
pnpm --filter @aiws/web test
pnpm test
pnpm build
pnpm test:e2e
pnpm test:release
pnpm verify
git diff --check
git status --short --branch
~~~

The branch performance thresholds are `verify:dev <= 120000 ms` and formal
`verify <= 360000 ms` on the workstation whose recorded baseline is
`549714 ms`. A failure freezes status and is recorded literally; it is never
converted into a release claim.
