import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export function browserDiscovery() {
  return {
    updated_at: new Date(0).toISOString(),
    sources: [
      {
        source_id: 'browser-cc',
        type: 'cc_switch',
        display_name: 'cc-switch local providers',
        status: 'available',
        path_hint: '~/.cc-switch/cc-switch.db',
        revision: 'browser-revision-cc',
        providers: [
          {
            discovery_id: 'browser-cc-provider',
            source_revision: 'browser-revision-cc',
            name: 'Browser Relay',
            provider: 'browser-relay',
            base_url: 'https://relay.browser.test/v1',
            model: 'browser/codex',
            wire_api: 'responses',
            has_credential: true,
            credential_hint: 'stored',
            importable: true
          }
        ]
      },
      {
        source_id: 'browser-home',
        type: 'codex_home',
        display_name: 'Local ~/.codex',
        status: 'available',
        path_hint: '~/.codex/config.toml',
        revision: 'browser-revision-home',
        providers: [
          {
            discovery_id: 'browser-home-provider',
            source_revision: 'browser-revision-home',
            name: 'Local Gateway',
            provider: 'local-gateway',
            base_url: 'http://127.0.0.1:8080/v1',
            model: 'local/codex',
            wire_api: 'responses',
            has_credential: false,
            credential_hint: 'required',
            importable: true
          }
        ]
      }
    ]
  };
}

export async function assertViewport(page, { allowOverflowWithin = [] } = {}) {
  const sizes = await page.evaluate((allowedSelectors) => {
    const root = document.getElementById('root');
    const scrollX = window.scrollX;
    const allowedLightSurface =
      '.attachment-text-preview,.attachment-office-preview,.attachment-csv-preview,.attachment-pdf-preview';
    const rows = [...document.querySelectorAll('body *')]
      .filter(
        (element) =>
          getComputedStyle(element).display !== 'none' &&
          !element.closest('.monaco-editor,.react-flow__viewport') &&
          !element.matches('.monaco-aria-container,.monaco-alert,.monaco-status,.react-flow__viewport') &&
          !allowedSelectors.some((selector) => element.closest(selector))
      )
      .map((element) => ({
        element: `${element.tagName.toLowerCase()}.${element.getAttribute('class') || ''}`,
        rect: element.getBoundingClientRect().toJSON()
      }));
    return {
      scrollX,
      rootScrollLeft: root?.scrollLeft || 0,
      rootScrollWidth: root?.scrollWidth || 0,
      scrollWidth: document.documentElement.scrollWidth,
      width: window.innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      height: window.innerHeight,
      offenders: rows
        .filter((item) => item.rect.right + scrollX > window.innerWidth + 1 || item.rect.left + scrollX < -1)
        .slice(0, 20),
      lightSurfaces: [...document.querySelectorAll('body *')]
        .flatMap((element) => {
          if (element.closest(allowedLightSurface)) return [];
          const rect = element.getBoundingClientRect(),
            style = getComputedStyle(element),
            values = style.backgroundColor.match(/[\d.]+/g)?.map(Number) || [],
            alpha = values[3] ?? 1;
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width * rect.height >= 200 &&
            alpha >= 0.8 &&
            values.slice(0, 3).reduce((sum, value) => sum + value, 0) / 3 >= 220
            ? [
                {
                  element: `${element.tagName.toLowerCase()}.${element.getAttribute('class') || ''}`,
                  color: style.backgroundColor,
                  area: Math.round(rect.width * rect.height)
                }
              ]
            : [];
        })
        .slice(0, 20)
    };
  }, allowOverflowWithin);
  assert.equal(sizes.rootScrollLeft, 0, `root horizontally scrolled: ${JSON.stringify(sizes)}`);
  assert.ok(
    sizes.rootScrollWidth <= sizes.width + 1 && sizes.scrollWidth <= sizes.width + 1,
    `document horizontally overflows: ${JSON.stringify(sizes)}`
  );
  assert.deepEqual(sizes.offenders, [], `elements outside viewport: ${JSON.stringify(sizes)}`);
  assert.deepEqual(sizes.lightSurfaces, [], `unexpected light UI surfaces: ${JSON.stringify(sizes)}`);
  assert.ok(sizes.scrollHeight >= sizes.height, 'document is rendered');
}

export async function assertA11y(page, label) {
  if (process.env.AIWS_V175_AXE !== '1') return;
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const violations = result.violations.filter((item) => ['critical', 'serious'].includes(item.impact));
  const diagnostics = [];
  for (const item of violations)
    for (const node of item.nodes) {
      const selector = String(node.target.at(-1) || ''),
        ancestry = selector
          ? await page
              .locator(selector)
              .first()
              .evaluate((element) => {
                const rows = [];
                let current = element;
                for (let depth = 0; current && depth < 5; depth++, current = current.parentElement) {
                  const style = getComputedStyle(current);
                  rows.push({
                    tag: current.tagName,
                    class: current.className,
                    color: style.color,
                    background: style.backgroundColor,
                    opacity: style.opacity,
                    display: style.display
                  });
                }
                return rows;
              })
              .catch(() => [])
          : [];
      diagnostics.push({
        id: item.id,
        impact: item.impact,
        target: node.target,
        element: node.html.match(/^<[^>]+>/)?.[0] || '',
        ancestry,
        summary: node.failureSummary
      });
    }
  assert.deepEqual(diagnostics, [], `${label} has serious/critical axe violations`);
}

export async function assertCanvasBounds(page) {
  await assertViewport(page);
  const bar = await page.locator('.app-bar').boundingBox();
  const toolbars = await page.locator('.canvas-toolbar').all();
  assert.ok(
    bar && toolbars.length === 2,
    `expected two canvas HUDs: ${JSON.stringify({ bar, count: toolbars.length })}`
  );
  for (const toolbar of toolbars) {
    const box = await toolbar.boundingBox();
    const size = page.viewportSize();
    assert.ok(
      box &&
        size &&
        box.y >= bar.y + bar.height &&
        box.x >= -1 &&
        box.x + box.width <= size.width + 1 &&
        box.y + box.height <= size.height + 1,
      `canvas HUD outside bounds: ${JSON.stringify({ bar, box, size })}`
    );
  }
}

export async function assertInsideViewport(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const size = page.viewportSize();
  assert.ok(
    box &&
      size &&
      box.x >= -1 &&
      box.y >= -1 &&
      box.x + box.width <= size.width + 1 &&
      box.y + box.height <= size.height + 1,
    `${selector} outside viewport: ${JSON.stringify({ box, size })}`
  );
}

export async function assertNoHorizontalScroll(page, selector) {
  const size = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    scrollLeft: element.scrollLeft
  }));
  assert.ok(
    size.scrollWidth <= size.clientWidth + 1 && size.scrollLeft === 0,
    `${selector} horizontally scrolls: ${JSON.stringify(size)}`
  );
}

export async function assertAssistHeader(page) {
  const [workbench, header, text] = await Promise.all([
    page.locator('.assist-workbench').boundingBox(),
    page.locator('.assist-workbench-head').boundingBox(),
    page.locator('.assist-workbench-head').textContent()
  ]);
  assert.ok(
    workbench && header && Math.abs(header.y - workbench.y) <= 1 && header.height >= 43 && header.height <= 45,
    `Assist header must stay in the 44px top track: ${JSON.stringify({ workbench, header })}`
  );
  assert.equal(
    await page.locator('.assist-workbench-head .lucide-bot').count(),
    0,
    'Assist header must not repeat the Bot icon'
  );
  assert.doesNotMatch(text || '', /live/i, 'Assist header must not repeat stream health');
}

export async function assertNoOverlap(page, firstSelector, secondSelector) {
  const [first, second] = await Promise.all([
    page.locator(firstSelector).first().boundingBox(),
    page.locator(secondSelector).first().boundingBox()
  ]);
  assert.ok(
    first &&
      second &&
      (first.x + first.width <= second.x ||
        second.x + second.width <= first.x ||
        first.y + first.height <= second.y ||
        second.y + second.height <= first.y),
    `${firstSelector} overlaps ${secondSelector}: ${JSON.stringify({ first, second })}`
  );
}

export async function assertOverlayBlocks(page, overlaySelector, backgroundSelector) {
  const result = await page.evaluate(
    ({ overlaySelector, backgroundSelector }) => {
      const overlay = document.querySelector(overlaySelector),
        background = document.querySelector(backgroundSelector),
        scrim = document.querySelector('.scrim');
      if (!(overlay instanceof HTMLElement) || !(background instanceof HTMLElement))
        return { blocked: false, reason: 'missing_element' };
      const box = background.getBoundingClientRect(),
        x = box.left + box.width / 2,
        y = box.top + box.height / 2,
        top = document.elementFromPoint(x, y);
      return {
        blocked: Boolean(top && (overlay.contains(top) || scrim?.contains(top))),
        top: top instanceof HTMLElement ? `${top.tagName}.${top.className}` : null,
        point: { x, y }
      };
    },
    { overlaySelector, backgroundSelector }
  );
  assert.equal(
    result.blocked,
    true,
    `${overlaySelector} did not block ${backgroundSelector}: ${JSON.stringify(result)}`
  );
}

export async function verifyShellOverlayStacking(page) {
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.locator('.drawer.left.open').waitFor();
  await assertOverlayBlocks(page, '.drawer.left.open', '.command-dock');
  await page.getByRole('button', { name: '关闭导航' }).click();
  await page.locator('.drawer.left.open').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '审批队列' }).click();
  await page.locator('.approval-center.open').waitFor();
  await assertOverlayBlocks(page, '.approval-center.open', '.command-dock');
  await page.getByRole('button', { name: '关闭审批中心' }).click();
}

export function browserExecutable() {
  if (fs.existsSync(chromium.executablePath())) return {};
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const executablePath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  return executablePath ? { executablePath } : {};
}
