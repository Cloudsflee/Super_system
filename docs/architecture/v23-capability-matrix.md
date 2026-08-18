# V2.3 to V3-Clean Capability Matrix

Status: characterization baseline and V3-Clean acceptance contract.
Source commit: e18dc0b (V2.3.0, state schema 23).
Target runtime: V3-Clean, API v2, schema family v3-clean.

This matrix is derived from the V2.3 route registry, state collection list,
tests/v23/catalog.json, Web router/features, and the current feature-catalog.json.
It is deliberately wider than the current implementation Catalog: every
capability is described as an API, command, event, table, state machine, UI,
external dependency, test, and Evidence obligation.

## 1. Coverage summary

| Source | Coverage recorded here |
| --- | --- |
| Current feature-catalog.json | 27 rows, REC-D0 through REC-D11 |
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
| REC-D2-IDENTITY-001 | identity | local owner account and sessions | implemented | C-04 |
| REC-D2-SETUP-002 | setup | Vault, Device Auth, profiles, provider probes | implemented | C-05 |
| REC-D3-RUNNER-003 | runner | Docker/Host broker and signed Job Spec | scaffolded | C-06 |
| REC-D4-MCP-004 | mcp | MCP clients, tools, operation lifecycle | implemented | C-07 |
| REC-D5-PROJECT-005 | project | draft intake and confirmed brief | implemented | C-08 |
| REC-D5-WORKFLOW-006 | workflow | Workstream/Task canvas and contracts | implemented | C-09 |
| REC-D6-GENERATION-007 | workflow | asynchronous generator and critic | implemented | C-10 |
| REC-D6-EXECUTION-008 | execution | persistent DAG and seven stages | scaffolded | C-11 |
| REC-D6-OUTCOME-009 | outcome | Evidence outcome and revocable waiver | scaffolded | C-12 |
| REC-D8-ASSIST-010 | assist | four-scope runtime and event replay | implemented | C-13 |
| REC-D8-ATTACHMENTS-011 | assist | attachments and secure previews | scaffolded | C-14 |
| REC-D8-FILES-012 | assist | files, tests, reversible change batches | scaffolded | C-15 |
| REC-D8-APPROVAL-013 | assist | approval, user input, semantic proposals | scaffolded | C-16 |
| REC-D8-TERMINAL-025 | terminal | native terminal and cursor recovery | verified | C-17 |
| REC-D8-BRIDGE-026 | bridge | Windows Bridge pairing and Git bundle | planned | C-18 |
| REC-D7-REPOSITORY-014 | repository | connections, targets, lines, worktrees | implemented | C-19 |
| REC-D7-DELIVERY-015 | delivery | GitHub Draft PR and merge recovery | scaffolded | C-20 |
| REC-D4-SCOPE-016 | mcp | scope requests, grants, allowlists, revoke | implemented | C-21 |
| REC-D9-CONTEXT-017 | context | tree, versions, selection, Context Pack v5 | implemented | C-22 |
| REC-D9-PROJECTION-018 | context | recoverable projection and index rebuild | implemented | C-23 |
| REC-D9-EVIDENCE-019 | evidence | CAS assets, trace, digest, attestation | scaffolded | C-24 |
| REC-D9-QUALITY-020 | quality | isolated parsers and human threshold | scaffolded | C-25 |
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
| C-01 REC-D0 Governance | /api/v2/system/catalog, /api/v2/system/architecture | governance.plan, governance.catalog, governance.coverage, governance.impact | governance.receipt; inspect -> classified -> passed/failed | schema_meta, schema_migrations, audit_events (scripts/v23-* and feature catalog) | Operations/Governance | Git, CI, receipt store | scripts/v23-plan.mjs, v23-catalog.mjs, v23-coverage.mjs, v23-impact.mjs --audit; docs/evidence/v3-r0-r1-governance-20260810/verification.json | verified; clean gate requires matrix and architecture scan |
| C-02 REC-D1 Contracts | /api/v2/system/schema, /api/v2/operations/{id} | schema.inspect, migration.apply, migration.verify | migration.applied; pending -> applied -> verified/rolled_back | schema_meta, schema_migrations, aggregate_heads (source schema 23 and migration modules) | none | SQLite WAL, CAS | tests/unit/database.test.mjs, migrations.test.mjs, contracts.test.mjs, recovery-golden.test.mjs; same governance Evidence | verified; clean baseline replaces historical chain |
| C-03 REC-D10 Frontend | /api/v2/setup, /api/v2/projects, /api/v2/assist/sessions, /api/v2/events | web.bootstrap, web.route.load, web.replay | ui.session.opened, ui.event.replayed; loading -> ready/error/offline | none (read model over every owned domain) | Setup, Projects, Workflow, Assist, Execution, Assets, Audit, Settings | Browser, offline cache, SSE | apps/web/src/test/workflow.test.tsx, project-onboarding.test.tsx, assist.test.tsx; target browser receipts under docs/evidence/v3-clean | scaffolded; every surface needs behavior, mobile, offline, and Evidence |
| C-04 REC-D2 Identity | /api/v2/account, /api/v2/sessions, /api/v2/actors | actor.update, session.create, session.revoke | actor.updated, session.created, session.revoked; active -> revoked/expired | actors, sessions, connected_accounts (users, sessions, connected_accounts) | Setup and account menu | session store, provider identity | identity-r2-flow, identity-operations, setup-flow tests; docs/evidence/v3-r2-identity-setup-20260810/verification.json | implemented; clean gate adds Team/Actor ACL parity |
| C-05 REC-D2 Setup/Credential | /api/v2/setup, /api/v2/credentials, /api/v2/profiles, /api/v2/integrations/codex, /api/v2/integrations/github | setup.complete, credential.rotate, credential.rebind, profile.probe | setup.completed, credential.created/rotated/revoked, probe.finished; unconfigured -> pending -> validated/rebind_required/failed | credential_refs, provider_profiles, setup_states, operations, operation_events (credential_refs, codex_profiles, setup_states, github_app_configs, github_installations) | Setup, Codex, GitHub App, Credential | Codex Device Auth, GitHub App, Vault, Docker probe | setup-flow, codex-provider-flow, github-provider-flow, github-operations-flow, provider-boundaries, credential security; v3-r2 Evidence | implemented; imported secrets remain rebind_required |
| C-06 REC-D3 Runner | /api/v2/executions/{id}/start, /api/v2/runners/profiles | execution.start, runner.claim, runner.finish | runner.started/completed; job accepted -> leased -> running -> succeeded/failed/expired | runner_profiles, job_specs, runner_receipts, executions, task_attempts (executions, task_attempts) | Execution | Docker Broker, Host Runner, signed Job Spec, fixed digest | tests/security/broker-http.test.mjs, tests/unit/real-runner.test.mjs; target runner receipts | scaffolded; Docker, Host, and credential isolation probes required |
| C-07 REC-D4 MCP | /api/v2/mcp, /api/v2/mcp/tools, /api/v2/mcp/clients, /api/v2/operations/{id} | mcp.tool.call, mcp.client.register, mcp.client.revoke | mcp.tool.called, mcp.client.created/revoked; request -> authorized -> operation -> terminal | mcp_clients, operations, operation_links, events (mcp_clients, exchange_requests, exchange_grants) | MCP Settings | MCP HTTP, stdio, client credentials | mcp-flow, mcp-stdio-r5, context-mcp security, r5-e2e; docs/evidence/v5-r5-context-mcp-20260816/verification.json | implemented; registry parity and Gateway probe required |

## 4. Project, workflow, execution, and outcome

| ID / capability | API v2 | Command | Event / state | Clean tables (historical source) | UI | External | Tests / Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-08 REC-D5 Project/Brief | /api/v2/projects, /api/v2/projects/{id}/intake, /api/v2/projects/{id}/briefs | project.create, intake.submit, intake.retry, brief.confirm | project.created, brief.created; draft -> confirming -> active | projects, project_intakes, briefs, brief_revisions (projects, project_intakes, project_briefs, brief_heads) | Projects, Intake, Brief | local import, optional GitHub source | project-repository-r3, project-repository security, project-onboarding UI, e2e; docs/evidence/v3-r3-project-repository-20260811/verification.json | implemented; clean ACL and revision checks required |
| C-09 REC-D5 Workflow | /api/v2/projects/{id}/workflows, /workflow-drafts, /api/v2/workflows/{id}/graph | workflow.revise, workflow.layout.update, node_contract.update, proposal.apply | workflow.revision.created, layout.created, node_contract.created/updated; draft -> proposed -> active -> superseded | workflows, workflow_nodes, workflow_revisions, node_contracts, aggregate_heads (workflow_revisions, workflow_heads, workflow_drafts, workflow_layout_revisions, node_contracts) | Workflow Canvas, Task Contract | browser layout, repository target read | unit/integration/security workflow-r4, golden r4, workflow UI/e2e; docs/evidence/v4-r4-workflow-generation-critic-20260813/verification.json | implemented; clean graph/head atomicity required |
| C-10 REC-D6 Generation/Critic | /api/v2/projects/{id}/workflow-generations, /api/v2/workflow-generations/{id}/*, /api/v2/workflow-proposals/{id}/apply | generation.start, generation.retry, generation.cancel, generation.apply, critic.evaluate | generation.completed/rejected/failed/cancelled/critic_pending/proposal_created/applied; queued -> running -> critic_pending -> proposed -> applied/rejected | workflow_generations, workflow_generation_proposals, workflow_critic_receipts, operations (workflow_generations, workflow_generation_events, workflow_critic_receipts) | Workflow Replan | Codex generator and independent critic profile | workflow-r4 unit/integration/security, golden r4, workflow UI/e2e; v4 Evidence | implemented; real generator and critic receipts required |
| C-11 REC-D6 Execution | /api/v2/projects/{id}/executions, /api/v2/executions/{id}/start, /pause, /resume, /cancel, /stages/{stage}/replay | execution.start, execution.pause, execution.resume, stage.replay, execution.cancel | execution.stage.changed, task.completed; created -> ready -> running -> paused -> completed/failed/cancelled | executions, execution_inputs, task_attempts, execution_stage_checkpoints, operations (executions, task_attempts, execution_inputs, execution_stage_checkpoints) | Execution, Recovery | signed runner, repository workspace, Context Pack | scheduler-flow, workflow-recovery, v21 stage replay, target seven-stage integration receipt | scaffolded; persistent dispatcher and replay gate required |
| C-12 REC-D6 Outcome | /api/v2/projects/{id}/outcome-requirements, /api/v2/executions/{id}/outcome, /waivers | outcome.evaluate, waiver.grant, waiver.revoke | outcome.evaluated, outcome.waived; pending -> evaluating -> passed/completed_with_gaps/waived/blocked | outcome_requirements, outcome_evaluations, outcome_waivers (outcome_requirements, outcome_evaluations, outcome_waivers) | Outcome, Quality Review | Evidence, rubric policy, human actor | workflow-recovery, v21 outcome tests/UI; target outcome golden and waiver receipt | scaffolded; Evidence-bound score and expiry checks required |

## 5. Assist, files, approval, terminal, and bridge

| ID / capability | API v2 | Command | Event / state | Clean tables (historical source) | UI | External | Tests / Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-13 REC-D8 Assist | /api/v2/assist/sessions, /turns, /follow-ups, /events, /goal, /references | assist.session.create, assist.turn.create, assist.turn.retry, assist.turn.cancel, assist.turn.steer, assist.turn.interrupt | assist.session.created, assist.turn.created/queued/running/completed/failed/cancelled, assist.message; draft -> queued -> running -> awaiting_input -> completed/failed/cancelled | assist_sessions, assist_turns, assist_messages, assist_goals, operations, operation_links, events (assist_sessions, assist_turns, assist_messages, assist_events, assist_operations, assist_session_heads, assist_turn_heads) | Assist Center, Composer, Context Pack, Turn Timeline, Operation Status | Codex app server, isolated profile, SSE | assist-flow, assist-r6, migration unit, assist UI; docs/evidence/v6-r6-assist-20260817/verification.json | implemented; clean operation_links replace historical assist_operations |
| C-14 REC-D8 Attachments | /api/v2/projects/{id}/attachments, /api/v2/attachments/{id}/content, /preview | attachment.create, attachment.preview, attachment.delete | attachment.created; staged -> scanned -> ready/rejected/deleted | attachments, asset_blobs, parser_runs (attachments) | Attachment Tray, previews | MIME scanner, isolated parser, CAS | assist-flow and attachment preview fixtures; target parser Evidence | scaffolded; quota, MIME, SHA, redaction, and all-format probes required |
| C-15 REC-D8 Files/Change Batches | /api/v2/projects/{id}/files, /change-batches, /api/v2/change-batches/{id}/review | file.read, file.save, change_batch.propose, change_batch.apply, change_batch.undo | change_batch.proposed/applied/rolled_back; proposed -> approved -> applied -> undone/expired | file_refs, file_change_batches, file_change_items, assist_checkpoints (file_changes, assist_change_batches, assist_checkpoints) | Monaco, Diff Review | workspace checkout, controlled test runner | file-changes integration, terminal bundle, target stale/CAS tests | scaffolded; before/after hash and stale protection required |
| C-16 REC-D8 Approval/Input/Proposal | /api/v2/approvals, /api/v2/user-inputs, /api/v2/proposals | approval.request, approval.decide, user_input.answer, proposal.apply, proposal.reject | approval.requested/approved/rejected, user_input.requested/answered; pending -> approved/rejected/expired | runtime_approvals, runtime_user_inputs, semantic_proposals (runtime_approvals, runtime_user_inputs, ui_action_intents, change_proposals) | Approval Center, Proposal Drawer, human-input prompt | actor, ACL, optional runner wait | approval-flow, change-proposal, boundary/security tests; target approval Evidence | scaffolded; wait/resume and expected revision required |
| C-17 REC-D8 Terminal | /api/v2/terminals, /api/v2/terminals/{id}/events, /ws, /review | terminal.open, terminal.resize, terminal.signal, terminal.stop, terminal.reconnect | terminal.opened/started/output/resized/signalled/orphaned/closed/failed; requested -> starting -> running -> orphaned/recovered -> closed | terminal_sessions, terminal_events, operations, asset_versions (terminal_sessions) | Terminal panel | node-pty/ConPTY, WebSocket, CAS output | terminal unit/bundle, terminal-flow integration, terminal UI; docs/evidence/v3-terminal-native-20260807/evidence-manifest.json | verified; clean bridge and redaction probes required |
| C-18 REC-D8 Bridge | /api/v2/bridge/pairing, /api/v2/bridge/devices, /api/v2/bridge/transfers | bridge.pair, bridge.rotate, bridge.bundle.send, bridge.bundle.receive | bridge.paired, bridge.bundle.transferred; unpaired -> pairing -> paired -> revoked | bridge_devices, bridge_transfers, operations (host_bridge_devices) | Bridge Settings | independent Windows service, DPAPI, ConPTY, Git bundle | v15 bridge tests are characterization; target Windows external probe and rollback receipt | planned; independent process and signed path/SHA checks required |

## 6. Repository, delivery, MCP scope, context, and projection

| ID / capability | API v2 | Command | Event / state | Clean tables (historical source) | UI | External | Tests / Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-19 REC-D7 Repository | /api/v2/projects/{id}/repository-connections, /repository-lines, /repository-workspaces, /api/v2/repository-workspaces/{id}/* | repository.connect, repository.bind, line.reconcile, workspace.create, workspace.refresh | repository.bound, worktree.created; pending -> ready -> faulted -> recovering -> ready/removed | repository_connections, repository_targets, repository_lines, repository_workspaces, repository_locks (repository_bindings, repository_connections, repository_targets, repository_lines, repository_workspaces) | Repository, Worktree, branch selector | Git, GitHub App, managed checkout, single-writer lease | project-repository-r3, repository security, repository fault/lifecycle suites; v3-r3 Evidence | implemented; clean path policy and lease fencing required |
| C-20 REC-D7 Delivery | /api/v2/deliveries, /api/v2/deliveries/{id}/pull-request, /api/v2/pull-request-intents/{id}/* | delivery.submit, delivery.retry, pr.create, pr.ready, pr.merge, delivery.reconcile | delivery.submitted, delivery.merged; planned -> staging -> checks_pending -> draft_pr -> ready -> merged/needs_reconcile | deliveries, delivery_policies, pull_request_intents, delivery_events (deliveries, delivery_policies, delivery_events, pull_request_intents) | Delivery, Draft PR, Merge Review | GitHub App, checks, webhook, repository head SHA | api-flow, v19 delivery/PR/webhook suites; target GitHub external receipt | scaffolded; real GitHub App, merge race, and recovery receipts required |
| C-21 REC-D4 Scope/Exchange | /api/v2/projects/{id}/exchange-requests, /api/v2/exchange-requests/{id}, /api/v2/exchange-grants/{id}/*, /api/v2/mcp/clients/{id}/revoke | exchange.request, exchange.approve, exchange.revoke, exchange.context_pack.create, mcp.scope.grant | exchange.requested/approved/revoked/expired; requested -> partially_approved -> active -> revoked/expired | exchange_requests, exchange_grants, mcp_clients, gateway_forward_receipts (exchange_requests, exchange_grants, mcp_clients) | MCP Settings, project member permissions | actor/team ACL, MCP client, Gateway | mcp-flow, v19 exchange, context-mcp security, r5-e2e; v5 Evidence | implemented; source/target approval and scope narrowing required |
| C-22 REC-D9 Context | /api/v2/projects/{id}/context/map, /search, /read, /nodes/{id}, /policy, /selections, /packs | context.source.add, context.node.select, context.pack.create, context.policy.update | context_source.created, context.selection.created, context_pack.created, context.rebuilt; source -> indexed -> selected -> packed | context_sources, context_nodes, context_document_versions, context_edges, context_selections, context_packs, context_policies (context_sources, context_nodes, context_document_versions, context_edges, context_selections, context_packs, context_policies, context_policy_heads) | Context Map, Context Pack | isolated index worker, CAS, retrieval policy | context-r5 unit/integration/security, context UI/e2e; docs/evidence/v5-r5-context-mcp-20260816/verification.json | implemented; clean index is a projection, not a second head |
| C-23 REC-D9 Projection | /api/v2/projects/{id}/context/status, /rebuild, /jobs/{id}, /jobs/{id}/events, /cancel, /retry | projection.rebuild, projection.cancel, projection.retry | projection.queued/completed/failed/cancelled; queued -> running -> completed/failed/cancelled | context_projection_jobs, context_index_snapshots, context_summaries, events (context_projection_jobs, context_projection_events, context_index_heads) | Context Map status/recovery | worker lease, index storage, restart | context-recovery, context-r5, security, performance; v5 Evidence | implemented; crash, stale lease, 1000-node replay, and rebuild receipts required |

## 7. Evidence, quality, deployment, operations, and Web

| ID / capability | API v2 | Command | Event / state | Clean tables (historical source) | UI | External | Tests / Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-24 REC-D9 Evidence | /api/v2/projects/{id}/assets, /api/v2/assets/{id}/versions, /content, /api/v2/executions/{id}/evidence | asset.capture, asset.version.create, asset.attest, evidence.link | asset.captured, asset.attested; candidate -> captured -> attested/rejected/tombstoned | assets, asset_versions, asset_blobs, asset_relations, asset_attestations, traces, digests, code_changes (asset_versions, asset_blobs, asset_attestations, asset_relations, traces, digests, code_changes) | Assets, Trace, Digest, Audit | CAS, verifier, secret scanner | real-slice integration, v110 CAS/attestation, security boundary; target CAS manifest and tamper receipt | scaffolded; canonical hash, lineage, and secret scan required |
| C-25 REC-D9 Quality | /api/v2/executions/{id}/quality-reviews, /api/v2/quality-reviews/{id}, /events, /decision | quality.prepare, quality.start, quality.cancel, quality.decision, parser.run, reviewer.run | quality.review.completed; queued -> preparing -> checking -> reviewing -> awaiting_human -> completed/failed/cancelled/stale | quality_review_runs, quality_review_reports, quality_review_events, human_reviews, parser_formats, parser_runs, test_results (quality_review_runs, quality_review_reports, quality_review_events, test_results) | Quality Review, Evidence, rubric editor | isolated parser worker, Docker reviewer, Codex profile, CAS | V23-L1/L3/L4/L5/L6/L7 cases; target quality Evidence and human receipt | scaffolded; all parser formats plus human threshold and stale checks required |
| C-26 REC-D9 Deployment Evidence | /api/v2/executions/{id}/evidence, /api/v2/system/deployment, /api/v2/deployments/{id}/verifications | deployment.verify, browser.capture, viewport.assert | deployment.verified; candidate -> probing -> verified/rejected | deployment_candidates, deployment_verifications, asset_versions, evidence_links (asset_versions, evidence_links) | Evidence, deployment status | browser at desktop/tablet/mobile viewports, Docker/Host runner | scripts/e2e.mjs, release rehearsals; target browser/health/CAS receipt | scaffolded; three viewports, console/layout checks, and attestation required |
| C-27 REC-D11 Operations | /api/v2/system/deployment, /api/v2/backups, /restore, /reset, /imports, /api/v2/operations/{id} | backup.create, backup.restore, import.inspect, import.dry_run, import.run, import.verify, import.cutover, deployment.rollback | operation.pending/running/completed/failed/cancelled, release.gate; import inspected -> dry_run -> running -> verified -> cutover/completed/failed | operations, operation_links, events, audit_events, backup_manifests, import_batches, import_checkpoints, import_id_map, import_conflicts (operations, operation_events, audit_events, import_jobs) | Setup, Recovery, Operations | SQLite/CAS volume, Docker Compose, deployment orchestrator | identity-operations, api-flow, release-gate, release-rehearsal-compose, boundary security; target cutover and rollback receipts | scaffolded; importer and actual volume rollback required |

### 7.1 Current Evidence snapshot

The paths below are copied from the current root Catalog. A value of none is
intentional and keeps a scaffolded capability below implemented.

| Current Catalog id | Current Evidence | Promotion gap |
| --- | --- | --- |
| REC-D0-GOVERNANCE-000 | docs/evidence/v3-r0-r1-governance-20260810/verification.json | clean architecture scan and v3-clean receipt |
| REC-D1-CONTRACTS-023 | docs/evidence/v3-r0-r1-governance-20260810/verification.json | clean baseline checksum and importer proof |
| REC-D10-FRONTEND-024 | none | complete Web workflow, mobile/offline, SSE receipt |
| REC-D2-IDENTITY-001 | docs/evidence/v3-r2-identity-setup-20260810/verification.json | Team/Actor and API v2 parity |
| REC-D2-SETUP-002 | docs/evidence/v3-r2-identity-setup-20260810/verification.json | rebind, rotation, and external provider receipts |
| REC-D3-RUNNER-003 | none | Docker, Host, signed Job Spec, and isolation probes |
| REC-D4-MCP-004 | docs/evidence/v5-r5-context-mcp-20260816/verification.json | API v2 registry and Gateway parity |
| REC-D5-PROJECT-005 | docs/evidence/v3-r3-project-repository-20260811/verification.json | clean ACL/CAS and importer mapping |
| REC-D5-WORKFLOW-006 | docs/evidence/v4-r4-workflow-generation-critic-20260813/verification.json | clean aggregate head and revision receipt |
| REC-D6-GENERATION-007 | docs/evidence/v4-r4-workflow-generation-critic-20260813/verification.json | real generator/critic external receipt |
| REC-D6-EXECUTION-008 | none | seven-stage dispatcher, replay, pause/resume |
| REC-D6-OUTCOME-009 | none | Evidence-bound score, waiver, and stale reevaluation |
| REC-D8-ASSIST-010 | docs/evidence/v6-r6-assist-20260817/verification.json | generic operations/event model and ACL replay |
| REC-D8-ATTACHMENTS-011 | none | all-format parser, quota, preview, and redaction proof |
| REC-D8-FILES-012 | none | CAS change batch, stale protection, apply/undo proof |
| REC-D8-APPROVAL-013 | none | wait/resume, expected revision, and audit proof |
| REC-D8-TERMINAL-025 | docs/evidence/v3-terminal-native-20260807/evidence-manifest.json | Bridge separation and clean event cursor |
| REC-D8-BRIDGE-026 | none | independent Windows process, pairing, bundle, rollback |
| REC-D7-REPOSITORY-014 | docs/evidence/v3-r3-project-repository-20260811/verification.json | clean lease/path policy and provider probe |
| REC-D7-DELIVERY-015 | none | GitHub App, webhook, merge race, recovery |
| REC-D4-SCOPE-016 | docs/evidence/v5-r5-context-mcp-20260816/verification.json | Team/Actor, Exchange, and Gateway scope probe |
| REC-D9-CONTEXT-017 | docs/evidence/v5-r5-context-mcp-20260816/verification.json | clean projection/index and importer closure |
| REC-D9-PROJECTION-018 | docs/evidence/v5-r5-context-mcp-20260816/verification.json | crash/restart/1000-node replay proof |
| REC-D9-EVIDENCE-019 | none | CAS, attestation, lineage, and secret scan |
| REC-D9-QUALITY-020 | none | parser breadth, human threshold, and stale proof |
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
| Team and multi-Actor | /api/v2/teams, /api/v2/projects/{id}/members; team.create, membership.grant, actor.switch | team.created, membership.granted/revoked; invited -> active -> suspended/revoked | actors, teams, team_memberships, project_memberships, invitations | Team/Member Settings | session/service identity | V19 ACL/parity and project-isolation suites; target Team ACL receipt |
| Project ACL and Exchange | /api/v2/projects/{id}/permissions, /exchange-requests; acl.evaluate, exchange.approve | acl.decided, exchange.requested/approved/revoked; requested -> active -> expired/revoked | project_acl_entries, exchange_requests, exchange_grants | Permissions, MCP Settings | actor/team policy | V19 exchange/ACL tests, V5 context-MCP security; target cross-project denial receipt |
| MCP Gateway | /api/v2/gateway/forward; gateway.forward | gateway.forwarded/denied; received -> scoped -> forwarded/denied | gateway_forward_receipts, events | Gateway Administration | separate process, signed client, no Docker socket | V18 gateway auth/flow tests; target independent Gateway probe |
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
