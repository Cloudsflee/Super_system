import fs from 'node:fs';
import path from 'node:path';
import { treeManifest } from './runner-input-provider.mjs';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

// Owner: Repository. Phase: post-P10. Snapshots use the existing receipt ledger.
export class CandidateWorkspace {
  constructor({ db, root, repository }) { this.db = db; this.root = path.resolve(root); this.repository = repository; }
  directory(execution) { return this.path(`candidates/${execution.id}/${execution.generation}`); }
  path(relative) { const target = path.resolve(this.root, relative); if (!target.startsWith(`${this.root}${path.sep}`)) fail('runner_path_invalid'); return target; }
  manifestHash(directory) { return sha256Hex(canonicalJson(treeManifest(directory))); }
  async prepare(execution, managed) {
    const id = `candidate-${execution.id}-${execution.generation}`, target = this.directory(execution);
    const prior = this.db.get('SELECT * FROM receipt_manifests WHERE id=?', [id]);
    if (prior) { if (!fs.existsSync(target)) fail('workspace_changed'); return target; }
    const workspace = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [execution.repository_workspace_id]);
    if (!fs.existsSync(managed)) fs.mkdirSync(managed, { recursive: true, mode: 0o700 });
    const before = this.manifestHash(managed);
    if (fs.existsSync(target)) fail('external_result_unknown');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(managed, target, { recursive: true, errorOnExist: true, force: false });
    if (this.manifestHash(target) !== before || this.manifestHash(managed) !== before) fail('workspace_changed');
    const payload = canonicalJson({ workspace_id: workspace.id, workspace_revision: Number(workspace.revision), base_hash: before });
    await this.db.withTransaction((tx) => tx.run("INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,created_at) VALUES(?,'repository.candidate','verified',?,?,?)", [id,payload,sha256Hex(payload),new Date().toISOString()]));
    return target;
  }
  async publish(execution, managed, principal) {
    const id = `candidate-${execution.id}-${execution.generation}`;
    const prior = this.db.get('SELECT * FROM receipt_manifests WHERE id=?', [id]);
    if (!prior || sha256Hex(prior.payload_json) !== prior.payload_sha256) fail('workspace_changed');
    const pin = JSON.parse(prior.payload_json), candidate = this.directory(execution), after = this.manifestHash(candidate);
    const completed = this.db.get('SELECT * FROM receipt_manifests WHERE id=?', [`publish-${execution.id}-${execution.generation}`]);
    if (completed) { if (this.manifestHash(managed) !== after) fail('workspace_changed'); return; }
    const workspace = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [pin.workspace_id]);
    if (Number(workspace.revision) !== pin.workspace_revision || this.manifestHash(managed) !== pin.base_hash) fail('workspace_changed');
    const lock = await this.repository.lockRepositoryWorkspace(workspace.id, { expected_revision: workspace.revision, idempotency_key: `publish-lock-${execution.id}-${execution.generation}` }, principal);
    const staging = this.path(`publication/${execution.id}/${execution.generation}`), backup = this.path(`rollback/${execution.id}/${execution.generation}`);
    let moved = false;
    try {
      if (fs.existsSync(staging) || fs.existsSync(backup)) fail('external_result_unknown');
      fs.mkdirSync(path.dirname(staging), { recursive: true }); fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.cpSync(candidate, staging, { recursive: true, force: false });
      const active = this.db.get("SELECT * FROM repository_locks WHERE id=? AND status='active'", [lock.lock.id]);
      if (!active || active.fencing_token !== lock.lock.fencing_token || Date.parse(active.expires_at) <= Date.now()) fail('workspace_lease_lost');
      if (this.manifestHash(managed) !== pin.base_hash || this.manifestHash(candidate) !== after || this.manifestHash(staging) !== after) fail('workspace_changed');
      fs.renameSync(managed, backup); moved = true;
      fs.renameSync(staging, managed);
      if (this.manifestHash(managed) !== after) fail('workspace_changed');
      const payload = canonicalJson({ execution_id: execution.id, generation: execution.generation, before_sha256: pin.base_hash, after_sha256: after, rollback_ref: `rollback/${execution.id}/${execution.generation}`, fencing_token_hash: sha256Hex(lock.lock.fencing_token) });
      await this.db.withTransaction((tx) => tx.run("INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,created_at) VALUES(?,'repository.publication','verified',?,?,?)", [`publish-${execution.id}-${execution.generation}`,payload,sha256Hex(payload),new Date().toISOString()]));
    } catch (error) {
      if (moved && fs.existsSync(backup)) { if (fs.existsSync(managed)) fs.renameSync(managed, staging); fs.renameSync(backup, managed); }
      throw error;
    } finally {
      const current = this.db.get('SELECT * FROM repository_workspaces WHERE id=?', [workspace.id]);
      if (current.status === 'locked') await this.repository.releaseRepositoryWorkspace(workspace.id, { expected_revision: current.revision, idempotency_key: `publish-release-${execution.id}-${execution.generation}` }, principal);
    }
  }
}
function fail(code) { throw new PlatformError(code, 'repository candidate snapshot validation failed', {}, 409); }
