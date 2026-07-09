import assert from 'node:assert/strict';
import {
  AssetStatus,
  Freshness,
  MemoryAuthority,
  buildAssistContextPack,
  buildContextPack,
  buildMemoryManifest,
  buildSufficiencyCheck,
  createLocalOwner,
  createAgentSession,
  createChangeProposal,
  createProject,
  createSubSubmission,
  defaultContractForNode,
  defaultTools,
  approveProposal,
  makeAssetFromCandidate,
  markProposalApplied,
  mergeSufficiencyIntoAssistResult,
  rejectProposal,
  recommendWorkflow,
  validateNodeContract
} from '../../packages/shared/index.mjs';

const { user } = createLocalOwner('Tester');
const created = createProject({ title: 'Test Project', goal: '实现 AIWS V1 闭环', created_by_user_id: user.id });
const wf = recommendWorkflow(created.project, user.id);
assert.equal(wf.nodes.length, 5, 'workflow must contain 5 node templates');

const node = wf.nodes[3];
const contract = defaultContractForNode(node, created.project, user.id, 'confirmed');
assert.equal(validateNodeContract(contract).ok, true, 'default contract should be valid');

const asset = makeAssetFromCandidate({ title: 'Confirmed Fact', summary: '系统事实', evidence_refs: ['trace:x'] }, { projectId: created.project.id, workspaceId: created.workspace.id, nodeId: node.id, runId: 'run_x', actorId: user.id }).asset;
asset.status = AssetStatus.Confirmed;
const stale = makeAssetFromCandidate({ title: 'Old Fact', summary: '过期事实', evidence_refs: ['trace:y'] }, { projectId: created.project.id, workspaceId: created.workspace.id, nodeId: node.id, runId: 'run_y', actorId: user.id }).asset;
stale.status = AssetStatus.Superseded;
const state = { projects: [created.project], assets: [asset, stale], decisions: [], digests: [], runner_memory_candidates: [], tools: defaultTools(user.id), node_runs: [] };

const sfc = buildSufficiencyCheck({ state, project: created.project, workspace: created.workspace, node, contract });
assert.equal(sfc.status, 'sufficient', 'context should be sufficient');
const manifest = buildMemoryManifest({ state, project: created.project, workspace: created.workspace, node, contract });
assert.ok(manifest.included.length >= 2, 'manifest should include project/tool/asset memory');
assert.ok(manifest.excluded.some((item) => item.ref === `asset:${stale.id}`), 'superseded asset is excluded');
const ctx = buildContextPack({ state, project: created.project, workspace: created.workspace, node, contract });
assert.equal(ctx.quality_check.passed, true, 'context pack quality should pass');
assert.ok(ctx.content_json.runner_instruction.includes('Confirmed Asset'), 'runner instruction should mention confirmed facts');

const topSession = createAgentSession({ projectId: created.project.id, workspaceId: created.workspace.id, scopeType: 'project', scopeId: created.project.id, actorId: user.id });
const nodeSession = createAgentSession({ projectId: created.project.id, workspaceId: 'wsp_node', scopeType: 'node', scopeId: node.id, parentSessionId: topSession.id, actorId: user.id });
assert.equal(nodeSession.parent_session_id, topSession.id);
const submission = createSubSubmission({ projectId: created.project.id, workspaceId: 'wsp_node', nodeId: node.id, fromSessionId: nodeSession.id, toSessionId: topSession.id, summary: '节点提交摘要', actorId: user.id });
state.submissions = [submission];
const ctxWithSubmission = buildContextPack({ state, project: created.project, workspace: created.workspace, node: wf.nodes[0], contract });
assert.equal(ctxWithSubmission.content_json.submissions.length, 1);

const proposal = createChangeProposal({ projectId: created.project.id, nodeId: node.id, changeType: 'node_contract_patch', title: '审批测试', actorId: user.id });
assert.equal(proposal.status, 'pending');
approveProposal(proposal, user.id);
assert.equal(proposal.status, 'approved');
markProposalApplied(proposal, user.id);
assert.equal(proposal.status, 'applied');
const rejected = createChangeProposal({ projectId: created.project.id, changeType: 'runner', actorId: user.id });
rejectProposal(rejected, user.id, 'no');
assert.equal(rejected.status, 'rejected');

state.runner_memory_candidates.push({ id: 'rmc_conflict', project_id: created.project.id, workspace_id: created.workspace.id, title: '不要使用 Confirmed Fact 的旧冲突记忆', summary: 'conflict with confirmed decision', scope: 'project', status: 'draft', freshness: Freshness.Disputed, tags: asset.tags, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
const conflicted = buildSufficiencyCheck({ state, project: created.project, workspace: created.workspace, node, contract });
assert.equal(conflicted.status, 'conflict', 'codex memory hint conflict should block certainty');
const assistCtx = buildAssistContextPack({ state, project: created.project, workspace: created.workspace, node, contract, target_type: 'node_contract', target_id: node.id, user_prompt: '补全验收标准' });
assert.equal(assistCtx.schema_version, 'aiws.assist_context_pack.v1');
assert.equal(assistCtx.sufficiency_check.status, 'conflict');
const merged = mergeSufficiencyIntoAssistResult({ status: 'draft_ready', summary: 'draft', questions: [], options: [], draft_patch: {} }, assistCtx);
assert.equal(merged.status, 'conflict');
assert.ok(merged.questions.length >= 1, 'conflict assist should ask user');
assert.ok(merged.memory_manifest.included.length >= 1, 'assist exposes memory manifest');
console.log('unit shared tests passed');
