import { QueryClient, type QueryKey } from '@tanstack/react-query';

export type WorkspaceScope = {
  actorId: string;
  teamId: string;
  projectId: string;
};

/** Every server-backed query is isolated by the authenticated workspace scope. */
export function workspaceQueryKey(
  scope: WorkspaceScope,
  resource: string,
  params: unknown = {}
): QueryKey {
  return ['v2', scope.actorId, scope.teamId, scope.projectId, resource, params];
}

export function isRetryableQueryError(error: unknown): boolean {
  const status = Number((error as { status?: number } | null)?.status || 0);
  return status === 0 || status >= 500;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => failureCount < 2 && isRetryableQueryError(error),
      refetchOnWindowFocus: false,
      networkMode: 'online'
    },
    mutations: {
      retry: 0,
      networkMode: 'online'
    }
  }
});

export async function clearWorkspaceScope(scope: WorkspaceScope): Promise<void> {
  await queryClient.cancelQueries({ queryKey: ['v2', scope.actorId, scope.teamId, scope.projectId] });
  queryClient.removeQueries({ queryKey: ['v2', scope.actorId, scope.teamId, scope.projectId] });
}

export function invalidateForEvent(eventType: string): QueryKey[] {
  const value = String(eventType || '');
  const mappings: Array<[RegExp, string]> = [
    [/^project\./, 'project'],
    [/^(?:intake|brief)\./, 'brief'],
    /^(?:workflow|generation|critic|proposal)\./.test(value) ? [/^/, 'workflow'] : null,
    [/^(?:context_|context\.)/, 'context'],
    [/^(?:assist_|runtime_approval|runtime_user_input)/, 'assist'],
    [/^(?:execution|task_attempt|execution_stage)\./, 'execution'],
    [/^(?:asset|evidence|trace|digest|code_change|test_result|parser_run)\./, 'evidence'],
    [/^quality_review\./, 'quality'],
    [/^(?:outcome|outcome_requirement)\./, 'outcome'],
    [/^(?:delivery|deployment)\./, 'delivery'],
    [/^(?:operation|backup|restore|system\.reset|cas\.gc)\./, 'operations']
  ].filter(Boolean) as Array<[RegExp, string]>;
  const match = mappings.find(([pattern]) => pattern.test(value));
  return match ? [['v2', '*', '*', '*', match[1]]] : [['v2', '*', '*', '*', 'operations']];
}

export function invalidateEventQueries(eventType: string): void {
  const resources = new Set(invalidateForEvent(eventType).map((key) => String(key[4])));
  queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'v2' && resources.has(String(query.queryKey[4])) });
}
