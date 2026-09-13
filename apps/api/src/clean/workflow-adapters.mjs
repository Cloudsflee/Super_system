import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PlatformError } from './platform-error.mjs';
import { ProcessAppServerAdapter } from './app-server-adapter.mjs';
import { treeManifest, containedPath, relativePath, taskContract } from './runner-input-provider.mjs';
import { canonicalJson, sha256Hex } from './canonical.mjs';

function extractJsonObject(text) {
  const source = String(text || '');
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function invalidGeneratedTaskContracts(candidate) {
  const nonemptyStrings = value => Array.isArray(value) && value.length > 0
    && value.every(item => typeof item === 'string' && item.trim().length > 0);
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.nodes) || !candidate.nodes.length) return true;
  return candidate.nodes.some((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return true;
    const kind = String(node?.kind || node?.node_kind || 'task');
    if (kind === 'workstream') return false;
    if (kind === 'check') return true;
    return !nonemptyStrings(node.config?.execution?.check_ids) || !nonemptyStrings(node.contract?.acceptance);
  });
}

const execFileAsync = promisify(execFile);

// Real workflow generation is deliberately provider-backed.  There is no
// deterministic success fallback in the normal phase-10 runtime.
export class ProcessWorkflowGenerator {
  constructor({ adapter = null, credentialResolver = null, config = {} } = {}) { this.adapter = adapter; this.credentialResolver = credentialResolver; this.config = config; this.requiresCredentialLease = true; }
  async generate(input = {}) {
    const leased = await this.credentialResolver?.(input);
    const credential = Buffer.isBuffer(leased) ? leased : leased?.credential;
    if (!Buffer.isBuffer(credential) || !credential.length) throw new PlatformError('provider_rebind_required', 'provider credential lease is required', {}, 409);
    let adapter = this.adapter;
    let thread;
    try {
      adapter ||= new ProcessAppServerAdapter({ command: this.config.providerCommand || 'codex', timeoutMs: this.config.providerTimeoutMs || 30000, homeRoot: this.config.providerHomeRoot });
      const prompt = canonicalJson({ purpose: input.purpose || 'generation', brief: input.brief || {}, context_pack: input.context_pack || {}, repository_snapshot: input.repository_snapshot || {}, policy_revision: input.policy_revision || 1, ...(input.purpose === 'critic' ? { candidate: input.candidate } : {}) });
      thread = await adapter.startThread({ credential, provider_config: leased.provider_config || {}, sandbox: 'read-only', approval_policy: 'never' });
      let response;
      let retryInstruction = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const generationContract = 'Generation constraints: the platform already owns source preflight, original hashes, candidate workspace isolation, verification records, Evidence capture, and rollback; do not add workflow nodes for those governance steps. Plan only the requested business change and its direct checks. Do not create nodes with kind "check"; attach check_ids and matching contract.acceptance to the business task, because the platform executes node_test and git_diff_check after task execution. For README changes, use a node command whose code refers only to the literal relative path README.md and never uses slash-prefixed paths. execution.mode must be exactly "read" or "write"; argv[0] must be one of node,pnpm,npm,git,codex; cwd_role must be task; input_paths and output_paths must be relative; every argv argument must use only relative workspace paths and must contain no absolute path, URL, token, credential, environment secret, shell redirection, or host path; capabilities must include network:none; check_ids must contain only node_test or git_diff_check; contract.acceptance is required and must equal the task check_ids exactly (for example check_ids:["node_test"] and acceptance:["node_test"]); never return an empty acceptance list; return one JSON object only, with no markdown or prose. ';
        const initialInstruction = input.purpose === 'critic'
          ? 'Independently review the candidate. The platform already performs preflight, original-hash, verification, Evidence, and rollback governance. Judge only whether business requirements and Brief acceptance are covered by valid task contracts. The final diff is produced and verified later by Host Runner and checks; do not reject merely because it is not visible yet. Emit one requirement_to_task row for every Brief acceptance, one task_to_acceptance row for every task check_id, and set missing to [] only when both mappings are complete. If the candidate has valid tasks, valid modes/checks, and covers every Brief acceptance, return status passed. Return JSON {status:"passed"|"rejected",issues:[{code,severity}],coverage:{requirement_to_task:[],task_to_acceptance:[],missing:[]}}. '
          : 'Return a workflow JSON {nodes:[{id,kind,title,parent_id,config:{execution:{argv,cwd_role,mode,input_paths,output_paths,runner_profile_ref,resource_profile,deadline_seconds,check_ids,capabilities}},contract:{acceptance:[]}}]}. Every task needs an independent check. ' + generationContract;
        const result = await adapter.startTurn({ thread_id: thread.thread_id, message: (retryInstruction || initialInstruction) + prompt, credential, approval_policy: 'never' });
        const events = result?.events || [];
        if (!Array.isArray(events) || events.some(event => !event || typeof event.method !== 'string')) throw new PlatformError('provider_protocol_drift', 'provider events are malformed', {}, 502);
        if (events.some((event,index) => event.sequence !== index + 1)) throw new PlatformError('provider_protocol_drift', 'provider sequence is not contiguous', {}, 502);
        if (events.some((event) => event.method.includes('requestApproval') || event.method.includes('requestUserInput'))) throw new PlatformError('provider_input_required', 'provider turn is waiting for a human decision', {}, 409);
        if (events.at(-1)?.method !== 'turn/completed') throw new PlatformError('provider_turn_incomplete', 'provider turn did not complete', {}, 502);
        const message = events.filter((event) => event.method === 'item/completed' && event.params?.role === 'assistant').map((event) => String(event.params.content || event.params.summary || '')).at(-1);
        if (!message?.trim()) throw new PlatformError('provider_output_empty', 'provider returned no JSON response', {}, 502);
        try {
          response = JSON.parse(message);
          if (input.purpose !== 'critic' && invalidGeneratedTaskContracts(response)) {
            if (attempt === 0) {
              response = null;
              retryInstruction = 'The workflow JSON was valid, but one or more ordinary task nodes had an empty execution.check_ids or contract.acceptance. Return the same workflow with non-empty matching check_ids and contract.acceptance on every task; keep workstream nodes allowed and do not add check nodes. Return only one JSON object. ';
              continue;
            }
            throw new PlatformError('provider_workflow_invalid', 'provider task checks and acceptance do not match', {}, 422);
          }
          break;
        } catch (error) {
          if (error instanceof PlatformError) throw error;
          if (attempt === 1) {
            throw new PlatformError('provider_output_invalid_json', 'provider JSON repair failed', {}, 502);
          }
          retryInstruction = 'The response was not valid JSON. Return only the requested JSON object without markdown, and obey every enum and field constraint. ';
        }
      }
      if (!response || Array.isArray(response) || typeof response !== 'object') throw new PlatformError('provider_output_invalid_json', 'provider JSON object is required', {}, 502);
      if (input.purpose !== 'critic' && Array.isArray(response.nodes) && response.nodes.some((node) => String(node?.kind || node?.node_kind || 'task') === 'check')) {
        throw new PlatformError('provider_workflow_invalid', 'provider workflow must attach checks to business tasks', {}, 422);
      }
      const outputHash = sha256Hex(canonicalJson(response));
      const receipt = { adapter: 'process-app-server', profile_id: leased.profile_id, profile_revision: leased.profile_revision, profile_hash: leased.profile_hash, input_sha256: sha256Hex(prompt), output_sha256: outputHash, turn_completed: true };
      return { candidate: response, provider_receipt: receipt, input_sha256: sha256Hex(prompt), output_sha256: outputHash };
    } finally { credential.fill(0); await adapter?.close?.(); }
  }
}

export class ProcessWorkflowCritic {
  constructor({ generator = null } = {}) { this.generator = generator; this.requiresCredentialLease = true; }
  async evaluate(input = {}) {
    let tasks;
    try { tasks = compileWorkflowToExecutionPlan(input.candidate).tasks; }
    catch (error) { return { status: 'rejected', issues: [{ code: error.code, severity: 'error' }], coverage: { missing: ['structural'] }, provider: 'server-structural-check' }; }
    const missingStructural = tasks.filter((task) => !task.check_ids.length).map((task) => task.id);
    if (!tasks.length || missingStructural.length) return { status: 'rejected', issues: [{ code: 'critic_coverage_incomplete', severity: 'error' }], coverage: { missing: missingStructural }, provider: 'server-structural-check' };
    if (!this.generator) throw new PlatformError('critic_failed', 'independent provider critic is required', {}, 409);
    const result = await this.generator.generate({ ...input, purpose: 'critic' });
    const assessed = result?.candidate;
    const text = value => typeof value === 'string' && value.trim().length > 0;
    const invalidReceipt = () => { throw new PlatformError('critic_failed', 'critic coverage receipt is invalid or incomplete', {}, 502); };
    if (!assessed || !['passed','rejected'].includes(assessed.status) || !Array.isArray(assessed.issues)
      || !Array.isArray(assessed.coverage?.requirement_to_task) || !Array.isArray(assessed.coverage?.task_to_acceptance)
      || !Array.isArray(assessed.coverage?.missing)) invalidReceipt();
    if (assessed.issues.some(issue => !issue || !text(issue.code) || !['info', 'warning', 'error', 'critical'].includes(issue.severity))
      || assessed.coverage.missing.some(value => !text(value))) invalidReceipt();
    const taskIds = new Set(tasks.map((task) => task.id));
    const requirements = (input.brief?.acceptance || []).map((value) => typeof value === 'string' ? value : value.id);
    if (requirements.some(value => !text(value)) || taskIds.size !== tasks.length) invalidReceipt();
    const requirementIds = new Set(requirements);
    const expectedChecks = new Set(tasks.flatMap(task => task.check_ids.map(check => canonicalJson([task.id, check]))));
    const requirementPairs = new Set(); const coveredRequirements = new Set(); const coveredChecks = new Set();
    for (const row of assessed.coverage.requirement_to_task) {
      if (!row || !text(row.requirement) || !text(row.task) || !requirementIds.has(row.requirement) || !taskIds.has(row.task)) invalidReceipt();
      const pair = canonicalJson([row.requirement, row.task]);
      if (requirementPairs.has(pair)) invalidReceipt();
      requirementPairs.add(pair); coveredRequirements.add(row.requirement);
    }
    for (const row of assessed.coverage.task_to_acceptance) {
      if (!row || !text(row.task) || !text(row.check)) invalidReceipt();
      const pair = canonicalJson([row.task, row.check]);
      if (!expectedChecks.has(pair) || coveredChecks.has(pair)) invalidReceipt();
      coveredChecks.add(pair);
    }
    const coverageMissing = requirements.filter(requirement => !coveredRequirements.has(requirement));
    coverageMissing.push(...tasks.filter(task => task.check_ids.some(check => !coveredChecks.has(canonicalJson([task.id, check])))).map(task => task.id));
    // Derived missing entries may only reject. Never fill provider mappings or
    // mutate the original provider receipt, and never upgrade a rejection.
    const coverage = { ...structuredClone(assessed.coverage), missing: [...new Set([...assessed.coverage.missing, ...coverageMissing])] };
    const status = coverage.missing.length || assessed.issues.some((issue) => ['error','critical'].includes(issue.severity)) ? 'rejected' : assessed.status;
    return { ...assessed, coverage, status, provider: 'process-app-server-critic', candidate_sha256: sha256Hex(canonicalJson(input.candidate)), coverage_sha256: sha256Hex(canonicalJson(coverage)), provider_receipt: result.provider_receipt };
  }
}

export { extractJsonObject };

const REGISTERED_COMMANDS = new Set(['node', 'pnpm', 'npm', 'git', 'codex']);
const EXECUTION_MODES = new Set(['read', 'write']);

export function compileWorkflowToExecutionPlan(graph = {}, pins = {}, policy = null) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const ids = new Set(nodes.map((node) => String(node.id || node.node_key || '')));
  const checkIdsByParent = new Map();
  for (const node of nodes) {
    if (String(node.kind || node.node_kind || 'task') !== 'check' || !node.parent_id) continue;
    const checks = Array.isArray(node.config?.execution?.check_ids) ? node.config.execution.check_ids.map(String) : [];
    if (checks.length) checkIdsByParent.set(String(node.parent_id), [...new Set([...(checkIdsByParent.get(String(node.parent_id)) || []), ...checks])]);
  }
  const executableNodes = nodes.filter((node) => String(node.kind || node.node_kind || 'task') !== 'workstream' && String(node.kind || node.node_kind || 'task') !== 'check');
  const tasks = executableNodes.map((originalNode, index) => {
    const node = structuredClone(originalNode);
    const inheritedChecks = checkIdsByParent.get(String(node.id || node.node_key || '')) || [];
    if (inheritedChecks.length) {
      node.config = { ...(node.config || {}), execution: { ...(node.config?.execution || {}), check_ids: [...new Set([...(node.config?.execution?.check_ids || []).map(String), ...inheritedChecks])] } };
      node.contract = { ...(node.contract || {}), acceptance: [...new Set([...(node.contract?.acceptance || []).map(String), ...inheritedChecks])] };
    }
    const id = String(node.id || node.node_key || `task_${index + 1}`);
    const execution = node.config?.execution;
    if (!execution || typeof execution !== 'object') throw new PlatformError('execution_config_missing', `task ${id} has no execution configuration`, { task_id: id }, 422);
    const argv = Array.isArray(execution.argv) ? execution.argv.map(String) : [];
    if (!argv.length || !REGISTERED_COMMANDS.has(argv[0])) throw new PlatformError('runner_command_not_allowed', `task ${id} command is not registered`, { task_id: id }, 422);
    const paths = (value, field) => {
      const list = Array.isArray(value) ? value.map(String) : [];
      if (list.some((item) => !item || item.startsWith('/') || /^[A-Za-z]:[\\/]/.test(item) || item.split('/').includes('..'))) throw new PlatformError('runner_path_invalid', `${field} contains an invalid path`, { task_id: id }, 422);
      return [...new Set(list)];
    };
    const dependsOn = [...new Set((node.depends_on || node.dependencies || execution.depends_on || []).map(String))];
    if (dependsOn.some((dependency) => !ids.has(dependency) || dependency === id)) throw new PlatformError('execution_dependency_invalid', `task ${id} has an unknown dependency`, { task_id: id }, 422);
    const mode = EXECUTION_MODES.has(execution.mode) ? execution.mode : null;
    if (!mode) throw new PlatformError('execution_mode_invalid', `task ${id} execution mode is invalid`, { task_id: id }, 422);
    const task = {
      id, ordinal: index + 1, title: String(node.title || id), mode, depends_on: dependsOn,
      argv, cwd_role: String(execution.cwd_role || 'task'), input_paths: paths(execution.input_paths, 'input_paths'),
      output_paths: paths(execution.output_paths, 'output_paths'),
      // Runner profile identity is pinned by the Execution/Runner owner; a
      // Provider-generated symbolic reference cannot be authoritative here.
      runner_profile_ref: '',
      resource_profile: String(execution.resource_profile || 'light'), deadline_seconds: Number(execution.deadline_seconds || 900),
      check_ids: Array.isArray(execution.check_ids) ? execution.check_ids.map(String) : [],
      capabilities: Array.isArray(execution.capabilities) ? execution.capabilities.map(String) : ['network:none']
    };
    task.task_contract = Object.freeze({ argv: [...task.argv], cwd_role: task.cwd_role, mode: task.mode, input_paths: [...task.input_paths], output_paths: [...task.output_paths], runner_profile_ref: task.runner_profile_ref, resource_profile: task.resource_profile, deadline_seconds: task.deadline_seconds, check_ids: [...task.check_ids], capabilities: [...task.capabilities] });
    task.task_contract_sha256 = sha256Hex(canonicalJson(task.task_contract));
    policy?.assertSafe?.(task);
    return task;
  });
  const pending = new Set(tasks.map((task) => task.id)); const complete = new Set();
  while (pending.size) {
    const ready = tasks.filter((task) => pending.has(task.id) && task.depends_on.every((item) => complete.has(item)));
    if (!ready.length) throw new PlatformError('execution_dag_cycle', 'workflow execution graph contains a cycle', {}, 422);
    for (const task of ready) { pending.delete(task.id); complete.add(task.id); }
  }
  return { tasks, pins: pins && typeof pins === 'object' ? pins : {} };
}

/** Real local Git source adapter. Deterministic fixtures remain an explicit caller concern. */
export class LocalGitRepositoryAdapter {
  constructor({ git = 'git', maxBytes = 100 * 1024 * 1024, vault = null } = {}) { this.git = git; this.maxBytes = maxBytes; this.vault = vault; }
  bindSource(source) {
    if (source.kind !== 'local') return source;
    if (!path.isAbsolute(String(source.path || source.locator || ''))) return source;
    const root = this.root(source);
    if (!this.vault) throw new PlatformError('repository_source_invalid', 'local source registry is unavailable', {}, 409);
    const locator = 'local-source-' + sha256Hex(root);
    this.vault.put(locator, Buffer.from(root));
    return { ...source, path: undefined, locator };
  }
  root(source) {
    let value = String(source.path || source.locator || '');
    if (value.startsWith('local-source-') && this.vault) {
      const bytes = this.vault.read(value); try { value = bytes.toString('utf8'); } finally { bytes.fill(0); }
    }
    if (!value || !path.isAbsolute(value)) throw new PlatformError('repository_source_invalid', 'local Git source is required', {}, 422);
    const resolved = path.resolve(value);
    let current = path.parse(resolved).root;
    try {
      for (const part of path.relative(current, resolved).split(path.sep).filter(Boolean)) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink'); }
      if (!fs.lstatSync(resolved).isDirectory()) throw new Error('directory');
      return fs.realpathSync(resolved);
    } catch { throw new PlatformError('repository_source_invalid', 'local repository path is invalid', {}, 422); }
  }
  async gitBytes(root, args) {
    try { const result = await execFileAsync(this.git, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', root, ...args], { encoding: 'buffer', shell: false, windowsHide: true, timeout: 30000, maxBuffer: this.maxBytes, env: { PATH: process.env.PATH || process.env.Path || '', SystemRoot: process.env.SystemRoot || '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } }); return result.stdout; }
    catch { throw new PlatformError('repository_probe_failed', 'Git source inspection failed', {}, 422); }
  }
  async gitDiffClean(root, relative) {
    try {
      await execFileAsync(this.git, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', root, 'diff', '--no-ext-diff', '--quiet', '--', relative], { encoding: 'buffer', shell: false, windowsHide: true, timeout: 30000, maxBuffer: this.maxBytes, env: { PATH: process.env.PATH || process.env.Path || '', SystemRoot: process.env.SystemRoot || '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
      return true;
    } catch (error) {
      // `git diff --quiet` exits 1 for a real worktree difference. Other
      // failures (for example an unavailable repository) are probe failures.
      if (Number(error?.code) === 1) return false;
      throw new PlatformError('repository_probe_failed', 'Git source inspection failed', {}, 422);
    }
  }
  async probe(source = {}) {
    if (source.kind === 'none') return { revision: '', hash: '' };
    const root = this.root(source);
    const commit = String(await this.gitBytes(root, ['rev-parse','--verify','HEAD^{commit}'])).trim();
    const tree = String(await this.gitBytes(root, ['rev-parse','--verify',commit + '^{tree}'])).trim();
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw new PlatformError('repository_probe_failed', 'Git revision is invalid', {}, 422);
    const worktreeStatus = String(await this.gitBytes(root, ['status', '--porcelain=v1', '--untracked-files=all']));
    if (worktreeStatus.trim()) throw new PlatformError('source_drift', 'Git worktree is dirty', {}, 409);
    const entries = []; let size = 0;
    const raw = String(await this.gitBytes(root, ['ls-tree','-rz','--full-tree',commit]));
    for (const record of raw.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
      if (!match || !['100644','100755'].includes(match[1]) || match[2] !== 'blob') throw new PlatformError('repository_source_invalid', 'tracked symlink, submodule or special entry', {}, 422);
      const relative = relativePath(match[4]), file = containedPath(root, relative);
      const bytes = await this.gitBytes(root, ['cat-file','blob',match[3]]);
      size += bytes.length; if (size > this.maxBytes || entries.length >= 10000) throw new PlatformError('repository_source_too_large', 'source quota exceeded', {}, 422);
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new PlatformError('source_drift', 'tracked file is missing', {}, 409);
      // `hash-object` hashes the worktree bytes. When a clean/smudge filter
      // (notably core.autocrlf) changes those bytes, defer to Git's diff
      // machinery, which compares the filtered worktree to the pinned commit.
      const workingBlob = String(await this.gitBytes(root, ['hash-object','--',relative])).trim();
      if (workingBlob !== match[3] && !(await this.gitDiffClean(root, relative))) throw new PlatformError('source_drift', 'tracked file differs from the pinned commit', {}, 409);
      entries.push({ path: relative, mode: match[1], blob_sha1: match[3], sha256: sha256Hex(bytes), byte_length: bytes.length });
    }
    entries.sort((a,b) => a.path.localeCompare(b.path));
    const hash = sha256Hex(canonicalJson({ commit, tree, entries }));
    if ((source.revision && source.revision !== commit) || (source.hash && source.hash !== hash)) throw new PlatformError('source_drift', 'repository input pin changed', {}, 409);
    return { revision: commit, commit_sha: commit, tree_sha: tree, hash, manifest_hash: hash, entries, file_count: entries.length };
  }
  async materialize(source, target, expected = {}) {
    const observed = await this.probe({ ...source, revision: expected.revision || source.revision, hash: expected.hash || source.hash });
    const root = this.root(source), destination = path.resolve(target);
    if (destination === root || root.startsWith(destination + path.sep) || destination.startsWith(root + path.sep) || fs.existsSync(destination)) throw new PlatformError('repository_source_invalid', 'materialization requires a distinct new directory', {}, 409);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of observed.entries) {
      const bytes = await this.gitBytes(root, ['cat-file','blob',entry.blob_sha1]);
      if (sha256Hex(bytes) !== entry.sha256) throw new PlatformError('source_drift', 'Git blob changed', {}, 409);
      const file = containedPath(destination, entry.path); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o700 : 0o600 });
    }
    const manifest = treeManifest(destination);
    if (canonicalJson(manifest) !== canonicalJson(observed.entries.map(({ path, sha256, byte_length }) => ({ path, sha256, byte_length })))) throw new PlatformError('workspace_changed', 'materialized bytes differ', {}, 409);
    return { ...observed, workspace_hash: sha256Hex(canonicalJson(manifest)), workspace_manifest: manifest };
  }
}
