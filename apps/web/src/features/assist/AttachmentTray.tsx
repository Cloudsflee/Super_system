import { File, FileX2, Image, X } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { api, ApiError, json } from '../../api/client';
import type { AssistAttachment } from '../../api/types';
import { IconButton } from '../../components/common/IconButton';

const AttachmentPreview = lazy(() => import('./AttachmentPreview'));
type Props = {
  attachments: AssistAttachment[];
  selectedIds: string[];
  onSelected: (ids: string[]) => void;
  onDeleted: (item: AssistAttachment, tombstone: boolean) => void;
  onError: (message: string) => void;
};

export function AttachmentTray(props: Props) {
  const [preview, setPreview] = useState<AssistAttachment | null>(null),
    [deleting, setDeleting] = useState<string | null>(null);
  function toggle(id: string) {
    props.onSelected(
      props.selectedIds.includes(id) ? props.selectedIds.filter((item) => item !== id) : [...props.selectedIds, id]
    );
  }
  async function remove(item: AssistAttachment) {
    setDeleting(item.id);
    try {
      let result: { attachment: AssistAttachment; tombstone: boolean };
      try {
        result = await api(`/assist/v3/attachments/${item.id}`, json('DELETE', undefined, `删除附件 ${item.title}`));
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.payload.error !== 'attachment_delete_confirmation_required' ||
          !window.confirm(`删除已被历史消息引用的“${item.title}”内容？`)
        )
          throw error;
        result = await api(
          `/assist/v3/attachments/${item.id}?confirm_referenced=true`,
          json('DELETE', undefined, `确认删除附件 ${item.title}`)
        );
      }
      props.onDeleted(result.attachment, result.tombstone);
      if (preview?.id === item.id) setPreview(null);
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setDeleting(null);
    }
  }
  if (!props.attachments.length) return null;
  return (
    <div className="attachment-tray">
      <div className="attachment-chips">
        {props.attachments.map((item) => {
          const deleted = Boolean(item.content_deleted_at || item.storage_status === 'deleted');
          return (
            <div className={`attachment-chip${deleted ? ' deleted' : ''}`} key={item.id}>
              <div className="attachment-chip-main">
                <input
                  type="checkbox"
                  aria-label={`选择 ${item.title}`}
                  disabled={deleted}
                  checked={!deleted && props.selectedIds.includes(item.id)}
                  onChange={() => toggle(item.id)}
                />
                {item.kind === 'image' ? <Image size={12} /> : deleted ? <FileX2 size={12} /> : <File size={12} />}
                <button type="button" disabled={deleted} onClick={() => setPreview(item)}>
                  {item.title}
                </button>
              </div>
              <IconButton
                label={`删除 ${item.title}`}
                disabled={deleting === item.id}
                onClick={() => void remove(item)}
              >
                <X size={12} />
              </IconButton>
            </div>
          );
        })}
      </div>
      {preview && (
        <Suspense fallback={<div className="attachment-preview-loading">正在加载预览</div>}>
          <AttachmentPreview attachment={preview} onClose={() => setPreview(null)} />
        </Suspense>
      )}
    </div>
  );
}
