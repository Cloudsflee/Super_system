import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from './server.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-bridge-probe-'));
const running = await start({ port: 0, stateRoot: root });
try {
  const live = await fetch(`${running.url}/livez`); const identity = await fetch(`${running.url}/v1/identity`);
  process.stdout.write(`${JSON.stringify({ live: live.status, identity: identity.status, body: await identity.json() })}\n`);
} finally { await running.close(); fs.rmSync(root, { recursive: true, force: true }); }
