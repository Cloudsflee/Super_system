#!/usr/bin/env node
process.env.AIWS_RELEASE_VERSION = '1.9.0';
const { runReleaseCli } = await import('../docker/release_orchestrator.mjs');
await runReleaseCli(process.argv.slice(2));
