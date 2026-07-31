import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { api, describeOperation, json } from '../../api/client';
import type {
  ContextMapResponse,
  ContextNodeRecord,
  ContextNodeResponse,
  ContextSearchResponse
} from '../../api/types';

export type ContextDocumentTab = 'summary' | 'source' | 'structure' | 'relations' | 'history';
export type ContextMobilePane = 'map' | 'document' | 'details';

export function useContextMapController() {
  const { projectId } = useParams(),
    location = useLocation(),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [versionId, setVersionId] = useState<string | null>(null),
    [tab, setTab] = useState<ContextDocumentTab>('summary'),
    [mobilePane, setMobilePane] = useState<ContextMobilePane>('map'),
    [searchInput, setSearchInput] = useState(''),
    [searchResult, setSearchResult] = useState<ContextSearchResponse | null>(null);
  const mapQuery = useQuery({
      queryKey: ['context-map', projectId || 'global'],
      queryFn: () =>
        api<ContextMapResponse>(`/context/v1/map${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`)
    }),
    nodeQuery = useQuery({
      queryKey: ['context-node', selectedId, versionId],
      queryFn: () =>
        api<ContextNodeResponse>(
          `/context/v1/nodes/${encodeURIComponent(selectedId!)}${versionId ? `?version_id=${encodeURIComponent(versionId)}` : ''}`
        ),
      enabled: Boolean(selectedId)
    }),
    searchMutation = useMutation({
      mutationFn: (query: string) =>
        api<ContextSearchResponse>(
          '/context/v1/search',
          json(
            'POST',
            { query, project_id: projectId || null, limit: 100 },
            describeOperation('检索上下文地图', { feedback: 'silent', safeRetry: true })
          )
        ),
      onSuccess: setSearchResult
    }),
    nodes = searchResult?.results || mapQuery.data?.nodes || [],
    effectiveFilter = searchResult?.query || '';
  usePreferredContextNode(nodes, selectedId, setSelectedId, setVersionId);
  useContextBrowserSync({
    ready: Boolean(mapQuery.data),
    projectId,
    route: location.pathname,
    selectedId,
    tab,
    effectiveFilter
  });
  const submitSearch = (event: FormEvent) => {
      event.preventDefault();
      const query = searchInput.trim();
      if (!query) setSearchResult(null);
      else searchMutation.mutate(query);
    },
    selectNode = (nodeId: string) => {
      setSelectedId(nodeId);
      setMobilePane('document');
    },
    clearSearch = () => {
      setSearchInput('');
      setSearchResult(null);
    };
  return {
    projectId,
    selectedId,
    setVersionId,
    tab,
    setTab,
    mobilePane,
    setMobilePane,
    searchInput,
    setSearchInput,
    searchResult,
    mapQuery,
    nodeQuery,
    nodes,
    submitSearch,
    selectNode,
    clearSearch
  };
}

function usePreferredContextNode(
  nodes: ContextNodeRecord[],
  selectedId: string | null,
  setSelectedId: (id: string | null) => void,
  setVersionId: (id: string | null) => void
) {
  useEffect(() => {
    if (selectedId && nodes.some((node) => node.id === selectedId)) return;
    const collectionKinds = [
        'system',
        'contracts',
        'dependencies',
        'executions',
        'assets',
        'conversations',
        'audit',
        'uncategorized'
      ],
      preferred = nodes.find((node) => !collectionKinds.includes(node.kind));
    setSelectedId(preferred?.id || nodes[0]?.id || null);
  }, [nodes, selectedId, setSelectedId]);
  useEffect(() => setVersionId(null), [selectedId, setVersionId]);
}

function useContextBrowserSync({
  ready,
  projectId,
  route,
  selectedId,
  tab,
  effectiveFilter
}: {
  ready: boolean;
  projectId?: string;
  route: string;
  selectedId: string | null;
  tab: ContextDocumentTab;
  effectiveFilter: string;
}) {
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController(),
      timer = window.setTimeout(() => {
        void api('/context/v1/browser-state', {
          ...json(
            'POST',
            {
              project_id: projectId || null,
              browser_id: contextBrowserId(),
              route,
              selected_node_id: selectedId,
              tab,
              filters: effectiveFilter ? { query: effectiveFilter } : {}
            },
            describeOperation('同步上下文语义状态', { feedback: 'silent', safeRetry: true })
          ),
          signal: controller.signal
        }).catch(() => undefined);
      }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [effectiveFilter, projectId, ready, route, selectedId, tab]);
}

function contextBrowserId() {
  const key = 'aiws-browser-instance-v16',
    stored = localStorage.getItem(key);
  if (stored) return stored;
  const random = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    value = `browser-${random}`;
  localStorage.setItem(key, value);
  return value;
}
