export type AssistV3TurnMode = 'default' | 'plan';
export type AssistComposerMode = AssistV3TurnMode;
export type AssistSurfaceMode = 'docked' | 'floating' | 'minimized' | 'fullscreen';
export type AssistV3EventType = 'queued' | 'started' | 'text' | 'plan' | 'command' | 'file_change' | 'diff' | 'test' | 'mcp' | 'search' | 'usage' | 'approval' | 'reasoning_summary' | 'request_user_input' | 'request_user_input_resolved' | 'operation' | 'status' | 'terminal' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'steered';
export type AssistV3Event = { id: number; sequence: number; session_id: string; turn_id: string | null; type: AssistV3EventType; data: Record<string, unknown>; created_at: string };
export type AssistAttachment = {
  id: string; project_id: string; session_id: string; turn_id?: string | null; kind: string; title: string;
  original_filename?: string | null; file_ref_id?: string | null; relative_path?: string | null; content_type: string; client_mime_type?: string; detected_mime_type?: string; preview_kind?: string; storage_status?: string; content_deleted_at?: string | null; size_bytes: number; sha256?: string | null;
  selection?: { start_line: number; start_column: number; end_line: number; end_column: number } | null;
  model_policy: 'injectable' | 'image' | 'artifact_only'; status: string; created_at: string; updated_at?: string;
};
export type AssistWorktree = {
  id: string; project_id: string; turn_id?: string | null; kind: string; status: string; base_commit?: string | null;
  head_commit?: string | null; target_hash?: string | null; applied_target_hash?: string | null; applied_at?: string; rolled_back_at?: string;
};
export type AssistV3Turn = {
  id: string; session_id: string; project_id: string; parent_turn_id?: string | null; retry_of_turn_id?: string | null;
  follow_up_kind?: string | null; mode: AssistV3TurnMode; collaboration_mode: AssistV3TurnMode; prompt: string; output_text: string; status: string; profile_id?: string | null;
  configuration_id?: string | null; model?: string; reasoning?: string; actions?: import('./types').UiAction[]; operations?: AssistOperation[]; user_inputs?: RuntimeUserInput[];
  attachment_ids: string[]; attachments?: AssistAttachment[]; worktree_id?: string | null; change_batch_id?: string | null; worktree?: AssistWorktree | null;
  code_access?: 'workspace_write' | 'read_only'; code_read_only_reason?: string | null;
  usage?: Record<string, number> | null; review_status: string;
  review?: { status: string; target_hash?: string; viewed_files?: Record<string, string>; comment_count?: number };
  error_code?: string; waiting_approval_id?: string | null; last_event_id?: number; created_at: string; updated_at: string;
  started_at?: string | null; completed_at?: string | null;
};
export type AssistV3Session = {
  id: string; version: 3; project_id: string; workspace_id?: string | null; node_id?: string | null; scope_type: 'project' | 'node';
  scope_id: string; title: string; status: string; lifecycle: string; pinned: boolean; archived_at?: string | null; parent_session_id?: string | null;
  forked_from_session_id?: string | null; forked_from_turn_id?: string | null; deleted_at?: string | null; delete_batch_id?: string | null; purge_after?: string | null; deletable?: boolean; descendant_count?: number; deleted_descendant_count?: number;
  turn_count?: number; last_turn?: Pick<AssistV3Turn, 'id' | 'mode' | 'status' | 'updated_at'> | null;
  turns?: AssistV3Turn[]; attachments?: AssistAttachment[]; last_event_id?: number; created_at: string; updated_at: string;
  change_batch?: AssistChangeBatch | null; native_goal_snapshot?: AssistGoal | null;
};
export type AssistReviewFile = { path: string; previous_path?: string | null; status: string; code?: string };
export type AssistReviewComment = { id: string; action: string; patch: { path?: string; line?: number; side?: 'old' | 'new'; body?: string; summary?: string }; created_at: string };
export type AssistReview = {
  turn_id?: string; terminal_session_id?: string; status: string; worktree: AssistWorktree; changed_files: AssistReviewFile[]; diff: string; target_hash: string;
  base_commit: string; head_commit: string; viewed_files: Record<string, string>; comments: AssistReviewComment[];
};
export type TerminalSession = {
  id: string; project_id: string; assist_session_id?: string | null; turn_id?: string | null; worktree_id: string; change_batch_id?: string | null; profile_id: string; model?: string; reasoning?: string; runtime: 'linux_container' | 'windows_bridge' | 'host_dev' | 'host' | 'docker'; status: string;
  cols: number; rows: number; exit_code?: number | null; output_preview: string; output_truncated: boolean;
  artifact_file_ref_id?: string | null; created_at: string; updated_at: string;
};

export type AssistModel = { id: string; model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean; defaultReasoningEffort: string; supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>; inputModalities?: string[] };
export type AssistModelCatalog = { profile_id: string; default_model: string; source: string; models: AssistModel[] };
export type AssistConfiguration = { id: string; name: string; base_profile_id: string; model: string; reasoning: string; created_at: string; updated_at: string };
export type AssistGoal = { objective: string; status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt?: number | null; updatedAt?: number | null };
export type RuntimeUserInputQuestion = { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: Array<{ label: string; description: string }> | null };
export type RuntimeUserInput = { id: string; session_id: string; turn_id: string; item_id: string; questions: RuntimeUserInputQuestion[]; status: string; contains_secret: boolean; auto_resolution_ms?: number | null; expires_at?: string | null; created_at: string; updated_at: string };
export type AssistOperation = { id: string; session_id: string; turn_id: string; tool: string; target_id: string; route: string; surface_id?: string | null; surface_revision: string; before_value?: unknown; after_value?: unknown; current_value?: unknown; before_hash?: string; after_hash?: string; current_hash?: string; status: string; risk: string; revision: number; inverse_of?: string | null; undone_by?: string | null; forced: boolean; conflict?: { before: unknown; after: unknown; current: unknown } | null; created_at: string; updated_at: string };
export type AssistOperationExecution = { operation_id: string; tool: string; target_id: string; value: unknown; route: string; surface_id?: string | null; surface_revision: string; inverse_of?: string | null; expected_current_hash?: string | null; forced: boolean; revision: number };
export type AssistCheckpoint = { id: string; batch_id: string; source: string; source_id: string; phase: string; before_commit?: string; after_commit?: string; target_hash: string; changed_files: AssistReviewFile[]; status: string; created_at: string };
export type AssistChangeBatch = { id: string; session_id: string; project_id: string; worktree_id: string; base_commit: string; head_commit: string; target_hash?: string | null; status: string; locked: boolean; worktree?: AssistWorktree | null; created_at: string; updated_at: string };
export type TerminalCapabilities = { linux_container: { available: boolean; default: boolean; reason?: string | null }; windows_bridge: { available: boolean; reason?: string | null; device_id?: string }; host_dev: { available: boolean; reason?: string | null } };
