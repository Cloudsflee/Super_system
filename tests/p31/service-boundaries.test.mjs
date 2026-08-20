import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { open, close } from './helpers.mjs';

test('facades expose complete owner inventories and command routing', async () => {
  const state = await open();
  try {
    const { runtime } = state;
    assert.deepEqual(Object.keys(runtime.projectWorkflow.ownerInventory()).sort(), ['Outcome', 'Project', 'Repository', 'Workflow']);
    assert.deepEqual(Object.keys(runtime.identity.ownerInventory()).sort(), ['Actor', 'CredentialProfile', 'Session', 'TeamAccess']);
    assert.equal(runtime.projectWorkflow.ownerForCommand('repository.line.reconcile'), 'Repository');
    assert.equal(runtime.projectWorkflow.ownerForCommand('generation.start'), 'Workflow');
    assert.equal(runtime.projectWorkflow.ownerForCommand('outcome.requirement.create'), 'Outcome');
    assert.equal(runtime.identity.ownerForCommand('session.revoke'), 'Session');
    assert.equal(runtime.identity.ownerForCommand('credential.rebind'), 'CredentialProfile');
    assert.equal(runtime.identity.projectScopeResolver, runtime.authorization.projectScopeResolver);
    assert.equal(runtime.projectWorkflow.projectService.core, runtime.projectWorkflow.core);
    assert.equal(runtime.projectWorkflow.repositoryService.core, runtime.projectWorkflow.core);
    assert.equal(runtime.projectWorkflow.workflowService.core, runtime.projectWorkflow.core);
    assert.equal(runtime.projectWorkflow.outcomeService.core, runtime.projectWorkflow.core);
    assert.equal(runtime.identity.actorService.core, runtime.identity.core);
    assert.equal(runtime.identity.sessionService.core, runtime.identity.core);
    assert.equal(runtime.identity.teamAccessService.core, runtime.identity.core);
    assert.equal(runtime.identity.credentialProfileService.core, runtime.identity.core);

    const projectSentinel = { forwarded: 'project' };
    const projectList = runtime.projectWorkflow.projectService.list;
    runtime.projectWorkflow.projectService.list = () => projectSentinel;
    assert.equal(runtime.projectWorkflow.listProjects('principal'), projectSentinel);
    runtime.projectWorkflow.projectService.list = projectList;
    const identitySentinel = { forwarded: 'identity' };
    const actorList = runtime.identity.actorService.list;
    runtime.identity.actorService.list = () => identitySentinel;
    assert.equal(runtime.identity.actors('principal'), identitySentinel);
    runtime.identity.actorService.list = actorList;
  } finally { close(state); }
});

test('owner modules contain no direct SQL writes and facades retain public methods', () => {
  const files = ['project-service.mjs', 'repository-service.mjs', 'workflow-service.mjs', 'outcome-service.mjs', 'actor-service.mjs', 'session-service.mjs', 'team-access-service.mjs', 'credential-profile-service.mjs'];
  for (const file of files) {
    const source = fs.readFileSync(new URL(`../../apps/api/src/clean/${file}`, import.meta.url), 'utf8');
    assert.equal(/\b(?:tx|db)\.(?:run|exec)\s*\(/.test(source), false, `${file} owns persistence through the facade ledger`);
  }
});
