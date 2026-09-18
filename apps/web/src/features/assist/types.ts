import type { WorkspacePageProps } from '../../workspace';

export type AssistSurfaceProps = WorkspacePageProps & { surface?: 'page' | 'drawer' };
export type Message = { id: string; role: string; kind: string; content: string | null; sequence: number };
export type Turn = { id: string; turn_no: number; status: string; revision: number; attempt: number; operation_id: string; error_code?: string | null; messages: Message[] };
export type Reference = { id: string; reference_type: string; reference_id: string; reference_revision?: number | null; reference_hash?: string | null; created_at: string };
export type Goal = { id: string; revision: number; goal: Record<string, unknown>; goal_hash: string };
export type Session = { id: string; project_id: string; scope: string; scope_id: string; title?: string; mode?: string; parent_session_id?: string | null; fork_source_turn_id?: string | null; context_pack_id: string; context_pack_hash: string; profile_id: string; provider_thread_id?: string | null; status: string; revision: number; archived_at?: string | null; deleted_at?: string | null; turns?: Turn[]; references?: Reference[]; goal?: Goal | null };
export type Pack = { id: string; pack_hash: string; status?: string };
export type Profile = { id: string; label: string; provider: string; status: string; lifecycle_status?: string; revision: number };
export type Workspace = { id: string; status: string; revision: number };
export type Operation = { id?: string; operation_id: string; status: string; revision: number; error_code?: string | null };
export type TimelineEvent = { sequence?: number; type?: string; method?: string; data?: unknown };
export type Replay = { events: Array<{ id: string; sequence: number; type: string; data: Record<string, unknown> }>; next_cursor: string | number; terminal?: boolean };
export type TerminalSummary = { id: string; approval_id?: string; assist_session_id?: string | null; runtime: string; status: string; exit_code?: number | null; output_preview?: string; output_sha256?: string | null; operation_id: string; revision: number; created_at?: string; completed_at?: string | null };
export type Approval = { id: string; action: string; request: Record<string, unknown>; assist_turn_id?: string | null; status: string; revision: number };
