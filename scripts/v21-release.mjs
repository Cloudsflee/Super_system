#!/usr/bin/env node
const { runV21UpgradeCli } = await import('../docker/v21-upgrade.mjs');
await runV21UpgradeCli(process.argv.slice(2));
