export const state = {
  view: 'dashboard',
  health: null,
  me: null,
  projects: [],
  project: null,
  workflow: null,
  workspace: null,
  selectedNodeId: null,
  selectedRunId: null,
  selectedContextPackId: null,
  workflowViewport: { x: 0, y: 0, scale: 1 },
  selectedWorkflowNodeId: null,
  review: null,
  tools: [],
  codexStatus: null,
  ccSwitchStatus: null,
  githubStatus: null,
  codexProfiles: [],
  changeProposals: [],
  agentSessions: []
};
export function setState(patch) { Object.assign(state, patch); }
export function currentNode() { return state.project?.nodes?.find((node) => node.id === state.selectedNodeId) || state.project?.nodes?.[0] || null; }
export function currentWorkspace() { const node = currentNode(); return state.project?.workspace?.id && !node ? state.project.workspace : null; }
export function currentContract() { const node = currentNode(); return state.project?.contracts?.find((item) => item.id === node?.current_contract_id) || state.project?.contracts?.find((item) => item.node_id === node?.id) || null; }
export function currentRun() { return state.workspace?.runs?.find((run) => run.id === state.selectedRunId) || state.review?.runs?.at?.(-1) || null; }
