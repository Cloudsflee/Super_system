import { apiUrl } from '../../api/client';

export function downloadUrl(versionId: string, path: string | null, download = true) {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : '';
  return apiUrl(`/asset-versions/${versionId}/${download ? 'download' : 'content'}${suffix}`);
}

export function isTextMedia(value: string) {
  return (
    value.startsWith('text/') ||
    value.includes('json') ||
    value.includes('xml') ||
    value.includes('yaml') ||
    value.includes('javascript')
  );
}

export function formatBytes(value?: number) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

export function short(value?: string | null) {
  return value ? value.slice(0, 12) : '未绑定';
}

export function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}
