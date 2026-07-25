import { useState } from 'react';
import { api, multipart } from '../../api/client';
import type { AssistAttachment } from '../../api/types';

export const LONG_PASTE_THRESHOLD = 8000;
export const MAX_DROP_FILES = 10;
type Upload = { id: string; name: string; status: 'uploading' | 'failed'; error?: string };
let uploadSequence = 0;

export function useComposerFiles(
  sessionId: string,
  onCreated: (item: AssistAttachment) => void,
  onSelected: (id: string) => void,
  onError: (message: string) => void
) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  async function upload(file: File) {
    const uploadId = `upload-${Date.now()}-${++uploadSequence}`;
    setUploads((items) => [...items, { id: uploadId, name: file.name, status: 'uploading' }]);
    const form = new FormData();
    form.set('file', file);
    form.set('title', file.name);
    try {
      if (file.size > 25 * 1024 * 1024 && /^(audio|video)\//.test(file.type)) {
        if (!window.confirm(`上传 ${file.name}（${formatBytes(file.size)}）？`)) {
          setUploads((items) => items.filter((entry) => entry.id !== uploadId));
          return null;
        }
        form.set('media_confirmed', 'true');
      }
      const item = await api<AssistAttachment>(
        `/assist/v3/sessions/${sessionId}/attachments/upload`,
        multipart('POST', form, { name: `上传附件 ${file.name}`, feedback: 'foreground', timeoutMs: 600_000 })
      );
      onCreated(item);
      onSelected(item.id);
      setUploads((items) => items.filter((entry) => entry.id !== uploadId));
      return item;
    } catch (error) {
      const message = (error as Error).message;
      setUploads((items) =>
        items.map((entry) => (entry.id === uploadId ? { ...entry, status: 'failed', error: message } : entry))
      );
      onError(message);
      throw error;
    }
  }
  async function uploadDrop(files: File[]) {
    if (files.length > MAX_DROP_FILES) {
      onError(`每次最多拖入 ${MAX_DROP_FILES} 个文件`);
      return;
    }
    await Promise.allSettled(files.map(upload));
  }
  return { uploads, uploading: uploads.some((item) => item.status === 'uploading'), upload, uploadDrop };
}
function formatBytes(value: number) {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
