import { hashJson } from '../../crypto.mjs';
import { AppError, assert } from '../../errors.mjs';
import { normalizeRelativePath } from '../../path-policy.mjs';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const SLOT_TYPES = new Set(['text', 'json', 'file', 'directory', 'image', 'number', 'boolean', 'artifact', 'any']);

function issue(code, message, details = {}) {
  throw new AppError(code, message, { status: 422, details });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanId(value, fallback) {
  const id = String(value || fallback || '').trim();
  if (!ID.test(id)) issue('workflow_contract_invalid', 'workflow identifier is invalid', { id });
  return id;
}

function pathList(value, field, nodeId) {
  if (value == null) return [];
  if (!Array.isArray(value)) issue('workflow_contract_invalid', `${field} must be an array`, { node_id: nodeId, field });
  const paths = value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) issue('workflow_contract_invalid', `${field} contains an empty path`, { node_id: nodeId, field });
    try { return normalizeRelativePath(item.trim()); }
    catch (error) { issue('workflow_contract_invalid', `${field} contains an invalid path`, { node_id: nodeId, field, path: item, cause: error?.message }); }
  });
  if (new Set(paths).size !== paths.length) issue('workflow_duplicate_output', `${field} contains a duplicate path`, { node_id: nodeId, field });
  return paths;
}

function slotList(value, field, nodeId) {
  if (value == null) return [];
  if (!Array.isArray(value)) issue('workflow_contract_invalid', `${field} must be an array`, { node_id: nodeId, field });
  const ids = new Set();
  const selectors = new Set();
  return value.map((raw, index) => {
    const slot = raw && typeof raw === 'object' ? raw : { name: raw };
    const name = String(slot.name || slot.id || `${field}_${index + 1}`).trim();
    if (!ID.test(name)) issue('workflow_contract_invalid', 'slot identifier is invalid', { node_id: nodeId, field, slot: name });
    if (ids.has(name)) issue('workflow_contract_invalid', 'slot identifier is duplicated', { node_id: nodeId, field, slot: name });
    ids.add(name);
    const type = String(slot.type || 'any').toLowerCase();
    if (!SLOT_TYPES.has(type)) issue('workflow_contract_invalid', 'slot type is invalid', { node_id: nodeId, field, slot: name, type });
    const rawSelector = String(slot.selector || slot.path || slot.target || '').trim();
    let selector = '';
    if (rawSelector) {
      try { selector = normalizeRelativePath(rawSelector); }
      catch (error) { issue('workflow_contract_invalid', 'slot selector is invalid', { node_id: nodeId, field, slot: name, selector: rawSelector, cause: error?.message }); }
      if (selectors.has(selector)) issue(field === 'outputs' ? 'workflow_duplicate_output' : 'workflow_contract_invalid', 'slot selector is duplicated', { node_id: nodeId, field, slot: name, selector });
      selectors.add(selector);
    }
    const targetOutput = String(slot.target_output || slot.targetOutput || '').trim();
    const acceptance = slot.acceptance == null ? [] : asArray(slot.acceptance).map((item) => String(item).trim()).filter(Boolean);
    if (field === 'inputs' && !selector && !targetOutput) issue('workflow_contract_invalid', 'input slot requires selector or target output', { node_id: nodeId, slot: name });
    if (field === 'outputs' && !selector) issue('workflow_contract_invalid', 'output slot requires selector', { node_id: nodeId, slot: name });
    if (!acceptance.length) issue('workflow_contract_invalid', 'slot acceptance is required', { node_id: nodeId, field, slot: name });
    return {
      name,
      type,
      required: slot.required !== false,
      selector,
      target_output: targetOutput,
      acceptance
    };
  });
}

function assertDag(nodes, dependencies, { code = 'workflow_graph_cycle', kind = 'workflow' } = {}) {
  const state = new Map(nodes.map((node) => [node, 0]));
  const visit = (node, stack = []) => {
    const current = state.get(node);
    if (current === 1) issue(code, `${kind} graph contains a cycle`, { cycle: [...stack, node] });
    if (current === 2) return;
    state.set(node, 1);
    for (const dep of dependencies.get(node) || []) visit(dep, [...stack, node]);
    state.set(node, 2);
  };
  for (const node of nodes) visit(node);
}

function normalizeTask(raw, index, workstreamId, taskIds) {
  const task = raw && typeof raw === 'object' ? raw : {};
  const id = cleanId(task.id, `task_${index + 1}`);
  if (taskIds.has(id)) issue('workflow_contract_invalid', 'task identifier is duplicated', { task_id: id });
  taskIds.add(id);
  const deps = [...new Set(asArray(task.deps ?? task.dependencies).map((value) => String(value).trim()).filter(Boolean))];
  const rawInputs = task.input_paths ?? task.inputs_paths ?? (Array.isArray(task.inputs) && task.inputs.every((item) => typeof item === 'string') ? task.inputs : undefined);
  const rawOutputs = task.output_paths ?? task.outputs_paths ?? (Array.isArray(task.outputs) && task.outputs.every((item) => typeof item === 'string') ? task.outputs : undefined);
  const inputs = pathList(rawInputs, 'input_paths', id);
  const outputs = pathList(rawOutputs, 'output_paths', id);
  const inputSlotValue = task.input_slots ?? (Array.isArray(task.inputs) && task.inputs.some((item) => item && typeof item === 'object') ? task.inputs : undefined);
  const outputSlotValue = task.output_slots ?? (Array.isArray(task.outputs) && task.outputs.some((item) => item && typeof item === 'object') ? task.outputs : undefined);
  const inputSlots = slotList(inputSlotValue, 'inputs', id);
  const outputSlots = slotList(outputSlotValue, 'outputs', id);
  const acceptance = asArray(task.acceptance ?? task.acceptance_criteria).map((item) => String(item).trim()).filter(Boolean);
  const tools = asArray(task.allowed_tools ?? task.tools).map((item) => String(item).trim()).filter(Boolean).slice(0, 32);
  const goal = String(task.goal || task.objective || task.title || id).trim();
  if (!goal) issue('workflow_contract_invalid', 'node goal is required', { task_id: id });
  if (!acceptance.length) issue('workflow_contract_invalid', 'node acceptance is required', { task_id: id });
  if (!outputSlots.length && !outputs.length) issue('workflow_contract_invalid', 'node requires an output', { task_id: id });
  return {
    id,
    title: String(task.title || goal).slice(0, 200),
    goal: goal.slice(0, 1000),
    workstream_id: workstreamId,
    deps,
    mode: task.mode === 'write' ? 'write' : 'read',
    inputs,
    outputs,
    input_slots: inputSlots,
    output_slots: outputSlots,
    allowed_tools: tools,
    acceptance
  };
}

/**
 * Validate and canonicalize the R4 two-level workflow shape.  A flat `tasks`
 * array is accepted as a compatibility input and grouped into one Workstream.
 */
export function validateWorkflowCandidate(input, { brief = null, allowEmpty = false } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  let workstreams = asArray(source.workstreams);
  if (!workstreams.length && Array.isArray(source.tasks)) {
    workstreams = [{ id: 'workstream_1', title: source.name || 'Workstream 1', tasks: source.tasks }];
  }
  if (!workstreams.length && allowEmpty) return { hierarchy_mode: 'two_level', workstreams: [], tasks: [], hash: hashJson([]) };
  if (!workstreams.length || workstreams.length > 12) issue('workflow_depth_invalid', 'workflow must contain 1-12 workstreams', { count: workstreams.length });
  const workstreamIds = new Set();
  const taskIds = new Set();
  const normalizedWorkstreams = workstreams.map((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const id = cleanId(item.id, `workstream_${index + 1}`);
    if (workstreamIds.has(id)) issue('workflow_contract_invalid', 'workstream identifier is duplicated', { workstream_id: id });
    workstreamIds.add(id);
    const tasks = asArray(item.tasks);
    if (!tasks.length || tasks.length > 12) issue('workflow_depth_invalid', 'each workstream must contain 1-12 tasks', { workstream_id: id, count: tasks.length });
    return {
      id,
      title: String(item.title || item.name || id).slice(0, 200),
      goal: String(item.goal || item.objective || item.title || id).slice(0, 1000),
      deps: [...new Set(asArray(item.deps ?? item.dependencies).map((value) => String(value).trim()).filter(Boolean))],
      tasks: tasks.map((task, taskIndex) => normalizeTask(task, taskIndex, id, taskIds)),
      acceptance: asArray(item.acceptance).map((value) => String(value).trim()).filter(Boolean)
    };
  });
  const workstreamDeps = new Map(normalizedWorkstreams.map((item) => [item.id, item.deps]));
  const workstreamPosition = new Map(normalizedWorkstreams.map((item, index) => [item.id, index]));
  for (const stream of normalizedWorkstreams) {
    for (const dep of stream.deps) {
      if (!workstreamIds.has(dep)) issue('workflow_dependency_scope_invalid', 'workstream dependency is unknown', { workstream_id: stream.id, dependency: dep });
      if (dep === stream.id) issue('workflow_dependency_scope_invalid', 'workstream cannot depend on itself', { workstream_id: stream.id });
    }
  }
  assertDag([...workstreamIds], workstreamDeps, { kind: 'workstream' });
  for (const stream of normalizedWorkstreams) {
    for (const dep of stream.deps) {
      if (workstreamPosition.get(dep) >= workstreamPosition.get(stream.id)) issue('workflow_dependency_scope_invalid', 'workstream dependency must reference an earlier declaration', { workstream_id: stream.id, dependency: dep });
    }
  }
  const taskById = new Map(normalizedWorkstreams.flatMap((stream) => stream.tasks.map((task) => [task.id, task])));
  const taskPosition = new Map(normalizedWorkstreams.flatMap((stream) => stream.tasks.map((task, index) => [task.id, index])));
  const taskDeps = new Map([...taskById].map(([id, task]) => [id, task.deps]));
  for (const task of taskById.values()) {
    for (const dep of task.deps) {
      const parent = taskById.get(dep);
      if (!parent) issue('workflow_dependency_scope_invalid', 'task dependency is unknown', { task_id: task.id, dependency: dep });
      if (parent.id === task.id) issue('workflow_dependency_scope_invalid', 'task cannot depend on itself', { task_id: task.id });
      if (parent.workstream_id !== task.workstream_id && !workstreamDeps.get(task.workstream_id)?.includes(parent.workstream_id)) {
        issue('workflow_dependency_scope_invalid', 'cross-workstream dependency is outside the declared scope', { task_id: task.id, dependency: dep });
      }
    }
  }
  assertDag([...taskById.keys()], taskDeps, { kind: 'task' });
  for (const task of taskById.values()) {
    for (const dep of task.deps) {
      const parent = taskById.get(dep);
      if (parent?.workstream_id === task.workstream_id && taskPosition.get(parent.id) >= taskPosition.get(task.id)) {
        issue('workflow_dependency_scope_invalid', 'task dependency must reference an earlier declaration', { task_id: task.id, dependency: dep });
      }
    }
  }
  const outputs = new Map();
  for (const task of taskById.values()) {
    for (const output of task.outputs) {
      if (outputs.has(output)) issue('workflow_duplicate_output', 'output path is produced more than once', { path: output, nodes: [outputs.get(output), task.id] });
      outputs.set(output, task.id);
    }
    for (const slot of task.output_slots) {
      if (slot.selector && outputs.has(slot.selector) && outputs.get(slot.selector) !== task.id) issue('workflow_duplicate_output', 'output selector is produced more than once', { path: slot.selector });
      if (slot.selector && !outputs.has(slot.selector)) outputs.set(slot.selector, task.id);
    }
  }
  const outputSlots = [...taskById.values()].flatMap((task) => task.output_slots.map((slot) => ({ ...slot, task_id: task.id })));
  const dependencyClosure = (taskId, found = new Set()) => {
    for (const dependency of taskDeps.get(taskId) || []) {
      if (found.has(dependency)) continue;
      found.add(dependency);
      dependencyClosure(dependency, found);
    }
    return found;
  };
  for (const task of taskById.values()) {
    const upstream = dependencyClosure(task.id);
    for (const slot of task.input_slots) {
      if (!slot.target_output) continue;
      const target = slot.target_output;
      const matches = outputSlots.filter((output) => upstream.has(output.task_id) && (
        output.name === target
        || output.selector === target
        || `${output.task_id}.${output.name}` === target
        || `${output.task_id}:${output.name}` === target
      ));
      if (matches.length !== 1) issue('workflow_contract_invalid', 'input slot target output is missing or ambiguous', { node_id: task.id, field: 'input_slots.target_output', target_output: target });
      const output = matches[0];
      if (slot.type !== 'any' && output.type !== 'any' && slot.type !== output.type) issue('workflow_contract_invalid', 'input and output slot types do not match', { node_id: task.id, field: 'input_slots.type', target_output: target });
      if (slot.selector && output.selector && slot.selector !== output.selector) issue('workflow_contract_invalid', 'input selector does not match its target output', { node_id: task.id, field: 'input_slots.selector', target_output: target });
    }
  }
  const paths = [...outputs.keys()].sort();
  for (let index = 1; index < paths.length; index += 1) {
    if (paths[index].startsWith(`${paths[index - 1]}/`) || paths[index - 1].startsWith(`${paths[index]}/`)) {
      issue('workflow_output_path_conflict', 'output paths have a prefix conflict', { paths: [paths[index - 1], paths[index]] });
    }
  }
  const briefCoverage = validateBriefCoverage(brief, normalizedWorkstreams);
  const tasks = normalizedWorkstreams.flatMap((stream) => stream.tasks);
  return {
    hierarchy_mode: 'two_level',
    name: String(source.name || 'Workflow').slice(0, 160),
    workstreams: normalizedWorkstreams,
    tasks,
    brief_coverage: briefCoverage,
    hash: hashJson({ hierarchy_mode: 'two_level', workstreams: normalizedWorkstreams, brief_coverage: briefCoverage })
  };
}

export function validateBriefCoverage(brief, workstreams) {
  const content = brief && typeof brief === 'object' ? brief : {};
  const groups = [
    { key: 'feature', aliases: ['feature', 'features'] },
    { key: 'acceptance', aliases: ['acceptance'] },
    { key: 'milestone', aliases: ['milestone', 'milestones'] },
    { key: 'risk', aliases: ['risk', 'risks'] }
  ];
  const present = groups.flatMap((group) => group.aliases.filter((key) => content[key] != null && (Array.isArray(content[key]) ? content[key].length : String(content[key]).trim().length)));
  const tasks = workstreams.flatMap((item) => item.tasks);
  const text = JSON.stringify(tasks).toLowerCase();
  const missing = [];
  for (const group of groups) {
    const values = group.aliases.flatMap((key) => content[key] == null ? [] : Array.isArray(content[key]) ? content[key] : [content[key]]);
    if (values.some((value) => !text.includes(typeof value === 'string' ? value.toLowerCase() : JSON.stringify(value).toLowerCase()))) missing.push(group.key);
  }
  return { present, missing, complete: missing.length === 0 };
}

export function candidateToLegacyTasks(candidate) {
  return candidate.workstreams.flatMap((stream) => stream.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    goal: task.goal,
    workstream_id: stream.id,
    level: stream.deps.length ? 2 : 1,
    deps: task.deps,
    mode: task.mode,
    inputs: task.inputs,
    outputs: task.outputs,
    input_slots: task.input_slots,
    output_slots: task.output_slots,
    allowed_tools: task.allowed_tools,
    acceptance: task.acceptance
  })));
}

export function criticIssues(candidate) {
  const issues = [];
  if (!candidate?.workstreams?.length) issues.push({ code: 'workflow_depth_invalid', field_path: 'workstreams' });
  if (candidate?.brief_coverage && !candidate.brief_coverage.complete) issues.push({ code: 'workflow_brief_coverage_incomplete', field_path: 'brief_coverage.missing' });
  return issues;
}
