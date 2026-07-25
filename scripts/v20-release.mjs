#!/usr/bin/env node
const { runV20UpgradeCli } = await import('../docker/v20-upgrade.mjs');
await runV20UpgradeCli(process.argv.slice(2));
