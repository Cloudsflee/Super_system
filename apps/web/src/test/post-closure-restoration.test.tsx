import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiV2 } from '../api';
import { routeFromPath } from '../App';
import { normalizeAssistMessage, normalizePastedText } from '../features/assist/AssistPage';
import { sanitizeOfficePreviewHtml } from '../features/assist/OfficePreview';

const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'post-closure-web', data, meta: { api_version: '2' } }), {
  status,
  headers: { 'content-type': 'application/json' }
});

describe('post-closure Web restoration', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('maps historical deep links to reachable Clean views', () => {
    const cases: Array<[string, string]> = [
      ['#/assets', 'evidence'],
      ['#/audit', 'operations'],
      ['#/projects/project-1/workstreams/stream-1', 'workflow'],
      ['#/projects/project-1/nodes/node-1', 'workflow'],
      ['#/projects/project-1/repository', 'repository'],
      ['#/github/install/callback', 'connections']
    ];
    for (const [path, expected] of cases) expect(routeFromPath(path.slice(1))).toBe(expected);
  });

  it('recovers an expired browser session once and retries the original request', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path === '/api/v2/setup/session') return envelope({ session: { id: 'session-recovered', revision: 1 } }, 201);
      if (calls.filter((value) => value === '/api/v2/account').length === 1) {
        return new Response(JSON.stringify({ error: { code: 'session_expired', message: 'expired' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      return envelope({ account: { id: 'account-recovered' } });
    }));
    const result = await apiV2<{ account: { id: string } }>('/api/v2/account');
    expect(result.data.account.id).toBe('account-recovered');
    expect(calls).toEqual(['/api/v2/account', '/api/v2/setup/session', '/api/v2/account']);
  });

  it('keeps pasted Assist content bounded and strips active Office markup', () => {
    const large = 'x'.repeat(300_000);
    expect(normalizeAssistMessage(large).length).toBeLessThanOrEqual(262_144);
    expect(normalizePastedText('x'.repeat(12_001))).toContain('```text');
    const safe = sanitizeOfficePreviewHtml('<script>alert(1)</script><p onclick="alert(2)" style="color:red">ok</p><img src="javascript:bad">');
    expect(safe).not.toMatch(/script|onclick|style|javascript|src=/i);
    expect(safe).toContain('ok');
  });
});
