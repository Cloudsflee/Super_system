// Owner: Platform Governance. Phase: D-040 post-P10 maintenance.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pnpmInvocation, executableInvocation, runGateCommand, redactGateText } from '../../../scripts/lib/gate-process.mjs';

const [label, command, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label || '') || !command) throw new Error('capture_arguments_invalid');
const root = process.cwd();
const destination = path.join(root, '.ai-workspace', 'post-p10-maintenance', 'commands');
fs.mkdirSync(destination, { recursive: true });
const prefix = `${label}-${Date.now()}-${process.pid}`;
const stdout = fs.openSync(path.join(destination, `${prefix}.stdout.log`), 'wx', 0o600);
const stderr = fs.openSync(path.join(destination, `${prefix}.stderr.log`), 'wx', 0o600);
const forward = (fd, stream) => ({ write(chunk) { fs.writeSync(fd, String(chunk)); if (process.env.AIWS_CAPTURE_QUIET !== '1') stream.write(chunk); } });
const record = await runGateCommand(command === 'pnpm' ? pnpmInvocation(args) : executableInvocation(command === 'node' ? process.execPath : command, args), {
  cwd: root, workspaceRoot: root, cwdRole: 'repository-root', timeoutMs: 1_800_000,
  maxCaptureBytes: 32 * 1024 * 1024, stdout: forward(stdout, process.stdout), stderr: forward(stderr, process.stderr)
});
fs.closeSync(stdout); fs.closeSync(stderr);
const data = { schema_version: 'aiws.maintenance-command.v1', label, logical_command: [command, ...args].map((value) => redactGateText(value, root).value), ...record };
data.output_sha256 = createHash('sha256').update(JSON.stringify(record.output)).digest('hex');
const file = path.join(destination, `${prefix}.json`);
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify({ command_receipt: path.relative(root, file).replaceAll('\\', '/'), exit_status: record.exit_status, duration_ms: record.duration_ms })}\n`);
process.exitCode = record.exit_status || (record.ok ? 0 : 1);
