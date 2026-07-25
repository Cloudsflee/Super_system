import { systemRoutes } from './routes/system.mjs';
import { projectRoutes } from './routes/projects.mjs';
import { runRoutes } from './routes/runs.mjs';
import { assetRoutes } from './routes/assets.mjs';
import { gitRoutes } from './routes/git.mjs';
import { githubRoutes } from './routes/github.mjs';
import { toolRoutes } from './routes/tools.mjs';
import { setupV12Routes } from './routes/setup-v12.mjs';
import { agentSessionRoutes } from './routes/agent-sessions.mjs';
import { changeProposalRoutes } from './routes/change-proposals.mjs';
import { githubConfigV12Routes } from './routes/github-config-v12.mjs';
import { githubInstallationsV12Routes } from './routes/github-installations-v12.mjs';
import { githubWebhookV12Routes } from './routes/github-webhook-v12.mjs';
import { codexV12Routes } from './routes/codex-v12.mjs';
import { codexDiscoveryV12Routes } from './routes/codex-discovery-v12.mjs';
import { workflowV12Routes } from './routes/workflow-v12.mjs';
import { fileV12Routes } from './routes/files-v12.mjs';
import { assistV12Routes } from './routes/assist-v12.mjs';
import { projectOnboardingV13Routes } from './routes/project-onboarding-v13.mjs';
import { approvalV13Routes } from './routes/approvals-v13.mjs';
import { terminalV13Routes } from './routes/terminal-v13.mjs';
import { codexCapabilitiesV13Routes } from './routes/codex-capabilities-v13.mjs';
import { githubRepositoriesV13Routes } from './routes/github-repositories-v13.mjs';
import { configGovernanceV13Routes } from './routes/config-governance-v13.mjs';
import { assistV3Routes } from './routes/assist-v3.mjs';
import { hostBridgeV15Routes } from './routes/host-bridge-v15.mjs';
import { mcpClientV18Routes } from './routes/mcp-clients-v18.mjs';
import { mcpV18Routes } from './routes/mcp-v18.mjs';
import { workflowV19Routes } from './routes/workflow-v19.mjs';
import { repositoryDeliveryV19Routes } from './routes/repository-delivery-v19.mjs';
import { workflowMigrationV19Routes } from './routes/workflow-migration-v19.mjs';
import { projectGovernanceV19Routes } from './routes/project-governance-v19.mjs';
import { exchangeV19Routes } from './routes/exchange-v19.mjs';
import { repositoryLifecycleV19Routes } from './routes/repository-lifecycle-v19.mjs';
import { repositoryWorkspaceV19Routes } from './routes/repository-workspaces-v19.mjs';
import { pullRequestIntentV19Routes } from './routes/pull-request-intents-v19.mjs';
import { workflowExecutionV110Routes } from './routes/workflow-executions-v110.mjs';
import { contextV20Routes } from './routes/context-v20.mjs';

const groups = [
  ['system.mjs', systemRoutes],
  ['setup-v12.mjs', setupV12Routes],
  ['projects.mjs', projectRoutes],
  ['project-onboarding-v13.mjs', projectOnboardingV13Routes],
  ['assist-v12.mjs', assistV12Routes],
  ['assist-v3.mjs', assistV3Routes],
  ['runs.mjs', runRoutes],
  ['assets.mjs', assetRoutes],
  ['git.mjs', gitRoutes],
  ['github.mjs', githubRoutes],
  ['tools.mjs', toolRoutes],
  ['github-config-v12.mjs', githubConfigV12Routes],
  ['github-installations-v12.mjs', githubInstallationsV12Routes],
  ['github-webhook-v12.mjs', githubWebhookV12Routes],
  ['codex-v12.mjs', codexV12Routes],
  ['codex-discovery-v12.mjs', codexDiscoveryV12Routes],
  ['workflow-v12.mjs', workflowV12Routes],
  ['files-v12.mjs', fileV12Routes],
  ['agent-sessions.mjs', agentSessionRoutes],
  ['change-proposals.mjs', changeProposalRoutes],
  ['approvals-v13.mjs', approvalV13Routes],
  ['terminal-v13.mjs', terminalV13Routes],
  ['codex-capabilities-v13.mjs', codexCapabilitiesV13Routes],
  ['github-repositories-v13.mjs', githubRepositoriesV13Routes],
  ['config-governance-v13.mjs', configGovernanceV13Routes],
  ['host-bridge-v15.mjs', hostBridgeV15Routes],
  ['mcp-clients-v18.mjs', mcpClientV18Routes],
  ['mcp-v18.mjs', mcpV18Routes],
  ['workflow-v19.mjs', workflowV19Routes],
  ['repository-delivery-v19.mjs', repositoryDeliveryV19Routes],
  ['workflow-migration-v19.mjs', workflowMigrationV19Routes],
  ['project-governance-v19.mjs', projectGovernanceV19Routes],
  ['exchange-v19.mjs', exchangeV19Routes],
  ['repository-lifecycle-v19.mjs', repositoryLifecycleV19Routes],
  ['repository-workspaces-v19.mjs', repositoryWorkspaceV19Routes],
  ['pull-request-intents-v19.mjs', pullRequestIntentV19Routes],
  ['workflow-executions-v110.mjs', workflowExecutionV110Routes],
  ['context-v20.mjs', contextV20Routes]
];

export const apiRouteGroups = Object.freeze(
  groups.map(([sourceModule, routes]) => Object.freeze({ source_module: sourceModule, routes }))
);
export const apiRoutes = Object.freeze(
  apiRouteGroups.flatMap(({ source_module, routes }) =>
    routes.map((route) => Object.freeze({ ...route, source_module }))
  )
);
