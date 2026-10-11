// Owner: Platform/Testing. Phase: P10+. Manifests contain private absolute paths.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { layout, git, digest, snapshot, sealManifest, applyManifest, fail } from './lib/workspace-storage.mjs';

export function creationSites(root) {
  const files = git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const rows = [];
  for (const file of [...new Set(files)].sort()) {
    if (!/^(?:scripts|tests|apps|packages)\/.*\.(?:mjs|js|ts|tsx)$/.test(file)) continue;
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/\b(?:mkdtemp(?:Sync)?\s*\(|(?:os\.)?tmpdir\s*\()/.test(line)) return;
      rows.push({ file, line: index + 1, source_sha256: digest(line.trim()), source: line.trim(), creator: file, cleanup_owner: /^(?:apps|packages)\//.test(file) ? 'existing_runtime_owner' : 'workspace:run + fixture resource owner', entrypoint: /^(?:apps|packages)\//.test(file) ? 'existing runtime (test launcher not imported)' : 'pnpm workspace:run -- node', exception: file === 'scripts/lib/port-lease.mjs' && line.includes('LOCK_DIRECTORY') ? 'shared coordination; retained outside runs' : null });
    });
  }
  return rows;
}
export function validateCreationSites(root) {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'scripts/lib/workspace-storage-sources.json'), 'utf8'));
  const actual = creationSites(root);
  const key = row => `${row.file}:${row.line}:${row.source_sha256}`;
  const keys = expected.sites.map(key);
  if (new Set(keys).size !== keys.length || actual.length !== keys.length || actual.some(row => !keys.includes(key(row)))
    || expected.sites.some(row => !row.creator || !row.cleanup_owner || !row.entrypoint)) fail('storage_source_inventory_mismatch');
  return { sites: actual.length, valid: true };
}
export function scan(root, output) {
  const roots = layout(root);
  const sites = creationSites(root);
  const prefixes = [...new Set(sites.flatMap(row => [...row.source.matchAll(/['"]((?:aiws-|v3-clean-|p\d+-)[\w-]+-)['"]/g)].map(match => match[1])))];
  const worktrees = git(root, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => path.resolve(line.slice(9)));
  const sources = [path.join(roots.main, '.ai-workspace'), roots.temp, roots.archive, roots.worktrees, roots.systemTemp, 'E:\\var\\lib\\aiws', path.dirname(roots.main), path.parse(roots.main).root];
  const processResult = process.platform === 'win32' ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }) : null;
  let processes = [];
  if (processResult?.status === 0) { try { processes = JSON.parse(processResult.stdout); } catch {} }
  const files = git(roots.main, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const references = [];
  for (const file of files) {
    if (!/\.(?:json|mjs|js|ts|tsx|md|ps1|yml|yaml|env|toml|txt)$/.test(file)) continue;
    try { references.push({ file, text: fs.readFileSync(path.join(roots.main, file), 'utf8').replaceAll('\\\\', '/').replaceAll('\\', '/') }); } catch {}
  }
  const id = randomUUID();
  const destination = path.join(roots.archive, 'legacy', id);
  const items = []; const visited = new Set();
  for (const sourceRoot of sources) {
    if (!fs.existsSync(sourceRoot)) continue;
    // Enumerate one level only. Junctions are recorded, never traversed.
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const source = path.join(sourceRoot, entry.name);
      if (visited.has(source.toLowerCase())) continue;
      visited.add(source.toLowerCase());
      const prefix = prefixes.find(value => entry.name.startsWith(value));
      if (sourceRoot === roots.systemTemp && !prefix && !/^(?:aiws|v3-clean|p\d+-)/.test(entry.name)) continue;
      let classification = 'skip_unknown'; let reason = 'No durable creator identity or independently verified idle-state proof';
      const proof = [];
      const referenced = references.filter(row => row.text.includes(source.replaceAll('\\', '/')) || (sourceRoot.endsWith('.ai-workspace') && row.text.includes(`.ai-workspace/${entry.name}`))).map(row => row.file);
      const active = processes.filter(row => row.CommandLine?.toLowerCase().includes(source.toLowerCase())).map(row => row.ProcessId);
      if (prefix) proof.push(...sites.filter(row => row.source.includes(prefix)).map(row => ({ file: row.file, line: row.line, source_sha256: row.source_sha256 })));
      if (sourceRoot === roots.archive) { classification = 'keep_referenced'; reason = 'Existing archive or receipt: retain immutable organization history'; }
      else if (worktrees.includes(path.resolve(source)) || source === roots.main) { classification = 'keep_referenced'; reason = 'Registered Git worktree; managed only through Git'; }
      else if (entry.isSymbolicLink()) { classification = 'keep_referenced'; reason = 'Existing junction/link; not traversed'; }
      else if (active.length) { classification = 'skip_active'; reason = 'Referenced by a current process command line'; }
      else if (referenced.length) { classification = 'keep_referenced'; reason = 'Referenced by tracked source, Evidence or configuration'; }
      else if (entry.name === 'aiws-port-leases-v1' || (sourceRoot.endsWith('.ai-workspace') && /^(?:data|cas|vault|v3-clean|workspaces|assist-workspaces|codex-homes|attachments|attachment-staging|executions|logs|service-logs)$/.test(entry.name))) { classification = 'keep_runtime'; reason = 'Runtime state, authentication owner or shared coordination'; }
      else if ([path.dirname(roots.main), path.parse(roots.main).root].includes(sourceRoot)) { classification = 'other_project'; reason = 'Outside confirmed project ownership; shallow discovery only'; }
      // Old directories lack a run token. Do not manufacture ownership from a
      // matching prefix. A human-reviewed manifest may attach stronger proof;
      // apply additionally requires exact bytes and exclusive handle checks.
      items.push({ id: String(items.length + 1).padStart(6, '0'), source, source_role: sourceRoot === roots.systemTemp ? 'windows-temp' : sourceRoot.endsWith('.ai-workspace') ? 'project-workspace' : 'discovery', classification, reason, creator_candidates: proof, references: referenced, active_pids: active, link_target: entry.isSymbolicLink() ? fs.readlinkSync(source) : null });
    }
  }
  sealManifest(output, { schema: 'aiws.workspace-storage.v1', run_id: id, created_at: new Date().toISOString(), baseline: git(root, ['rev-parse', 'HEAD']), source_roots: sources, destination_root: destination, process_inventory_available: processes.length > 0, creation_sites: sites, items });
  return { candidates: items.length, classifications: Object.fromEntries(['archive', 'keep_referenced', 'keep_runtime', 'skip_active', 'skip_unknown', 'other_project'].map(key => [key, items.filter(row => row.classification === key).length])) };
}
export function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--') argv = argv.slice(1);
  const [action, ...args] = argv;
  const value = name => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) fail('storage_argument_missing'); return path.resolve(args[index + 1]); };
  if (action === 'scan') return scan(process.cwd(), value('--out'));
  if (action === 'audit') return validateCreationSites(process.cwd());
  return applyManifest(value('--manifest'), action, args.includes('--dry-run'));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const result = main(); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); if (result.ok === false) process.exitCode = 1; }
  catch (error) { process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1; }
}
