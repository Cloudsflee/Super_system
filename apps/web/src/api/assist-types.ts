export type AssistV3TurnMode = 'ask' | 'plan' | 'agent';
export type AssistComposerMode = AssistV3TurnMode | 'cli';
export type AssistSurfaceMode = 'docked' | 'floating' | 'minimized' | 'fullscreen';
export type AssistV3EventType = 'queued' | 'started' | 'text' | 'plan' | 'command' | 'file_change' | 'test' | 'mcp' | 'search' | 'usage' | 'approval' | 'reasoning_summary' | 'status' | 'terminal' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'steered';
export type AssistV3Event = { id: number; sequence: number; session_id: string; turn_id: string | null; type: AssistV3EventType; data: Record<string, unknown>; created_at: string };
export type AssistAttachment = {
  id: string; project_id: string; session_id: string; turn_id?: string | null; kind: string; title: string;
  file_ref_id?: string | null; relative_path?: string | null; content_type: string; size_bytes: number; sha256?: string | null;
  selection?: { start_line: number; start_column: number; end_line: number; end_column: number } | null;
  model_policy: 'injectable' | 'image' | 'artifact_only'; status: string; created_at: string; updated_at?: string;
};
export type AssistWorktree = {
  id: string; project_id: string; turn_id?: string | null; kind: string; status: string; base_commit?: string | null;
  head_commit?: string | null; target_hash?: string | null; applied_target_hash?: string | null; applied_at?: string; rolled_back_at?: string;
};
export type AssistV3Turn = {
  id: string; session_id: string; project_id: string; parent_turn_id?: string | null; retry_of_turn_id?: string | null;
  follow_up_kind?: string | null; mode: AssistV3TurnMode; prompt: string; output_text: string; status: string; profile_id?: string | null;
  model?: string; reasoning?: string; actions?: import('./types').UiAction[];
  attachment_ids: string[]; attachments?: AssistAttachment[]; worktree_id?: string | null; worktree?: AssistWorktree | null;
  usage?: Record<string, number> | null; review_status: string;
  review?: { status: string; target_hash?: string; viewed_files?: Record<string, string>; comment_count?: number };
  error_code?: string; waiting_approval_id?: string | null; last_event_id?: number; created_at: string; updated_at: string;
  started_at?: string | null; completed_at?: string | null;
};
export type AssistV3Session = {
  id: string; version: 3; project_id: string; workspace_id?: string | null; node_id?: string | null; scope_type: 'project' | 'node';
  scope_id: string; title: string; status: string; lifecycle: string; pinned: boolean; archived_at?: string | null; parent_session_id?: string | null;
  turn_count?: number; last_turn?: Pick<AssistV3Turn, 'id' | 'mode' | 'status' | 'updated_at'> | null;
  turns?: AssistV3Turn[]; attachments?: AssistAttachment[]; last_event_id?: number; created_at: string; updated_at: string;
};
export type AssistReviewFile = { path: string; previous_path?: string | null; status: string; code?: string };
export type AssistReviewComment = { id: string; action: string; patch: { path?: string; line?: number; side?: 'old' | 'new'; body?: string; summary?: string }; created_at: string };
export type AssistReview = {
  turn_id?: string; terminal_session_id?: string; status: string; worktree: AssistWorktree; changed_files: AssistReviewFile[]; diff: string; target_hash: string;
  base_commit: string; head_commit: string; viewed_files: Record<string, string>; comments: AssistReviewComment[];
};
export type TerminalSession = {
  id: string; project_id: string; assist_session_id?: string | null; turn_id?: string | null; worktree_id: string; profile_id: string; model?: string; reasoning?: string; runtime: 'host' | 'docker'; status: string;
  cols: number; rows: number; exit_code?: number | null; output_preview: string; output_truncated: boolean;
  artifact_file_ref_id?: string | null; created_at: string; updated_at: string;
};
