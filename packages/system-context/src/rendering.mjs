import {
  CONTEXT_EDGE_TYPES,
  CONTEXT_RENDERER_VERSION,
  compareContextNodes,
  contextNodeUri,
  sanitizeContextFacts
} from './protocol.mjs';

export function renderContextMarkdown({ node, record = null, edges = [], relatedNodes = [] }) {
  const sanitized = sanitizeContextFacts(
    record ?? {
      id: node.source_id,
      source_collection: node.source_collection,
      tombstone: node.status === 'tombstone'
    }
  );
  const relationLines = contextDocumentRelationSnapshot(node, edges, relatedNodes).map(
    (relation) =>
      `- ${relation.type} ${relation.direction} ${relation.other_uri}${relation.other_title ? ` (${relation.other_title})` : ''}`
  );
  const redactionLines = sanitized.redactions.length
    ? sanitized.redactions.map((item) => `- \`${item.path}\`: ${redactionLabel(item.reason)}`)
    : ['- 未发生字段脱敏。'];
  const sourceVersion = node.source_version ?? record?.version ?? record?.revision ?? 1;
  return [
    `# ${cleanContextInline(node.title || node.id)}`,
    '',
    '## 身份',
    `- URI: ${node.uri}`,
    `- 类型: ${node.kind}`,
    `- 作用域: ${node.project_id ? `项目 ${node.project_id}` : '系统'}`,
    `- 敏感级: ${node.sensitivity}`,
    '',
    '## 摘要',
    cleanContextInline(node.deterministic_summary) || '暂无摘要。',
    '',
    '## 状态',
    `- 投影状态: ${node.status}`,
    `- 新鲜度: ${node.freshness?.status || 'current'}`,
    `- 权威级: ${node.authority || 'authoritative'}`,
    '',
    '## 完整事实',
    '```json',
    JSON.stringify(sanitized.facts, null, 2),
    '```',
    '',
    '## 关系',
    ...(relationLines.length ? relationLines : ['- 无已记录关系。']),
    '',
    '## 来源与版本',
    `- 来源: ${node.source_collection || 'system_context'}/${node.source_id || node.id}`,
    `- 源版本: ${sourceVersion}`,
    `- 源哈希: ${node.source_hash}`,
    `- 渲染器: ${CONTEXT_RENDERER_VERSION}`,
    `- 当前版本: ${node.current_version_id || '待物化'}`,
    '- 权威声明: 本文是只读文本投影，业务修改必须回到来源记录完成。',
    '',
    '## 脱敏说明',
    ...redactionLines,
    '- Vault 值、令牌、Cookie、私钥和原始凭据不会进入正文。',
    ''
  ].join('\n');
}

export function contextDocumentRelationSnapshot(node, edges = [], relatedNodes = []) {
  const related = new Map(relatedNodes.map((item) => [item.id, item]));
  return edges
    .filter((edge) => edge.source_node_id === node.id || edge.target_node_id === node.id)
    .filter((edge) => {
      const otherId = edge.source_node_id === node.id ? edge.target_node_id : edge.source_node_id;
      return contextDocumentEdgeAllowed(node, related.get(otherId), edge);
    })
    .sort(compareContextEdges)
    .map((edge) => {
      const outbound = edge.source_node_id === node.id;
      const otherId = outbound ? edge.target_node_id : edge.source_node_id;
      const other = related.get(otherId);
      return {
        edge_id: edge.id,
        type: edge.type,
        direction: outbound ? '->' : '<-',
        order_index: Number(edge.order_index || 0),
        other_id: otherId,
        other_uri: other?.uri || contextNodeUri(otherId),
        other_title: other?.title ? cleanContextInline(other.title) : ''
      };
    });
}

export function compactContextMap(nodes, { rootId = 'ctx_root_system', maxDepth = 4, maxNodes = 300 } = {}) {
  const byParent = new Map(),
    byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const key = node.parent_id || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(node);
  }
  for (const children of byParent.values()) children.sort(compareContextNodes);
  const lines = [];
  const visit = (id, depth) => {
    if (lines.length >= maxNodes || depth > maxDepth) return;
    const node = byId.get(id);
    if (node) lines.push(`${'  '.repeat(depth)}- [${node.kind}] ${cleanContextInline(node.title)} (${node.uri})`);
    for (const child of byParent.get(id) || []) visit(child.id, depth + 1);
  };
  visit(rootId, 0);
  return lines.join('\n');
}

export function compareContextEdges(left, right) {
  return (
    CONTEXT_EDGE_TYPES.indexOf(left.type) - CONTEXT_EDGE_TYPES.indexOf(right.type) ||
    Number(left.order_index || 0) - Number(right.order_index || 0) ||
    String(left.id).localeCompare(String(right.id))
  );
}

export function cleanContextInline(value) {
  return sanitizeContextFacts(String(value || ''))
    .facts.replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function redactionLabel(reason) {
  return (
    {
      sensitive_field: '敏感字段已移除',
      sensitive_value: '自由文本中的凭据已移除',
      secret_reference_only: '仅保留密钥引用和脱敏状态',
      host_path_hidden: '宿主机绝对路径已隐藏',
      binary_manifest_only: '二进制仅保留清单、哈希、类型和描述'
    }[reason] || reason
  );
}

function contextDocumentEdgeAllowed(node, related, edge) {
  if (!node || !related) return false;
  const projectId = node.project_id ? String(node.project_id) : null,
    relatedProjectId = related.project_id ? String(related.project_id) : null;
  if (projectId === relatedProjectId) return true;
  return Boolean(
    projectId &&
    !relatedProjectId &&
    related.id === 'ctx_root_system' &&
    edge.type === 'contains' &&
    edge.source_node_id === related.id &&
    edge.target_node_id === node.id
  );
}
