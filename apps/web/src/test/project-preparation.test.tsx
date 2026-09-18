import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SourceSelector, ReadinessSummary } from '../features/projects/preparation';

describe('project preparation controls', () => {
  it('offers local and GitHub sources with an editable branch', () => {
    render(<SourceSelector kind="github" onKindChange={vi.fn()} locator="ORG/REPO" branch="trunk" onLocatorChange={vi.fn()} onBranchChange={vi.fn()} profiles={[{ id: 'profile', provider: 'github', status: 'available' }]} onDiscover={vi.fn()} repositories={[{ id: 1, full_name: 'ORG/REPO', default_branch: 'trunk' }]} selectedRepository="ORG/REPO" onRepositoryChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /本机 Git/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /GitHub/ })).toBeTruthy();
    expect(screen.getByLabelText('仓库分支')).toHaveValue('trunk');
  });

  it('exposes missing preparation steps as direct actions', () => {
    const open = vi.fn();
    render(<ReadinessSummary ready={false} missing={['source', 'pack']} onOpen={open} />);
    screen.getByRole('button', { name: 'source' }).click();
    expect(open).toHaveBeenCalledWith('source');
  });
});
