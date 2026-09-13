import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { open, close } from './helpers.mjs';
import { prepare, waitOperation } from '../p6/helpers.mjs';
import { createAssistPrerequisites } from '../p5/helpers.mjs';
import { HostRunnerAdapter } from '../../apps/api/src/clean/runner-adapters.mjs';
import { LocalGitRepositoryAdapter, ProcessWorkflowGenerator, ProcessWorkflowCritic, compileWorkflowToExecutionPlan, extractJsonObject } from '../../apps/api/src/clean/workflow-adapters.mjs';
import { canonicalJson, sha256Hex } from '../../apps/api/src/clean/canonical.mjs';
import { taskContract, treeManifest } from '../../apps/api/src/clean/runner-input-provider.mjs';
import { assertSource, resolveRunRoot } from '../../scripts/v3-clean-real-development-loop.mjs';

const hardGraph = () => ({ nodes: [{
  id: 'write', kind: 'task', config: { execution: {
    argv: ['node', '-e', 'process.exit(0)'], cwd_role: 'task', mode: 'write',
    input_paths: ['README.md'], output_paths: ['result.txt'], check_ids: ['node_test', 'git_diff_check'],
    capabilities: ['network:none'], resource_profile: 'light', deadline_seconds: 30
  } }, contract: { acceptance: ['result'] }
}] });
const hardTurn = content => ({ events: [
  { sequence: 1, method: 'turn/started', params: {} },
  { sequence: 2, method: 'item/completed', params: { role: 'assistant', content } },
  { sequence: 3, method: 'turn/completed', params: {} }
] });
function hardProvider(answers) {
  const credential = Buffer.from('fixture-only-lease');
  const messages = []; let closed = 0;
  const generator = new ProcessWorkflowGenerator({
    credentialResolver: () => ({ credential }),
    adapter: {
      async startThread() { return { thread_id: 'fixture' }; },
      async startTurn(input) { messages.push(input.message); return typeof answers[0] === 'function' ? answers[0]() : hardTurn(answers[Math.min(messages.length - 1, answers.length - 1)]); },
      async close() { closed++; }
    }
  });
  return { generator, messages, credential, closed: () => closed };
}
const hardAssessment = (status = 'passed') => ({
  status, issues: [], coverage: {
    requirement_to_task: [{ requirement: 'result', task: 'write' }],
    task_to_acceptance: [{ task: 'write', check: 'node_test' }, { task: 'write', check: 'git_diff_check' }],
    missing: []
  }
});
async function hardCritic(receipt) {
  let calls = 0;
  const critic = new ProcessWorkflowCritic({ generator: { async generate() { calls++; return { candidate: receipt }; } } });
  const result = await critic.evaluate({ candidate: hardGraph(), brief: { acceptance: ['result'] } });
  assert.equal(calls, 1, 'exercise the provider Critic, not structural rejection');
  return result;
}

test('hard limits: strict provider JSON rejects wrappers and trailing objects after one repair', async () => {
  for (const answer of [JSON.stringify(hardGraph()) + ' {}', '```json\n' + JSON.stringify(hardGraph()) + '\n```', 'prefix ' + JSON.stringify(hardGraph())]) {
    const fixture = hardProvider([answer]);
    await assert.rejects(fixture.generator.generate(), { code: 'provider_output_invalid_json', status: 502 });
    assert.equal(fixture.messages.length, 2);
    assert.equal(fixture.closed(), 1);
    assert.ok(fixture.credential.every(value => value === 0));
  }
});
test('hard limits: valid JSON and one contract repair preserve the provider candidate', async () => {
  const invalid = hardGraph(); invalid.nodes[0].contract.acceptance = [];
  const valid = hardGraph(); valid.nodes.unshift({ id: 'group', kind: 'workstream' });
  const before = structuredClone(invalid);
  const fixture = hardProvider([JSON.stringify(invalid), JSON.stringify(valid)]);
  const result = await fixture.generator.generate();
  assert.deepEqual(result.candidate, valid);
  assert.deepEqual(invalid, before);
  assert.equal(fixture.messages.length, 2);
  assert.match(fixture.messages[1], /execution.check_ids.*contract.acceptance/);
  assert.ok(fixture.credential.every(value => value === 0));
  assert.equal(fixture.closed(), 1);
});
test('hard limits: missing or ill-typed task fields fail with 422 without local repair', async () => {
  for (const field of ['checks', 'acceptance']) for (const value of [[], [''], [' '], [null], [{}], [1], null]) {
    const graph = hardGraph();
    if (field === 'checks') graph.nodes[0].config.execution.check_ids = value;
    else graph.nodes[0].contract.acceptance = value;
    const fixture = hardProvider([JSON.stringify(graph)]);
    await assert.rejects(fixture.generator.generate(), { code: 'provider_workflow_invalid', status: 422 });
    assert.equal(fixture.messages.length, 2);
    assert.ok(fixture.credential.every(value => value === 0));
    assert.equal(fixture.closed(), 1);
  }
});
test('hard limits: JSON repair accepts a complete valid second response only', async () => {
  const fixture = hardProvider(['invalid', JSON.stringify(hardGraph())]);
  assert.deepEqual((await fixture.generator.generate()).candidate, hardGraph());
  assert.equal(fixture.messages.length, 2);
  assert.equal(fixture.closed(), 1);
});
test('hard limits: provider protocol errors retain stable codes and clear the lease', async () => {
  for (const [value, code] of [[{ events: [] }, 'provider_turn_incomplete'], [hardTurn(''), 'provider_output_empty'],
    [{ events: [{ sequence: 9, method: 'turn/completed' }] }, 'provider_protocol_drift']]) {
    const fixture = hardProvider([() => value]);
    await assert.rejects(fixture.generator.generate(), { code });
    assert.equal(fixture.messages.length, 1);
    assert.equal(fixture.closed(), 1);
    assert.ok(fixture.credential.every(value => value === 0));
  }
});

// Owner: Workflow/Repository/Runner/Evidence. Phase: post-P10; explicit provider fixtures.

test('hard limits: provider rejected stays rejected with complete coverage and no findings', async () => {
  const receipt = hardAssessment('rejected'); const before = structuredClone(receipt);
  assert.equal((await hardCritic(receipt)).status, 'rejected');
  assert.deepEqual(receipt, before);
});
test('hard limits: every task check requires its own immutable coverage row', async () => {
  const receipt = hardAssessment(); receipt.coverage.task_to_acceptance.pop();
  const before = structuredClone(receipt);
  const result = await hardCritic(receipt);
  assert.equal(result.status, 'rejected');
  assert.ok(result.coverage.missing.length > 0);
  assert.deepEqual(receipt, before, 'provider receipt must not be edited');
});
test('hard limits: complete coverage passes and critical issues still reject', async () => {
  assert.equal((await hardCritic(hardAssessment())).status, 'passed');
  const receipt = hardAssessment(); receipt.issues.push({ code: 'fixture_issue', severity: 'critical' });
  assert.equal((await hardCritic(receipt)).status, 'rejected');
});
test('hard limits: malformed, duplicate, stale and orphan Critic rows fail closed', async () => {
  const mutations = [
    r => r.coverage.task_to_acceptance.push({ task: 'write', check: 'node_test' }),
    r => r.coverage.task_to_acceptance.push({ task: 'orphan', check: 'node_test' }),
    r => r.coverage.task_to_acceptance.push({ task: 'write', check: 'stale_check' }),
    r => r.coverage.requirement_to_task.push({ requirement: 'result', task: 'write' }),
    r => r.coverage.requirement_to_task.push({ requirement: 'obsolete', task: 'write' }),
    r => r.coverage.requirement_to_task.push({ requirement: 'result', task: 'orphan' }),
    r => r.coverage.task_to_acceptance.push(null),
    r => r.coverage.missing.push({}),
    r => r.issues.push({ code: 'fixture_issue', severity: 'unknown' }),
    r => r.issues.push(null)
  ];
  for (const mutate of mutations) {
    const receipt = hardAssessment(); mutate(receipt);
    const before = structuredClone(receipt);
    await assert.rejects(hardCritic(receipt), { code: 'critic_failed', status: 502 });
    assert.deepEqual(receipt, before);
  }
});
const task = (extra = {}) => ({ id:'write', mode:'write', argv:['node','-e',"require('node:fs').writeFileSync('result.txt','verified\\n')"], cwd_role:'task', input_paths:['README.md'], output_paths:['result.txt'], check_ids:['node_test'], capabilities:['network:none'], resource_profile:'light', deadline_seconds:30, ...extra });
const candidate = (value = task()) => ({ nodes:[{ id:value.id, kind:'task', config:{execution:value}, contract:{acceptance:['result']} }] });
const events = (content) => ({ events:[{sequence:1,method:'turn/started',params:{}},{sequence:2,method:'item/completed',params:{role:'assistant',content}},{sequence:3,method:'turn/completed',params:{}}] });

test('task contracts bind complete execution fields and reject commands, paths and cycles', () => {
  const compiled = compileWorkflowToExecutionPlan(candidate()).tasks[0];
  assert.equal(compiled.task_contract_sha256,sha256Hex(canonicalJson(taskContract(compiled))));
  assert.throws(()=>compileWorkflowToExecutionPlan({nodes:[{id:'a'}]}),{code:'execution_config_missing'});
  assert.throws(()=>taskContract(task({argv:['powershell','x']})),{code:'runner_command_not_allowed'});
  for(const relative of ['/tmp/out','../out','C:/out','..\\out']) assert.throws(()=>taskContract(task({output_paths:[relative]})),{code:'runner_path_invalid'});
  assert.throws(()=>compileWorkflowToExecutionPlan({nodes:[{id:'a',depends_on:['b'],config:{execution:task()}},{id:'b',depends_on:['a'],config:{execution:task()}}]}),{code:'execution_dag_cycle'});
  const withCheckNode = compileWorkflowToExecutionPlan({ nodes: [
    { id: 'change', kind: 'task', config: { execution: task({ check_ids: ['node_test'] }) }, contract: { acceptance: ['node_test'] } },
    { id: 'diff', kind: 'check', parent_id: 'change', config: { execution: task({ mode: 'read', argv: ['git', 'diff', '--check'], input_paths: ['README.md'], output_paths: [], check_ids: ['git_diff_check'] }) }, contract: { acceptance: ['git_diff_check'] } }
  ] });
  assert.equal(withCheckNode.tasks.length, 1);
  assert.deepEqual(withCheckNode.tasks[0].check_ids, ['node_test', 'git_diff_check']);
});

test('provider JSON repair extracts one balanced object without accepting trailing objects', () => {
  const extracted = extractJsonObject('Here is the result:\n```json\n{"nodes":[{"id":"x","title":"brace } inside string"}]}\n```');
  assert.deepEqual(JSON.parse(extracted), { nodes: [{ id: 'x', title: 'brace } inside string' }] });
});

test('real loop preflight requires a clean, real Git worktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-cli-preflight-')); const source = path.join(root, 'source'); fs.mkdirSync(source);
  const git = (args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true });
  try {
    git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
    fs.writeFileSync(path.join(source, 'README.md'), 'baseline\n'); git(['add', '.']); git(['commit', '-qm', 'baseline']);
    assert.equal(assertSource(source), fs.realpathSync(source));
    fs.writeFileSync(path.join(source, 'untracked.txt'), 'dirty\n');
    assert.throws(() => assertSource(source), /source_worktree_dirty/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real loop rejects Git subdirectories and explicit run roots inside the source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-cli-root-')); const source = path.join(root, 'source'); fs.mkdirSync(source);
  const git = (args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true });
  try {
    git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
    fs.writeFileSync(path.join(source, 'README.md'), 'baseline\n'); git(['add', '.']); git(['commit', '-qm', 'baseline']);
    fs.mkdirSync(path.join(source, 'subdir')); assert.throws(() => assertSource(path.join(source, 'subdir')), /repository_source_invalid/);
    assert.throws(() => resolveRunRoot(path.join(source, 'run'), fs.realpathSync(source), 'run-test'), /run_root_inside_source/);
    const redirected = resolveRunRoot(undefined, fs.realpathSync(source), 'run-test');
    assert.equal(redirected.redirected, false); assert.match(redirected.root, /real-development-loop/); fs.rmSync(redirected.root, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local Git reads commit blobs, verifies drift and materializes without touching the source', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aiws-local-git-')); const source=path.join(root,'source'), output=path.join(root,'managed'); fs.mkdirSync(source);
  const git=(args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8',windowsHide:true});
  try {
    git(['init','-q']); git(['config','user.name','Fixture']); git(['config','user.email','fixture@example.test']);
    fs.writeFileSync(path.join(source,'README.md'),'baseline\n'); git(['add','.']); git(['commit','-qm','baseline']);
    const adapter=new LocalGitRepositoryAdapter(); const pin=await adapter.probe({kind:'local',path:source});
    assert.equal(pin.commit_sha,git(['rev-parse','HEAD']).trim()); assert.equal(pin.tree_sha,git(['rev-parse','HEAD^{tree}']).trim());
    const result=await adapter.materialize({kind:'local',path:source},output,pin);
    assert.equal(result.workspace_hash,sha256Hex(canonicalJson(treeManifest(output))));
    assert.equal(fs.readFileSync(path.join(output,'README.md'),'utf8'),'baseline\n');
    fs.writeFileSync(path.join(source,'README.md'),'changed'); await assert.rejects(adapter.probe({kind:'local',path:source}),{code:'source_drift'});
    await assert.rejects(adapter.materialize({kind:'local',path:source},source),{code:'source_drift'});
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('local Git accepts clean autocrlf worktrees while rejecting real content drift', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-local-git-autocrlf-')); const source = path.join(root, 'source'); fs.mkdirSync(source);
  const git = (args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true });
  try {
    git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
    git(['config', 'core.autocrlf', 'true']); fs.writeFileSync(path.join(source, 'README.md'), 'baseline\n'); git(['add', '.']); git(['commit', '-qm', 'baseline']);
    // Materialize the CRLF-smudged representation through Git itself so the
    // index remains clean under core.autocrlf.
    git(['checkout', '--', 'README.md']);
    const adapter = new LocalGitRepositoryAdapter(); const pin = await adapter.probe({ kind: 'local', path: source });
    assert.equal(pin.file_count, 1);
    fs.writeFileSync(path.join(source, 'README.md'), 'changed\r\n');
    await assert.rejects(adapter.probe({ kind: 'local', path: source }), { code: 'source_drift' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('provider JSON gets one repair and zeroizes its lease after a separate critic turn', async () => {
  const buffers=[];let calls=0,threads=0;
  const adapter={ async startThread(){threads++;return {thread_id:String(threads)};},async startTurn(){calls++;return events(calls===1?'invalid':JSON.stringify(candidate()));},async close(){} };
  const resolver=()=>{const credential=Buffer.from('fixture-provider-lease');buffers.push(credential);return {credential,profile_id:'fixture',profile_revision:1,profile_hash:'a'.repeat(64),provider_config:{}};};
  const generator=new ProcessWorkflowGenerator({adapter,credentialResolver:resolver});
  const generated=await generator.generate({brief:{acceptance:['result']}}); assert.equal(calls,2);assert.deepEqual(generated.candidate,candidate());assert.equal(buffers[0].every(x=>x===0),true);
  adapter.startTurn=async()=>events(JSON.stringify({status:'passed',issues:[],coverage:{requirement_to_task:[{requirement:'result',task:'write'}],task_to_acceptance:[{task:'write',check:'node_test'}],missing:[]}}));
  const critic=new ProcessWorkflowCritic({generator}); const assessed=await critic.evaluate({candidate:generated.candidate,brief:{acceptance:['result']}});
  assert.equal(assessed.provider,'process-app-server-critic');assert.equal(threads,2); assert.equal(buffers[1].every(x=>x===0),true);
  assert.match(assessed.coverage_sha256,/^[a-f0-9]{64}$/);
});

test('provider incomplete events and empty output are failed rather than candidates',async()=>{
  for(const value of [{events:[]},events('')]) {
    const credential=Buffer.from('fixture-only');const adapter={async startThread(){return {thread_id:'one'};},async startTurn(){return value;},async close(){}};
    await assert.rejects(new ProcessWorkflowGenerator({adapter,credentialResolver:()=>({credential})}).generate({})); assert.equal(credential.every(x=>x===0),true);
  }
});

test('Critic rejects duplicate ownership and unknown missing markers', async () => {
  const baseCandidate = candidate();
  for (const coverage of [
    { requirement_to_task: [{ requirement: 'result', task: 'write' }, { requirement: 'result', task: 'write' }], task_to_acceptance: [{ task: 'write', check: 'node_test' }], missing: [] },
    { requirement_to_task: [{ requirement: 'result', task: 'write' }], task_to_acceptance: [{ task: 'write', check: 'node_test' }], missing: ['obsolete'] }
  ]) {
    const critic = new ProcessWorkflowCritic({ generator: { async generate() { return { candidate: { status: 'passed', issues: [], coverage } }; } } });
    await assert.rejects(critic.evaluate({ candidate: baseCandidate, brief: { acceptance: ['result'] } }), { code: 'critic_failed', status: 502 });
  }
});

test('real Host task stays in candidate until finalize, binds CAS outputs and captures Evidence',async()=>{
  const hostRoot=fs.mkdtempSync(path.join(os.tmpdir(),'aiws-host-')); const adapter=new HostRunnerAdapter({homeRoot:hostRoot}); const state=await open({runnerAdapter:adapter});
  try {
    const fixture=await prepare(state,'real-host',[task()]);
    const original=sha256Hex(canonicalJson(treeManifest(fixture.directory)));
    const review=state.runtime.execution.review.bind(state.runtime.execution);
    let reviewed=false; state.runtime.execution.review=async(...args)=>{reviewed=true;assert.equal(fs.existsSync(path.join(fixture.directory,'result.txt')),false);return review(...args);};
    const started=await state.runtime.execution.start(fixture.execution.id,{expected_revision:fixture.execution.revision,idempotency_key:'real-host-start'},state.principal);
    const operation=await waitOperation(state.runtime,started.operation.operation_id,state.principal.actorId,10000);
    assert.equal(operation.status,'succeeded',operation.error_code);assert.equal(reviewed,true);
    assert.equal(fs.readFileSync(path.join(fixture.directory,'result.txt'),'utf8'),'verified\n');
    const attempt=state.runtime.db.get('SELECT * FROM task_attempts WHERE execution_id=?',[fixture.execution.id]);
    const spec=JSON.parse(state.runtime.db.get('SELECT spec_json FROM job_specs WHERE id=?',[attempt.job_spec_id]).spec_json);
    assert.equal(Object.hasOwn(spec,'argv'),false);const contractRef=spec.input_refs.find(x=>x.type==='task_contract');assert.ok(state.runtime.cas.has(contractRef.hash));
    const manifest=JSON.parse(state.runtime.cas.read(attempt.output_sha256));assert.equal(manifest.entries[0].sha256,sha256Hex('verified\n'));
    assert.equal(state.runtime.db.get('SELECT status FROM test_results WHERE execution_id=?',[fixture.execution.id]).status,'passed');
    await state.runtime.evidence.recoverPending();assert.equal(state.runtime.db.get('SELECT count(*) AS n FROM assets WHERE execution_id=?',[fixture.execution.id]).n,1);
    const rollback=path.join(state.config.workspaceRoot,'rollback',fixture.execution.id,'1');assert.equal(sha256Hex(canonicalJson(treeManifest(rollback))),original);
  } finally {await close(state);fs.rmSync(hostRoot,{recursive:true,force:true});}
});

test('zero exit with missing output fails and leaves managed bytes unchanged',async()=>{
  const hostRoot=fs.mkdtempSync(path.join(os.tmpdir(),'aiws-host-fail-')); const state=await open({runnerAdapter:new HostRunnerAdapter({homeRoot:hostRoot})});
  try {
    const fixture=await prepare(state,'missing-output',[task({argv:['node','-e','process.exit(0)']})]);const before=treeManifest(fixture.directory);
    const started=await state.runtime.execution.start(fixture.execution.id,{expected_revision:fixture.execution.revision,idempotency_key:'missing-output-start'},state.principal);
    const result=await waitOperation(state.runtime,started.operation.operation_id,state.principal.actorId,10000);assert.equal(result.status,'failed');assert.equal(result.error_code,'runner_artifact_missing');
    assert.deepEqual(treeManifest(fixture.directory),before);assert.equal(state.runtime.db.get('SELECT count(*) AS n FROM task_attempts WHERE execution_id=?',[fixture.execution.id]).n,1);
  } finally {await close(state);fs.rmSync(hostRoot,{recursive:true,force:true});}
});

test('local repository, leased Generation, independent Critic, Proposal, Host, Check and Evidence form one loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-complete-loop-'));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const git = (args) => execFileSync('git', ['-C', source, ...args], { windowsHide: true, stdio: 'ignore' });
  git(['init','-q']); git(['config','user.name','Fixture']); git(['config','user.email','fixture@example.test']); fs.writeFileSync(path.join(source,'README.md'),'baseline\n'); git(['add','.']); git(['commit','-qm','baseline']);
  let state; let turns = 0; const leases = [];
  const appServer = { async startThread() { return { thread_id: 'fixture-turn-' + turns }; }, async startTurn(input) { turns++; return events(JSON.stringify(input.message.startsWith('Independently') ? {status:'passed',issues:[],coverage:{requirement_to_task:[{requirement:'result',task:'write'}],task_to_acceptance:[{task:'write',check:'node_test'}],missing:[]}} : candidate())); }, async close() {} };
  const repository = new LocalGitRepositoryAdapter();
  const generator = new ProcessWorkflowGenerator({adapter:appServer, credentialResolver:(input) => { const lease=state.runtime.identity.leaseProviderCredential(input.provider_profile_id,{actorId:input.principal_actor_id}); leases.push(lease.credential); return lease; }});
  const critic = new ProcessWorkflowCritic({generator});
  state = await open({runnerAdapter:new HostRunnerAdapter({homeRoot:path.join(root,'host')}),runtime:{repositoryAdapter:repository,generator,critic}});
  repository.vault = state.runtime.vault;
  try {
    const {runtime,principal}=state;
    const project=await runtime.project.createProject({name:'Real loop',idempotency_key:'complete-loop-project'},principal);
    const intake=await runtime.project.submitIntake(project.id,{mode:'brainstorm',content:{objective:'write result'},expected_revision:1,idempotency_key:'complete-loop-intake'},principal);
    await waitOperation(runtime,intake.operation.operation_id,principal.actorId);
    await runtime.project.createBrief(project.id,{objective:'write result',acceptance:['result'],expected_revision:1,idempotency_key:'complete-loop-brief'},principal);
    await runtime.project.confirmBrief(project.id,{brief_revision:1,expected_revision:2,idempotency_key:'complete-loop-confirm'},principal);
    await runtime.project.createRepositoryConnection(project.id,{provider:'local',source_kind:'local',source_locator:source,idempotency_key:'complete-loop-repository'},principal);
    const line=runtime.project.listRepositoryLines(project.id,principal)[0];
    const materialized=await runtime.project.createRepositoryWorkspace(project.id,{line_id:line.id,expected_revision:0,idempotency_key:'complete-loop-workspace'},principal);
    assert.equal(materialized.workspace.status,'ready'); assert.equal(materialized.workspace.revision,3);
    const prerequisites=await createAssistPrerequisites(state,project,'complete-loop');
    await runtime.project.reviseWorkflow(project.id,{graph:candidate(),expected_revision:1,idempotency_key:'complete-loop-workflow'},principal);
    const generation=await runtime.project.startGeneration(project.id,{provider_profile_id:prerequisites.profile.id,expected_revision:runtime.project.getProject(project.id,principal).revision,idempotency_key:'complete-loop-generation'},principal);
    const generated=await waitOperation(runtime,generation.operation.operation_id,principal.actorId,10000); assert.equal(generated.status,'succeeded',generated.error_code);
    const current=runtime.project.getGeneration(generation.generation.id,principal);
    const reviewed=await runtime.project.evaluateCritic(current.id,{status:'passed',expected_revision:current.revision,idempotency_key:'complete-loop-critic'},principal);
    assert.equal(reviewed.critic.status,'passed');assert.equal(turns,2);assert.equal(leases.every(bytes=>bytes.every(x=>x===0)),true);
    const workflow=runtime.db.get('SELECT * FROM workflows WHERE project_id=?',[project.id]);
    await runtime.project.applyProposal(reviewed.proposal.id,{expected_revision:workflow.revision,idempotency_key:'complete-loop-apply'},principal);
    const profile=await runtime.runner.createProfile({runner_type:'host',label:'Complete loop host',expected_revision:0,idempotency_key:'complete-loop-runner'},principal);
    const probe=await runtime.runner.probeProfile(profile.profile.id,{expected_revision:profile.profile.revision,idempotency_key:'complete-loop-runner-probe'},principal);await waitOperation(runtime,probe.operation.operation_id,principal.actorId);
    const execution=await runtime.execution.create(project.id,{repository_workspace_id:materialized.workspace.id,context_pack_id:prerequisites.pack.id,runner_profile_id:profile.profile.id,expected_revision:runtime.project.getProject(project.id,principal).revision,idempotency_key:'complete-loop-execution'},principal);
    const started=await runtime.execution.start(execution.execution.id,{expected_revision:execution.execution.revision,idempotency_key:'complete-loop-start'},principal);
    const completed=await waitOperation(runtime,started.operation.operation_id,principal.actorId,10000);assert.equal(completed.status,'succeeded',completed.error_code);
    await runtime.evidence.recoverPending();assert.equal(runtime.db.get('SELECT count(*) AS n FROM assets WHERE execution_id=?',[execution.execution.id]).n,1);
    assert.equal(fs.existsSync(path.join(source,'result.txt')),false);
  } finally { await close(state); fs.rmSync(root,{recursive:true,force:true}); }
});
