import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AssistSurfaceMode } from '../api/types';

type Toast = { id: number; message: string; tone: 'info' | 'error' };
export type AssistGeometry = { x: number; y: number; width: number; height: number };
export type ContextLane = 'assist' | 'inspector' | null;
export type InspectorMode = 'expanded' | 'peek';
export type WorkflowTaskDensity = 'compact' | 'comfortable' | 'detailed';
type UiState = {
  navOpen: boolean;
  assistOpen: boolean;
  inspectorNodeId: string | null;
  assistSurface: AssistSurfaceMode;
  assistRestoreSurface: Exclude<AssistSurfaceMode, 'minimized'>;
  assistGeometry: AssistGeometry;
  assistDockWidth: number;
  commandDockExpanded: boolean;
  focusMode: boolean;
  contextLane: ContextLane;
  inspectorMode: InspectorMode;
  contextNodeId: string | null;
  workflowTaskDensity: WorkflowTaskDensity;
  /** Compatibility name: the proposal currently interrupting the canvas. */
  proposalId: string | null;
  approvalCenterOpen: boolean;
  approvalSelectionId: string | null;
  activeProjectId: string | null;
  toasts: Toast[];
  setNav: (value: boolean) => void;
  setAssist: (value: boolean) => void;
  setAssistSurface: (value: AssistSurfaceMode) => void;
  restoreAssist: () => void;
  setAssistGeometry: (value: Partial<AssistGeometry>) => void;
  setAssistDockWidth: (value: number) => void;
  setCommandDockExpanded: (value: boolean) => void;
  setFocusMode: (value: boolean) => void;
  toggleFocusMode: () => void;
  setContextNode: (id: string | null) => void;
  setWorkflowTaskDensity: (value: WorkflowTaskDensity) => void;
  inspect: (nodeId: string | null) => void;
  showProposal: (id: string | null) => void;
  openApprovalCenter: (value: boolean, id?: string | null) => void;
  selectApproval: (id: string | null) => void;
  closeOverlay: () => void;
  setProject: (id: string | null) => void;
  toast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
};

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      navOpen: false,
      assistOpen: false,
      assistSurface: 'docked',
      assistRestoreSurface: 'docked',
      assistGeometry: { x: 70, y: 84, width: 760, height: 680 },
      assistDockWidth: 520,
      commandDockExpanded: false,
      focusMode: true,
      workflowTaskDensity: 'comfortable',
      contextLane: null,
      inspectorMode: 'expanded',
      inspectorNodeId: null,
      contextNodeId: null,
      proposalId: null,
      approvalCenterOpen: false,
      approvalSelectionId: null,
      activeProjectId: null,
      toasts: [],
      setNav: (navOpen) =>
        set((state) =>
          navOpen
            ? {
                navOpen: true,
                assistOpen: false,
                contextLane: state.inspectorNodeId ? 'inspector' : null,
                inspectorMode: state.inspectorNodeId ? 'expanded' : state.inspectorMode,
                approvalCenterOpen: false
              }
            : { navOpen: false }
        ),
      setAssist: (assistOpen) =>
        set((state) =>
          assistOpen
            ? {
                assistOpen: true,
                assistSurface: state.assistSurface === 'minimized' ? state.assistRestoreSurface : state.assistSurface,
                contextLane: 'assist',
                inspectorMode: state.inspectorNodeId ? 'peek' : state.inspectorMode,
                navOpen: false
              }
            : {
                assistOpen: false,
                contextLane: state.inspectorNodeId ? 'inspector' : null,
                inspectorMode: state.inspectorNodeId ? 'expanded' : state.inspectorMode
              }
        ),
      setAssistSurface: (assistSurface) =>
        set((state) =>
          assistSurface === 'minimized'
            ? {
                assistSurface,
                assistOpen: false,
                commandDockExpanded: false,
                contextLane: state.inspectorNodeId ? 'inspector' : null,
                inspectorMode: state.inspectorNodeId ? 'expanded' : state.inspectorMode,
                assistRestoreSurface:
                  state.assistSurface === 'minimized' ? state.assistRestoreSurface : state.assistSurface
              }
            : {
                assistSurface,
                assistRestoreSurface: assistSurface,
                assistOpen: true,
                contextLane: 'assist',
                inspectorMode: state.inspectorNodeId ? 'peek' : state.inspectorMode
              }
        ),
      restoreAssist: () =>
        set((state) => ({
          assistSurface: state.assistRestoreSurface,
          assistOpen: true,
          contextLane: 'assist',
          inspectorMode: state.inspectorNodeId ? 'peek' : state.inspectorMode
        })),
      setAssistGeometry: (value) => set((state) => ({ assistGeometry: { ...state.assistGeometry, ...value } })),
      setAssistDockWidth: (assistDockWidth) => set({ assistDockWidth: clampDockWidth(assistDockWidth) }),
      setCommandDockExpanded: (commandDockExpanded) => set({ commandDockExpanded }),
      setFocusMode: (focusMode) => set({ focusMode }),
      toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
      setWorkflowTaskDensity: (workflowTaskDensity) =>
        set({ workflowTaskDensity: normalizeWorkflowTaskDensity(workflowTaskDensity) }),
      setContextNode: (contextNodeId) => set({ contextNodeId }),
      inspect: (inspectorNodeId) =>
        set((state) =>
          inspectorNodeId
            ? {
                inspectorNodeId,
                contextNodeId: inspectorNodeId,
                contextLane: 'inspector',
                inspectorMode: 'expanded',
                navOpen: false
              }
            : {
                inspectorNodeId: null,
                contextNodeId: null,
                contextLane: state.assistOpen ? 'assist' : null,
                inspectorMode: 'expanded'
              }
        ),
      // Existing proposal creation sites call this method; it now raises an interrupting prompt.
      showProposal: (proposalId) => set(proposalId ? { proposalId, navOpen: false } : { proposalId: null }),
      openApprovalCenter: (approvalCenterOpen, id = null) =>
        set(
          approvalCenterOpen
            ? { approvalCenterOpen: true, approvalSelectionId: id, navOpen: false }
            : { approvalCenterOpen: false, approvalSelectionId: null }
        ),
      selectApproval: (approvalSelectionId) => set({ approvalSelectionId }),
      closeOverlay: () =>
        set({
          navOpen: false,
          assistOpen: false,
          inspectorNodeId: null,
          contextLane: null,
          inspectorMode: 'expanded',
          proposalId: null,
          approvalCenterOpen: false,
          approvalSelectionId: null
        }),
      setProject: (activeProjectId) => set({ activeProjectId }),
      toast: (message, tone = 'info') =>
        set((state) => ({
          toasts: [...state.toasts, { id: Date.now() + Math.random(), message, tone }].slice(-4)
        })),
      dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }))
    }),
    {
      name: 'aiws-v13-ui',
      version: 19,
      migrate: (persisted) => persisted as UiState,
      partialize: ({
        activeProjectId,
        assistSurface,
        assistRestoreSurface,
        assistGeometry,
        assistDockWidth,
        commandDockExpanded,
        focusMode,
        workflowTaskDensity
      }) => ({
        activeProjectId,
        assistSurface,
        assistRestoreSurface,
        assistGeometry,
        assistDockWidth,
        commandDockExpanded,
        focusMode,
        workflowTaskDensity
      }),
      merge: (persisted, current) => {
        const saved = (persisted || {}) as Partial<UiState>;
        return {
          ...current,
          ...saved,
          focusMode: saved.focusMode ?? true,
          workflowTaskDensity: normalizeWorkflowTaskDensity(saved.workflowTaskDensity),
          assistDockWidth: clampDockWidth(saved.assistDockWidth ?? current.assistDockWidth),
          commandDockExpanded: saved.commandDockExpanded ?? false,
          assistOpen: false,
          contextLane: null,
          inspectorNodeId: null,
          inspectorMode: 'expanded'
        };
      }
    }
  )
);

function clampDockWidth(value: number) {
  return Math.min(680, Math.max(420, Number.isFinite(value) ? value : 520));
}
function normalizeWorkflowTaskDensity(value: unknown): WorkflowTaskDensity {
  return value === 'compact' || value === 'detailed' || value === 'comfortable' ? value : 'comfortable';
}
