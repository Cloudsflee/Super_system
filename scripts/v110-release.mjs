#!/usr/bin/env node
const { runV110UpgradeCli } = await import('../docker/v110-upgrade.mjs');
await runV110UpgradeCli(process.argv.slice(2));
