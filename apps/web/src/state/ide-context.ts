import { create } from 'zustand';

export type EditorSelection = {
  text: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
};
type IdeContextState = {
  path: string;
  content: string;
  selection: EditorSelection | null;
  setFile: (path: string, content: string) => void;
  setSelection: (selection: EditorSelection | null) => void;
  clear: () => void;
};

export const useIdeContext = create<IdeContextState>((set) => ({
  path: '',
  content: '',
  selection: null,
  setFile: (path, content) =>
    set((state) => (state.path === path ? { path, content } : { path, content, selection: null })),
  setSelection: (selection) => set({ selection }),
  clear: () => set({ path: '', content: '', selection: null })
}));
