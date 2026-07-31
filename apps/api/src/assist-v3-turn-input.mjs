import { cleanText } from './assist-v3-domain.mjs';

export function retryTurnInput(source, input) {
  return {
    ...retryTestAdapter(source, input),
    ...input,
    content: firstTruthy(input.content, source.prompt),
    collaboration_mode: retryCollaborationMode(source, input),
    attachment_ids: firstTruthy(input.attachment_ids, source.attachment_ids, []),
    profile_id: retryProfileId(source, input),
    configuration_id: firstTruthy(input.configuration_id, source.configuration_id),
    model: firstTruthy(input.model, source.model),
    reasoning: firstTruthy(input.reasoning, source.reasoning),
    view_context: firstTruthy(input.view_context, source.view_context),
    operation_reference_id: firstTruthy(input.operation_reference_id, source.operation_reference_id)
  };
}

function retryTestAdapter(source, input) {
  if (!source.test_adapter || process.env.NODE_ENV !== 'test') return {};
  return { adapter: 'test', test_response: firstTruthy(input.test_response, source.test_response) };
}

function retryCollaborationMode(source, input) {
  if (input.collaboration_mode) return input.collaboration_mode;
  if (source.collaboration_mode) return source.collaboration_mode;
  return source.mode === 'plan' ? 'plan' : 'default';
}

function retryProfileId(source, input) {
  if (input.profile_id) return input.profile_id;
  return source.profile_id === 'test_adapter' ? undefined : source.profile_id;
}

function firstTruthy(...values) {
  return values.find(Boolean);
}

export function normalizeTestResponse(value, delayValue) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    message: cleanText(source.message || 'Test Assist V3 Turn completed.', 100_000),
    delay_ms: Math.max(0, Math.min(2_000, Number(source.delay_ms ?? delayValue ?? 10) || 0)),
    events: Array.isArray(source.events) ? source.events.slice(0, 100).map(normalizeTestEvent) : [],
    files: Array.isArray(source.files)
      ? source.files.slice(0, 50).map((file) => ({
          path: cleanText(file?.path, 2_000),
          content: String(file?.content ?? '').slice(0, 200_000)
        }))
      : [],
    actions: Array.isArray(source.actions) ? source.actions.slice(0, 50) : []
  };
}

function normalizeTestEvent(event) {
  const type = cleanText(event?.type, 100),
    data = event?.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {};
  const fields =
    {
      text: ['text'],
      plan: ['text', 'status'],
      command: ['command', 'status', 'exit_code', 'output'],
      file_change: ['changes', 'status'],
      test: ['name', 'status', 'summary'],
      mcp: ['server', 'tool', 'status'],
      search: ['query', 'status'],
      usage: ['input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens'],
      approval: ['external_id', 'approval_type', 'status'],
      reasoning_summary: ['summary'],
      status: ['status']
    }[type] || [];
  return {
    type,
    data: Object.fromEntries(fields.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]))
  };
}
