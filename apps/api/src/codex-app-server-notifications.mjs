const NOTIFICATION_MAPPERS = Object.freeze({
  'item/agentMessage/delta': agentMessageDelta,
  'item/plan/delta': planDelta,
  'item/reasoning/summaryTextDelta': reasoningDelta,
  'turn/plan/updated': planUpdated,
  'turn/diff/updated': diffUpdated,
  'item/commandExecution/outputDelta': commandOutputDelta,
  'item/fileChange/outputDelta': fileChangeDelta,
  'item/fileChange/patchUpdated': fileChangeDelta,
  'thread/tokenUsage/updated': tokenUsageUpdated
});

const COMPLETED_ITEM_MAPPERS = Object.freeze({
  agentMessage: completedAgentMessage,
  plan: completedPlan,
  commandExecution: completedCommand,
  fileChange: completedFileChange,
  mcpToolCall: completedMcpToolCall,
  webSearch: completedWebSearch,
  reasoning: completedReasoning
});

export function mapNotification(message, deltaItems) {
  const params = message.params || {},
    mapper = NOTIFICATION_MAPPERS[message.method];
  if (mapper) return mapper(params, deltaItems);
  if (message.method !== 'item/completed') return null;
  const item = params.item || {},
    completedMapper = COMPLETED_ITEM_MAPPERS[item.type];
  return completedMapper ? completedMapper(item, deltaItems) : null;
}

function agentMessageDelta(params, deltaItems) {
  deltaItems.add(params.itemId);
  return { aiws_type: 'text', data: { text: params.delta || '' }, output_text: params.delta || '' };
}

function planDelta(params) {
  return { aiws_type: 'plan', data: { text: params.delta || '', status: 'streaming', source: 'codex-native' } };
}

function reasoningDelta(params) {
  return { aiws_type: 'reasoning_summary', data: { summary: params.delta || '' } };
}

function planUpdated(params) {
  return {
    aiws_type: 'plan',
    data: {
      text: (params.plan || []).map((step) => `${step.status}: ${step.step}`).join('\n'),
      status: 'updated',
      source: 'codex-native'
    }
  };
}

function diffUpdated(params) {
  return { aiws_type: 'diff', data: { diff: params.diff || '', status: 'updated' } };
}

function commandOutputDelta(params) {
  return { aiws_type: 'command', data: { item_id: params.itemId, output: params.delta || '', status: 'running' } };
}

function fileChangeDelta(params) {
  return {
    aiws_type: 'file_change',
    data: { item_id: params.itemId, patch: params.delta || params.patch || '', status: 'running' }
  };
}

function tokenUsageUpdated(params) {
  const usage = params.tokenUsage?.total || {};
  return {
    aiws_type: 'usage',
    data: {
      input_tokens: usage.inputTokens,
      cached_input_tokens: usage.cachedInputTokens,
      output_tokens: usage.outputTokens,
      reasoning_output_tokens: usage.reasoningOutputTokens,
      total_tokens: usage.totalTokens
    }
  };
}

function completedAgentMessage(item, deltaItems) {
  return deltaItems.has(item.id)
    ? null
    : { aiws_type: 'text', data: { text: item.text || '' }, output_text: item.text || '' };
}

function completedPlan(item) {
  return { aiws_type: 'plan', data: { text: item.text || '', status: 'completed', source: 'codex-native' } };
}

function completedCommand(item) {
  return {
    aiws_type: 'command',
    data: { command: item.command, status: item.status, exit_code: item.exitCode, output: item.aggregatedOutput }
  };
}

function completedFileChange(item) {
  return { aiws_type: 'file_change', data: { status: item.status, changes: item.changes || [] } };
}

function completedMcpToolCall(item) {
  return { aiws_type: 'mcp', data: { server: item.server, tool: item.tool, status: item.status } };
}

function completedWebSearch(item) {
  return { aiws_type: 'search', data: { query: item.query || '', status: 'completed' } };
}

function completedReasoning(item) {
  if (!Array.isArray(item.summary)) return null;
  return { aiws_type: 'reasoning_summary', data: { summary: item.summary.join('\n') } };
}
