import { PROJECT_OWNER_TABLES } from './project-domain-helpers.mjs';

/** Repository connection, source drift, and workspace fencing owner. */
export class RepositoryService {
  constructor({ core } = {}) {
    if (!core) throw new TypeError('project_core_required');
    this.core = core;
    this.owner = 'Repository';
    this.tables = PROJECT_OWNER_TABLES.Repository;
  }

  listConnections(id, principal) { return this.core.listRepositoryConnections(id, principal); }
  createConnection(id, input, principal) { return this.core.createRepositoryConnection(id, input, principal); }
  updateConnection(id, input, principal) { return this.core.updateRepositoryConnection(id, input, principal); }
  listTargets(id, principal) { return this.core.listRepositoryTargets(id, principal); }
  createTarget(id, input, principal) { return this.core.createRepositoryTarget(id, input, principal); }
  synchronizeBaselineInTransaction(tx, id, input) { return this.core.synchronizeRepositoryBaselineInTransaction(tx, id, input); }
  listLines(id, principal) { return this.core.listRepositoryLines(id, principal); }
  reconcileLine(id, input, principal) { return this.core.reconcileRepositoryLine(id, input, principal); }
  listWorkspaces(id, principal) { return this.core.listRepositoryWorkspaces(id, principal); }
  createWorkspace(id, input, principal) { return this.core.createRepositoryWorkspace(id, input, principal); }
  refreshWorkspace(id, input, principal) { return this.core.refreshRepositoryWorkspace(id, input, principal); }
  lockWorkspace(id, input, principal) { return this.core.lockRepositoryWorkspace(id, input, principal); }
  releaseWorkspace(id, input, principal) { return this.core.releaseRepositoryWorkspace(id, input, principal); }
}
