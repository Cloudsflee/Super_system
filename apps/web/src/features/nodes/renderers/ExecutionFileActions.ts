import { api } from '../../../api/client';
import type { FileEntry } from '../../../api/types';
import type { UiState } from '../../../state/ui';

export type ExecutionFileTab = { path: string; content: string; saved: string; language: string };
type OpenExecutionEntryState = {
  repositoryAvailable: boolean;
  tabs: ExecutionFileTab[];
  workspaceId?: string;
  setDirectory: (path: string) => void;
  setActive: (path: string) => void;
  setTabs: (update: (items: ExecutionFileTab[]) => ExecutionFileTab[]) => void;
  toast: UiState['toast'];
};

export async function openExecutionEntry(entry: FileEntry, state: OpenExecutionEntryState) {
  if (!state.repositoryAvailable) return;
  if (entry.type === 'directory') {
    state.setDirectory(entry.path);
    return;
  }
  const existing = state.tabs.find((tab) => tab.path === entry.path);
  if (existing) {
    state.setActive(existing.path);
    return;
  }
  try {
    const file = await api<{ path: string; content: string; language: string }>(
      `/repository-workspaces/${state.workspaceId}/files/content?path=${encodeURIComponent(entry.path)}`
    );
    state.setTabs((items) => [
      ...items,
      { path: file.path, content: file.content, saved: file.content, language: file.language }
    ]);
    state.setActive(file.path);
  } catch (reason) {
    state.toast((reason as Error).message, 'error');
  }
}
