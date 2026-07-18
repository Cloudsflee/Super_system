#!/usr/bin/env node

process.env.AIWS_RELEASE_VERSION = '1.8.0';
const { runReleaseCli } = await import('../docker/release_orchestrator.mjs');

runReleaseCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.code || 'v18_release_failed'}${Object.keys(error.details || {}).length ? ` ${JSON.stringify(error.details)}` : ''}\n`);
  process.exitCode = 1;
});
