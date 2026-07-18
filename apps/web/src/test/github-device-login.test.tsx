import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubSetup } from '../features/setup/GithubSetup';

describe('GitHub Device Login', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('promotes the returned device code into a dedicated authorization status', async () => {
    const replace = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({ opener: window, location: { replace } } as unknown as Window);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toMatch(/\/github\/device\/start$/);
      return new Response(JSON.stringify({
        request_id: 'ghdev_fixture', user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device', expires_in: 899, interval: 5
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    render(<GithubSetup mode="byo" state={{
      ready: false, status: 'account_required',
      checks: { app_configured: true, account_connected: false }
    }} onChange={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.click(screen.getByRole('button', { name: '连接 GitHub' }));
    const code = await screen.findByLabelText('GitHub 设备码');
    expect(code).toHaveTextContent('ABCD-1234');
    expect(code.closest('[role="status"]')).toHaveClass('github-device-auth');
    expect(screen.getByRole('link', { name: '打开 GitHub' })).toHaveAttribute('href', 'https://github.com/login/device');
    expect(screen.getByRole('button', { name: '复制设备码' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '检查授权' })).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://github.com/login/device'));
  });
});
