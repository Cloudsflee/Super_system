import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCommand } from '../../scripts/v175-lib.mjs';

const args = parseArgs(), durationMs = Number(args['duration-ms'] || 7_200_000), cycles = Number(args.cycles || 20), output = path.resolve(String(args.output || 'soak-summary.json'));
if (!Number.isFinite(durationMs) || durationMs < 7_200_000) throw new Error('V1.75 soak duration must be at least 120 minutes');
if (!Number.isInteger(cycles) || cycles < 20) throw new Error('V1.75 soak requires at least 20 cycles');
if (typeof global.gc !== 'function') throw new Error('V1.75 soak requires node --expose-gc for stable heap samples');

const started = Date.now(), interval = durationMs / cycles, samples = [], results = [];
const processBaseline = managedProcesses(), tempBaseline = temporaryFixtures();
for (let index = 0; index < cycles; index++) {
  const target = started + Math.floor(index * interval);
  if (Date.now() < target) await delay(target - Date.now());
  const [buildPort, assistPort] = await Promise.all([freePort(), freePort()]);
  const cycleStarted = Date.now();
  const [build, assist] = await Promise.all([
    runCommand(['node', 'tests/integration/codex-build-async-flow.test.mjs'], { timeout: 120000, env: { AIWS_TEST_PORT: String(buildPort), AIWS_SOAK_CYCLE: String(index + 1) } }),
    runCommand(['node', 'tests/integration/v13-assist-lifecycle-flow.test.mjs'], { timeout: 120000, env: { AIWS_TEST_PORT: String(assistPort), AIWS_SOAK_CYCLE: String(index + 1) } })
  ]);
  const portChecks = await Promise.all([buildPort, assistPort].map((port) => waitForPortRelease(port, 10_000)));
  global.gc();
  const heap = process.memoryUsage().heapUsed;
  samples.push({ cycle: index + 1, at_ms: Date.now() - started, heap_used: heap });
  results.push({ cycle: index + 1, duration_ms: Date.now() - cycleStarted, build: state(build), assist: state(assist), ports: [{ port: buildPort, released: portChecks[0] }, { port: assistPort, released: portChecks[1] }] });
  console.log(`[v175-soak] cycle ${index + 1}/${cycles}: build=${state(build)} assist=${state(assist)} heap=${heap}`);
}
if (Date.now() < started + durationMs) await delay(started + durationMs - Date.now());
await delay(10_000);

const warmed = samples.slice(Math.min(3, samples.length - 1)), firstHeap = warmed[0]?.heap_used || 0, lastHeap = warmed.at(-1)?.heap_used || 0;
const monotonic = warmed.slice(1).every((sample, index) => sample.heap_used >= warmed[index].heap_used);
const growth = firstHeap ? (lastHeap - firstHeap) / firstHeap : 0;
const failures = results.filter((item) => item.build !== 'PASS' || item.assist !== 'PASS');
const processFinal = managedProcesses(), baselinePids = new Set(processBaseline.items.map((item) => item.pid));
const newManagedProcesses = processFinal.items.filter((item) => !baselinePids.has(item.pid));
const occupiedPorts = results.flatMap((item) => item.ports).filter((item) => !item.released);
const residualTempDirectories = temporaryFixtures().filter((item) => !tempBaseline.includes(item));
const lockFiles = findLockFiles([process.env.AIWS_HOME, ...residualTempDirectories].filter(Boolean));
const resources = {
  grace_ms: 10_000, process_inventory_available: processBaseline.available && processFinal.available,
  preexisting_managed_processes: processBaseline.items, new_managed_processes: newManagedProcesses,
  occupied_ports: occupiedPorts, temp_directories: residualTempDirectories, lock_files: lockFiles
};
const summary = {
  generated_at: new Date().toISOString(), duration_ms: Date.now() - started, cycles,
  successful_cycles: cycles - failures.length, heap: { gc_exposed: true, warmup_cycles: 3, first: firstHeap, last: lastHeap, growth_ratio: growth, monotonic },
  resource_grace_ms: 10_000, resources, failures, samples, results
};
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(summary, null, 2));
if (failures.length) throw new Error(`${failures.length} soak cycles failed`);
if (monotonic && growth > 0.2) throw new Error(`heap grew monotonically by ${(growth * 100).toFixed(2)}% after warmup`);
if (!resources.process_inventory_available) throw new Error('managed process inventory was unavailable');
if (newManagedProcesses.length || occupiedPorts.length || residualTempDirectories.length || lockFiles.length) throw new Error(`managed resources remain after grace period: processes=${newManagedProcesses.length} ports=${occupiedPorts.length} temp=${residualTempDirectories.length} locks=${lockFiles.length}`);
console.log(`V1.75 soak passed (${cycles} cycles, ${summary.duration_ms}ms)`);

function parseArgs() { const result = {}; for (let index = 2; index < process.argv.length; index++) if (process.argv[index].startsWith('--')) result[process.argv[index].slice(2)] = process.argv[++index]; return result; }
function state(result) { return result.status === 0 && !result.timedOut ? 'PASS' : result.timedOut ? 'TIMEOUT' : `FAIL:${result.status ?? 'spawn'}`; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); }); }); }
async function waitForPortRelease(port, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    if (await canBind(port)) return true;
    await delay(100);
  }
  return false;
}
function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
function temporaryFixtures() {
  const prefixes = ['aiws-codex-build-', 'aiws-v13-assist-lifecycle-'];
  try { return fs.readdirSync(os.tmpdir(), { withFileTypes: true }).filter((item) => item.isDirectory() && prefixes.some((prefix) => item.name.startsWith(prefix))).map((item) => path.join(os.tmpdir(), item.name)).sort(); }
  catch { return []; }
}
function managedProcesses() {
  const result = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    : spawnSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) return { available: false, items: [] };
  try {
    const rows = process.platform === 'win32'
      ? (() => { const value = JSON.parse(result.stdout || '[]'); return Array.isArray(value) ? value : [value]; })()
      : String(result.stdout || '').split(/\r?\n/).flatMap((line) => { const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/); return match ? [{ ProcessId: match[1], Name: match[2], CommandLine: match[3] }] : []; });
    const patterns = [['api-server', /apps[\\/]api[\\/]server\.mjs/i], ['build-fixture', /codex-build-async-flow\.test\.mjs/i], ['assist-fixture', /v13-assist-lifecycle-flow\.test\.mjs/i]];
    return { available: true, items: rows.flatMap((row) => { const command = String(row.CommandLine || ''); const match = patterns.find(([, pattern]) => pattern.test(command)); return match ? [{ pid: Number(row.ProcessId), name: String(row.Name || ''), kind: match[0] }] : []; }).sort((left, right) => left.pid - right.pid) };
  } catch { return { available: false, items: [] }; }
}
function findLockFiles(roots) {
  const matches = [], seen = new Set();
  const visit = (entry) => {
    if (!entry || seen.has(entry) || matches.length >= 100 || !fs.existsSync(entry)) return;
    seen.add(entry);
    let stat; try { stat = fs.lstatSync(entry); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { if (/(?:^|[.])(lock|pid)$/i.test(path.basename(entry))) matches.push(entry); return; }
    if (!stat.isDirectory()) return;
    let children; try { children = fs.readdirSync(entry); } catch { return; }
    for (const child of children) visit(path.join(entry, child));
  };
  for (const root of roots) visit(path.resolve(root));
  return matches.sort();
}
