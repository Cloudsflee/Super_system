import {
  contextStatus,
  createSelection,
  getContextMap,
  getContextPolicy,
  getSelection,
  putContextPolicy,
  readContextNode,
  rebuildContext,
  reportBrowserSemanticState,
  searchContext
} from '../context-service.mjs';
import { makeRoute, send } from '../http.mjs';

const readOptions = { required_scopes: ['context:read'] };

export const contextV20Routes = [
  makeRoute(
    'POST',
    '/context/v1/browser-state',
    async ({ req, res, body }) => send(res, 200, await reportBrowserSemanticState(body, { req })),
    { ...readOptions, summary: '上报浏览器语义上下文状态', idempotency: 'idempotent' }
  ),
  makeRoute(
    'GET',
    '/context/v1/map',
    async ({ req, res, query }) => send(res, 200, await getContextMap(query, { req })),
    {
      ...readOptions,
      summary: '读取有序系统上下文地图',
      mcp_resource_uri_template: 'aiws://context/map/{scope}'
    }
  ),
  makeRoute(
    'POST',
    '/context/v1/search',
    async ({ req, res, body }) => send(res, 200, await searchContext(body, { req })),
    { ...readOptions, summary: '检索系统上下文节点', idempotency: 'idempotent' }
  ),
  makeRoute(
    'GET',
    '/context/v1/nodes/:id',
    async ({ req, res, params, query }) => send(res, 200, await readContextNode(params.id, query, { req })),
    {
      ...readOptions,
      summary: '读取精确上下文文档版本',
      mcp_resource_uri_template: 'aiws://context/nodes/{id}'
    }
  ),
  makeRoute(
    'POST',
    '/context/v1/selections',
    async ({ req, res, body }) => send(res, 201, await createSelection(body, { req })),
    { ...readOptions, summary: '按预算裁决并记录上下文选择', idempotency: 'conditional' }
  ),
  makeRoute(
    'GET',
    '/context/v1/selections/:id',
    async ({ req, res, params }) => send(res, 200, await getSelection(params.id, { req })),
    {
      ...readOptions,
      summary: '解释不可变上下文选择',
      mcp_resource_uri_template: 'aiws://context/selections/{id}'
    }
  ),
  makeRoute(
    'GET',
    '/context/v1/policy',
    async ({ req, res, query }) => send(res, 200, await getContextPolicy(query, { req })),
    { ...readOptions, summary: '读取当前上下文固定和排除策略' }
  ),
  makeRoute(
    'PUT',
    '/context/v1/policy',
    async ({ req, res, body }) => send(res, 200, await putContextPolicy(body, { req })),
    { ...readOptions, summary: '更新当前上下文固定和排除策略', idempotency: 'idempotent' }
  ),
  makeRoute('GET', '/context/v1/status', async ({ req, res }) => send(res, 200, await contextStatus({ req })), {
    required_scopes: ['context:admin'],
    summary: '读取上下文投影与索引状态'
  }),
  makeRoute('POST', '/context/v1/rebuild', async ({ req, res }) => send(res, 200, await rebuildContext({ req })), {
    required_scopes: ['context:admin'],
    summary: '重建上下文投影与全文索引',
    idempotency: 'idempotent'
  })
];
