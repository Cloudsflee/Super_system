import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, normalizePath, redactText, runCommandSync, sha256, writeFileEnsured } from './v175-lib.mjs';

export function captureBaseline(reportDir, runId, isolation = {}) {
  const files = sourceSnapshot(), active = activeWorkspaceSnapshot(), commands = processCommands(), writers = workspaceWriters(commands);
  const baseline = {
    run_id: runId, captured_at: new Date().toISOString(),
    git: {
      commit: text(['git', 'rev-parse', 'HEAD']), branch: text(['git', 'branch', '--show-current']),
      status: output(['git', 'status', '--porcelain=v1', '--untracked-files=all']),
      dirty_diff_sha256: sha256(Buffer.concat([buffer(['git', 'diff', '--binary', 'HEAD']), buffer(['git', 'diff', '--cached', '--binary', 'HEAD'])])),
      source_snapshot_sha256: snapshotHash(files), source_file_count: Object.keys(files).length
    },
    environment: {
      platform: `${process.platform} ${process.arch}`, node: process.version,
      pnpm: text(['pnpm', '--version']), docker: text(['docker', 'version', '--format', '{{.Client.Version}}/{{.Server.Version}}']),
      codex: text(['codex', '--version'])
    },
    host: {
      processes: hostOutput(process.platform === 'win32' ? ['tasklist', '/fo', 'csv', '/nh'] : ['ps', '-eo', 'pid,ppid,comm']),
      ports: hostOutput(process.platform === 'win32' ? ['netstat', '-ano', '-p', 'tcp'] : ['ss', '-ltnp']),
      relevant_process_commands: commands
    },
    docker: {
      containers: output(['docker', 'ps', '-a', '--no-trunc', '--format', '{{.ID}}|{{.Names}}|{{.Status}}|{{.Labels}}']),
      images: output(['docker', 'images', '--no-trunc', '--format', '{{.ID}}|{{.Repository}}:{{.Tag}}|{{.Size}}']),
      volumes: output(['docker', 'volume', 'ls', '--format', '{{.Name}}|{{.Labels}}'])
    },
    active_workspace: {
      state_sha256: fileHash(path.join(ROOT, '.ai-workspace', 'data', 'state.json')),
      snapshot_sha256: snapshotHash(active), file_count: Object.keys(active).length,
      preexisting_writers: writers, isolation
    },
    _source_snapshot: files, _active_snapshot: active
  };
  writeFileEnsured(path.join(reportDir, 'baseline.json'), JSON.stringify(publicBaseline(baseline), null, 2));
  return baseline;
}

export function finishBaseline(baseline, reportDir) {
  const sourceAfter = sourceSnapshot(), activeAfter = activeWorkspaceSnapshot();
  const sourceChanges = diffSnapshots(baseline._source_snapshot, sourceAfter), activeChanges = diffSnapshots(baseline._active_snapshot, activeAfter);
  const drift = classifyWorkspaceDrift({ sourceChanges, activeChanges, writers: baseline.active_workspace.preexisting_writers, isolation: baseline.active_workspace.isolation });
  const result = {
    captured_at: new Date().toISOString(), source_changes: sourceChanges, active_workspace_changes: activeChanges,
    source_polluted: sourceChanges.length > 0, active_workspace_polluted: drift.polluted, active_workspace_external_drift: drift.external,
    active_workspace_drift_reason: drift.reason, preexisting_writers: baseline.active_workspace.preexisting_writers, isolation: baseline.active_workspace.isolation,
    active_state_sha256: fileHash(path.join(ROOT, '.ai-workspace', 'data', 'state.json')),
    labeled_resources: labeledResources(baseline.run_id)
  };
  result.resources_clean = Object.values(result.labeled_resources).every((items) => items.length === 0);
  writeFileEnsured(path.join(reportDir, 'final-baseline.json'), JSON.stringify(result, null, 2));
  return result;
}

export function classifyWorkspaceDrift({ sourceChanges = [], activeChanges = [], writers = [], isolation = {} }) {
  if (!activeChanges.length) return { polluted: false, external: false, reason: 'no_active_workspace_changes' };
  const isolationProven = isolation.child_aiws_home === true && isolation.report_output_redirected === true && isolation.docker_context_excludes_active_workspace === true;
  if (!sourceChanges.length && writers.length && isolationProven) return { polluted: false, external: true, reason: 'preexisting_writer_with_proven_test_isolation' };
  return { polluted: true, external: false, reason: !writers.length ? 'no_preexisting_writer' : !isolationProven ? 'test_isolation_not_proven' : 'source_changed_during_run' };
}

export function publicBaseline(value) {
  const { _source_snapshot, _active_snapshot, ...clean } = value;
  return clean;
}

function sourceSnapshot() {
  const result = runCommandSync(['git', 'ls-files', '-co', '--exclude-standard']);
  const files = result.status === 0 ? result.stdout.split(/\r?\n/).map(normalizePath).filter(Boolean) : [];
  return Object.fromEntries(files.map((file) => [file, fileHash(path.join(ROOT, file))]));
}

function activeWorkspaceSnapshot() {
  const root = path.join(ROOT, '.ai-workspace');
  if (!fs.existsSync(root)) return {};
  const result = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name), relative = normalizePath(path.relative(root, full));
      if (relative === 'test-reports' || relative.startsWith('test-reports/')) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result[relative] = fileHash(full);
      else result[relative] = entry.isSymbolicLink() ? `symlink:${fs.readlinkSync(full)}` : 'other';
    }
  };
  visit(root);
  return result;
}

function fileHash(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const stat = fs.statSync(file);
  return stat.size > 16 * 1024 * 1024 ? `large:${stat.size}:${stat.mtimeMs}` : sha256(fs.readFileSync(file));
}

function snapshotHash(snapshot) { return sha256(JSON.stringify(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)))); }
function diffSnapshots(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]), changes = [];
  for (const key of [...keys].sort()) if (before[key] !== after[key]) changes.push({ path: key, before: before[key] || null, after: after[key] || null });
  return changes;
}

function labeledResources(runId) {
  const filter = `label=aiws.test_run=${runId}`;
  return {
    containers: lines(['docker', 'ps', '-aq', '--filter', filter]),
    volumes: lines(['docker', 'volume', 'ls', '-q', '--filter', filter]),
    networks: lines(['docker', 'network', 'ls', '-q', '--filter', filter]),
    images: lines(['docker', 'images', '-q', '--filter', filter])
  };
}

function processCommands() {
  const result = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    : spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) return [];
  if (process.platform === 'win32') {
    try {
      const parsed = JSON.parse(result.stdout || '[]'), rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.filter(relevantCommand).map((item) => ({ pid: Number(item.ProcessId), parent_pid: Number(item.ParentProcessId), name: String(item.Name || ''), command: redactText(item.CommandLine || '') }));
    } catch { return []; }
  }
  return String(result.stdout || '').split(/\r?\n/).flatMap((line) => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); if (!match) return []; const item = { pid: Number(match[1]), parent_pid: Number(match[2]), name: match[3], command: redactText(match[4]) }; return relevantCommand(item) ? [item] : []; });
}

function relevantCommand(item) { const value = String(item.CommandLine || item.command || ''); return /apps[\\/]api[\\/]server\.mjs|v175-runner|@openai[\\/]codex|codex\.exe/i.test(value); }
function workspaceWriters(commands) { return commands.filter((item) => /apps[\\/]api[\\/]server\.mjs/i.test(item.command)); }

function output(argv) { const result = runCommandSync(argv); return result.status === 0 ? normalizeCommandOutput(result.stdout) : `unavailable:${redactText(result.stderr || result.error?.message)}`; }
export function normalizeCommandOutput(value) { return redactText(value).replace(/(?:\r?\n)+$/, ''); }
function text(argv) { const value = output(argv); return value.split(/\r?\n/)[0] || 'unavailable'; }
function buffer(argv) { const result = runCommandSync(argv); return Buffer.from(result.status === 0 ? result.stdout : result.stderr); }
function lines(argv) { const result = runCommandSync(argv); return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : []; }
function hostOutput(argv) { const result = spawnHost(argv); return result.status === 0 ? redactText(result.stdout).split(/\r?\n/).slice(0, 500) : [`unavailable:${redactText(result.stderr || result.error?.message)}`]; }
function spawnHost([command, ...args]) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error || null };
}
