import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FinalBusinessParityPage } from '../features/p10';
import type { WorkspacePageProps } from '../workspace';

const navigate = vi.fn();
const props: WorkspacePageProps = {
  projectId: 'project-p10',
  selectedProject: { id: 'project-p10', name: 'P10 Project', description: '', status: 'active', revision: 4, updated_at: '', team_id: 'team-p10' } as WorkspacePageProps['selectedProject'],
  selectProject: vi.fn(),
  refreshProjects: vi.fn(),
  notify: vi.fn(),
  navigate,
  setupReady: true,
  refreshSetup: vi.fn()
};

afterEach(() => { cleanup(); navigate.mockReset(); vi.restoreAllMocks(); });

it('renders the 19-group parity overview without loading or mutating governance data', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<FinalBusinessParityPage {...props} />);

  expect(screen.getByTestId('p10-parity-overview')).toBeVisible();
  expect(screen.getByText('27/0/27')).toBeVisible();
  expect(screen.getByText('19 business groups · no gaps')).toBeVisible();
  expect(screen.getAllByRole('article')).toHaveLength(23);
  expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  expect(screen.queryByRole('button', { name: '执行' })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('links each parity group to its canonical owner page', () => {
  render(<FinalBusinessParityPage {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '打开 Provider settings canonical 页面' }));
  expect(navigate).toHaveBeenCalledWith('settings');
  fireEvent.click(screen.getByRole('button', { name: '打开 Project and Brief canonical 页面' }));
  expect(navigate).toHaveBeenCalledWith('brief');
});
