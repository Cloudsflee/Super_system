import fsp from 'node:fs/promises';
import path from 'node:path';
import { readState } from './state.mjs';
import { cleanText, readableProjectCwd, requireProject, requireSession } from './assist-v3-domain.mjs';

export async function listAssistReferences(sessionId, query = {}) {
  const state = await readState(),
    session = requireSession(state, sessionId),
    project = requireProject(state, session.project_id);
  const search = cleanText(query.q, 300).toLowerCase(),
    limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
  const attachments = state.attachments
    .filter((item) => item.session_id === session.id && !item.deleted_at)
    .map((item) => ({
      id: `attachment:${item.id}`,
      reference_id: item.id,
      kind: 'uploaded_file',
      title: item.original_filename || item.title || item.id,
      path: null,
      content_type: item.detected_mime_type || item.content_type || 'application/octet-stream',
      size_bytes: item.size_bytes || 0,
      available: !item.content_deleted_at && item.storage_status !== 'deleted',
      preview_kind: item.preview_kind || 'metadata'
    }))
    .filter((item) => matchesReference(item, search));
  const editorPath = currentEditorPath(session.view_context);
  const editor = editorPath
    ? [
        {
          id: `editor:${editorPath}`,
          reference_id: editorPath,
          kind: 'current_editor_file',
          title: path.posix.basename(editorPath),
          path: editorPath,
          current: true,
          available: true
        }
      ]
    : [];
  const projectFiles = await scanProjectReferences(
    project,
    search,
    Math.max(0, limit - attachments.length - editor.length)
  );
  return [...editor.filter((item) => matchesReference(item, search)), ...attachments, ...projectFiles].slice(0, limit);
}

async function scanProjectReferences(project, search, limit) {
  if (!limit) return [];
  const root = readableProjectCwd(project),
    result = [],
    queue = [''];
  let visited = 0;
  while (queue.length && result.length < limit && visited < 5000) {
    const relativeDir = queue.shift(),
      fullDir = path.join(root, relativeDir);
    const entries = await fsp.readdir(fullDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++visited > 5000 || result.length >= limit) break;
      if (entry.isSymbolicLink() || ['.git', 'node_modules', '.ai-workspace', 'dist', 'coverage'].includes(entry.name))
        continue;
      const relative = path.join(relativeDir, entry.name).split(path.sep).join('/');
      if (entry.isDirectory()) queue.push(relative);
      else if (entry.isFile()) {
        const item = {
          id: `project:${relative}`,
          reference_id: relative,
          kind: 'project_file',
          title: entry.name,
          path: relative,
          available: true
        };
        if (matchesReference(item, search)) result.push(item);
      }
    }
  }
  return result;
}

function matchesReference(item, search) {
  return !search || `${item.title || ''}\n${item.path || ''}`.toLowerCase().includes(search);
}
function currentEditorPath(view) {
  const value = view?.editor?.path || view?.path || view?.file?.path;
  const normalized = String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
  return normalized && !normalized.startsWith('/') && !normalized.split('/').includes('..') ? normalized : null;
}
