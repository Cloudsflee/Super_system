# V2.3 to V3-Clean Capability Matrix

Status: characterization baseline and V3-Clean acceptance contract.
Source commit: e18dc0b (V2.3.0, state schema 23).
Target runtime: V3-Clean, API v2, schema family v3-clean.

This matrix is derived from the V2.3 route registry, state collection list,
tests/v23/catalog.json, Web router/features, and the Clean/Historical Catalog
layers (`feature-catalog.index.json`, `feature-catalog.clean.json`, and
`feature-catalog.historical.json`). The compatibility aggregate
`feature-catalog.json` remains available to P1 governance tests.
It is deliberately wider than the current implementation Catalog: every
capability is described as an API, command, event, table, state machine, UI,
external dependency, test, and Evidence obligation.

## 1. Coverage summary

| Source | Coverage recorded here |
| --- | --- |
| Clean Catalog layer | 23 active rows, including P7 Evidence and Quality; `runtime_surface=v3-clean` |
| Historical Catalog layer | 4 explicit fixture rows; `runtime_surface=historical-fixture` |
| Compatibility feature-catalog.json | 27 aggregate rows, REC-D0 through REC-D11 |
| V2.3 tests/v23/catalog.json | 14 cases across every layer L0-L7 |
| V2.3 optimization packages | OPT21-01, OPT21-02, OPT21-03, OPT21-04, OPT21-05, OPT22-01, OPT23-01 |
| Historical state inventory | 98 source collections at e18dc0b, mapped to clean tables |
| Historical route registry | all route modules in apps/api/src/api-routes.mjs and routes/*.mjs |
| Historical Web surfaces | setup, projects/onboarding, workflow/workstream/node, context, assets, audit, settings, and Assist overlays |
| Current Evidence | docs/evidence/** paths named in each current Catalog row |

The V2.3 rows are acceptance inputs. They do not imply that a V3-Clean row is
implemented. Current status is copied from the Catalog; a later status change
requires the evidence-derived progression in AGENTS.md.

### 1.1 Current Catalog index

| ID | Domain | Capability | Catalog status | Matrix row |
| --- | --- | --- | --- | --- |
| REC-D0-GOVERNANCE-000 | governance | recovery truth, ownership, architecture gates | verified | C-01 |
| REC-D1-CONTRACTS-023 | contracts | forward-only migrations and public contracts | verified | C-02 |
| REC-D10-FRONTEND-024 | frontend | complete operational Web workflows | scaffolded | C-03 |
| REC-D2-IDENTITY-001 | identity | local owner account and sessions | verified | C-04 |
| REC-D2-SETUP-002 | setup | Vault, credentials, profiles, fake provider probes | implemented | C-05 |
| REC-D3-RUNNER-003 | runner | Docker/Host/Windows Bridge runners and signed Job Spec | verified | C-06 |
| REC-D4-MCP-004 | mcp | MCP clients, tools, operation lifecycle | verified | C-07 |
| REC-D5-PROJECT-005 | project | draft intake and confirmed brief | verified | C-08 |
| REC-D5-WORKFLOW-006 | workflow | Workstream/Task canvas and contracts | verified | C-09 |
| REC-D6-GENERATION-007 | workflow | asynchronous generator and critic | verified | C-10 |
| REC-D6-EXECUTION-008 | execution | persistent DAG and seven replayable stages | verified | C-11 |
| REC-D6-OUTCOME-009 | outcome | Evidence outcome and revocable waiver | verified | C-12 |
| REC-D8-ASSIST-010 | assist | four-scope runtime and event replay | verified | C-13 |
| REC-D8-ATTACHMENTS-011 | assist | attachments and secure previews | verified | C-14 |
| REC-D8-FILES-012 | assist | files, tests, reversible change batches | verified | C-15 |
| REC-D8-APPROVAL-013 | assist | approval, user input, semantic proposals | verified | C-16 |
| REC-D8-TERMINAL-025 | terminal | native terminal and cursor recovery | verified | C-17 |
| REC-D8-BRIDGE-026 | bridge | Windows Bridge pairing and Git bundle | verified | C-18 |
| REC-D7-REPOSITORY-014 | repository | connections, targets, lines, worktrees | verified | C-19 |
| REC-D7-DELIVERY-015 | delivery | GitHub Draft PR and merge recovery | scaffolded | C-20 |
| REC-D4-SCOPE-016 | mcp | scope requests, grants, allowlists, revoke | verified | C-21 |
| REC-D9-CONTEXT-017 | context | tree, versions, selection, Context Pack v5 | verified | C-22 |
| REC-D9-PROJECTION-018 | context | recoverable projection and index rebuild | verified | C-23 |
| REC-D9-EVIDENCE-019 | evidence | CAS assets, trace, digest, attestation | verified | C-24 |
| REC-D9-QUALITY-020 | quality | isolated parsers and human threshold | verified | C-25 |
| REC-D9-DEPLOYMENT-021 | evidence | deployment/browser/viewport Evidence | scaffolded | C-26 |
| REC-D11-OPS-022 | operations | deployment API, backup, restore, reset, import | scaffolded | C-27 |

## 2. Matrix field definitions

Every row below has the same required fields:

- API v2: public path family and representative read/mutation addresses;
- Command: registry command ids that own mutations;
- Event/state: event names and the state machine or CAS rule;
- Tables: canonical clean tables, followed by important historical source names
  when they differ;
- UI: Web surface or explicit absence;
- External: runner, provider, parser, browser, bridge, or Docker dependency;
- Tests/Evidence: behavior/UI/integration commands and the receipt path;
- Status: current Catalog status and the V3-Clean gate condition.

API paths are written with the /api/v2 prefix even when the historical source
route omitted it.

## 3. Governance, identity, setup, and runner

| ID / capability | API v2 | Command | Event / state | Clean tables (historical source) | UI | External | Tests / Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-01 REC-D0 Governance | /api/v2/system/catalog, /api/v2/system/architecture | governance.plan, governance.catalog, governance.coverage, governance.impact | governance.receipt; inspect -> classified -> passed/failed | schema_meta, schema_migrations, audit_events (scripts/v23-* and feature layers) | Operations/Governance | Git, CI, receipt store | P1 gate sync and recovery governance; `tests/p31/catalog-split.test.mjs`, `tests/p31/layered-gates.test.mjs`; docs/evidence/v3-clean-p1-gate-contract-complete-20260819/verification.json, docs/evidence/v3-clean-p3-1-debt-burn-down-20260820/verification.json, and docs/evidence/v3-clean-p3-1-gate-receipt-hygiene-20260820/verification.json | verified; GS-001 through GS-007 and Clean/Historical bidirectional Catalog checks are required |
| C-02 REC-D1 Contracts | /api/v2/system/schema, /api/v2/operations/{id} | schema.inspect, migration.apply, migration.verify | migration.applied; pending -> applied -> verified/rolled_back | schema_meta, schema_migrations, aggregate_heads (source schema 23 and migration modules) | none | SQLite WAL, CAS | tests/unit/database.test.mjs, migrations.test.mjs, contracts.test.mjs, recovery-golden.test.mjs; same governance Evidence | verified; clean baseline replaces historical chain |
| C-03 REC-D10 Frontend | /api/v2/setup, /api/v2/account, /api/v2/actors, /api/v2/teams, /api/v2/projects, /api/v2/projects/{id}/permissions, /api/v2/credentials, /api/v2/profiles | web.setup.load/complete, web.identity.load, web.team.load, web.acl.set, web.credential.probe | ui.setup.loaded, ui.identity.loaded, ui.permission.updated; loading -> ready/empty/denied/conflict/rebind_required | none (clean-v2 read model) | Clean Setup, Identity, Projects, Workflow | Browser, HttpOnly session cookie, API v2 | apps/web/src/test/identity-access.test.tsx, apps/web/src/test/project-workflow-clean.test.tsx, apps/web/src/test/setup-flow.test.tsx, apps/web/src/test/workflow.test.tsx, tests/p31/clean-entrypoint-web.test.mjs; docs/evidence/v3-clean-p3-1-debt-burn-down-20260820/verification.json | scaffolded; complete project/workflow/offline/mobile/SSE/release promotion remains deferred |
| C-04 REC-D2 Identity | /api/v2/account, /api/v2/actors, /api/v2/sessions, /api/v2/teams, /api/v2/projects/{id}/members, /api/v2/projects/{id}/invitations, /api/v2/projects/{id}/permissions | actor.update/switch, session.create/revoke, team.create, membership.grant/status, invitation.create/accept/revoke, acl.set | actor.*, session.*, team.*, membership.*, invitation.*, acl.*; active <-> suspended -> revoked/expired/archived | actors, teams, team_memberships, sessions, project_memberships, project_invitations, project_acl_entries | Identity, Teams, Members, Permissions | HttpOnly session cookie, service credential delegation, ProjectScopeResolver | tests/p2/identity-acl.test.mjs, identity-acl-security.test.mjs, apps/web/src/test/identity-access.test.tsx; docs/evidence/v3-clean-p2-identity-acl-20260819/verification.json | verified; P2 clean ACL/session/team isolation, registry parity, and rollback receipt passed |
| C-05 REC-D2 Setup/Credential | /api/v2/setup, /api/v2/credentials, /api/v2/credentials/{id}/rebind, /api/v2/credentials/{id}/rotate, /api/v2/profiles, /api/v2/profiles/{id}/probe | setup.complete, credential.create/rebind/rotate/revoke, profile.create/probe | setup.completed, credential.*, profile.*; rebind_required -> pending -> active/failed -> revoked; unprobed -> probing -> available/unavailable | credential_refs, provider_profiles, operations, operation_links | Setup, Credentials, Profiles | AES-256-GCM Vault and deterministic Codex/GitHub/MCP fake adapters | tests/p2/identity-acl.test.mjs, identity-acl-security.test.mjs, apps/web/src/test/identity-access.test.tsx; docs/evidence/v3-clean-p2-identity-acl-20260819/verification.json | implemented; real external provider receipts remain deferred |
| C-06 REC-D3 Runner | /api/v2/runners/profiles, /api/v2/runners/profiles/{id}, /probe, /disable; /api/v2/executions/{id}/start | runner.profile.list/create/get/update/probe/disable; execution.start | runner_profile.*, runner_job.*, runner_receipt.*; unprobed -> probing -> ready/unavailable/disabled; job accepted -> leased -> running -> terminal | runner_profiles, job_specs, runner_receipts (historical executions/task_attempts remain fixture input) | Connections / Runner Profiles, Execution | Clean Docker Broker, Host process, Windows Bridge, Ed25519 Job Spec/receipt, HMAC transport, fixed digest and resource profiles | `tests/p6/runner-execution.test.mjs`, `tests/p6/runner-transports.test.mjs`, `tests/p6/http-security.test.mjs`, Docker/Host/Bridge/restart probes; `docs/evidence/v3-clean-p6-runner-execution-20260824/verification.json` | verified; all three real adapters, isolation, zeroization, terminal receipt and restart reconciliation passed non-provisionally |
| C-07 REC-D4 MCP | /api/v2/mcp, /api/v2/mcp/tools, /api/v2/mcp/clients, /api/v2/mcp/clients/{id}/revoke, /api/v2/operations/{id} | mcp.rpc, mcp.tools.list, mcp.client.create/list/revoke | mcp.tool.called, mcp_client.created/revoked; request -> authorized -> operation -> terminal | mcp_clients, operations, operation_links, events | MCP Settings | MCP SDK Streamable HTTP and stdio `2025-06-18`, one-time client token | `tests/p4/mcp-exchange-gateway.test.mjs`, `tests/p4/transport-parity.test.mjs`, `scripts/v3-clean-p4-gateway-probe.mjs`, `scripts/e2e.mjs`; `docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json` | verified; HTTP, stdio, REST, and independent Gateway use one schema validator and dispatcher |

## 4. Project, workflow, execution, and outcome

| ID / capability | API v2 | Command | Event / state | Clean tables (historical source) | UI | External | Tests / Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-08 REC-D5 Project/Brief | /api/v2/projects, /api/v2/projects/{id}, /intake, /intake/retry, /intake/cancel, /briefs, /briefs/{revision}/confirm, /preview | project.create/update/archive/restore, intake.submit/retry/cancel, brief.create/confirm | project.created, intake.*, brief.*; draft -> confirming -> active <-> archived; intake processing -> ready/failed/cancelled | projects, project_intakes, briefs, brief_revisions, aggregate_heads | Projects, Intake, Brief, `ProjectWorkflowPage` | deterministic repository fixture and source revision/hash probe | `tests/p3/active-entrypoint.test.mjs`, `tests/p3/http-contract.test.mjs`, `tests/p3/project-workflow.test.mjs`, `tests/p3/migration.test.mjs`, `apps/web/src/test/project-workflow-clean.test.tsx`; `docs/evidence/v3-clean-p3-project-workflow-20260819/verification.json` | verified; P3 entrypoint, migration/CAS/restart, ACL, and rollback receipts passed |
| C-09 REC-D5 Workflow | /api/v2/projects/{id}/workflows, /workflow-draft, /api/v2/workflow-proposals/{id}/apply | workflow.revise, workflow.get, workflow.proposal.get/apply | workflow.*, draft -> proposed -> active -> superseded/archived; proposal pending -> applied/rejected/stale | workflows, workflow_revisions, workflow_nodes, node_contracts, workflow_generation_proposals, aggregate_heads | Workflow Canvas, Task Contract, `ProjectWorkflowPage` | deterministic graph/hash and repository source snapshot | `tests/p3/project-workflow.test.mjs`, `tests/p3/migration.test.mjs`, `apps/web/src/test/project-workflow-clean.test.tsx`; `docs/evidence/v3-clean-p3-project-workflow-20260819/verification.json` | verified; clean graph/head atomicity and stale apply receipt passed |
| C-10 REC-D6 Generation/Critic | /api/v2/projects/{id}/workflow-generations, /api/v2/workflow-generations/{id}, /retry, /cancel, /critic, /api/v2/workflow-proposals/{id}/apply | generation.start/retry/cancel, critic.evaluate, workflow.proposal.apply | generation queued -> running -> critic_pending -> proposed -> applied/rejected with failed/cancelled branches; retry lineage retained | workflow_generations, workflow_generation_proposals, workflow_critic_receipts, operations | Workflow Replan, `ProjectWorkflowPage` | deterministic fake generator/critic; real provider state deferred | `tests/p3/project-workflow.test.mjs`, `tests/p3/migration.test.mjs`, `apps/web/src/test/project-workflow-clean.test.tsx`; `docs/evidence/v3-clean-p3-project-workflow-20260819/verification.json` | verified; fake adapter/restart receipt passed, real provider remains deferred |
| C-11 REC-D6 Execution | /api/v2/projects/{project_id}/executions, /api/v2/executions/{id}, /events, /attempts, /checkpoints, /start, /pause, /resume, /cancel, /replan, /stages/{stage}/replay | execution.list/create/get/events/attempts/checkpoints/start/pause/resume/cancel/replan/stage.replay | execution.*, execution_stage.*, task_attempt.*; draft -> queued -> running -> pause_requested/awaiting_approval -> paused -> running -> completed/failed/cancelled; replay increments generation | executions, execution_inputs, task_attempts, execution_stage_checkpoints, execution_events, operations, events, aggregate_heads | Execution list, seven-stage rail, attempts, checkpoints, recovery controls | signed Runner, Repository workspace/fencing, sealed Context Pack, P5 Approval | `tests/p6/runner-execution.test.mjs`, `tests/p6/execution-recovery.test.mjs`, `tests/p6/http-security.test.mjs`, `tests/p6/transport-parity.test.mjs`, `scripts/v3-clean-p6-performance.mjs`, `scripts/e2e.mjs`; `docs/evidence/v3-clean-p6-runner-execution-20260824/verification.json` | verified; stable DAG, read/write scheduling, seven stages, approval wait, pause/resume/cancel, replan, generation replay and restart receipts passed |
| C-12 REC-D6 Outcome | /api/v2/projects/{project_id}/outcome-requirements, /api/v2/executions/{id}/outcome, /evaluate, /waivers, /api/v2/outcome-waivers/{id}/revoke | outcome.requirement.list/create, outcome.get/evaluate/waiver.create/waiver.revoke | outcome.requirement.*, outcome.evaluated, outcome.waiver.*; immutable generations derive passed/completed_with_gaps/waived/blocked | outcome_requirements, outcome_evaluations, outcome_waivers, digests | Execution Outcome tab, requirement detail, waiver/revoke | deterministic evidence_count/test_pass/digest_match/human_score evaluators; active session proof for waiver actions | `tests/p7/quality-outcome.test.mjs`, `tests/p7/http-contract.test.mjs`, `apps/web/src/test/execution-p7.test.tsx`, `scripts/v3-clean-p7-quality-outcome-probe.mjs`, `scripts/e2e.mjs`; `docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json` | verified; deterministic replay and blocked -> waived -> blocked generations passed |

## 5. Assist, files, approval, terminal, and bridge

| ID / capability | API v2 | Command | Event / state | Clean tables (historical source) | UI | External | Tests / Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-13 REC-D8 Assist | /api/v2/assist/sessions, /turns, /follow-ups, /events, /goal, /references | assist.session.create, assist.turn.create, assist.turn.retry, assist.turn.cancel, assist.turn.steer, assist.turn.interrupt | assist.session.created, assist.turn.created/queued/running/completed/failed/cancelled, assist.message; draft -> queued -> running -> awaiting_input -> completed/failed/cancelled | assist_sessions, assist_turns, assist_messages, assist_goals, operations, operation_links, events (assist_sessions, assist_turns, assist_messages, assist_events, assist_operations, assist_session_heads, assist_turn_heads) | Assist Center, Composer, Context Pack, Turn Timeline, Operation Status | Codex app server, isolated profile, SSE | assist-flow, assist-r6, migration unit, assist UI; docs/evidence/v6-r6-assist-20260817/verification.json | implemented; clean operation_links replace historical assist_operations |
| C-14 REC-D8 Attachments | /api/v2/projects/{id}/attachments, /api/v2/attachments/{id}/content, /preview, /api/v2/assets/{id}/versions/{version_id}/parse | attachment.create/preview/delete, parser.run.start/get/retry/cancel | attachment.*, parser_run.*; staged -> scanned -> ready/rejected/deleted and queued -> running -> terminal parser state | attachments, asset_blobs, parser_runs | Attachment Tray, Evidence preview | MIME scanner, fixed-digest isolated parser, CAS | `tests/p5/assist-files.test.mjs`, `tests/p7/parser-evidence.test.mjs`, `tests/p7/http-contract.test.mjs`, `scripts/v3-clean-p7-parser-probe.mjs`; `docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json` | verified; quotas, MIME/signature, hash, redaction, all-format registration and parser isolation passed |
| C-15 REC-D8 Files/Change Batches | /api/v2/projects/{id}/files, /change-batches, /api/v2/change-batches/{id}/review | file.read, file.save, change_batch.propose, change_batch.apply, change_batch.undo | change_batch.proposed/applied/rolled_back; proposed -> approved -> applied -> undone/expired | file_refs, file_change_batches, file_change_items, assist_checkpoints (file_changes, assist_change_batches, assist_checkpoints) | Monaco, Diff Review | workspace checkout, controlled test runner | file-changes integration, terminal bundle, target stale/CAS tests | scaffolded; before/after hash and stale protection required |
| C-16 REC-D8 Approval/Input/Proposal | /api/v2/approvals, /api/v2/user-inputs, /api/v2/proposals | approval.request, approval.decide, user_input.answer, proposal.apply, proposal.reject | approval.requested/approved/rejected, user_input.requested/answered; pending -> approved/rejected/expired | runtime_approvals, runtime_user_inputs, semantic_proposals (runtime_approvals, runtime_user_inputs, ui_action_intents, change_proposals) | Approval Center, Proposal Drawer, human-input prompt | actor, ACL, optional runner wait | approval-flow, change-proposal, boundary/security tests; target approval Evidence | scaffolded; wait/resume and expected revision required |
| C-17 REC-D8 Terminal | /api/v2/terminals, /api/v2/terminals/{id}/events, /ws, /review | terminal.open, terminal.resize, terminal.signal, terminal.stop, terminal.reconnect | terminal.opened/started/output/resized/signalled/orphaned/closed/failed; requested -> starting -> running -> orphaned/recovered -> closed | terminal_sessions, terminal_events, operations, asset_versions (terminal_sessions) | Terminal panel | node-pty/ConPTY, WebSocket, CAS output | terminal unit/bundle, terminal-flow integration, terminal UI; docs/evidence/v3-terminal-native-20260807/evidence-manifest.json | verified; clean bridge and redaction probes required |
| C-18 REC-D8 Bridge | /api/v2/bridge/pairing, /api/v2/bridge/devices, /api/v2/bridge/transfers | bridge.pair, bridge.rotate, bridge.bundle.send, bridge.bundle.receive | bridge.paired, bridge.bundle.transferred; unpaired -> pairing -> paired -> revoked | bridge_devices, bridge_transfers, operations (host_bridge_devices) | Bridge Settings | independent Windows service, DPAPI, ConPTY, Git bundle | v15 bridge tests are characterization; target Windows external probe and rollback receipt | planned; independent process and signed path/SHA checks required |

## 6. Repository, delivery, MCP scope, context, and projection

| ID / capability | API v2 | Command | Event / state | Clean tables (historical source) | UI | External | Tests / Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-19 REC-D7 Repository | /api/v2/projects/{id}/repository-connections, /repository-lines, /repository-workspaces, /api/v2/repository-connections/{id}, /targets, /api/v2/repository-lines/{id}/reconcile, /api/v2/repository-workspaces/{id}/refresh, /lock, /release | repository.connection/target create/update, line.reconcile, workspace.create/refresh/lock/release | connection pending -> ready/faulted -> archived; line pending -> ready/faulted <-> recovering -> removed; workspace requested -> ready <-> locked -> released/orphaned | repository_connections, repository_targets, repository_lines, repository_workspaces, repository_locks | Repository, Worktree, `ProjectWorkflowPage` | deterministic repository fixture; source drift and fencing probes | `tests/p3/project-workflow.test.mjs`, `tests/p3/migration.test.mjs`, `apps/web/src/test/project-workflow-clean.test.tsx`; `docs/evidence/v3-clean-p3-project-workflow-20260819/verification.json` | verified; clean path policy, lease fencing, restart, and rollback receipts passed |
| C-20 REC-D7 Delivery | /api/v2/deliveries, /api/v2/deliveries/{id}/pull-request, /api/v2/pull-request-intents/{id}/* | delivery.submit, delivery.retry, pr.create, pr.ready, pr.merge, delivery.reconcile | delivery.submitted, delivery.merged; planned -> staging -> checks_pending -> draft_pr -> ready -> merged/needs_reconcile | deliveries, delivery_policies, pull_request_intents, delivery_events (deliveries, delivery_policies, delivery_events, pull_request_intents) | Delivery, Draft PR, Merge Review | GitHub App, checks, webhook, repository head SHA | api-flow, v19 delivery/PR/webhook suites; target GitHub external receipt | scaffolded; real GitHub App, merge race, and recovery receipts required |
| C-21 REC-D4 Scope/Exchange | /api/v2/projects/{id}/exchange-requests, /api/v2/exchange-requests/{id}/approve, /reject, /api/v2/exchange-grants/{id}/revoke, /context-packs, /api/v2/gateway/forward | exchange.request.create/approve/reject, exchange.grant.revoke/pack.create, gateway.forward | exchange_request.*, exchange_grant.*, gateway.*; requested -> partially_approved -> active -> revoked/expired, with rejected terminal | exchange_requests, exchange_grants, mcp_clients, gateway_forward_receipts | MCP Settings, project member permissions | actor/team ACL, MCP client, signed stateless Gateway | `tests/p4/mcp-exchange-gateway.test.mjs`, `tests/p4/transport-parity.test.mjs`, `scripts/v3-clean-p4-gateway-probe.mjs`, `scripts/e2e.mjs`; `docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json` | verified; dual approval, immediate expiry/revoke recheck, allowlists, nonce replay, and destination ACL narrowing passed |
| C-22 REC-D9 Context | /api/v2/projects/{id}/context/sources, /map, /search, /read, /nodes/{id}, /nodes/{id}/versions, /policy, /selections, /packs | context.source.create, context.map/search/read, context.policy.update, context.selection.create, context.pack.create | context_source.*, context_policy.*, context_selection.*, context_pack.*; source -> projected -> selected -> sealed | context_sources, context_nodes, context_document_versions, context_edges, context_selections, context_packs, context_policies, aggregate_revisions | Context Map, document history, Context Pack | MiniSearch worker, Clean CAS, retrieval policy | `tests/p4/context-projection.test.mjs`, `tests/p4/mcp-exchange-gateway.test.mjs`, `scripts/v3-clean-p4-performance.mjs`, Web context tests, `scripts/e2e.mjs`; `docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json` | verified; deterministic projection, policy CAS, sensitivity/freshness filtering, budget, and sealed Pack checks passed |
| C-23 REC-D9 Projection | /api/v2/projects/{id}/context/status, /rebuild, /jobs, /jobs/{id}, /events, /cancel, /retry | context.projection.status/rebuild/jobs/job/events/cancel/retry | context_projection.* in generic events; queued -> running -> indexing -> completed/failed/cancelled | context_projection_jobs, context_index_snapshots, events, operations, aggregate_heads | Context Map status/recovery | worker lease/fencing, CAS index storage, restart recovery | `tests/p4/context-projection.test.mjs`, `tests/p4/migration.test.mjs`, `scripts/v3-clean-p4-performance.mjs`, `scripts/e2e.mjs`; `docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json` | verified; stale lease, source drift, CAS tamper, cancel/retry, deterministic 1000-node rebuild, SSE replay, and no-shadow-head checks passed |

## 7. Evidence, quality, deployment, operations, and Web

| ID / capability | API v2 | Command | Event / state | Clean tables (historical source) | UI | External | Tests / Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-24 REC-D9 Evidence | /api/v2/projects/{project_id}/assets, /api/v2/assets/{id}, /versions, /versions/{version_id}/content, /relations, /attestations, /tombstone, /api/v2/executions/{id}/evidence, /traces, /digests, /test-results, /code-changes | asset.list/capture/get/version.list/content/relation.list/relation.create/attestation.list/attest/tombstone, evidence.execution.get/trace.list/digest.list/test-result.list/code-change.list | asset.*, evidence.*, trace.*, digest.*, code_change.*, test_result.*; immutable version/lineage/attestation with logical tombstone | assets, asset_versions, asset_blobs, asset_relations, asset_attestations, traces, digests, code_changes, test_results, cas_objects | project Evidence assets, restricted preview, lineage and attestation; Execution Evidence tab | Clean CAS, execution handoff/receipt verifier, secret scanner | `tests/p7/parser-evidence.test.mjs`, `tests/p7/http-contract.test.mjs`, `scripts/v3-clean-p7-cas-tamper-probe.mjs`, `scripts/v3-clean-p7-performance.mjs`, Web P7 tests, `scripts/e2e.mjs`; `docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json` | verified; canonical hash, immutable lineage, CAS tamper detection, capture/replay and redaction passed |
| C-25 REC-D9 Quality | /api/v2/parser/formats, /api/v2/parser-runs/{id}/*, /api/v2/executions/{id}/quality-reviews, /api/v2/quality-reviews/{id}, /events, /report, /decision, /cancel, /retry | parser.format.list, parser.run.start/get/retry/cancel, quality.list/start/get/events/report.get/decision/cancel/retry | parser_run.* and quality_review.*; parser queued -> running -> parsed/unsupported/invalid/resource_exceeded/failed/cancelled/external_result_unknown; quality queued -> preparing -> checking -> reviewing -> awaiting_human -> completed/failed/cancelled/stale | parser_formats, parser_runs, quality_review_runs, quality_review_reports, quality_review_events, human_reviews, test_results | Execution Quality tab, full dimension scoring, parser status/retry | fixed-digest isolated Docker parser, Clean Broker, CAS; human decision is local REST/Web only | `tests/p7/governance-protocol.test.mjs`, `tests/p7/parser-evidence.test.mjs`, `tests/p7/quality-outcome.test.mjs`, `tests/p7/broker-restart-tamper.test.mjs`, `scripts/v3-clean-p7-parser-probe.mjs`, `scripts/v3-clean-p7-quality-outcome-probe.mjs`, Web P7 tests, `scripts/e2e.mjs`; `docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json` | verified; 21 formats, quotas/tamper/restart, complete human threshold and stale hashes passed |
| C-26 REC-D9 Deployment Evidence | /api/v2/executions/{id}/evidence, /api/v2/system/deployment, /api/v2/deployments/{id}/verifications | deployment.verify, browser.capture, viewport.assert | deployment.verified; candidate -> probing -> verified/rejected | deployment_candidates, deployment_verifications, asset_versions, evidence_links (asset_versions, evidence_links) | Evidence, deployment status | browser at desktop/tablet/mobile viewports, Docker/Host runner | scripts/e2e.mjs, release rehearsals; target browser/health/CAS receipt | scaffolded; three viewports, console/layout checks, and attestation required |
| C-27 REC-D11 Operations | /api/v2/system/deployment, /api/v2/backups, /restore, /reset, /imports, /api/v2/operations/{id} | backup.create, backup.restore, import.inspect, import.dry_run, import.run, import.verify, import.cutover, deployment.rollback | operation.pending/running/completed/failed/cancelled, release.gate; import inspected -> dry_run -> running -> verified -> cutover/completed/failed | operations, operation_links, events, audit_events, backup_manifests, import_batches, import_checkpoints, import_id_map, import_conflicts (operations, operation_events, audit_events, import_jobs) | Setup, Recovery, Operations | SQLite/CAS volume, Docker Compose, deployment orchestrator | identity-operations, api-flow, release-gate, release-rehearsal-compose, boundary security; target cutover and rollback receipts | scaffolded; importer and actual volume rollback required |

### 7.1 Current Evidence snapshot

The paths below are copied from the current root Catalog. A value of none is
intentional and keeps a scaffolded capability below implemented.

| Current Catalog id | Current Evidence | Promotion gap |
| --- | --- | --- |
| REC-D0-GOVERNANCE-000 | docs/evidence/v3-clean-p1-gate-contract-complete-20260819/verification.json | GS-001 through GS-007 gate synchronization, clean architecture scan and byte-exact rollback |
| REC-D1-CONTRACTS-023 | docs/evidence/v3-r0-r1-governance-20260810/verification.json | clean baseline checksum and importer proof; R5 source-hash replay remains Historical through `pnpm fixture:legacy:integration` |
| REC-D10-FRONTEND-024 | docs/evidence/v3-clean-p2-identity-acl-20260819/verification.json | complete Web workflow, mobile/offline, SSE receipt |
| REC-D2-IDENTITY-001 | docs/evidence/v3-clean-p2-identity-acl-20260819/verification.json | P2 Team/Actor/session/ACL isolation and API v2 parity |
| REC-D2-SETUP-002 | docs/evidence/v3-clean-p2-identity-acl-20260819/verification.json | fake-provider rebind/rotation/probe receipt; real provider proof remains deferred |
| REC-D3-RUNNER-003 | docs/evidence/v3-clean-p6-runner-execution-20260824/verification.json | verified Docker, Host, Windows Bridge, signed Job Spec/receipt, isolation and restart probes |
| REC-D4-MCP-004 | docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json | real external provider integration remains deferred |
| REC-D5-PROJECT-005 | docs/evidence/v3-clean-p3-project-workflow-20260819/verification.json | clean Project/Intake/Brief lifecycle, source drift, CAS and ACL receipt |
| REC-D5-WORKFLOW-006 | docs/evidence/v3-clean-p3-project-workflow-20260819/verification.json | clean workflow graph/head, node contract, proposal stale and revision receipt |
| REC-D6-GENERATION-007 | docs/evidence/v3-clean-p3-project-workflow-20260819/verification.json | fake generator/critic failure, retry lineage, cancellation and restart receipt; real provider deferred |
| REC-D6-EXECUTION-008 | docs/evidence/v3-clean-p6-runner-execution-20260824/verification.json | verified seven-stage dispatcher, approval, replay, pause/resume/replan and recovery |
| REC-D6-OUTCOME-009 | docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json | deterministic evaluation and revocable waiver verified; release remains P9 |
| REC-D8-ASSIST-010 | docs/evidence/v3-clean-p5-assist-terminal-20260820/verification.json | generic operations/event model and ACL replay |
| REC-D8-ATTACHMENTS-011 | docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json | bounded preview plus all-format parser isolation and CAS receipt verified |
| REC-D8-FILES-012 | docs/evidence/v3-clean-p5-assist-terminal-20260820/verification.json | CAS change batch, stale protection, apply/undo proof |
| REC-D8-APPROVAL-013 | docs/evidence/v3-clean-p5-assist-terminal-20260820/verification.json | wait/resume, expected revision, and audit proof |
| REC-D8-TERMINAL-025 | docs/evidence/v3-clean-p5-assist-terminal-20260820/verification.json | Bridge separation and clean event cursor |
| REC-D8-BRIDGE-026 | docs/evidence/v3-clean-p5-assist-terminal-20260820/verification.json | independent Windows process, pairing, bundle, rollback |
| REC-D7-REPOSITORY-014 | docs/evidence/v3-clean-p3-project-workflow-20260819/verification.json | clean lease/path policy, source drift/recovery and deterministic provider probe |
| REC-D7-DELIVERY-015 | none | GitHub App, webhook, merge race, recovery |
| REC-D4-SCOPE-016 | docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json | production Gateway secret provisioning and release remain deferred |
| REC-D9-CONTEXT-017 | docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json | full Assist/Execution consumption remains deferred |
| REC-D9-PROJECTION-018 | docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json | release-volume cutover remains deferred |
| REC-D9-EVIDENCE-019 | docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json | canonical CAS, attestation, lineage, capture, tamper and secret scan verified |
| REC-D9-QUALITY-020 | docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json | 21-format parser, human threshold, stale/retry/restart and Outcome linkage verified |
| REC-D9-DEPLOYMENT-021 | none | browser/viewport, health, and deployment attestation |
| REC-D11-OPS-022 | none | offline importer, temporary-volume cutover, actual rollback |

## 8. V2.3 L0-L7 catalog coverage

The following table reproduces every entry in e18dc0b/tests/v23/catalog.json.
The command, layer, suite, and external-effect values are preserved; the
contract fields describe the V3-Clean replacement test and Evidence.

| Catalog id / layer | API / command | Events / state | Tables | UI | External | Test and Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| V23-L0-PLAN-001 (governance) | /api/v2/system/architecture; governance.plan | governance.plan.checked; declared -> classified -> passed/failed | schema_meta, schema_migrations | Governance receipt | none | node scripts/v23-plan.mjs; source tests/v23/catalog.json; target docs/evidence/v3-clean/l0-plan.json |
| V23-L0-CATALOG-002 (governance) | /api/v2/system/catalog; governance.catalog | governance.catalog.checked; loaded -> indexed -> passed/failed | capability_catalog, audit_events | Catalog view | none | node scripts/v23-catalog.mjs; source scripts/v23-catalog.mjs; target matrix receipt |
| V23-L0-COVERAGE-003 (governance) | /api/v2/system/coverage; governance.coverage | governance.coverage.checked; mapped -> bidirectional -> passed/failed | capability_links, test_links | Coverage report | none | node scripts/v23-coverage.mjs; source tests/v23/coverage-map.json; target coverage receipt |
| V23-L0-IMPACT-004 (governance) | /api/v2/system/impact; governance.impact | governance.impact.classified; changed -> selected -> audited | impact_receipts, test_links | Change impact view | Git | node scripts/v23-impact.mjs --audit; source tests/v23/impact-map.json; target impact receipt |
| V23-L1-QUALITY-001 (quality_review) | /api/v2/quality-reviews; quality.protocol.validate | quality.protocol.checked; draft -> normalized -> accepted/rejected | quality_review_runs, quality_review_reports, human_reviews | Quality Review | isolated worker fixture | node tests/unit/v23-quality-review.test.mjs; target protocol Evidence |
| V23-L1-STATE-002 (state) | /api/v2/system/schema; schema.state.validate | state.validated; loaded -> normalized -> immutable/invalid | schema_meta, aggregate_revisions, quality_review_runs, quality_review_reports | Operations | SQLite | node --disable-warning=ExperimentalWarning tests/unit/v23-quality-review-state.test.mjs; target clean-schema receipt |
| V23-L2-MIGRATION-001 (migration) | /api/v2/imports; import.verify | import.migration.checked; source -> cloned -> verified/failed | import_batches, import_checkpoints, import_id_map, backup_manifests | Recovery | Docker volume | node --disable-warning=ExperimentalWarning tests/release/v23-volume-flow.test.mjs; target import verify and rollback receipts |
| V23-L3-PARSER-001 (parser) | /api/v2/parser-runs and /api/v2/quality-reviews; parser.run | parser.completed/failed; queued -> isolated -> parsed/unsupported/invalid/resource_exceeded | parser_formats, parser_runs, asset_blobs, quality_review_reports | Quality Review, Attachment Preview | worker sandbox, CAS | node --disable-warning=ExperimentalWarning tests/unit/v23-quality-review-parser.test.mjs; target per-format Evidence; clean scope includes audio/video, PPTX, archives |
| V23-L3-WEB-002 (quality_review_web) | /api/v2/quality-reviews; quality.review.open/decide | quality.ui.updated; loading -> ready -> awaiting_human -> submitted | quality_review_runs, human_reviews | Quality Review, rubric editor | browser unit environment | pnpm --filter @aiws/web exec vitest run src/test/quality-review-v23.test.tsx; target UI receipt |
| V23-L3-BROWSER-003 (quality_review_browser) | /api/v2/quality-reviews/events; quality.review.replay | quality.event.replayed; connect -> replay -> live -> terminal | events, event_cursors, quality_review_runs | Quality Review across desktop/tablet/mobile | Playwright/browser | node tests/e2e/v23-quality-review-browser.test.mjs; target three-viewport screenshot and console receipt |
| V23-L4-LIFECYCLE-001 (runtime) | /api/v2/quality-reviews, /events, /operations/{id} | operation.accepted/running/completed/failed/cancelled; queued -> running -> terminal | operations, operation_links, events, event_cursors | Operation Status | process restart, SIGTERM | node --disable-warning=ExperimentalWarning tests/integration/v23-quality-review-flow.test.mjs; target restart/replay receipt |
| V23-L5-SECURITY-001 (security) | all project-scoped API v2 and MCP mappings; security.scan | security.scan.completed/blocked; clean -> scanned -> accepted/blocked | audit_events, events, asset_blobs, ACL tables | Security/Audit | secret scanner, isolated profiles | node --disable-warning=ExperimentalWarning tests/security/v23-quality-review-security.test.mjs; target redaction/ACL receipt |
| V23-L6-PERFORMANCE-001 (performance) | /api/v2/quality-reviews; performance.observe | performance.sampled; queued -> measured -> reported | operations, parser_runs, event_cursors | Operations metrics | event-loop and worker metrics | node --disable-warning=ExperimentalWarning tests/performance/v23-quality-review-performance.test.mjs; target performance receipt |
| V23-L7-RELEASE-001 (release) | /api/v2/system/deployment, /api/v2/imports/cutover; release.gate | release.gate.passed/failed; candidate -> verified -> promoted/rolled_back | deployment_candidates, deployment_verifications, backup_manifests, import_batches | Recovery/Release | Docker Compose, temporary volume | node --disable-warning=ExperimentalWarning tests/release/v23-release-contract.test.mjs; target cutover and actual rollback receipt |

Catalog integrity obligations:

- all 14 ids remain unique and present in their declared pr/full/release
  suites;
- all eight layers L0, L1, L2, L3, L4, L5, L6, and L7 remain represented;
- all seven OPT packages in tests/v23/coverage-map.json map in both
  directions;
- each row has a V3-Clean command, event/state, table, UI, dependency, test,
  and Evidence link, even when the source row had no UI or external effect.

### 8.1 Catalog execution metadata

This is the execution metadata copied from tests/v23/catalog.json, including
suite membership, timeout, external effect, and optimization coverage.

| Catalog id | Suites | Timeout | External effect | Requires env | Covers |
| --- | --- | ---: | --- | --- | --- |
| V23-L0-PLAN-001 | pr, full, release | 60000 ms | none | [] | OPT23-01 |
| V23-L0-CATALOG-002 | pr, full, release | 60000 ms | none | [] | OPT23-01 |
| V23-L0-COVERAGE-003 | pr, full, release | 60000 ms | none | [] | OPT23-01 |
| V23-L0-IMPACT-004 | pr, full, release | 60000 ms | none | [] | OPT23-01, OPT21-05 |
| V23-L1-QUALITY-001 | pr, full, release | 120000 ms | none | [] | OPT23-01 |
| V23-L1-STATE-002 | pr, full, release | 120000 ms | none | [] | OPT23-01, OPT22-01 |
| V23-L2-MIGRATION-001 | full, release | 180000 ms | docker | [] | OPT23-01, OPT22-01 |
| V23-L3-PARSER-001 | pr, full, release | 120000 ms | none | [] | OPT23-01, OPT21-04 |
| V23-L3-WEB-002 | pr, full, release | 120000 ms | none | [] | OPT23-01 |
| V23-L3-BROWSER-003 | full, release | 240000 ms | browser | [] | OPT23-01 |
| V23-L4-LIFECYCLE-001 | pr, full, release | 240000 ms | none | [] | OPT23-01, OPT21-01, OPT21-02, OPT21-03 |
| V23-L5-SECURITY-001 | pr, full, release | 120000 ms | none | [] | OPT23-01 |
| V23-L6-PERFORMANCE-001 | full, release | 180000 ms | none | [] | OPT23-01 |
| V23-L7-RELEASE-001 | release | 120000 ms | none | [] | OPT23-01 |

The seven optimization packages are bidirectional in the clean plan:

| Package | Source implementation anchors | V2.3 catalog tests |
| --- | --- | --- |
| OPT21-01 | context-projection and search-index | V23-L4-LIFECYCLE-001 |
| OPT21-02 | runtime-health and system routes | V23-L4-LIFECYCLE-001 |
| OPT21-03 | shutdown coordinator and server | V23-L4-LIFECYCLE-001 |
| OPT21-04 | context-index runtime and search-index | V23-L3-PARSER-001 |
| OPT21-05 | impact-range and compatibility runner | V23-L0-IMPACT-004 |
| OPT22-01 | state store, worker, and schema migration | V23-L1-STATE-002, V23-L2-MIGRATION-001 |
| OPT23-01 | quality review service/parser/policy/rubric/routes/UI/protocol | all V23-L0 through V23-L7 cases |

## 9. Explicit recovery obligations

Several V2.3 capabilities are distributed across route groups and therefore
need an explicit acceptance row in addition to the current Catalog rows.

| Obligation | API v2 / command | Event / state | Tables | UI | External | Test / Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Team and multi-Actor | /api/v2/teams, /api/v2/projects/{id}/members, /api/v2/projects/{id}/invitations; team.create, membership.grant, actor.switch | team.created, membership.granted/revoked, invitation.accepted; invited -> active -> suspended/revoked | actors, teams, team_memberships, project_memberships, project_invitations | Teams, Members, Permissions | session/service identity | tests/p2/identity-acl-security.test.mjs; docs/evidence/v3-clean-p2-identity-acl-20260819/isolation-receipt.json |
| Project ACL and Exchange | /api/v2/projects/{id}/permissions, /exchange-requests; acl.set, exchange.request.approve | acl.*, exchange_request.*, exchange_grant.*; requested -> partially_approved -> active -> expired/revoked | project_acl_entries, exchange_requests, exchange_grants | Permissions, MCP Settings | actor/team policy | `tests/p4/mcp-exchange-gateway.test.mjs`, `tests/p4/transport-parity.test.mjs`; P4 isolation and expiry/revoke receipt |
| MCP Gateway | /api/v2/gateway/forward; gateway.forward | gateway.forwarded/denied; received -> scoped -> forwarded/denied | gateway_forward_receipts, events | P4 MCP Settings controls; full administration deferred | separate stateless process, signed client, no Docker socket | `tests/p4/mcp-exchange-gateway.test.mjs`; `scripts/v3-clean-p4-gateway-probe.mjs`; P4 verification receipt |
| Docker and Host Runner | /api/v2/runners; runner.claim/finish | runner.started/completed/failed; signed -> leased -> terminal | runner_profiles, job_specs, runner_receipts | Execution/Operations | Docker digest, Host process, isolated CODEX_HOME | broker-http, real-runner, v110 runner suites; target external runner receipts |
| Windows Bridge | /api/v2/bridge; bridge.pair/bundle.send | bridge.paired, bundle.transferred; pairing -> active -> revoked | bridge_devices, bridge_transfers | Bridge Settings | Windows service, DPAPI, ConPTY, Git | V15 bridge characterization plus independent Windows probe |
| Parser breadth | /api/v2/parser-formats and /parser-runs; parser.register/run | parser.completed/unsupported/failed; registered -> isolated -> terminal | parser_formats, parser_runs, asset_versions | Attachment/Quality Review | worker quotas, sandbox, CAS | V23-L3 parser plus audio/video, PPTX, archive format probes |
| Seven-stage execution | /api/v2/executions/{id}/stages; stage.replay | stage.changed, checkpoint.created; prepare -> context -> run -> check -> review -> finalize -> deliver | executions, checkpoints, task_attempts, events | Execution/Recovery | runner, repository, Context Pack | V21 replay and target scheduler/restart suite |
| Offline, SSE, and mobile | /api/v2/events; replay.read, client.reconnect | cursor.advanced; disconnected -> replaying -> live | events, event_cursors, audit_events | all Web surfaces at 1440x900, 1024x768, 390x844 | browser/offline cache | V23-L3 browser, V21/V20 browser suites; target reconnect and overlap receipts |

## 10. Historical route inventory and target mapping

The V2.3 registry imports these route modules. The module name is evidence of
coverage; the clean API family is the target owner.

| Historical module | Main capability | Clean API family |
| --- | --- | --- |
| system.mjs | health, readiness, account, deployment | probes, identity, deployment |
| setup-v12.mjs | setup mode and completion | setup |
| projects.mjs, project-onboarding-v13.mjs | project, intake, brief | projects/briefs |
| assist-v12.mjs, assist-v3.mjs | Assist sessions, turns, attachments, operations, terminal overlays | Assist/files/terminal |
| runs.mjs, workflow-executions-v110.mjs | runs and staged execution | execution |
| assets.mjs | asset versions, lineage, attestation | evidence/assets |
| git.mjs, repository-lifecycle-v19.mjs, repository-workspaces-v19.mjs | Git, deletion, workspaces | repository |
| github.mjs, github-config-v12.mjs, github-installations-v12.mjs, github-repositories-v13.mjs, github-webhook-v12.mjs | provider/app/installations/webhooks | setup/repository/delivery |
| config-governance-v13.mjs | provider/config revision proposals and reconciliation | setup/operations |
| tools.mjs | tool registry and health | MCP/tools |
| codex-v12.mjs, codex-runtime-v12.mjs, codex-discovery-v12.mjs, codex-capabilities-v13.mjs | profile, device auth, discovery, capabilities | setup/runner |
| workflow-v12.mjs, workflow-v19.mjs | workflow graph, layout, proposals | workflow |
| files-v12.mjs, change-proposals.mjs | files and change proposals | files/proposals |
| agent-sessions.mjs, approvals-v13.mjs | agent submissions and approvals | Assist/approval |
| terminal-v13.mjs, host-bridge-v15.mjs | PTY and Windows bridge | terminal/bridge |
| mcp-clients-v18.mjs, mcp-v18.mjs | MCP HTTP/stdio and clients | MCP/Gateway |
| repository-delivery-v19.mjs, pull-request-intents-v19.mjs | delivery, PR intent, merge | delivery |
| workflow-migration-v19.mjs | workflow migration orchestration | operations/import |
| project-governance-v19.mjs, exchange-v19.mjs | ACL, membership, Exchange | identity/exchange |
| context-v20.mjs | map, search, selection, packs | context |
| quality-reviews-v23.mjs | quality review policy/run/events/decision | quality |

Representative historical endpoint groups include project CRUD and onboarding,
Assist V3 session/turn/follow-up/attachment/review routes, repository and
delivery routes, Exchange approval/context-pack routes, MCP tool/client
routes, context map/rebuild routes, terminal WebSocket routes, and quality
prepare/history/start/detail/events/cancel/decision routes. Every group is
represented in the API v2 family table and has one registry owner.

## 11. Historical UI inventory

The V2.3 Web router at apps/web/src/app/router.tsx defines:

~~~text
/setup
/integrations/github/install/setup
/projects
/projects/:projectId/onboarding
/projects/:projectId/workflow
/projects/:projectId/workflow/:workstreamId
/projects/:projectId/nodes/:nodeId
/assets
/context
/projects/:projectId/context
/audit
/settings
~~~

Feature directories and their clean surfaces are:

| Source feature | Clean surface | Matrix rows |
| --- | --- | --- |
| setup | Setup, Codex, GitHub App, Credential | C-04, C-05 |
| projects | Projects, Intake, Brief | C-08 |
| workflow | Workflow Canvas, Generation, Critic, Outcome, Quality Review | C-09-C-12, C-25 |
| nodes | Task Contract, Execution, Evidence, repository workspace | C-09, C-11, C-19, C-24 |
| assist | Assist Center, Composer, attachments, approvals, terminal overlays | C-13-C-18 |
| context | Context Map and Context Pack | C-22-C-23 |
| assets | Assets, Trace, Digest | C-24 |
| audit | Audit and operation receipts | C-01, C-27 |
| settings | MCP, Exchange, Team, provider settings | C-04-C-07, C-21 |

The clean Web client consumes only API v2 schemas and event cursors. It keeps
the same workflow breadth while removing source-version route names.

## 12. Historical schema inventory and mapping notes

The V2.3 config collection list contains 98 names. Important source groups
are:

- identity/setup: users, sessions, connected_accounts, credential_refs,
  codex_profiles, setup_states, github_app_configs, github_installations;
- project/workflow: projects, workspaces, workflows, workflow_nodes,
  node_contracts, project_intakes, project_briefs, workflow_drafts,
  workflow_generations, workflow_generation_events;
- repository/delivery: repository_connections, repository_targets,
  repository_lines, repository_bindings, repository_workspaces,
  canonical_repositories, pull_request_intents, deliveries,
  delivery_policies, delivery_events;
- context/MCP/Exchange: context_nodes, context_document_versions,
  context_edges, context_selections, context_policies,
  context_projection_jobs, context_summaries, context_packs, mcp_clients,
  exchange_requests, exchange_grants;
- Assist/files/runtime: assist_sessions, assist_turns, assist_messages,
  assist_events, assist_operations, assist_configurations,
  assist_change_batches, assist_checkpoints, attachments, file_changes,
  runtime_approvals, runtime_user_inputs, terminal_sessions,
  host_bridge_devices;
- execution/evidence/quality: workflow_executions, task_executions,
  execution_events, execution_stage_checkpoints, assets, asset_versions,
  asset_blobs, asset_attestations, asset_relations, traces, digests,
  quality_review_runs, quality_review_reports, quality_review_events,
  human_reviews, test_results, outcome_requirements, outcome_evaluations,
  outcome_waivers.

The clean schema groups these into canonical aggregates and generic
operations/events/CAS. Source-only compatibility fields are mapped or listed
as import conflicts; they are never recreated as runtime toggles.

## 13. Evidence and promotion rules

For every matrix row, Evidence must prove:

1. baseline behavior and the V3-Clean command output;
2. expected revision, idempotency, permission, and redaction behavior;
3. normal, failure, retry, restart, and rollback paths appropriate to the row;
4. UI behavior and the three required viewports where a UI is listed;
5. external adapter behavior with a bounded receipt where a dependency is
   listed.

The current Catalog status remains a snapshot until these checks are complete.
The three historical parser exclusions in feature-catalog.json are recorded
as source facts; decision D-017 changes the V3-Clean target to include those
format families and requires new parser Evidence.

## 14. Matrix validation

The documentation gate checks:

~~~text
node -e "parse feature-catalog.json and assert all 27 ids occur in this file"
node -e "parse e18dc0b/tests/v23/catalog.json and assert all 14 ids occur in this file"
rg -n "V23-L[0-7]-|REC-D[0-9]+-|API v2|Command|Event|Tables|UI|External|Tests|Evidence" docs/architecture/v23-capability-matrix.md
git diff --check
~~~

Any missing id, layer, field, route family, source collection group, or
Evidence link blocks the documentation phase.

## 15. P1 clean-platform receipt

The platform foundation used by all later rows is independently tracked below;
these rows do not promote domain Catalog entries by schema existence alone.

P1's cross-phase gate synchronization contract is composed of `GS-001`,
`GS-002`, `GS-003`, `GS-004`, `GS-005`, `GS-006`, and `GS-007`. Rule text,
command inventory, owner/phase/path inventories, and Evidence references update
with `AGENTS.md`, `docs/testing.md`, the development plan, Catalog, and this
matrix in one change. Machine verification is recorded in
`docs/evidence/v3-clean-p1-gate-contract-complete-20260819/gate-sync-contract.json`.

| P1 row | Clean owner | API/command surface | Tables/events | Test and Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| P1-PLATFORM-001 | Platform | `/livez`, `/readyz`, `operations.get`, `operations.events`, `operations.cancel` | `schema_meta`, `schema_migrations`, `actors`, `aggregate_heads`, `aggregate_revisions`, `operations`, `operation_links`, `events`, `event_cursors`, `idempotency_keys`, `audit_events`, `cas_objects`, `receipt_manifests` | `tests/p1/clean-platform.test.mjs`; `docs/evidence/v3-clean-p1-gate-contract-complete-20260819/verification.json` | verified |
| P1-PLATFORM-002 | CAS/Redaction | registry receipt and replay envelopes | `cas_objects`, `receipt_manifests`, `events`, `audit_events` | `tests/p1/clean-platform.test.mjs`; `docs/evidence/v3-clean-p1-gate-contract-complete-20260819/cas-manifest.json` | verified |
| P1-GOVERNANCE-003 | Platform | GS-001 through GS-007 gate, document, Catalog/matrix and Evidence synchronization | no domain tables; one governed hash inventory plus one all-path classification inventory | `tests/p1/workspace-sync.test.mjs`; `docs/evidence/v3-clean-p1-gate-contract-complete-20260819/workspace-audit.json` | verified |

## 16. P3.1 Clean debt-burn-down receipt

P3.1 does not add a schema or business capability row. It synchronizes the
owners, active entrypoints, layered gates, Catalog references, and immutable
rollback artifacts for the existing P3 rows. The receipt directory is
`docs/evidence/v3-clean-p3-1-debt-burn-down-20260820/`.

| P3.1 surface | Owner | Required inventory/behavior | Test and Evidence | Status effect |
| --- | --- | --- | --- | --- |
| service boundaries and ledger parity | Operations + domain owners | one operation/event/head/idempotency implementation; no owner SQL writes | `tests/p31/ledger-parity.test.mjs`, `tests/p31/service-boundaries.test.mjs`; P3.1 verification receipt | preserves P3 statuses |
| Clean Web and E2E entrypoint | Frontend | Setup/Identity/Projects/Workflow use `/api/v2`; active request count has `/api/v1=0`; three viewports | `tests/p31/clean-entrypoint-web.test.mjs`, Web suite, `scripts/e2e.mjs` | `REC-D10-FRONTEND-024` remains `scaffolded` until final Web Evidence |
| Catalog layers and gate wrappers | Platform/Governance | index references, disjoint ids, matrix bidirectional coverage, Clean blocking and historical advisory receipts; successful wrappers stay Git-stable and failures append local redacted receipts | `tests/p31/catalog-split.test.mjs`, `tests/p31/layered-gates.test.mjs`, `scripts/catalog-loader.mjs`, `scripts/layered-gate.mjs`; `docs/evidence/v3-clean-p3-1-gate-receipt-hygiene-20260820/verification.json` | failed advisory cannot promote Clean |
| immutable Evidence and rollback | Evidence/CAS | append-only attempts, exclusive final receipt, dry-run plus isolated apply and byte comparison | `tests/p31/evidence-immutability.test.mjs`, `rollback.ps1`, `verification.json` | only final non-provisional receipt may promote |

## 17. P4 Context, MCP, Exchange, and Gateway receipt

Decision D-033 advances the active schema to `user_version=4`. The four P4
Catalog rows move from Historical to Clean together only after the final
non-provisional receipt at
`docs/evidence/v3-clean-p4-context-mcp-20260820/verification.json` is verified.
Frontend and Outcome remain `scaffolded`; this receipt does not claim P5+
runtime, real provider, Runner, Parser, Outcome evaluation, release, or
production cutover.

| P4 surface | Owner | Required inventory/behavior | Test and Evidence | Status effect |
| --- | --- | --- | --- | --- |
| schema v4 and ownership | Platform + Context/Projection/MCP/Exchange/Gateway | migration 004 from targets 0/1/2/3, checksum/fault recovery, twelve owned tables, additive Exchange grant fields, no shadow heads | `tests/p4/migration.test.mjs`, `tests/p4/governance-sync.test.mjs`; migration/schema/owner receipts | promotes the four P4 rows only |
| Context/Projection/Pack | Context + Projection | deterministic source adapters, MiniSearch/CAS projection, lease fencing, policy CAS, stable selection, `aiws.context_pack.v5`, retry/cancel/recovery | `tests/p4/context-projection.test.mjs`, `scripts/v3-clean-p4-performance.mjs`; performance and migration receipts | `REC-D9-CONTEXT-017` and `REC-D9-PROJECTION-018` verified |
| MCP/Exchange/Gateway parity | MCP + Exchange + Gateway | one registry/validator/dispatcher across REST, MCP HTTP, stdio, and signed Gateway; dual approval and immediate authorization recheck | `tests/p4/mcp-exchange-gateway.test.mjs`, `tests/p4/transport-parity.test.mjs`, `scripts/v3-clean-p4-gateway-probe.mjs` | `REC-D4-MCP-004` and `REC-D4-SCOPE-016` verified |
| Clean Web and browser | Frontend | Context, policy, selection, Pack, one-time token, dual approval, cancel/retry; three viewports, no overlap/overflow, `/api/v1=0` | `apps/web/src/test/context.test.tsx`, `scripts/e2e.mjs`; browser receipt | `REC-D10-FRONTEND-024` remains scaffolded |
| immutable Evidence and rollback | Evidence/CAS | original/modified hashes, binary patch, literal gate output, secret scan, reverse-check, isolated v3 SQLite/CAS restore, four-artifact and byte comparison | `scripts/v3-clean-p4-evidence.mjs`, `rollback.ps1`, `verification.json` | only final `verified`, `provisional=false` receipt promotes |

## 18. P5 Assist, Files, Terminal, and Bridge receipt

Decision D-034 advances the active schema to `user_version=5`. Five P5 rows
move to `verified` and Attachments moves to `implemented` only after the final
non-provisional receipt at
`docs/evidence/v3-clean-p5-assist-terminal-20260820/verification.json` passes.

| P5 surface | Owner | Required inventory/behavior | Test and Evidence | Status effect |
| --- | --- | --- | --- | --- |
| schema v5 and ownership | Platform + Assist/Files/Terminal/Bridge | migration 005 from targets 0/1/2/3/4, fault rollback, seventeen owned tables, one operations/events/head/CAS model | `tests/p5/migration.test.mjs`, `tests/p5/mutation-recovery.test.mjs`; migration/schema/owner receipts | enables the six P5 rows only |
| Assist and provider | Assist | bound profile/credential revision, isolated `CODEX_HOME`, zeroable credential lease, real fixed-response turn, contiguous events, assistant item, terminal tools and `turn/completed` | `tests/p5/assist-files.test.mjs`, `tests/p5/provider-probe.test.mjs`, `scripts/v3-clean-p5-assist-probe.mjs`; Assist probe receipt | `REC-D8-ASSIST-010` verified; missing credential or incomplete turn remains provisional |
| Attachments and Files | Files | bounded MIME preview/quarantine, managed relative paths, atomic change batch, stale fencing, apply/recovery/undo | `tests/p5/assist-files.test.mjs`, `tests/p5/http-contract.test.mjs`, `tests/p5/mutation-recovery.test.mjs` | Files verified; Attachments implemented pending P7 parsers |
| Approval, Terminal, and Bridge | Assist + Terminal + Bridge | revision-bound decisions, pause/resume, PTY cursor/redaction, independent pairing/nonce/rotate/revoke and bundle verification | `tests/p5/terminal-bridge.test.mjs`, `scripts/v3-clean-p5-bridge-probe.mjs` | Approval, Terminal, and Bridge verified |
| immutable Evidence and rollback | Evidence/CAS | real probes, literal commands, secret scan, four roles, reverse-check and isolated byte-exact v4 restore | `scripts/v3-clean-p5-evidence.mjs`, `rollback.ps1`, `verification.json` | only final `verified`, `provisional=false` receipt promotes; Clean/Historical is 19/8 |

## 19. P6 Runner, Execution, Checkpoint, and Replay receipt

Decision D-035 advances the active schema to `user_version=6`. Runner and
Execution move to `verified` only after the final non-provisional receipt at
`docs/evidence/v3-clean-p6-runner-execution-20260824/verification.json` passes.
Frontend and Outcome remain `scaffolded`; `deliver` creates only a handoff
manifest and does not claim GitHub Delivery or release.

| P6 surface | Owner | Required inventory/behavior | Test and Evidence | Status effect |
| --- | --- | --- | --- | --- |
| schema v6 and ownership | Platform + Runner/Execution | migration 006 from targets 0/1/2/3/4/5, fault rollback, eight P6 tables, immutable Job Spec/receipt/input/terminal-attempt/checkpoint, one operations/events/head/CAS model | `tests/p6/migration.test.mjs`, `tests/p6/runner-execution.test.mjs`, `tests/p6/governance-sync.test.mjs`; migration/schema/owner receipts | enables only Runner and Execution |
| Runner adapters and Broker | Runner | `runner.job-spec.v2`, `runner.receipt.v2`, Ed25519 identities, timestamp/nonce/body-hash HMAC, Docker digest/isolation, Host `CODEX_HOME`/process cleanup, Bridge DPAPI/ConPTY submit-status-cancel parity | `tests/p6/runner-transports.test.mjs`, `tests/p6/http-security.test.mjs`; Docker, Host, Bridge and restart probes | `REC-D3-RUNNER-003` verified; any provisional adapter freezes promotion |
| seven-stage execution and recovery | Execution | stable bounded DAG, read concurrency four, serial writes, attempts/backoff, pin/workspace validation, approval wait, pause/resume/cancel, lineage replan, generation replay and restart reconciliation | `tests/p6/runner-execution.test.mjs`, `tests/p6/execution-recovery.test.mjs`, `tests/p6/transport-parity.test.mjs`, performance receipt | `REC-D6-EXECUTION-008` verified |
| Clean Web and browser | Frontend | Execution list/rail/attempt/checkpoint controls and Runner Profiles readiness/probe/disable; approval resume and generation 2 deliver replay at three viewports with `/api/v1=0` | `apps/web/src/test/execution-p6.test.tsx`, `apps/web/src/test/connections-p6.test.tsx`, `scripts/e2e.mjs`; browser receipt | Frontend remains scaffolded pending complete P9 workflow/offline/release Evidence |
| immutable Evidence and rollback | Evidence/CAS | declarative P4/P5/P6 policy, literal gates, manifest/hash reopen, redaction scan, reverse-check, isolated actual v5 restore of SQLite/CAS/Vault/workspace/Broker/Bridge, ledger 1-5, FK empty and P6 tables absent | `scripts/v3-clean-p6-evidence.mjs`, `rollback.ps1`, `verification.json` | only final `verified`, `provisional=false` promotes; Clean/Historical is 21/6/27 |

## 20. P7 Evidence, Quality, Parser, and Outcome receipt

Decision D-036 advances the active schema to `user_version=7`. Evidence and
Quality move from Historical to Clean, while Outcome and Attachments advance
to `verified`, only after the final non-provisional receipt at
`docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json`
passes. Frontend remains `scaffolded`; parser output remains Evidence and never
becomes a human verdict.

| P7 surface | Owner | Required inventory/behavior | Test and Evidence | Status effect |
| --- | --- | --- | --- | --- |
| schema v7 and ownership | Platform + Parser/Evidence/Quality/Outcome | migration 007 from targets 0/1/2/3/4/5/6, fault rollback, 17 P7 tables, Project-owned requirements and CAS-owned objects, one operations/events/cursor/head/CAS model | `tests/p7/migration.test.mjs`, `tests/p7/governance-sync.test.mjs`; migration/schema/owner receipts | enables the four promoted statuses only |
| Evidence capture and immutable chain | Evidence | execution handoff validation, managed relative output capture, immutable asset/blob/version/relation/attestation/trace/digest/code-change/test-result records, logical tombstone and CAS tamper detection | `tests/p7/parser-evidence.test.mjs`, `tests/p7/http-contract.test.mjs`, `scripts/v3-clean-p7-cas-tamper-probe.mjs`, performance receipt | `REC-D9-EVIDENCE-019` verified |
| isolated Parser and Broker recovery | Parser | 21 seeded formats, fixed reproducible image digest, `parser.job.v1`/`parser.receipt.v1`, HMAC/nonce, quotas, no-network/read-only/cap-drop isolation, terminal lineage, cancel/retry and restart reconciliation | `tests/p7/governance-protocol.test.mjs`, `tests/p7/broker-restart-tamper.test.mjs`, `scripts/v3-clean-p7-parser-probe.mjs`, `scripts/v3-clean-p7-restart-probe.mjs` | Evidence/Quality and `REC-D8-ATTACHMENTS-011` verify only when the real container probe is non-provisional |
| Quality and Outcome replay | Quality + Outcome | 1-20 dimension rubric with weight 100, at most 16 assets, deterministic advisory report, complete session-bound human scoring, four fixed evaluators, immutable waiver/revoke/expiry generations | `tests/p7/quality-outcome.test.mjs`, `scripts/v3-clean-p7-quality-outcome-probe.mjs`, Web P7 tests | `REC-D9-QUALITY-020` and `REC-D6-OUTCOME-009` verified |
| Clean Web and browser | Frontend | Evidence project view; Execution Evidence/Quality/Outcome tabs; parser controls, full scoring, waiver/revoke, reconnect/duplicate/partial-event states at three viewports with `/api/v1=0` | `apps/web/src/test/evidence-p7.test.tsx`, `apps/web/src/test/execution-p7.test.tsx`, `scripts/e2e.mjs`; browser receipt | Frontend remains scaffolded pending P9 offline/release Evidence |
| immutable Evidence and rollback | Evidence/CAS | declarative P4-P7 policy, literal gates, hash-complete manifest/reopen, redaction scan, reverse-check, isolated actual v6 restore of SQLite/CAS/Vault/workspace/Broker/Bridge/parser, ledger 1-6, FK empty and 17 P7 tables absent | `scripts/v3-clean-p7-evidence.mjs`, `rollback.ps1`, `verification.json` | only final `verified`, `provisional=false` promotes; Clean/Historical is 23/4/27 |
