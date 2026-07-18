import { makeRoute } from '../http.mjs';
import { handleMcpHttpRequest } from '../mcp-http-runtime.mjs';

const handle = ({ req, res, body }) => handleMcpHttpRequest(req, res, body);

export const mcpV18Routes = [
  makeRoute('POST', '/mcp', handle),
  makeRoute('GET', '/mcp', handle),
  makeRoute('DELETE', '/mcp', handle)
];
