import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nodeInvocation, pnpmInvocation, runGateCommand } from './lib/gate-process.mjs';

export async function main({ root = process.cwd(), unitOnly = process.env.AIWS_TEST_UNIT_ONLY === '1' } = {}) {
  const started = Date.now();
  const records = [];
  const commands = [
    {
      id: 'unit',
      invocation: nodeInvocation('--test', [
        '--test-skip-pattern=committed sanitized V2.3 golden',
        'tests/unit/*.test.mjs'
      ]),
      timeoutMs: 900_000
    },
    ...(!unitOnly ? [{
      id: 'web',
      invocation: pnpmInvocation(['--filter', '@aiws/web', 'test']),
      timeoutMs: 600_000
    }] : [])
  ];
  for (const command of commands) {
    process.stdout.write(`\n== test:${command.id} ==\n`);
    const record = await runGateCommand(command.invocation, {
      cwd: root,
      workspaceRoot: root,
      cwdRole: 'repository-root',
      timeoutMs: command.timeoutMs
    });
    records.push({ id: command.id, ...record });
    if (!record.ok) {
      process.stdout.write(`${JSON.stringify(summary(records, unitOnly, started, 'failed'), null, 2)}\n`);
      return record.exit_status || 1;
    }
  }
  process.stdout.write(`${JSON.stringify(summary(records, unitOnly, started, 'passed'), null, 2)}\n`);
  return 0;
}

function summary(records, unitOnly, started, status) {
  return {
    schema_version: 'aiws.v3-clean.test-result.v1',
    status,
    unit_only: unitOnly,
    web_executed: records.some((record) => record.id === 'web'),
    duration_ms: Date.now() - started,
    commands: records.map(({ id, command, args, exit_status, signal, duration_ms, error_code, ok }) => ({
      id, command, args, exit_status, signal, duration_ms, error_code, ok
    }))
  };
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked && invoked === import.meta.url) {
  const exitCode = await main();
  if (exitCode) process.exitCode = exitCode;
}
