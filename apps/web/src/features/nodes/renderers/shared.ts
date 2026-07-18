import { api, json } from '../../../api/client';

export async function saveWorkspaceData(nodeId: string, data: Record<string, unknown>) {
  return api(`/nodes/${nodeId}/workspace-data`, json('PUT', { data }, '保存节点工作区数据'));
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function lines(value: string) { return value.split('\n').map((item) => item.trim()).filter(Boolean); }
