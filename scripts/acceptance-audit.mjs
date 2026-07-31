import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const checks = [
  ['V1.2 dev plan', '开发计划v1.2.md', '相对 `开发计划v1.1.md`'],
  ['V1.3 dev plan', '开发计划v1.3.md', '相对 `开发计划v1.2.md`'],
  ['V1.4 dev plan', '开发计划v1.4.md', '完全容器化增量'],
  ['V1.5 dev plan', '开发计划v1.5.md', 'state schema 14'],
  ['V1.5 test plan', '测试计划v1.5.md', 'Windows Native Bridge 测试'],
  ['V1.6 dev plan', '开发计划v1.6.md', 'V1.6-14'],
  ['V1.6 test plan', '测试计划v1.6.md', 'P0/P1 用例必须 100%'],
  ['V1.6 cutover appendix', 'docs/v1.6-cutover.md', '27810352c6abe6b36c5be57c17c375acce8571b2b1b262050e8e6b1b6f85f48f'],
  ['V1.7 dev plan', '开发计划v1.7.md', 'state schema 16'],
  ['V1.7 test plan', '测试计划v1.7.md', '四种组合'],
  ['V1.7 cutover guide', 'docs/v1.7-cutover.md', 'aiws-data-v17'],
  ['V1.8 Focus OS UI design', 'docs/v1.8-focus-os-ui-design.md', '单一上下文轨道'],
  ['V1.8 dev plan', '开发计划v1.8.md', 'state schema：`17`'],
  ['V1.8 test plan', '测试计划v1.8.md', 'test:v18:mcp-journey'],
  ['V2.1 dev plan', '开发计划v2.1.md', 'DEV210-14'],
  ['V2.1 test plan', '测试计划v2.1.md', 'L7 Release'],
  ['V2.2 dev plan', '开发计划v2.2.md', 'OPT22-01'],
  ['V2.2 test plan', '测试计划v2.2.md', 'L7 Release'],
  ['V1.8 cutover guide', 'docs/v1.8-cutover.md', 'aiws-data-v18'],
  ['Collaborative MCP architecture', 'docs/mcp-collaboration-architecture.md', 'Team Single Node'],
  ['Production Dockerfile', 'Dockerfile', 'FROM workspace-deps AS verify'],
  ['Offline native Node headers', 'Dockerfile', 'npm_config_nodedir=/usr/local'],
  ['Windows Bridge export', 'Dockerfile', 'FROM scratch AS windows-bridge-export'],
  ['Validated archive creation', 'docker/backup_archive.py', 'def create_archive'],
  ['Safe archive sanitization', 'docker/backup_archive.py', 'def sanitize_archive'],
  ['Transient Codex backup exclusion', 'docker/backup_archive.py', 'def transient_codex_path'],
  ['Safe relative symlink restore', 'docker/backup_archive.py', 'target.symlink_to(member.linkname)'],
  ['Release volume audit', 'docker/release_volume.mjs', 'source_changed_after_clone'],
  ['Release clone orchestration', 'docker/release_orchestrator.mjs', 'initializeFromSource'],
  ['Offline verify refresh', 'docker/verify-refresh.Dockerfile', 'pnpm install --offline --frozen-lockfile'],
  ['Failed cutover preservation', 'docker/release_orchestrator.mjs', 'failed_source_preserved'],
  ['Legacy purge confirmation', 'docker/release_volume.mjs', 'purge_legacy_requires_confirm'],
  ['V2.2 Compose', 'compose.yml', 'aiws-app:2.2.0'],
  ['Schema 18 migration', 'apps/api/src/state-migration-v18.mjs', 'STATE_SCHEMA_VERSION = 18'],
  ['Schema 19 migration', 'apps/api/src/state-migration-v19.mjs', 'STATE_SCHEMA_VERSION = 19'],
  ['Schema 20 migration', 'apps/api/src/state-migration-v20.mjs', 'STATE_SCHEMA_VERSION = 20'],
  ['Schema 21 migration', 'apps/api/src/state-migration-v21.mjs', 'STATE_SCHEMA_VERSION = 21'],
  ['Schema 22 migration', 'apps/api/src/state-migration-v22.mjs', 'STATE_SCHEMA_VERSION = 22'],
  ['SQLite state Worker', 'apps/api/src/state-store-worker.mjs', "from 'node:sqlite'"],
  ['SQLite state facade', 'apps/api/src/state-store.mjs', 'initializeStateStore'],
  ['Runtime readiness', 'apps/api/src/runtime-health.mjs', 'readyzSnapshot'],
  ['Shutdown coordinator', 'apps/api/src/shutdown-coordinator.mjs', 'createShutdownCoordinator'],
  ['Deterministic Context index runtime', 'apps/api/src/context-index-runtime.mjs', 'minisearch-v2.json'],
  [
    'System context protocol',
    'packages/system-context/src/protocol.mjs',
    "CONTEXT_PACK_SCHEMA = 'aiws.context_pack.v5'"
  ],
  ['Context projection materializer', 'apps/api/src/context-projection.mjs', 'materializeContextDocumentsInState'],
  ['Context projection retention', 'apps/api/src/context-projection.mjs', 'collectContextVersions'],
  ['Context resource adapters', 'apps/api/src/context-resource-adapters.mjs', 'refreshContextResourcesInState'],
  ['Context REST service', 'apps/api/src/context-service.mjs', 'context_projection_unavailable'],
  ['Context REST routes', 'apps/api/src/routes/context-v20.mjs', '/context/v1/rebuild'],
  ['Immutable asset CAS', 'apps/api/src/asset-cas.mjs', 'createImmutableAssetVersion'],
  ['Atomic asset attestation', 'apps/api/src/asset-attestation-service.mjs', 'attestAssetVersionInState'],
  ['Workflow execution state machine', 'apps/api/src/workflow-execution-domain.mjs', 'TASK_EXECUTION_STATUSES'],
  ['Persistent DAG dispatcher', 'apps/api/src/workflow-dispatcher.mjs', 'scheduleWorkflowExecution'],
  ['Repository Line provisioning', 'apps/api/src/repository-line-service.mjs', 'provisionRepositoryLine'],
  ['Two-level workflow domain', 'apps/api/src/workflow-hierarchy-domain.mjs', 'TASKS_PER_WORKSTREAM_LIMIT = 12'],
  [
    'Workflow generation service',
    'apps/api/src/workflow-generation-service.mjs',
    'critiqueWorkflowGenerationCandidate'
  ],
  ['Workstream and task graph routes', 'apps/api/src/routes/workflow-v19.mjs', '/workflows/:id/graph-proposals'],
  ['Multi-repository delivery', 'apps/api/src/delivery-service.mjs', 'draft_pr'],
  ['Semantic workflow migration', 'apps/api/src/workflow-migration-service.mjs', 'validateLegacyMigrationMapping'],
  ['V1.10 historical release entry', 'scripts/v110-release.mjs', 'runV110UpgradeCli'],
  ['V2.0 release entry', 'scripts/v20-release.mjs', 'runV20UpgradeCli'],
  ['V2.1 release entry', 'scripts/v21-release.mjs', 'runV21UpgradeCli'],
  ['V2.2 release entry', 'scripts/v22-release.mjs', 'runV22UpgradeCli'],
  ['V2.0 read-only clone', 'docker/v20-upgrade.mjs', "source_mount_mode: 'readonly'"],
  ['V2.1 read-only clone', 'docker/v21-upgrade.mjs', "source_mount_mode: 'readonly'"],
  ['V2.2 read-only clone', 'docker/v22-upgrade.mjs', "source_mount_mode: 'readonly'"],
  ['Runner image', 'docker/codex-runner.Dockerfile', 'ARG CODEX_VERSION=0.144.0'],
  ['PowerShell bridge operations', 'scripts/aiws.ps1', "@('install','start','stop','status','uninstall')"],
  ['PowerShell backup validation', 'scripts/aiws.ps1', 'backup_validation_failed'],
  ['PowerShell verify cache validation', 'scripts/aiws.ps1', 'cmp -s /app/pnpm-lock.yaml'],
  ['POSIX V2.2 upgrade entry', 'scripts/aiws.sh', 'v22-release.mjs'],
  ['PowerShell V2.2 upgrade entry', 'scripts/aiws.ps1', 'v22-release.mjs'],
  ['Setup guard', 'apps/web/src/app/setup-guard.tsx', '<Navigate to="/setup"'],
  ['GitHub App JWT', 'apps/api/src/github-service.mjs', 'createAppJwt'],
  ['GitHub webhook', 'apps/api/src/routes/github-webhook-v12.mjs', 'timingSafeEqual'],
  ['Secret vault', 'apps/api/src/vault.mjs', 'vault:'],
  ['Codex profile home', 'apps/api/src/codex-service.mjs', 'CODEX_HOME'],
  ['Codex local discovery', 'apps/api/src/routes/codex-discovery-v12.mjs', '/codex/discovery/import'],
  ['Async Codex build manager', 'apps/api/src/codex-build-service.mjs', 'class CodexBuildManager'],
  ['Codex build SSE replay', 'apps/api/src/routes/codex-runtime-v12.mjs', "'snapshot'"],
  ['Codex build cancellation', 'apps/api/src/routes/codex-runtime-v12.mjs', '/codex/docker/builds/:id/cancel'],
  ['Async Docker status cache', 'apps/api/src/codex-runtime-status.mjs', 'inspectCodexRuntimeCached'],
  ['Managed realpath barrier', 'apps/api/src/managed-workspace.mjs', 'realPathWithin'],
  ['File traversal guard', 'apps/api/src/file-service.mjs', 'path_outside_repository'],
  ['Assist V3 routes', 'apps/api/src/routes/assist-v3.mjs', '/assist/v3/sessions/:id/follow-ups'],
  ['Assist V3 replay', 'apps/api/src/assist-v3-events.mjs', 'last-event-id'],
  ['Codex app-server', 'apps/api/src/codex-app-server.mjs', "appServerRequest(context, 'turn/start'"],
  ['Native collaboration mode', 'apps/api/src/codex-app-server.mjs', 'collaborationMode: nativeCollaborationMode'],
  ['Application context channel', 'apps/api/src/assist-v3-context.mjs', "return [{ kind: 'application'"],
  ['App-server-only Assist', 'apps/api/src/assist-v3-runtime.mjs', 'runCodexAppServer'],
  ['Raw model catalog', 'apps/api/src/assist-models.mjs', "method: 'model/list'"],
  ['Reasoning catalog passthrough', 'apps/api/src/assist-models.mjs', 'supportedReasoningEfforts'],
  ['Assist configuration CRUD', 'apps/api/src/routes/assist-v3.mjs', "'PATCH', '/assist/v3/configurations/:id'"],
  ['Native Goal RPC', 'apps/api/src/assist-goals.mjs', "'thread/goal/set'"],
  ['Session coordinator', 'apps/api/src/assist-session-coordinator.mjs', 'coordinateAssistSession'],
  ['Native user input', 'apps/api/src/codex-app-server.mjs', 'item/tool/requestUserInput'],
  [
    'Secret answers memory-only',
    'apps/api/src/assist-user-input.mjs',
    'deliberately never passed through state/event/logging'
  ],
  ['Schema 14 migration', 'apps/api/src/state-migration-v14.mjs', 'STATE_SCHEMA_VERSION = 14'],
  ['Schema 14 collections', 'apps/api/src/state-migration-v14.mjs', 'host_bridge_devices'],
  ['Atomic migration backup', 'apps/api/src/state-migration-v14.mjs', 'migration_failed_and_backup_corrupt'],
  ['Schema 15 migration', 'apps/api/src/state-migration-v15.mjs', 'STATE_SCHEMA_VERSION = 15'],
  ['Schema 16 migration', 'apps/api/src/state-migration-v16.mjs', 'STATE_SCHEMA_VERSION = 16'],
  ['Schema 17 migration', 'apps/api/src/state-migration-v17.mjs', 'STATE_SCHEMA_VERSION = 17'],
  ['MCP route registry', 'apps/api/src/api-route-registry.mjs', 'createApiRouteRegistry'],
  ['MCP Streamable HTTP runtime', 'apps/api/src/mcp-http-runtime.mjs', 'StreamableHTTPServerTransport'],
  ['MCP server tools', 'apps/api/src/mcp-server-factory.mjs', "'aiws_execute'"],
  ['MCP context tool', 'apps/api/src/mcp-server-factory.mjs', "'aiws_context'"],
  ['MCP token governance', 'apps/api/src/mcp-client-service.mjs', 'token_hash'],
  ['MCP subject attribution', 'apps/api/src/mcp-client-service.mjs', 'subject_user_id'],
  ['MCP Gateway HMAC', 'packages/mcp-bridge/src/gateway-auth.mjs', 'gateway_signature_replayed'],
  ['MCP Gateway protocol termination', 'apps/mcp-gateway/src/runtime.mjs', 'StreamableHTTPServerTransport'],
  ['MCP collaboration Compose', 'compose.collaboration.yml', 'aiws-mcp-gateway:2.2.0'],
  ['Brief V2 domain', 'apps/api/src/brief-workflow-domain.mjs', 'schema_version: 2'],
  ['Brief revision operations', 'apps/api/src/project-brief-service.mjs', 'expected_revision'],
  ['Workflow draft persistence', 'apps/api/src/workflow-draft-service.mjs', 'workflow_draft_revision_conflict'],
  ['Assist capability manifest', 'packages/shared/src/assist-capabilities.mjs', 'ASSIST_CAPABILITY_MANIFEST'],
  ['Manifest project tool generation', 'apps/api/src/assist-project-tool-spec.mjs', 'projectCapabilityToolSpec'],
  [
    'Manifest project tool execution',
    'apps/api/src/assist-project-operation-ledger.mjs',
    'handleProjectCapabilityTool'
  ],
  [
    'Server capability operation isolation',
    'apps/api/src/assist-operation-metadata.mjs',
    "item.execution_layer !== 'server'"
  ],
  ['Assist capability route', 'apps/api/src/routes/assist-v3.mjs', "'GET', '/assist/v3/capabilities'"],
  ['Clarification policy route', 'apps/api/src/routes/assist-v3.mjs', "'PATCH', '/assist/v3/sessions/:id'"],
  ['Targeted operation revisions', 'apps/api/src/routes/assist-v3.mjs', '/assist/v3/operations/:id/revisions'],
  ['Brief template routes', 'apps/api/src/routes/project-onboarding-v13.mjs', '/brief-templates'],
  ['Workflow draft routes', 'apps/api/src/routes/project-onboarding-v13.mjs', '/workflow-draft'],
  ['Official Runner normalization', 'apps/api/src/state-migration-v15.mjs', 'LEGACY_OFFICIAL_RUNNER_PATTERN'],
  ['Shared Fork isolation', 'apps/api/src/state-migration-v15.mjs', 'historical_shared_codex_thread_id'],
  ['Native thread Fork', 'apps/api/src/assist-session-lifecycle.mjs', "method: 'thread/fork'"],
  ['Root delete protection', 'apps/api/src/assist-session-lifecycle.mjs', 'assist_root_session_not_deletable'],
  ['Delete batch restore', 'apps/api/src/routes/assist-v3.mjs', '/restore-deleted'],
  ['Ephemeral BTW', 'apps/api/src/codex-ephemeral-thread.mjs', "ephemeralRequest(context, 'thread/fork'"],
  ['BTW memory lifecycle', 'apps/api/src/assist-btw.mjs', 'BTW_GLOBAL_LIMIT = 4'],
  ['Streaming upload', 'apps/api/src/assist-attachments.mjs', 'streamMultipartFile'],
  ['Attachment Range', 'apps/api/src/assist-attachments.mjs', 'parseSingleRange'],
  ['Reference candidates', 'apps/api/src/assist-references.mjs', 'listAssistReferences'],
  ['Native mention input', 'apps/api/src/assist-v3-context.mjs', "type: 'mention'"],
  ['Context menu registry', 'apps/web/src/components/common/ContextMenu.tsx', 'ContextMenuResolver'],
  ['Unified Tooltip', 'apps/web/src/components/common/Tooltip.tsx', 'data-tooltip'],
  ['Operation diagnostics provider', 'apps/web/src/operations/OperationFeedback.tsx', 'OperationFeedbackProvider'],
  ['Session-only operation history', 'apps/web/src/operations/operation-store.ts', 'aiws-operation-diagnostics-v1'],
  ['Request ID client protocol', 'apps/web/src/api/client.ts', "headers.set('x-aiws-request-id'"],
  ['Composer commands', 'apps/web/src/features/assist/composer-support.ts', "['btw'"],
  ['Long paste boundary', 'apps/web/src/features/assist/useComposerFiles.ts', 'LONG_PASTE_THRESHOLD = 8000'],
  ['Lazy preview engines', 'apps/web/src/features/assist/AttachmentPreview.tsx', "lazy(() => import('./PdfPreview'))"],
  ['Bundle budgets', 'scripts/bundle-budget.mjs', '300 * 1024'],
  ['Change batches', 'apps/api/src/assist-change-batches.mjs', 'assist_change_batch_locked'],
  ['Batch checkpoints', 'apps/api/src/assist-change-batches.mjs', 'state.assist_checkpoints.push'],
  ['Batch review API', 'apps/api/src/routes/assist-v3.mjs', '/assist/v3/change-batches/:id/review/apply'],
  ['Dynamic page tools', 'apps/api/src/assist-operations.mjs', "name: 'aiws_page'"],
  ['Operation conflict response', 'apps/api/src/assist-operation-waiters.mjs', 'assist_operation_undo_conflict'],
  ['Operation conflict values', 'apps/api/src/assist-operations.mjs', 'before: reference?.before_value ?? null'],
  ['Conflict retry', 'apps/api/src/assist-operation-revision.mjs', 'retryingConflict ? original.current_hash'],
  ['Compensating Undo', 'apps/api/src/assist-operations.mjs', 'inverse_of: original.id'],
  ['Terminal capabilities', 'apps/api/src/routes/terminal-v13.mjs', '/assist/v3/terminal-capabilities'],
  ['Host Bridge pairing', 'apps/api/src/routes/host-bridge-v15.mjs', '/assist/v3/host-bridge/pairing'],
  ['One-time pairing secret', 'apps/api/src/routes/host-bridge-v15.mjs', 'sendOneTimeSecret'],
  ['Host Bridge round trip', 'apps/api/src/host-bridge-service.mjs', 'workspace_return_begin'],
  ['Bundle fsck', 'apps/api/src/host-bridge-workspace.mjs', "['fsck', '--strict'"],
  ['Bundle symlink guard', 'apps/api/src/host-bridge-workspace.mjs', 'host_bridge_bundle_symlink_rejected'],
  ['Bundle case collision guard', 'apps/api/src/host-bridge-workspace.mjs', 'host_bridge_bundle_case_collision'],
  ['Windows DPAPI CurrentUser', 'bridge/dpapi_windows.go', 'DPAPI is bound to Windows CurrentUser'],
  ['Windows ConPTY', 'bridge/main.go', 'conpty.Start'],
  ['Windows loopback-only bridge', 'bridge/main.go', 'parsed.Hostname() != "127.0.0.1"'],
  ['Desktop composer model', 'apps/web/src/features/assist/AssistComposerControls.tsx', 'composer-text-control'],
  ['One-shot Plan UI', 'apps/web/src/features/assist/AssistComposerControls.tsx', 'composer-plan-toggle'],
  ['Goal card', 'apps/web/src/features/assist/AssistWorkbench.tsx', '<GoalCard'],
  ['Runtime details disclosure', 'apps/web/src/features/assist/TurnRuntimeDetails.tsx', '运行详情'],
  ['Clarification control', 'apps/web/src/features/assist/AssistComposerControls.tsx', 'clarification-segment'],
  ['Independent Plan control', 'apps/web/src/features/assist/AssistComposerControls.tsx', 'composer-plan-toggle'],
  ['Brief V2 workspace', 'apps/web/src/features/projects/onboarding/BriefWorkspaceChrome.tsx', 'brief-mobile-tabs'],
  ['Runtime chooser', 'apps/web/src/features/assist/AssistWorkbench.tsx', '<TerminalRuntimeSelector'],
  ['Request user input UI', 'apps/web/src/features/assist/UserInputCard.tsx', 'Codex 需要你的输入'],
  ['Forced Undo confirmation', 'apps/web/src/features/assist/OperationReceipt.tsx', '确认强制撤回'],
  ['Dock resize handle', 'apps/web/src/features/assist/AssistWorkbench.tsx', 'assist-dock-resizer'],
  ['Real PTY transport', 'apps/api/src/terminal-service.mjs', 'WebSocketServer'],
  ['V1.5 core unit', 'tests/unit/v15-core.test.mjs', 'V1.5 core unit tests passed'],
  ['V1.5 operations unit', 'tests/unit/v15-operations.test.mjs', 'V1.5 operation ledger unit tests passed'],
  ['V1.5 Bridge unit', 'tests/unit/v15-change-bridge.test.mjs', 'V1.5 change batch and Host Bridge unit tests passed'],
  [
    'V1.5 Assist integration',
    'tests/integration/v15-native-assist-flow.test.mjs',
    'V1.5 native Assist integration tests passed'
  ],
  [
    'V1.5 Bridge integration',
    'tests/integration/v15-host-bridge-flow.test.mjs',
    'V1.5 Windows Host Bridge integration tests passed'
  ],
  ['V1.5 Web interactions', 'apps/web/src/test/assist-v15-interactions.test.tsx', 'Assist V1.5 interactions'],
  ['V1.6 core unit', 'tests/unit/v16-core.test.mjs', 'V1.6 core unit tests passed'],
  ['V1.6 release unit', 'tests/unit/v16-release.test.mjs', 'V1.6 release volume unit tests passed'],
  [
    'V1.6 release Docker flow',
    'tests/release/v16-volume-flow.test.mjs',
    'V1.6 Docker release volume flow tests passed'
  ],
  [
    'V1.6 Assist files integration',
    'tests/integration/v16-assist-files-flow.test.mjs',
    'V1.6 Assist files and native Fork integration tests passed'
  ],
  [
    'V1.6 Web interactions',
    'apps/web/src/test/assist-v16-interactions.test.tsx',
    'Assist V1.6 context, threads, and composer input'
  ],
  ['V1.7 core unit', 'tests/unit/v17-core.test.mjs', 'V1.7 core unit tests passed'],
  ['V1.7 release primitives', 'tests/unit/v17-release.test.mjs', 'V1.7 release primitive compatibility tests passed'],
  [
    'V1.7 Assist and Brief integration',
    'tests/integration/v17-assist-brief-flow.test.mjs',
    'V1.7 Assist, Brief, and Workflow integration tests passed'
  ],
  ['V1.7 Web interactions', 'apps/web/src/test/assist-v17-interactions.test.tsx', 'Assist V1.7 interactions'],
  [
    'V1.7 Docker release volume flow',
    'tests/release/v17-volume-flow.test.mjs',
    'V1.7 Docker release volume flow tests passed'
  ],
  ['V1.8 MCP journey', 'tests/e2e/v18-mcp-journey.test.mjs', 'V1.8 MCP-only legacy execution rejection journey passed'],
  [
    'V1.8 MCP Gateway contract',
    'tests/integration/v18-mcp-gateway-flow.test.mjs',
    'collaborative MCP Gateway integration tests passed'
  ],
  ['V1.8 release volume flow', 'tests/release/v18-volume-flow.test.mjs', 'V1.8 release volume flow tests passed'],
  ['V1.8 MCP Settings UI', 'apps/web/src/test/settings-mcp-v18.test.tsx', 'V1.8 MCP client settings'],
  [
    'V1.9 hierarchy unit',
    'tests/unit/v19-core.test.mjs',
    'V1.9 hierarchy, revision, and Assist scope unit tests passed'
  ],
  [
    'V1.9 migration unit',
    'tests/unit/v19-migration.test.mjs',
    'V1.9 state and semantic workflow migration unit tests passed'
  ],
  ['V1.9 MCP registry unit', 'tests/unit/v19-mcp-registry.test.mjs', 'V1.9 MCP route registry unit tests passed'],
  ['V1.9 catalog runner', 'scripts/v19-runner.mjs', '测试结果v1.9.md'],
  ['V1.9 live MCP journey', 'scripts/mcp-live-project-smoke.mjs', 'AIWS_MCP_LIVE_SMOKE_CONFIRM'],
  ['Codex 30 minute timeout policy', 'packages/shared/src/codex.mjs', 'DEFAULT_CODEX_TIMEOUT_MS = 30 * 60_000'],
  ['GitHub device MCP action', 'apps/api/src/routes/github-config-v12.mjs', "type: 'github_device_authorization'"],
  [
    'V1.9 generation integration',
    'tests/integration/v19-workflow-generation-flow.test.mjs',
    'V1.9 asynchronous workflow generation integration tests passed'
  ],
  [
    'V1.9 Delivery integration',
    'tests/integration/v19-delivery-flow.test.mjs',
    'V1.9 multi-task Delivery integration tests passed'
  ],
  ['V1.9 release volume flow', 'tests/release/v19-volume-flow.test.mjs', 'V1.9 release volume flow tests passed'],
  ['V1.10 CAS unit', 'tests/unit/v110-cas.test.mjs', 'V1.10 CAS immutability and tamper detection unit tests passed'],
  [
    'V1.10 DAG integration',
    'tests/integration/v110-workflow-execution-flow.test.mjs',
    'V1.10 persistent DAG, CAS, same-SHA verification, and PR integration flow passed'
  ],
  [
    'V1.10 in-place release flow',
    'tests/release/v110-in-place-flow.test.mjs',
    'V1.10 in-place volume backup and app-only replacement tests passed'
  ],
  ['V1.10 browser DAG journey', 'tests/e2e/v110-workflow-journey.test.mjs', 'assertWriteJourney'],
  ['V2.0 plan gate', 'scripts/v20-plan.mjs', 'V2.0 historical compatibility validation passed'],
  ['V2.0 catalog gate', 'scripts/v20-catalog.mjs', 'V2.0 historical catalog validation passed'],
  ['V2.0 coverage gate', 'scripts/v20-coverage.mjs', 'V2.0 coverage gate passed'],
  ['V2.0 impact gate', 'scripts/v20-impact.mjs', 'V2.0 impact'],
  ['V2.0 protocol unit', 'tests/unit/v20-system-context.test.mjs', 'V2.0 system context protocol unit tests passed'],
  ['V2.0 Context Pack unit', 'tests/unit/v20-context-pack.test.mjs', 'V2.0 Context Pack v4'],
  ['V2.0 MCP context unit', 'tests/unit/v20-mcp-context.test.mjs', 'V2.0 MCP context tool'],
  ['V2.0 migration unit', 'tests/unit/v20-migration.test.mjs', 'V2.0 schema migration'],
  ['V2.0 context security integration', 'tests/integration/v20-context-flow.test.mjs', 'protectedProjectionData'],
  ['V2.0 Context Map UI', 'apps/web/src/features/context/ContextMapPage.tsx', '上下文地图'],
  ['V2.0 six-viewport browser', 'tests/e2e/v20-context-map-browser.test.mjs', 'V2.0 Context Map six-viewport'],
  ['V2.0 10k performance', 'tests/unit/v20-context-performance.test.mjs', 'V2.0 10k context performance'],
  [
    'V2.0 read-only release flow',
    'tests/release/v20-volume-flow.test.mjs',
    'V2.0 read-only clone, projection acceptance, source retention, and rollback tests passed'
  ],
  ['V2.1 plan gate', 'scripts/v21-plan.mjs', 'V2.1 plan validation passed'],
  ['V2.1 catalog gate', 'scripts/v21-catalog.mjs', 'V2.1 catalog validation passed'],
  ['V2.1 coverage gate', 'scripts/v21-coverage.mjs', 'V2.1 coverage gate passed'],
  ['V2.1 impact gate', 'scripts/v21-impact.mjs', 'V2.1 impact'],
  ['V2.1 execution protocol', 'tests/unit/v21-execution-protocol.test.mjs', 'Deployment Evidence v2'],
  ['V2.1 Outcome contract', 'tests/unit/v21-outcome.test.mjs', 'DesignSignal fixture'],
  ['V2.1 stage replay', 'tests/unit/v21-stage-replay.test.mjs', 'replay identity'],
  ['V2.1 Context v5', 'tests/unit/v21-context.test.mjs', 'Context Pack v5'],
  ['V2.1 schema migration', 'tests/unit/v21-migration.test.mjs', 'schema 20 migration'],
  ['V2.1 replay integration', 'tests/integration/v21-stage-replay-flow.test.mjs', 'replayed verify only'],
  ['V2.1 Outcome UI', 'apps/web/src/features/workflow/WorkflowOutcomePanel.tsx', '创建 Outcome waiver'],
  ['V2.1 stage timeline UI', 'apps/web/src/features/workflow/TaskStageTimeline.tsx', 'replay'],
  ['V2.1 browser journey', 'tests/e2e/v21-outcomes-browser.test.mjs', 'viewports = ['],
  ['V2.1 security', 'tests/unit/v21-security.test.mjs', 'secret sentinel'],
  ['V2.1 performance', 'tests/unit/v21-performance.test.mjs', '10k Context'],
  ['V2.1 soak', 'tests/v21/soak.test.mjs', 'concurrent checkpoint/projector soak'],
  [
    'V2.1 read-only release flow',
    'tests/release/v21-volume-flow.test.mjs',
    'V2.1 read-only clone, Outcome/Context acceptance, source retention, and rollback tests passed'
  ],
  ['V2.2 plan gate', 'scripts/v22-plan.mjs', 'V2.2 plan validation passed'],
  ['V2.2 catalog gate', 'scripts/v22-catalog.mjs', 'V2.2 catalog validation passed'],
  ['V2.2 coverage gate', 'scripts/v22-coverage.mjs', 'V2.2 coverage gate passed'],
  ['V2.2 committed impact gate', 'scripts/v22-impact.mjs', 'base_sha'],
  ['V2.2 SQLite state tests', 'tests/unit/v22-state-store.test.mjs', 'SQLite'],
  ['V2.2 projector and index tests', 'tests/unit/v22-projector-index.test.mjs', 'snapshot'],
  ['V2.2 health and shutdown tests', 'tests/unit/v22-health-shutdown.test.mjs', 'shutdown coordinator'],
  ['V2.2 impact tests', 'tests/unit/v22-impact.test.mjs', 'committed'],
  [
    'V2.2 read-only release flow',
    'tests/release/v22-volume-flow.test.mjs',
    'V2.2 read-only V21 clone, idempotent SQLite migration, persistence and V21 refusal tests passed'
  ],
  ['Interaction audit', 'tests/e2e/smoke.test.mjs', 'auditButtons']
];

for (const [name, file, needle] of checks) {
  assert.ok(fs.existsSync(file), `${name}: ${file} exists`);
  assert.ok(fs.readFileSync(file, 'utf8').includes(needle), `${name}: contains ${needle}`);
}

for (const removed of [
  'apps/api/src/routes/demo.mjs',
  'tests/integration/demo-flow.test.mjs',
  'apps/web/app.js',
  'apps/web/boot.js',
  'apps/web/src/features/assist/ActivityLedger.tsx'
])
  assert.equal(fs.existsSync(removed), false, `${removed} removed`);
const runtimeFiles = [...walk('apps'), ...walk('packages')].filter(
  (file) => /\.(mjs|js|ts|tsx|html|css|json)$/.test(file) && !file.includes(`${path.sep}dist${path.sep}`)
);
const runtime = runtimeFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
for (const forbidden of [
  '/demo/full-chain',
  'MockRunner',
  'mock_runner',
  '生成演示链路',
  '<aiws_actions>',
  'transport_fallback'
])
  assert.equal(runtime.includes(forbidden), false, `production runtime excludes ${forbidden}`);
assert.equal(runtime.includes('buildAssistResult'), false, 'production runtime excludes fixed-rule Assist');
assert.equal(
  runtime.includes('codexProfileFromCcSwitch'),
  false,
  'production runtime excludes fake cc-switch Profiles'
);
assert.ok(fs.existsSync('apps/web/dist/index.html'), 'production frontend build exists');

const webSources = walk('apps/web/src').filter(
  (file) => /\.(ts|tsx)$/.test(file) && !file.includes(`${path.sep}test${path.sep}`)
);
const rawWriteRequests = [];
for (const file of webSources) {
  const source = fs.readFileSync(file, 'utf8');
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (/\bapi(?:<[^>]+>)?\([^\n]*\{\s*method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(line))
      rawWriteRequests.push(`${file}:${index + 1}: raw api write`);
    if (/\bfetch\([^\n]*\{[^\n]*method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(line))
      rawWriteRequests.push(`${file}:${index + 1}: direct fetch write`);
  }
}
assert.deepEqual(
  rawWriteRequests,
  [],
  `web writes use described json()/multipart() requests:\n${rawWriteRequests.join('\n')}`
);
const apiClient = fs.readFileSync('apps/web/src/api/client.ts', 'utf8');
assert.match(
  apiClient,
  /json\(method: string, body: unknown, operation: OperationDescriptor \| string\)/,
  'json writes require an operation description'
);
assert.match(
  apiClient,
  /multipart\(method: string, form: FormData, operation: OperationDescriptor \| string\)/,
  'uploads require an operation description'
);
assert.match(apiClient, /method === 'GET' \? 30_000 : 120_000/, 'request timeout defaults are explicit');

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(manifest.version, '2.2.0', 'root package is V2.2');
for (const script of [
  'lint',
  'typecheck',
  'test',
  'test:integration',
  'test:e2e',
  'test:release',
  'audit:acceptance',
  'verify'
])
  assert.ok(manifest.scripts[script], `mandatory script ${script}`);
for (const dependency of ['@modelcontextprotocol/sdk', 'busboy', 'node-pty', 'ws', 'zod'])
  assert.ok(manifest.dependencies[dependency], `runtime dependency ${dependency}`);
assert.match(
  manifest.scripts['test:e2e'],
  /build-web.*v110-workflow-journey.*v20-context-map-browser.*v21-outcomes-browser/,
  'standalone e2e builds the frontend and runs the historical plus V2.1 Outcome journeys'
);
assert.match(manifest.scripts['audit:acceptance'], /build-web/, 'standalone acceptance builds the frontend');
for (const suite of [
  'v13-terminal-flow',
  'v14-container-flow',
  'v15-native-assist-flow',
  'v15-host-bridge-flow',
  'v16-assist-files-flow',
  'v17-assist-brief-flow',
  'v18-mcp-gateway-flow',
  'v18-mcp-operations-flow',
  'v18-mcp-terminal-flow',
  'v19-workflow-generation-flow',
  'v19-delivery-flow',
  'v110-workflow-execution-flow',
  'v20-context-flow',
  'v21-suite.mjs integration'
])
  assert.ok(manifest.scripts['test:integration'].includes(suite), `integration gate includes ${suite}`);
for (const suite of [
  'v14-container.test',
  'v15-core.test',
  'v15-operations.test',
  'v15-change-bridge.test',
  'v16-core.test',
  'v16-release.test',
  'v17-core.test',
  'v17-capability-operations.test',
  'v17-release.test',
  'v18-mcp-auth.test',
  'v18-mcp-gateway-auth.test',
  'v18-mcp-registry.test',
  'v18-release.test',
  'v19-core.test',
  'v19-repository-delivery.test',
  'v19-migration.test',
  'v19-mcp-registry.test',
  'v110-cas.test',
  'v110-attestation.test',
  'v110-workflow-execution.test',
  'v20-system-context.test',
  'v20-context-pack.test',
  'v20-mcp-context.test',
  'v20-migration.test'
])
  assert.ok(manifest.scripts.test.includes(suite), `unit gate includes ${suite}`);
for (const script of [
  'test:v18:plan',
  'test:v18:impact',
  'test:v18:contract',
  'test:v18:pr',
  'test:v18:full',
  'test:v18:mcp-journey',
  'test:v18:live',
  'test:v18:release',
  'test:v18:soak',
  'mcp:stdio',
  'mcp:client',
  'mcp:gateway'
])
  assert.ok(manifest.scripts[script], `V1.8 command ${script}`);
assert.ok(manifest.scripts['test:release'].includes('v18-volume-flow'), 'release gate includes V1.8 volume migration');
for (const script of [
  'test:v19:unit',
  'test:v19:integration',
  'test:v19:pr',
  'test:v19:full',
  'test:v19:live',
  'test:v19:release',
  'test:v19:soak'
])
  assert.ok(manifest.scripts[script], `V1.9 command ${script}`);
for (const suite of ['pr', 'full', 'live', 'release', 'soak'])
  assert.match(
    manifest.scripts[`test:v19:${suite}`],
    new RegExp(`v19-runner\\.mjs ${suite}$`),
    `V1.9 ${suite} uses the catalog runner`
  );
assert.ok(manifest.scripts['test:release'].includes('v19-volume-flow'), 'release gate includes V1.9 volume migration');
for (const script of ['test:v110:unit', 'test:v110:integration', 'test:v110:release', 'test:v110:full'])
  assert.ok(manifest.scripts[script], `V1.10 command ${script}`);
assert.ok(
  manifest.scripts['test:release'].includes('v110-in-place-flow'),
  'release gate includes V1.10 in-place upgrade'
);
for (const script of [
  'test:v20:plan',
  'test:v20:catalog',
  'test:v20:coverage',
  'test:v20:impact',
  'test:v20:unit',
  'test:v20:integration',
  'test:v20:web',
  'test:v20:performance',
  'test:v20:pr',
  'test:v20:full',
  'test:v20:release'
])
  assert.ok(manifest.scripts[script], `V2.0 command ${script}`);
for (const suite of ['pr', 'full', 'release'])
  assert.match(
    manifest.scripts[`test:v20:${suite}`],
    new RegExp(`v20-runner\\.mjs ${suite}$`),
    `V2.0 ${suite} uses the catalog runner`
  );
assert.ok(manifest.scripts['test:release'].includes('v20-volume-flow'), 'release gate includes V2.0 volume clone');
for (const script of [
  'test:v21:plan',
  'test:v21:catalog',
  'test:v21:coverage',
  'test:v21:impact',
  'test:v21:unit',
  'test:v21:integration',
  'test:v21:web',
  'test:v21:security',
  'test:v21:performance',
  'test:v21:soak',
  'test:v21:pr',
  'test:v21:full',
  'test:v21:release'
])
  assert.ok(manifest.scripts[script], `V2.1 command ${script}`);
for (const suite of ['pr', 'full', 'release'])
  assert.match(
    manifest.scripts[`test:v21:${suite}`],
    new RegExp(`v21-runner\\.mjs ${suite}$`),
    `V2.1 ${suite} uses the catalog runner`
  );
assert.ok(manifest.scripts.test.includes('v21-suite.mjs unit'), 'unit gate includes V2.1 unit suite');
assert.ok(manifest.scripts.test.includes('v21-suite.mjs security'), 'unit gate includes V2.1 security suite');
assert.ok(manifest.scripts['test:release'].includes('v21-volume-flow'), 'release gate includes V2.1 volume clone');
for (const script of [
  'test:v22:plan',
  'test:v22:catalog',
  'test:v22:coverage',
  'test:v22:impact',
  'test:v22:unit',
  'test:v22:integration',
  'test:v22:security',
  'test:v22:performance',
  'test:v22:pr',
  'test:v22:full',
  'test:v22:release'
])
  assert.ok(manifest.scripts[script], `V2.2 command ${script}`);
for (const suite of ['pr', 'full', 'release'])
  assert.match(
    manifest.scripts[`test:v22:${suite}`],
    new RegExp(`v22-runner\\.mjs ${suite}$`),
    `V2.2 ${suite} uses the catalog runner`
  );
assert.ok(manifest.scripts.test.includes('v22-suite.mjs unit'), 'unit gate includes V2.2 unit suite');
assert.ok(manifest.scripts.test.includes('v22-suite.mjs security'), 'unit gate includes V2.2 security suite');
assert.ok(manifest.scripts['test:integration'].includes('v22-suite.mjs integration'), 'integration gate includes V2.2');
assert.ok(manifest.scripts['test:release'].includes('v22-volume-flow'), 'release gate includes V2.2 volume clone');
assert.match(manifest.scripts['test:compat:pr'], /compat-pr-runner\.mjs$/, 'pre-push has one compatibility runner');
const v22GateReceipt = fs.readFileSync('scripts/gate-receipt-v22.mjs', 'utf8'),
  compatibilityRunner = fs.readFileSync('scripts/compat-pr-runner.mjs', 'utf8');
assert.ok(
  v22GateReceipt.includes("Object.freeze(['test:compat:pr'])") &&
    compatibilityRunner.includes("['v18', 'v20', 'v21', 'v22']") &&
    compatibilityRunner.includes('dedupe_kind'),
  'pre-push gate consolidates historical and current PR suites with explicit dedupe ownership'
);

for (const file of workspaceManifests())
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, '2.2.0', `${file} is V2.2`);
const compose = fs.readFileSync('compose.yml', 'utf8');
for (const value of ['name: aiws-v22', 'aiws-app:2.2.0', 'aiws-codex-runner:2.2.0-codex-0.144.0', 'aiws-data-v22'])
  assert.ok(compose.includes(value), `Compose pins ${value}`);
assert.match(
  compose,
  /aiws-data:\s+[\s\S]*external: true/,
  'production data volume cannot be silently replaced by Compose'
);
assert.equal(compose.includes('aiws-data-v21'), false, 'V2.2 Compose never mounts the migration source volume');
assert.ok(compose.includes('/api/readyz'), 'V2.2 Compose healthcheck uses readiness');
assert.ok(compose.includes('stop_grace_period: 30s'), 'V2.2 Compose grants 30 seconds for shutdown');
const collaborationCompose = fs.readFileSync('compose.collaboration.yml', 'utf8');
for (const value of [
  'aiws-mcp-gateway:2.2.0',
  'target: mcp-gateway',
  'AIWS_MCP_REMOTE_MODE: gateway',
  'AIWS_RUNNER_NETWORK',
  'AIWS_PUBLIC_MCP_URL'
])
  assert.ok(collaborationCompose.includes(value), `collaboration Compose includes ${value}`);
const gatewayService = collaborationCompose.match(/\n  mcp-gateway:\n([\s\S]*?)\nsecrets:/)?.[1] || '';
assert.equal(gatewayService.includes('docker.sock'), false, 'MCP Gateway never mounts Docker socket');
assert.equal(gatewayService.includes('/var/lib/aiws'), false, 'MCP Gateway never mounts AIWS data volume');
assert.equal(runtime.includes('aiws-codex-runner:local'), false, 'runtime excludes mutable local Runner tag');

const verify = fs.readFileSync('scripts/verify.mjs', 'utf8');
for (const gate of [
  'v2.2:plan',
  'v2.2:catalog',
  'v2.2:coverage',
  'v2.2:impact-audit',
  "pnpmStep('test'",
  "pnpmStep('test:integration'",
  'e2e:playwright',
  'acceptance:audit'
])
  assert.ok(verify.includes(gate), `verify includes ${gate}`);
const composer = fs.readFileSync('apps/web/src/features/assist/AssistComposer.tsx', 'utf8');
for (const removedMode of ['>Ask<', '>Agent<', '>CLI<', '>Default<'])
  assert.equal(composer.includes(removedMode), false, `composer excludes ${removedMode}`);
const browser = fs.readFileSync('tests/e2e/playwright.test.mjs', 'utf8');
for (const viewport of ['1440', '1024', '390', "keyboard.press('Escape')"])
  assert.ok(browser.includes(viewport), `browser acceptance includes ${viewport}`);
const managedCcSwitch = fs.readFileSync('apps/api/src/cc-switch-managed-cli.mjs', 'utf8');
assert.equal(/sqlite|better-sqlite3/i.test(managedCcSwitch), false, 'managed cc-switch path never writes SQLite');
assert.ok(
  fs.readFileSync('bridge/main.go', 'utf8').includes('bridgeVersion   = "2.2.0"'),
  'Windows Bridge reports V2.2'
);
console.log(`V2.2 acceptance audit passed (${checks.length} implementation checks)`);

function workspaceManifests() {
  return ['apps', 'packages'].flatMap((root) =>
    fs
      .readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => path.join(root, item.name, 'package.json'))
      .filter(fs.existsSync)
  );
}
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
