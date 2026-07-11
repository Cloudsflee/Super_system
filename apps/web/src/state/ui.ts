import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AssistSurfaceMode } from '../api/types';

type Toast = { id: number; message: string; tone: 'info' | 'error' };
export type AssistGeometry = { x: number; y: number; width: number; height: number };
type UiState = {
  navOpen: boolean; assistOpen: boolean; inspectorNodeId: string | null;
  assistSurface: AssistSurfaceMode; assistRestoreSurface: Exclude<AssistSurfaceMode, 'minimized'>; assistGeometry: AssistGeometry;
  contextNodeId: string | null;
  /** Compatibility name: the proposal currently interrupting the canvas. */
  proposalId: string | null;
  approvalCenterOpen: boolean; approvalSelectionId: string | null;
  activeProjectId: string | null; toasts: Toast[];
  setNav: (value: boolean) => void; setAssist: (value: boolean) => void;
  setAssistSurface: (value: AssistSurfaceMode) => void; restoreAssist: () => void;
  setAssistGeometry: (value: Partial<AssistGeometry>) => void;
  inspect: (nodeId: string | null) => void;
  showProposal: (id: string | null) => void;
  openApprovalCenter: (value: boolean, id?: string | null) => void;
  selectApproval: (id: string | null) => void;
  closeOverlay: () => void;
  setProject: (id: string | null) => void; toast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
};

export const useUi = create<UiState>()(persist((set) => ({
  navOpen: false,
  assistOpen: false,
  assistSurface: 'docked',
  assistRestoreSurface: 'docked',
  assistGeometry: { x: 70, y: 84, width: 760, height: 680 },
  inspectorNodeId: null,
  contextNodeId: null,
  proposalId: null,
  approvalCenterOpen: false,
  approvalSelectionId: null,
  activeProjectId: null,
  toasts: [],
  setNav: (navOpen) => set(navOpen
    ? { navOpen: true, assistOpen: false, approvalCenterOpen: false }
    : { navOpen: false }),
  // Assist is a peer surface in V1.3. Opening it must not hide the canvas Inspector.
  setAssist: (assistOpen) => set(assistOpen ? { assistOpen: true, navOpen: false } : { assistOpen: false }),
  setAssistSurface: (assistSurface) => set((state) => assistSurface === 'minimized'
    ? { assistSurface, assistRestoreSurface: state.assistSurface === 'minimized' ? state.assistRestoreSurface : state.assistSurface }
    : { assistSurface, assistRestoreSurface: assistSurface }),
  restoreAssist: () => set((state) => ({ assistSurface: state.assistRestoreSurface, assistOpen: true })),
  setAssistGeometry: (value) => set((state) => ({ assistGeometry: { ...state.assistGeometry, ...value } })),
  inspect: (inspectorNodeId) => set(inspectorNodeId
    ? { inspectorNodeId, contextNodeId: inspectorNodeId, navOpen: false }
    : { inspectorNodeId: null }),
  // Existing proposal creation sites call this method; it now raises an interrupting prompt.
  showProposal: (proposalId) => set(proposalId ? { proposalId, navOpen: false } : { proposalId: null }),
  openApprovalCenter: (approvalCenterOpen, id = null) => set(approvalCenterOpen
    ? { approvalCenterOpen: true, approvalSelectionId: id, navOpen: false }
    : { approvalCenterOpen: false, approvalSelectionId: null }),
  selectApproval: (approvalSelectionId) => set({ approvalSelectionId }),
  closeOverlay: () => set({ navOpen: false, assistOpen: false, inspectorNodeId: null, proposalId: null, approvalCenterOpen: false, approvalSelectionId: null }),
  setProject: (activeProjectId) => set({ activeProjectId }),
  toast: (message, tone = 'info') => set((state) => ({
    toasts: [...state.toasts, { id: Date.now() + Math.random(), message, tone }].slice(-4)
  })),
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }))
}), { name: 'aiws-v13-ui', partialize: ({ activeProjectId, assistSurface, assistRestoreSurface, assistGeometry }) => ({ activeProjectId, assistSurface, assistRestoreSurface, assistGeometry }) }));
