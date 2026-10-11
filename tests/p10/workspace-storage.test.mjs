// Owner: Platform/Testing. Phase: P10+. Real files, child processes and rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { runManaged } from '../../scripts/workspace-run.mjs';
import { snapshot, sealManifest, applyManifest, layout, loadManifest } from '../../scripts/lib/workspace-storage.mjs';
import { validateCreationSites } from '../../scripts/workspace-storage.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-storage-test-'));
  const temp = path.join(root, 'temp'); const archive = path.join(root, 'archive');
  fs.mkdirSync(temp); fs.mkdirSync(archive);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, AIWS_TEMP_ROOT: temp, AIWS_ARCHIVE_ROOT: archive };
  delete env.AIWS_STORAGE_RUN_ID; delete env.AIWS_STORAGE_COMMAND_ID;
  return { root, temp, archive, env };
}
const writer = "const f=require('fs'),p=require('path'),o=require('os');f.writeFileSync(p.join(o.tmpdir(),'data.txt'),'fixture');";
test('successful commands clean their exclusive run and preserve adjacent files', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.temp, 'keep'), 'keep');
  const result = await runManaged(['node', '-e', writer], { env: f.env, stdio: 'inherit' });
  assert.equal(result.exit_status, 0); assert.equal(result.cleanup_error, null);
  assert.deepEqual(fs.readdirSync(path.join(f.temp, 'runs')), []);
  assert.equal(fs.readFileSync(path.join(f.temp, 'keep'), 'utf8'), 'keep');
});
test('failure archives bytes and original nonzero status without recording arguments', async t => {
  const f = fixture(t);
  const result = await runManaged(['node', '-e', `${writer}process.exit(7)`], { env: f.env, stdio: 'ignore' });
  assert.equal(result.exit_status, 7);
  const archived = path.join(f.archive, 'failed-runs', result.archive_id);
  assert.equal(fs.readFileSync(path.join(archived, 'temp/data.txt'), 'utf8'), 'fixture');
  assert.equal(JSON.parse(fs.readFileSync(path.join(archived, 'result.json'))).business_exit_status, 7);
  assert.equal(JSON.stringify(result).includes(writer), false);
});
test('spawn failure and timeout remain failures with independent cleanup results', async t => {
  const f = fixture(t);
  const missing = await runManaged(['aiws-command-that-does-not-exist'], { env: f.env, stdio: 'ignore' });
  assert.equal(missing.business_error, 'ENOENT'); assert.notEqual(missing.exit_status, 0);
  const timeout = await runManaged(['node', '-e', 'setInterval(()=>{},1000)'], { env: f.env, timeoutMs: 500, stdio: 'ignore' });
  assert.equal(timeout.business_error, 'workspace_run_timeout'); assert.notEqual(timeout.exit_status, 0);
});
test('authentication leftovers are not copied into diagnostic archives', async t => {
  const f = fixture(t);
  const result = await runManaged(['node', '-e', "require('fs').writeFileSync(require('path').join(require('os').tmpdir(),'auth.json'),'private');process.exit(9)"], { env: f.env, stdio: 'ignore' });
  assert.equal(result.exit_status, 9); assert.equal(result.cleanup_error, 'workspace_run_auth_owner_cleanup_required');
  assert.equal(fs.existsSync(path.join(f.archive, 'failed-runs')), false);
});
test('nested commands share run identity and lock namespace but own different directories', async t => {
  const f = fixture(t); const output = path.join(f.root, 'nested.json');
  const inner = "require('fs').writeFileSync(process.env.STORAGE_TEST_OUTPUT,JSON.stringify({id:process.env.AIWS_STORAGE_RUN_ID,cmd:process.env.AIWS_STORAGE_COMMAND_ID,temp:require('os').tmpdir(),lock:process.env.AIWS_PORT_LEASE_ROOT}))";
  const script = `const {runManaged}=await import('./scripts/workspace-run.mjs');const r=await runManaged(['node','-e',${JSON.stringify(inner)}],{stdio:'ignore'});process.exitCode=r.exit_status;`;
  const lock = path.join(f.root, 'shared-lock');
  const result = await runManaged(['node', '--input-type=module', '-e', script], { env: { ...f.env, STORAGE_TEST_OUTPUT: output, AIWS_PORT_LEASE_ROOT: lock }, stdio: 'ignore' });
  assert.equal(result.exit_status, 0);
  const nested = JSON.parse(fs.readFileSync(output));
  assert.equal(nested.id, result.run_id); assert.notEqual(nested.cmd, result.command_id); assert.equal(nested.lock, lock);
  assert.deepEqual(fs.readdirSync(path.join(f.temp, 'runs')), []);
});
test('concurrent commands allocate distinct run roots', async t => {
  const f = fixture(t);
  const results = await Promise.all([1, 2].map(() => runManaged(['node', '-e', writer], { env: f.env, stdio: 'ignore' })));
  assert.equal(new Set(results.map(row => row.run_id)).size, 2);
  assert.ok(results.every(row => row.exit_status === 0));
  assert.deepEqual(fs.readdirSync(path.join(f.temp, 'runs')), []);
});
function migration(f, sourceParent = f.root) {
  const source = path.join(sourceParent, `sample space 中文-${randomUUID()}`);
  fs.mkdirSync(source); fs.mkdirSync(path.join(source, 'empty')); fs.writeFileSync(path.join(source, 'a'), 'original');
  const before = snapshot(source); const destination = path.join(f.archive, 'sample'); const manifest = path.join(f.root, 'manifest.json');
  sealManifest(manifest, { schema: 'aiws.workspace-storage.v1', source_roots: [sourceParent], destination_root: f.archive, items: [{ id: 'sample', source, destination, classification: 'archive', reason: 'Isolated test fixture with explicit creator identity', proof: { owner: 'test' }, snapshot: before }] });
  return { source, destination, manifest, before };
}
test('same-volume migration, idempotence, verify, dry-run and actual rollback preserve bytes', t => {
  const f = fixture(t); const m = migration(f);
  const applied = applyManifest(m.manifest, 'apply');
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applyManifest(m.manifest, 'apply').ok, true);
  assert.equal(applyManifest(m.manifest, 'verify').ok, true);
  assert.equal(applyManifest(m.manifest, 'rollback', true).ok, true);
  assert.equal(fs.existsSync(m.source), false);
  assert.deepEqual(applyManifest(m.manifest, 'rollback').byte_exact_mismatches, []);
  assert.equal(snapshot(m.source).sha256, m.before.sha256);
  assert.equal(applyManifest(m.manifest, 'rollback').ok, true);
});
test('changed files, destination collisions and modified manifests fail closed', t => {
  const f = fixture(t); const m = migration(f);
  fs.writeFileSync(path.join(m.source, 'a'), 'changed');
  assert.equal(applyManifest(m.manifest, 'apply').ok, false);
  fs.writeFileSync(path.join(m.source, 'a'), 'original'); fs.mkdirSync(m.destination);
  assert.equal(applyManifest(m.manifest, 'apply').ok, false);
  const body = JSON.parse(fs.readFileSync(m.manifest)); body.items[0].destination += '-changed';
  fs.writeFileSync(m.manifest, JSON.stringify(body));
  assert.throws(() => loadManifest(m.manifest), /storage_manifest_invalid/);
});
test('rollback refuses post-archive mutation without overwriting', t => {
  const f = fixture(t); const m = migration(f);
  assert.equal(applyManifest(m.manifest, 'apply').ok, true);
  fs.writeFileSync(path.join(m.destination, 'new'), 'retain');
  assert.throws(() => applyManifest(m.manifest, 'rollback'), /storage_source_changed/);
  assert.equal(fs.readFileSync(path.join(m.destination, 'new'), 'utf8'), 'retain');
  assert.equal(fs.existsSync(m.source), false);
});
test('junctions are inventoried without following and cannot cross migration boundaries', t => {
  const f = fixture(t); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  const m = migration(f); fs.symlinkSync(outside, path.join(m.source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const captured = snapshot(m.source);
  assert.equal(captured.rows.filter(row => row.kind === 'link').length, 1);
  assert.equal(captured.rows.some(row => row.path.endsWith('keep')), false);
  assert.equal(applyManifest(m.manifest, 'apply').ok, false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
});
test('source inventory is bidirectional and every registered creation site has owners', () => {
  const result = validateCreationSites(process.cwd()); assert.ok(result.sites > 100); assert.equal(result.valid, true);
});
test('all linked worktrees derive the main checkout layout and explicit roots take precedence', t => {
  const f = fixture(t); const derived = layout(process.cwd(), f.env);
  assert.equal(derived.temp, fs.realpathSync(f.temp)); assert.equal(derived.archive, fs.realpathSync(f.archive));
  assert.ok(fs.existsSync(path.join(derived.main, '.git')));
});

test('cancellation terminates the owned process tree and archives its failure', async t => {
  const f = fixture(t); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const result = await runManaged(['node', '-e', 'setInterval(()=>{},1000)'], { env: f.env, signal: controller.signal, stdio: 'ignore' });
    assert.notEqual(result.exit_status, 0); assert.equal(result.signal, 'cancelled');
    assert.ok(result.archive_id);
  } finally { clearTimeout(timer); }
});
test('cleanup identity failure cannot turn a successful child into a successful run', async t => {
  const f = fixture(t);
  const result = await runManaged(['node', '-e', "require('fs').unlinkSync(require('path').join(require('os').tmpdir(),'..','.owner.json'))"], { env: f.env, stdio: 'ignore' });
  assert.equal(result.business_exit_status, 0); assert.equal(result.cleanup_error, 'ENOENT'); assert.equal(result.exit_status, 1);
});
test('Windows job refuses success while descendants survive their parent', async t => {
  if (process.platform !== 'win32') return;
  const f = fixture(t);
  const result = await runManaged(['node', '-e', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref()"], { env: f.env, stdio: 'ignore' });
  assert.equal(result.business_exit_status, 0); assert.equal(result.business_error, 'workspace_run_descendants_alive'); assert.equal(result.exit_status, 1);
});
test('actual cross-volume migration and rollback restore bytes and original ACLs', t => {
  if (process.platform !== 'win32') return;
  const f = fixture(t);
  const systemTemp = path.dirname(process.env.AIWS_PORT_LEASE_ROOT);
  assert.notEqual(path.parse(systemTemp).root.toLowerCase(), path.parse(f.archive).root.toLowerCase(), 'workstation C/E cross-volume proof');
  const sampleRoot = fs.mkdtempSync(path.join(systemTemp, 'aiws-storage-cross-'));
  t.after(() => fs.rmSync(sampleRoot, { recursive: true, force: true }));
  const m = migration(f, sampleRoot);
  const applied = applyManifest(m.manifest, 'apply'); assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applyManifest(m.manifest, 'verify').ok, true);
  assert.equal(applyManifest(m.manifest, 'rollback', true).ok, true);
  const rolled = applyManifest(m.manifest, 'rollback'); assert.deepEqual(rolled.byte_exact_mismatches, [], JSON.stringify(rolled));
  assert.equal(snapshot(m.source).sha256, m.before.sha256);
});

test('an exclusively held Windows file freezes migration until its owner closes it', async t => {
  if (process.platform !== 'win32') return;
  const f = fixture(t); const m = migration(f);
  const holder = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$f=[IO.File]::Open($env:STORAGE_LOCK_FILE,'Open','Read','None');[Console]::WriteLine('READY');try{Start-Sleep -Seconds 30}finally{$f.Dispose()}"], { env: { ...process.env, STORAGE_LOCK_FILE: path.join(m.source, 'a') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const closed = new Promise(resolve => holder.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', value => String(value).includes('READY') ? resolve() : reject(new Error('lock_not_ready')));
      holder.once('error', reject); holder.once('exit', () => reject(new Error('lock_holder_exited')));
    });
    assert.equal(applyManifest(m.manifest, 'apply').ok, false);
    assert.equal(fs.existsSync(m.source), true); assert.equal(fs.existsSync(m.destination), false);
  } finally { holder.kill(); await closed; }
  assert.equal(applyManifest(m.manifest, 'apply').ok, true);
  assert.deepEqual(applyManifest(m.manifest, 'rollback').byte_exact_mismatches, []);
});
test('interrupted rename resumes from an immutable intent without repeating a move', t => {
  const f = fixture(t); const m = migration(f);
  assert.equal(applyManifest(m.manifest, 'apply').ok, true);
  // Simulate a crash between durable rename and receipt publication in this
  // disposable test journal; production receipts are never deleted.
  fs.unlinkSync(path.join(m.manifest + '.journal', 'sample.applied.json'));
  assert.equal(applyManifest(m.manifest, 'apply').ok, true);
  assert.equal(applyManifest(m.manifest, 'apply').ok, true);
  assert.deepEqual(applyManifest(m.manifest, 'rollback').byte_exact_mismatches, []);
});
