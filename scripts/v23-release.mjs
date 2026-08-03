#!/usr/bin/env node
const { runV23UpgradeCli } = await import('../docker/v23-upgrade.mjs');
await runV23UpgradeCli(process.argv.slice(2));
