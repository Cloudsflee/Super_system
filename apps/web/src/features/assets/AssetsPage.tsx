import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, json } from '../../api/client';
import type {
  AssetDetails,
  AssetManifestEntry,
  AssetRecord,
  AssetVersionDetails,
  AssetVersionRecord,
  TaskExecutionDetails
} from '../../api/types';
import { useAssistSurface } from '../../components/assist/semantic-actions';
import { useUi } from '../../state/ui';
import { AssetsPageView } from './AssetsPageView';
import { downloadUrl, isTextMedia } from './asset-presentation';

const PREVIEW_LIMIT = 1024 * 1024;

function useAssetsPageController() {
  const projectId = useUi((state) => state.activeProjectId);
  const [status, setStatus] = useState('all');
  useAssistSurface({
    id: 'assets-page',
    filters: {
      'assets.status': {
        label: '资产状态',
        elementId: 'assets-status-filter',
        values: ['all', 'candidate', 'confirmed', 'rejected', 'stale', 'disputed', 'superseded'],
        set: (value) => setStatus(String(value || 'all'))
      }
    }
  });
  const selection = useAssetSelection(projectId, status),
    preview = useAssetPreview(selection),
    attestation = useAssetAttestation(selection);
  return { ...selection, ...preview, ...attestation, status, setStatus };
}

function useAssetSelection(projectId: string | null, status: string) {
  const [selectedId, setSelectedId] = useState(''),
    [versionId, setVersionId] = useState(''),
    [previewPath, setPreviewPath] = useState<string | null>(null);
  const assets = useQuery({
    queryKey: ['assets', projectId],
    queryFn: () => api<AssetRecord[]>(`/assets${projectId ? `?project_id=${projectId}` : ''}`)
  });
  const rows = useMemo(
    () => (assets.data || []).filter((item) => status === 'all' || item.status === status),
    [assets.data, status]
  );
  useEffect(() => {
    if (!rows.some((item) => item.id === selectedId)) setSelectedId(rows[0]?.id || '');
  }, [rows, selectedId]);
  const detail = useQuery({
    queryKey: ['asset', selectedId],
    queryFn: () => api<AssetDetails>(`/assets/${selectedId}`),
    enabled: Boolean(selectedId)
  });
  useEffect(() => {
    const next = detail.data?.current?.id || detail.data?.versions[0]?.id || '';
    setVersionId(next);
    setPreviewPath(null);
  }, [detail.data?.asset.id, detail.data?.current?.id]);
  const version = useQuery({
    queryKey: ['asset-version', versionId],
    queryFn: () => api<AssetVersionDetails>(`/asset-versions/${versionId}`),
    enabled: Boolean(versionId)
  });
  return {
    assets,
    rows,
    selectedId,
    setSelectedId,
    detail,
    selected: version.data?.version,
    current: detail.data?.asset,
    versionId,
    setVersionId,
    previewPath,
    setPreviewPath,
    version
  };
}

function useAssetPreview(selection: ReturnType<typeof useAssetSelection>) {
  const entry = selection.version.data?.version.manifest?.entries?.find((item) => item.path === selection.previewPath),
    previewMedia = entry?.media_type || selection.version.data?.version.media_type || '',
    previewSize = previewPayloadSize(selection.version.data, entry),
    canPreview = previewAvailable(
      selection.versionId,
      selection.previewPath,
      previewMedia,
      previewSize,
      selection.version.data
    );
  const preview = useQuery({
    queryKey: ['asset-content', selection.versionId, selection.previewPath],
    queryFn: () => readPreview(selection.versionId, selection.previewPath, previewMedia),
    enabled: canPreview
  });
  return { preview, canPreview };
}

function previewPayloadSize(version: AssetVersionDetails | undefined, entry: AssetManifestEntry | undefined) {
  if (entry) return entry.size_bytes;
  const entries = version?.version.manifest?.entries;
  return entries?.length && entries.length > 1 ? 0 : version?.version.size_bytes || 0;
}

function previewAvailable(
  versionId: string,
  previewPath: string | null,
  mediaType: string,
  size: number,
  version: AssetVersionDetails | undefined
) {
  if (!versionId || size > PREVIEW_LIMIT) return false;
  if (previewPath) return isTextMedia(mediaType);
  return isTextMedia(mediaType) || (version?.version.manifest?.entries?.length || 0) > 1;
}

function useAssetAttestation(selection: ReturnType<typeof useAssetSelection>) {
  const toast = useUi((state) => state.toast),
    [busy, setBusy] = useState(''),
    executionId = selection.detail.data?.asset.task_execution_id || '';
  const task = useQuery({
    queryKey: ['task-execution', executionId],
    queryFn: () => api<TaskExecutionDetails>(`/task-executions/${executionId}`),
    enabled: Boolean(executionId)
  });
  async function decide(decision: 'accepted' | 'rejected') {
    const asset = selection.detail.data?.asset,
      selected = selection.version.data?.version;
    if (!asset || !selected?.content_sha256) return;
    setBusy(decision);
    try {
      await submitAssetDecision(asset, selected, task.data, decision);
      await Promise.all([
        selection.assets.refetch(),
        selection.detail.refetch(),
        selection.version.refetch(),
        task.refetch()
      ]);
      toast(decision === 'accepted' ? '资产版本已验收' : '资产版本已退回');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }
  const canAttest =
    selection.current?.status === 'candidate' &&
    selection.current.current_version_id === selection.selected?.id &&
    selection.current.confirmation_policy !== 'system_evidence' &&
    Boolean(selection.selected?.content_sha256);
  return { canAttest, executionId, busy, task, decide };
}

export function AssetsPage() {
  return <AssetsPageView controller={useAssetsPageController()} />;
}

export type AssetsPageController = ReturnType<typeof useAssetsPageController>;

async function submitAssetDecision(
  asset: AssetRecord,
  selected: AssetVersionRecord,
  task: TaskExecutionDetails | undefined,
  decision: 'accepted' | 'rejected'
) {
  if (asset.task_execution_id) return attestTaskOutputs(asset.task_execution_id, task, decision);
  return api(
    `/asset-versions/${selected.id}/attestations`,
    json(
      'POST',
      { decision, expected_sha256: selected.content_sha256 },
      decision === 'accepted' ? '确认资产版本' : '拒绝资产版本'
    )
  );
}

function attestTaskOutputs(
  executionId: string,
  task: TaskExecutionDetails | undefined,
  decision: 'accepted' | 'rejected'
) {
  const candidates =
    task?.outputs.filter(
      (item) => item.asset?.status === 'candidate' && !item.bound && item.version?.id && item.version.content_sha256
    ) || [];
  if (!candidates.length) throw new Error('任务执行没有可验收的候选输出');
  return api(
    `/task-executions/${executionId}/human-approve`,
    json(
      'POST',
      {
        decision: decision === 'accepted' ? 'approve' : 'reject',
        expected_versions: candidates.map((item) => ({
          version_id: item.version?.id,
          content_sha256: item.version?.content_sha256
        }))
      },
      decision === 'accepted' ? '验收任务输出' : '退回任务输出'
    )
  );
}
async function readPreview(versionId: string, path: string | null, mediaType: string) {
  const response = await fetch(downloadUrl(versionId, path, false));
  if (!response.ok) throw new Error(`正文读取失败（HTTP ${response.status}）`);
  const text = await response.text();
  if (mediaType.includes('json') || (!path && text.trimStart().startsWith('{'))) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}
