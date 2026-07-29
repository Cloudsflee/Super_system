import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require('/usr/local/lib/node_modules/playwright');

const request = JSON.parse(await fsp.readFile('/aiws-verify/request.json', 'utf8'));
const screenshotDir = '/aiws-verify/screenshots';
const failures = [];
const startedAt = new Date().toISOString();
const COOP_HOST_GATEWAY_MESSAGE =
  "The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy. It was defined either in the final response or a redirect. Please deliver the response using the HTTPS protocol. You can also use the 'localhost' origin instead. See https://www.w3.org/TR/powerful-features/#potentially-trustworthy-origin and https://html.spec.whatwg.org/#the-cross-origin-opener-policy-header.";

await fsp.mkdir(screenshotDir, { recursive: true });
await prepareChromiumHome();

const endpointResults = [];
for (const endpoint of request.endpoints) endpointResults.push(await inspectEndpoint(endpoint));

const health = endpointResults.find((item) => item.path === request.health_path) || null;
if (!health || health.status !== request.health_status) {
  failures.push(`health_status:${health?.status ?? 'missing'}`);
} else {
  if (health.json?.status !== 'ok') failures.push('health_body_status');
  if (health.json?.storageWritable !== true) failures.push('health_storage_not_writable');
}

const security = [];
for (const result of endpointResults) {
  const missing = request.security_headers.filter((name) => !result.headers[name]);
  security.push({ path: result.path, missing });
  if (missing.length) failures.push(`security_headers:${result.path}:${missing.join(',')}`);
}

const images = [];
for (const image of request.images) {
  const result = await inspectImage(image.path);
  images.push(result);
  if (!result.ok) failures.push(`image:${image.path}:${result.error || result.status}`);
}

const schedule = inspectSchedule(health?.json?.nextRunAt, request.schedule_time, request.time_zone);
if (request.schedule_time && !schedule.ok) failures.push(`schedule:${schedule.error}`);

const browser = await inspectBrowser();
for (const viewport of browser.viewports) {
  if (viewport.document_overflow !== 0) failures.push(`viewport:${viewport.width}:document_overflow`);
  if (viewport.horizontal_violations.length) failures.push(`viewport:${viewport.width}:horizontal`);
  if (viewport.overlap_violations.length) failures.push(`viewport:${viewport.width}:overlap`);
  if (viewport.console_errors.length) failures.push(`viewport:${viewport.width}:console_errors`);
  if (viewport.page_errors.length) failures.push(`viewport:${viewport.width}:page_errors`);
  if (viewport.failed_responses.length) failures.push(`viewport:${viewport.width}:failed_responses`);
  if (viewport.images.some((item) => !item.complete || item.natural_width <= 0 || item.natural_height <= 0))
    failures.push(`viewport:${viewport.width}:image_decode`);
  if (viewport.elapsed_ms > request.maximum_page_load_ms) failures.push(`viewport:${viewport.width}:page_load_budget`);
}

for (const endpoint of endpointResults) {
  if (endpoint.status !== endpoint.expected_status) failures.push(`endpoint:${endpoint.path}:${endpoint.status}`);
  if (endpoint.elapsed_ms > request.maximum_endpoint_ms) failures.push(`endpoint:${endpoint.path}:budget`);
}

const report = {
  schema_version: 'aiws.deployment_runtime_verification.v1',
  verifier: 'deployment_runtime_verifier',
  target: request.base_url,
  repository_sha: request.repository_sha,
  node_run_id: request.node_run_id,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  health,
  endpoints: endpointResults,
  security,
  images,
  schedule,
  browser,
  failures: [...new Set(failures)].sort(),
  ok: failures.length === 0
};

await fsp.writeFile('/aiws-verify/report.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify({ ok: report.ok, report_sha256: sha256(JSON.stringify(report)), failures: report.failures })}\n`
);
process.exitCode = report.ok ? 0 : 1;

async function prepareChromiumHome() {
  for (const directory of ['/tmp/aiws-browser-home', '/tmp/aiws-browser-home/.config', '/tmp/aiws-browser-home/.cache'])
    await fsp.mkdir(directory, { recursive: true });
}

async function inspectEndpoint(endpoint) {
  const before = performance.now();
  try {
    const response = await fetch(new URL(endpoint.path, request.base_url), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(request.request_timeout_ms)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      path: endpoint.path,
      expected_status: endpoint.expected_status,
      status: response.status,
      elapsed_ms: Math.round(performance.now() - before),
      size_bytes: bytes.length,
      sha256: sha256(bytes),
      headers: selectedHeaders(response.headers),
      json: parseJson(bytes)
    };
  } catch (error) {
    return {
      path: endpoint.path,
      expected_status: endpoint.expected_status,
      status: 0,
      elapsed_ms: Math.round(performance.now() - before),
      size_bytes: 0,
      sha256: null,
      headers: {},
      json: null,
      error: String(error?.cause?.code || error?.code || error?.message || error)
    };
  }
}

async function inspectImage(path) {
  try {
    const response = await fetch(new URL(path, request.base_url), {
      redirect: 'error',
      signal: AbortSignal.timeout(request.request_timeout_ms)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const mediaType = String(response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const detectedType = imageType(bytes);
    return {
      path,
      status: response.status,
      media_type: mediaType,
      detected_type: detectedType,
      size_bytes: bytes.length,
      sha256: sha256(bytes),
      ok: response.status === 200 && Boolean(detectedType) && mediaType === detectedType
    };
  } catch (error) {
    return {
      path,
      status: 0,
      media_type: null,
      detected_type: null,
      size_bytes: 0,
      sha256: null,
      ok: false,
      error: String(error?.message || error)
    };
  }
}

function inspectSchedule(value, expected, timeZone) {
  if (!expected) return { required: false, ok: true, next_run_at: value || null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    return { required: true, ok: false, error: 'next_run_invalid', next_run_at: value || null };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    })
      .formatToParts(date)
      .filter((item) => item.type !== 'literal')
      .map((item) => [item.type, item.value])
  );
  const localTime = `${parts.hour}:${parts.minute}`;
  return {
    required: true,
    ok: localTime === expected,
    error: localTime === expected ? null : 'next_run_time_mismatch',
    next_run_at: date.toISOString(),
    local_time: localTime,
    expected_local_time: expected,
    time_zone: timeZone
  };
}

async function inspectBrowser() {
  const browser = await chromium.launch({
    executablePath: process.env.AIWS_BROWSER_EXECUTABLE || '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: {
      ...process.env,
      HOME: '/tmp/aiws-browser-home',
      XDG_CONFIG_HOME: '/tmp/aiws-browser-home/.config',
      XDG_CACHE_HOME: '/tmp/aiws-browser-home/.cache'
    }
  });
  const results = [];
  try {
    for (const width of request.viewports) results.push(await inspectViewport(browser, width));
  } finally {
    await browser.close();
  }
  return { executable: process.env.AIWS_BROWSER_EXECUTABLE, viewports: results };
}

async function inspectViewport(browser, width) {
  const height = width <= 480 ? 844 : width <= 768 ? 1024 : 900;
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  const ignoredConsoleMessages = [];
  const pageErrors = [];
  const failedResponses = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    const record = {
      text: message.text(),
      url: location.url || null,
      line_number: location.lineNumber,
      column_number: location.columnNumber
    };
    const reason = ignoredConsoleReason(record);
    if (reason) ignoredConsoleMessages.push({ ...record, reason });
    else consoleErrors.push(record);
  });
  page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400 && url.pathname !== '/favicon.ico')
      failedResponses.push({ path: url.pathname, status: response.status() });
  });
  const before = performance.now();
  try {
    await page.goto(request.base_url, { waitUntil: 'networkidle', timeout: request.request_timeout_ms });
    await page.evaluate(() => document.fonts?.ready);
    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const horizontal = [];
      for (const element of document.querySelectorAll('body *')) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 1 || rect.height <= 1) continue;
        if (rect.left < -1 || rect.right > window.innerWidth + 1)
          horizontal.push({
            tag: element.tagName.toLowerCase(),
            id: element.id || null,
            class_name: String(element.className || '').slice(0, 120),
            left: Math.round(rect.left),
            right: Math.round(rect.right)
          });
      }
      const overlaps = [];
      for (const parent of document.querySelectorAll(
        'body, main, section, aside, article, nav, footer, [role="main"]'
      )) {
        const children = [...parent.children].filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.position !== 'absolute' &&
            style.position !== 'fixed' &&
            rect.width > 2 &&
            rect.height > 2
          );
        });
        for (let left = 0; left < children.length; left += 1) {
          for (let right = left + 1; right < children.length; right += 1) {
            const a = children[left].getBoundingClientRect();
            const b = children[right].getBoundingClientRect();
            const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (overlapWidth > 2 && overlapHeight > 2)
              overlaps.push({
                parent: parent.tagName.toLowerCase(),
                left: children[left].tagName.toLowerCase(),
                right: children[right].tagName.toLowerCase(),
                overlap_width: Math.round(overlapWidth),
                overlap_height: Math.round(overlapHeight)
              });
          }
        }
      }
      return {
        document_overflow: Math.max(0, root.scrollWidth - window.innerWidth),
        horizontal_violations: horizontal.slice(0, 50),
        overlap_violations: overlaps.slice(0, 50),
        images: [...document.images].map((image) => ({
          src: new URL(image.currentSrc || image.src).pathname,
          complete: image.complete,
          natural_width: image.naturalWidth,
          natural_height: image.naturalHeight
        }))
      };
    });
    const screenshot = `/aiws-verify/screenshots/${width}.png`;
    await page.screenshot({ path: screenshot, fullPage: true, type: 'png' });
    const bytes = await fsp.readFile(screenshot);
    return {
      width,
      height,
      elapsed_ms: Math.round(performance.now() - before),
      screenshot_path: `screenshots/${width}.png`,
      screenshot_sha256: sha256(bytes),
      screenshot_size_bytes: bytes.length,
      console_errors: consoleErrors,
      ignored_console_messages: ignoredConsoleMessages,
      page_errors: pageErrors,
      failed_responses: failedResponses,
      ...layout
    };
  } finally {
    await context.close();
  }
}

function ignoredConsoleReason(message) {
  let location;
  try {
    location = new URL(message.url);
  } catch {
    return null;
  }
  const target = new URL(request.base_url);
  if (location.origin !== target.origin) return null;
  if (
    location.pathname === '/favicon.ico' &&
    Number(message.line_number) === 0 &&
    Number(message.column_number) === 0 &&
    message.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)'
  )
    return 'favicon_not_found';
  if (
    target.protocol === 'http:' &&
    target.hostname === 'host.docker.internal' &&
    location.pathname === '/' &&
    Number(message.line_number) === 0 &&
    Number(message.column_number) === 0 &&
    message.text === COOP_HOST_GATEWAY_MESSAGE
  )
    return 'coop_untrustworthy_host_gateway';
  return null;
}

function selectedHeaders(headers) {
  return Object.fromEntries(
    request.security_headers.map((name) => [name, headers.get(name)]).filter(([, value]) => value)
  );
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

function imageType(bytes) {
  const hex = bytes.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  return null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
