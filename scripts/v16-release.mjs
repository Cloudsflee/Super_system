#!/usr/bin/env node
import { runReleaseCli } from '../docker/release_orchestrator.mjs';

runReleaseCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.code || 'v16_release_failed'}${Object.keys(error.details || {}).length ? ` ${JSON.stringify(error.details)}` : ''}\n`);
  process.exitCode = 1;
});
