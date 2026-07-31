#!/usr/bin/env node
const { runV22UpgradeCli } = await import('../docker/v22-upgrade.mjs');
await runV22UpgradeCli(process.argv.slice(2));
