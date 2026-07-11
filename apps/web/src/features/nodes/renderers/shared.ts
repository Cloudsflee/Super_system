import { api, json } from '../../../api/client';

export async function saveWorkspaceData(nodeId: string, data: Record<string, unknown>) {
  return api(`/nodes/${nodeId}/workspace-data`, json('PUT', { data }));
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function lines(value: string) { return value.split('\n').map((item) => item.trim()).filter(Boolean); }
