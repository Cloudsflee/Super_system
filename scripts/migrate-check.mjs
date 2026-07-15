import assert from 'node:assert/strict';
import fs from 'node:fs';

const required = [
  'apps/api/server.mjs', 'apps/worker/src/index.mjs', 'apps/web/index.html',
  'packages/shared/index.mjs', 'packages/runner-adapters/src/index.mjs',
  'packages/context-pack/src/index.mjs', 'packages/memory-policy/src/index.mjs',
  'packages/git-tools/src/index.mjs', 'packages/mcp-bridge/src/index.mjs',
  'prisma/schema.prisma', 'docker/compose.infra.yml'
];
for (const file of required) assert.ok(fs.existsSync(file), `${file} exists`);

const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
const coreModels = [
  'User', 'ConnectedAccount', 'CredentialRef', 'Project', 'Workspace',
  'Workflow', 'WorkflowNode', 'NodeContract', 'ContextPack',
  'ContextSufficiencyCheck', 'AssistSession', 'NodeRun', 'TraceEvent',
  'FileRef', 'Asset', 'AssetVersion', 'DecisionRecord', 'WorkspaceDigest',
  'CodeChange', 'ToolDefinition', 'HumanReview', 'SetupState', 'GitHubAppConfig',
  'GitHubInstallation', 'RepositoryBinding', 'CodexProfile', 'AgentSession',
  'AssistMessage', 'AssistStreamEvent', 'UIActionIntent', 'ChangeProposal',
  'FileChangeRecord', 'NodeWorkspaceData', 'WebhookDelivery', 'TestTask',
  'ProjectIntake', 'ProjectBrief', 'AssistTurn', 'Attachment', 'Worktree',
  'RuntimeApproval', 'TerminalSession', 'ConfigRevision', 'ImportJob',
  'AssistConfiguration', 'AssistChangeBatch', 'AssistCheckpoint', 'AssistOperation',
  'RuntimeUserInput', 'HostBridgeDevice', 'BriefTemplate', 'WorkflowDraft'
];
for (const model of coreModels) assert.ok(schema.includes(`model ${model}`), `schema contains ${model}`);
for (const mapped of ['users', 'projects', 'context_packs', 'node_runs', 'trace_events', 'assets', 'code_changes', 'tool_definitions']) assert.ok(schema.includes(`@@map("${mapped}")`), `schema maps ${mapped}`);
const declaredModels = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
assert.equal(new Set(declaredModels).size, declaredModels.length, 'schema model names are unique');
assert.equal((schema.match(/\{/g) || []).length, (schema.match(/\}/g) || []).length, 'schema braces are balanced');
for (const mapped of ['setup_states', 'github_app_configs', 'github_installations', 'repository_bindings', 'assist_messages', 'assist_events', 'ui_action_intents', 'file_changes', 'webhook_deliveries']) assert.ok(schema.includes(`@@map("${mapped}")`), `schema maps V1.2 collection ${mapped}`);
for (const mapped of ['project_intakes', 'project_briefs', 'assist_turns', 'attachments', 'worktrees', 'runtime_approvals', 'terminal_sessions', 'config_revisions', 'import_jobs']) assert.ok(schema.includes(`@@map("${mapped}")`), `schema maps V1.3 collection ${mapped}`);
for (const mapped of ['assist_configurations', 'assist_change_batches', 'assist_checkpoints', 'assist_operations', 'runtime_user_inputs', 'host_bridge_devices']) assert.ok(schema.includes(`@@map("${mapped}")`), `schema maps V1.5 collection ${mapped}`);
for (const mapped of ['brief_templates', 'workflow_drafts']) assert.ok(schema.includes(`@@map("${mapped}")`), `schema maps V1.7 collection ${mapped}`);
assert.match(schema, /model FileChangeRecord[\s\S]*?diff\s+Json[\s\S]*?createdByUserId/, 'file change schema keeps diff and actor');
assert.match(schema, /model CodexProfile[\s\S]*?baseUrl\s+String\?[\s\S]*?wireApi\s+String[\s\S]*?requiresOpenaiAuth\s+Boolean[\s\S]*?ccSwitchProviderId/, 'Codex profile schema keeps third-party endpoint and cc-switch binding');
assert.match(schema, /model CodexProfile[\s\S]*?discoverySource\s+Json\?[\s\S]*?credentialConfigured\s+Boolean/, 'Codex profile schema keeps sanitized discovery provenance');
assert.match(schema, /model Project[\s\S]*?onboardingState\s+String[\s\S]*?managedWorkspaceState\s+String[\s\S]*?deletedAt\s+DateTime\?/, 'project schema keeps V1.3 lifecycle state');
assert.match(schema, /model Project[\s\S]*?lifecycleOperation\s+Json\?/, 'project schema keeps resumable lifecycle operation metadata');
assert.match(schema, /model ChangeProposal[\s\S]*?attentionState\s+String[\s\S]*?revision\s+Int[\s\S]*?targetHash\s+String\?/, 'change proposal schema keeps V1.3 atomic decision metadata');
assert.match(schema, /model ProjectBrief[\s\S]*?content\s+Json[\s\S]*?createdByUserId/, 'project brief schema matches versioned runtime content');
assert.match(schema, /model ProjectBrief[\s\S]*?revision\s+Int[\s\S]*?content\s+Json[\s\S]*?updatedByUserId/, 'project brief schema keeps V2 optimistic revision metadata');
assert.match(schema, /model BriefTemplate[\s\S]*?templateKey[\s\S]*?version\s+Int[\s\S]*?sources\s+Json[\s\S]*?retrievedAt/, 'brief template schema keeps version and provenance');
assert.match(schema, /model WorkflowDraft[\s\S]*?projectId[\s\S]*?revision\s+Int[\s\S]*?nodes\s+Json[\s\S]*?sourceBriefRevision[\s\S]*?status\s+String[\s\S]*?workflowId[\s\S]*?activatedAt/, 'workflow draft schema keeps stable graph and activation metadata');
assert.match(schema, /model WorkflowDraft[\s\S]*?userModifiedAt\s+DateTime\?/, 'workflow draft schema distinguishes user edits from generated revisions');
assert.match(schema, /model AssistTurn[\s\S]*?attachmentIds\s+Json[\s\S]*?reviewStatus\s+String/, 'Assist Turn schema matches attachment and review runtime fields');
assert.match(schema, /model Attachment[\s\S]*?managedPath\s+String\?[\s\S]*?modelPolicy\s+String\?/, 'attachment schema supports project and Turn sources');
assert.match(schema, /model Worktree[\s\S]*?path\s+String[\s\S]*?targetHash\s+String\?/, 'worktree schema matches managed checkout records');
assert.match(schema, /model TerminalSession[\s\S]*?reconnectTokenHash\s+String[\s\S]*?artifactFileRefId\s+String\?/, 'terminal schema matches PTY recovery and artifact records');
assert.match(schema, /model ConfigRevision[\s\S]*?patch\s+Json[\s\S]*?reconciliation\s+Json/, 'config revision schema matches reconciliation runtime');
assert.match(schema, /model ImportJob[\s\S]*?kind\s+String[\s\S]*?managedRepoPath\s+String\?/, 'import job schema matches idempotent operation runtime');
assert.match(schema, /model AssistSession[\s\S]*?runtimeProfileId[\s\S]*?activeChangeBatchId[\s\S]*?nativeGoalSnapshot/, 'Assist session schema keeps native affinity, batch, and Goal state');
assert.match(schema, /model AssistSession[\s\S]*?clarificationPolicy\s+String/, 'Assist session schema keeps thread clarification policy');
assert.match(schema, /model AssistTurn[\s\S]*?collaborationMode[\s\S]*?configurationId[\s\S]*?changeBatchId[\s\S]*?waitingUserInputId/, 'Assist Turn schema keeps V1.5 native runtime fields');
assert.match(schema, /model AssistTurn[\s\S]*?operationReferenceId\s+String\?/, 'Assist Turn schema keeps targeted operation reference');
assert.match(schema, /model AssistOperation[\s\S]*?beforeHash[\s\S]*?inverseOf[\s\S]*?expectedCurrentHash[\s\S]*?forced/, 'operation schema keeps append-only Undo fields');
assert.match(schema, /model AssistOperation[\s\S]*?capabilityId[\s\S]*?action\s+String\?[\s\S]*?targetLabel[\s\S]*?inputSchema[\s\S]*?locator/, 'operation schema keeps semantic and locator metadata');
assert.match(schema, /model AssistOperation[\s\S]*?operationReferenceId\s+String\?/, 'operation schema keeps targeted revision references');
console.log(`migration/schema check passed (${coreModels.length} core models)`);
