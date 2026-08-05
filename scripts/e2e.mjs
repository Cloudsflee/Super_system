import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { start as startApi } from '../apps/api/server.mjs';
import { start as startBroker } from '../apps/runner-broker/server.mjs';

const build = spawnSync('corepack', ['pnpm', '--filter', '@aiws/web', 'build'], { cwd: process.cwd(), stdio: 'inherit', shell: process.platform === 'win32' });
if (build.status !== 0) process.exit(build.status || 1);
const home = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'aiws-v3-e2e-'));
const secret = 'e2e-secret';
const digest = `sha256:${'c'.repeat(64)}`;
const broker = await startBroker({ config: { host: '127.0.0.1', port: 0, secret, dataRoot: home, dataVolume: 'aiws-data-v3', runnerDigest: digest, executor: 'mock', runnerImage: `runner@${digest}` } });
const app = await startApi({ config: { version: '3.0.0', apiPrefix: '/api/v1', host: '127.0.0.1', port: 0, home, databaseFile: path.join(home, 'data', 'state.sqlite'), casRoot: path.join(home, 'cas'), dataVolume: 'aiws-data-v3', brokerUrl: `http://127.0.0.1:${broker.server.address().port}`, brokerMode: 'http', brokerSecret: secret, runnerDigest: digest, codexAvailable: false, githubAvailable: false } });
const base = `http://127.0.0.1:${app.server.address().port}`;
const request = async (route, body, key) => {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return response.json();
};
const project = await request('/api/v1/projects', { name: 'Browser fixture' }, 'e2e-project');
const browser = await chromium.launch({ headless: true });
const reportDir = path.join(process.cwd(), '.ai-workspace', 'e2e-v3');
fs.mkdirSync(reportDir, { recursive: true });
const viewports = [
  ['mobile', 360, 800], ['mobile-wide', 390, 844], ['tablet', 768, 1024],
  ['laptop', 1024, 768], ['desktop', 1440, 900], ['wide', 1920, 1080]
];
try {
  const page = await browser.newPage();
  for (const [name, width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/#/projects`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(reportDir, `${name}.png`), fullPage: true });
    if (!(await page.getByRole('heading', { name: 'Projects' }).isVisible())) throw new Error(`Projects heading missing at ${name}`);
    const overlap = await page.evaluate(() => {
      const elements = [...document.querySelectorAll('.topbar, .page-heading, .panel')].filter((element) => {
        const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
      });
      return elements.some((left, index) => elements.slice(index + 1).some((right) => {
        const a = left.getBoundingClientRect(); const b = right.getBoundingClientRect();
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top && left.parentElement === right.parentElement;
      }));
    });
    if (overlap) throw new Error(`layout overlap at ${name}`);
  }
  process.stdout.write(`E2E passed: ${viewports.length} viewports, project ${project.id}\n`);
} finally {
  await browser.close();
  await app.close();
  await broker.close();
}
