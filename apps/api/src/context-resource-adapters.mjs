import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  contextHash,
  contextNodeId,
  contextNodeUri,
  sanitizeContextFacts
} from '../../../packages/system-context/src/index.mjs';
import { now } from '../../../packages/shared/index.mjs';
import { readCasBlob } from './asset-cas.mjs';
import { ARTIFACT_DIR, ATTACHMENT_DIR, CAS_DIR } from './config.mjs';

const REPOSITORY_ADAPTER = 'repository_file.v1';
const REPOSITORY_MANIFEST_ADAPTER = 'repository_manifest.v1';
const RUNTIME_ADAPTER = 'runtime_environment.v1';
const BROWSER_ADAPTER = 'browser_semantic_state.v1';
const MAX_REPOSITORY_FILES = boundedEnvironment('AIWS_CONTEXT_REPOSITORY_FILE_LIMIT', 2000, 0, 20_000);
const MAX_REPOSITORY_FILE_BYTES = boundedEnvironment(
  'AIWS_CONTEXT_REPOSITORY_FILE_MAX_BYTES',
  32 * 1024 * 1024,
  1024,
  256 * 1024 * 1024
);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.ai-workspace',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  'vendor'
]);
const SECRET_FILE =
  /(?:^|[._-])(?:\.env|credentials?|secrets?|tokens?|cookies?|id_rsa|id_ed25519|private[_-]?key)(?:[._-]|$)|\.(?:pem|p12|pfx|key)$/i;

export async function refreshContextResourcesInState(
  state,
  { projectId = null, projectIds = null, timestamp = now(), includeRepositoryFiles = true } = {}
) {
  const allowedProjects = projectIds == null ? null : new Set([...projectIds].map(String)),
    desired = [runtimeResourceNode(state, timestamp)],
    repositoryReports = [];
  const projects = (state.projects || []).filter(
    (project) =>
      !project.deleted_at &&
      (!projectId || String(project.id) === String(projectId)) &&
      (!allowedProjects || allowedProjects.has(String(project.id)))
  );
  if (includeRepositoryFiles) {
    for (const project of projects) {
      const projection = await repositoryResourceNodes(state, project, timestamp);
      if (projection.manifestNode) desired.push(projection.manifestNode);
      desired.push(...projection.nodes);
      repositoryReports.push(projection.report);
    }
  }
  updateRepositoryCoverage(state, repositoryReports, {
    fullRefresh: !projectId && allowedProjects == null,
    timestamp
  });
  const desiredIds = new Set(desired.map((node) => node.id));
  let dirty = 0;
  for (const next of desired) {
    const existing = state.context_nodes.find((node) => node.id === next.id);
    const changed =
      !existing ||
      (existing.source_record_hash || existing.source_hash) !== next.source_record_hash ||
      existing.status !== 'active';
    if (existing)
      Object.assign(existing, next, {
        current_version_id: existing.current_version_id || null,
        created_at: existing.created_at || next.created_at
      });
    else state.context_nodes.push(next);
    if (changed) dirty += 1;
  }

  const refreshedProjectIds = new Set(projects.map((project) => String(project.id)));
  for (const node of state.context_nodes) {
    const managedRuntime = node.resource?.adapter === RUNTIME_ADAPTER;
    const managedRepository =
      [REPOSITORY_ADAPTER, REPOSITORY_MANIFEST_ADAPTER].includes(node.resource?.adapter) &&
      (projectId || allowedProjects ? refreshedProjectIds.has(String(node.project_id)) : true);
    if ((!managedRuntime && !managedRepository) || desiredIds.has(node.id) || node.status === 'tombstone') continue;
    const sourceRecordHash = contextHash({ tombstone: true, id: node.id, adapter: node.resource.adapter });
    Object.assign(node, {
      kind: 'tombstone',
      status: 'tombstone',
      parent_id: null,
      freshness: { ...(node.freshness || {}), status: 'superseded', tombstoned_at: timestamp },
      source_record_hash: sourceRecordHash,
      source_hash: sourceRecordHash,
      updated_at: timestamp
    });
    dirty += 1;
  }
  return {
    dirty,
    resources: desired.length,
    repository_files: desired.filter((node) => node.resource?.adapter === REPOSITORY_ADAPTER).length,
    repository_reports: repositoryReports
  };
}

export async function resolveContextProjectionRecord(state, node, record, { casRoot = CAS_DIR } = {}) {
  if (node.source_type === 'resource') return resolveResourceNode(state, node);
  if (!record) return record;
  if (node.source_collection === 'file_refs')
    return attachFileContent(record, record.absolute_path, {
      allowedRoot: ARTIFACT_DIR,
      expectedSha256: record.sha256,
      mediaType: record.content_type
    });
  if (node.source_collection === 'attachments' && record.managed_path && record.storage_status === 'ready')
    return attachFileContent(record, record.managed_path, {
      allowedRoot: ATTACHMENT_DIR,
      expectedSha256: record.sha256,
      mediaType: record.content_type || record.detected_mime_type
    });
  if (node.source_collection === 'asset_blobs') {
    const bytes = await readCasBlob(record, { casRoot });
    return attachBytes(record, bytes, record.media_type);
  }
  return record;
}

export function upsertBrowserSemanticResourceInState(
  state,
  { actorId, projectId = null, browserId = 'default', semanticState, timestamp = now() }
) {
  const sourceId = `${actorId}:${projectId || 'global'}:${browserId}`;
  const id = contextNodeId('browser_semantic_states', sourceId);
  const manifest = structuredClone(semanticState),
    sourceHash = contextHash({ adapter: BROWSER_ADAPTER, manifest });
  const next = {
    id,
    uri: contextNodeUri(id),
    kind: 'record',
    source_type: 'resource',
    source_collection: null,
    source_id: `browser_semantic_state:${sourceId}`,
    source_version: 1,
    project_id: projectId,
    parent_id: projectId ? contextNodeId('projects', projectId) : 'ctx_root_system',
    title: '浏览器语义状态',
    deterministic_summary: '当前路由、项目、选中节点、标签页和过滤条件的语义快照。',
    sort: { type_order: 90, order_index: 0, stable_id: id },
    scope: { type: projectId ? 'project' : 'system', id: projectId || 'system', project_id: projectId },
    sensitivity: 'restricted',
    required_scopes: ['context:read', projectId ? 'project:read' : 'system:read'],
    freshness: { status: 'current', source_updated_at: timestamp, checked_at: timestamp },
    authority: 'observed',
    source_record_hash: sourceHash,
    source_hash: sourceHash,
    current_version_id: null,
    status: 'active',
    resource: { adapter: BROWSER_ADAPTER, manifest },
    created_at: timestamp,
    updated_at: timestamp
  };
  const existing = state.context_nodes.find((node) => node.id === id);
  if (existing)
    Object.assign(existing, next, {
      current_version_id: existing.current_version_id || null,
      created_at: existing.created_at || next.created_at
    });
  else state.context_nodes.push(next);
  return existing || next;
}

async function repositoryResourceNodes(state, project, timestamp) {
  const root = await repositoryRoot(project),
    projectNodeId = contextNodeId('projects', project.id);
  if (!root) {
    const report = repositoryReport(project, {
      status: project?.repo_path ? 'unavailable' : 'not_configured',
      discoveredFiles: 0,
      includedFiles: 0,
      omittedFiles: 0,
      oversizedFiles: 0,
      excludedSensitive: 0,
      excludedSymlinks: 0,
      ignoredDirectories: 0,
      unreadableDirectories: 0
    });
    return {
      nodes: [],
      manifestNode: project?.repo_path ? repositoryManifestNode(project, projectNodeId, report, timestamp) : null,
      report
    };
  }
  const previous = new Map(
    state.context_nodes
      .filter((node) => node.resource?.adapter === REPOSITORY_ADAPTER && String(node.project_id) === String(project.id))
      .map((node) => [node.resource.relative_path, node])
  );
  const scan = {
    files: [],
    excludedSensitive: 0,
    excludedSymlinks: 0,
    ignoredDirectories: 0,
    unreadableDirectories: 0
  };
  await walkRepository(root, '', scan);
  scan.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const files = scan.files.slice(0, MAX_REPOSITORY_FILES),
    report = repositoryReport(project, {
      status: scan.files.length > files.length ? 'truncated' : 'complete',
      discoveredFiles: scan.files.length,
      includedFiles: files.length,
      omittedFiles: Math.max(0, scan.files.length - files.length),
      oversizedFiles: scan.files.filter((item) => item.manifestOnly).length,
      excludedSensitive: scan.excludedSensitive,
      excludedSymlinks: scan.excludedSymlinks,
      ignoredDirectories: scan.ignoredDirectories,
      unreadableDirectories: scan.unreadableDirectories
    });
  const nodes = [];
  for (const file of files) {
    const prior = previous.get(file.relativePath);
    let sha256 = file.manifestOnly ? null : prior?.resource?.sha256;
    if (
      !file.manifestOnly &&
      (!sha256 ||
        Number(prior?.resource?.size_bytes) !== file.stat.size ||
        Number(prior?.resource?.mtime_ms) !== file.stat.mtimeMs ||
        Number(prior?.resource?.ctime_ms) !== file.stat.ctimeMs)
    ) {
      const bytes = await fsp.readFile(file.fullPath);
      sha256 = contextHash(bytes);
    }
    const mediaType = mediaTypeFor(file.relativePath);
    const binary = file.manifestOnly || isBinaryMediaType(mediaType);
    const id = contextNodeId('repository_files', `${project.id}:${file.relativePath}`);
    const resource = {
      adapter: REPOSITORY_ADAPTER,
      project_id: String(project.id),
      relative_path: file.relativePath,
      sha256,
      size_bytes: file.stat.size,
      mtime_ms: file.stat.mtimeMs,
      ctime_ms: file.stat.ctimeMs,
      media_type: mediaType,
      binary,
      manifest_only: file.manifestOnly,
      description: file.manifestOnly
        ? '文件超过内容读取上限，仅投影元数据清单。'
        : binary
          ? '仓库二进制文件，仅投影清单。'
          : '仓库文本文件，只读投影。'
    };
    const sourceHash = contextHash({
      adapter: REPOSITORY_ADAPTER,
      sha256,
      size_bytes: file.stat.size,
      media_type: mediaType,
      manifest_only: file.manifestOnly,
      ...(file.manifestOnly ? { mtime_ms: file.stat.mtimeMs, ctime_ms: file.stat.ctimeMs } : {})
    });
    nodes.push({
      id,
      uri: contextNodeUri(id),
      kind: 'record',
      source_type: 'resource',
      source_collection: null,
      source_id: `repository_file:${project.id}:${file.relativePath}`,
      source_version: 1,
      project_id: String(project.id),
      parent_id: projectNodeId,
      title: file.relativePath,
      deterministic_summary: `${file.relativePath} 的仓库${file.manifestOnly ? '元数据清单' : binary ? '二进制清单' : '文本'}投影。`,
      sort: { type_order: 80, order_index: 0, stable_id: file.relativePath },
      scope: { type: 'project', id: String(project.id), project_id: String(project.id) },
      sensitivity: 'internal',
      required_scopes: ['context:read', 'files:read'],
      freshness: { status: 'current', source_updated_at: file.stat.mtime.toISOString(), checked_at: timestamp },
      authority: 'authoritative',
      source_record_hash: sourceHash,
      source_hash: sourceHash,
      current_version_id: null,
      status: 'active',
      resource,
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  return { nodes, manifestNode: repositoryManifestNode(project, projectNodeId, report, timestamp), report };
}

function runtimeResourceNode(state, timestamp) {
  const id = contextNodeId('runtime_resources', 'system');
  const docker = (state.integration_statuses || []).find((item) => item.key === 'codex_docker') || null;
  const manifest = {
    runtime: 'node',
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
    containerized: process.env.AIWS_CONTAINERIZED === '1',
    docker: docker
      ? {
          status: docker.status || 'unknown',
          image: docker.image || null,
          error_code: docker.error_code || null,
          updated_at: docker.updated_at || null
        }
      : { status: 'unknown', image: process.env.AIWS_CODEX_DOCKER_IMAGE || null, error_code: null, updated_at: null },
    tools: (state.tools || []).map((tool) => ({
      id: tool.id,
      name: tool.name,
      enabled: tool.enabled !== false,
      capabilities: tool.capabilities || [],
      health_status: tool.health_status || 'unknown',
      last_checked_at: tool.last_checked_at || null
    }))
  };
  const sourceHash = contextHash({ adapter: RUNTIME_ADAPTER, manifest });
  return {
    id,
    uri: contextNodeUri(id),
    kind: 'record',
    source_type: 'resource',
    source_collection: null,
    source_id: 'runtime_environment:system',
    source_version: 1,
    project_id: null,
    parent_id: 'ctx_root_system',
    title: '运行环境与工具能力',
    deterministic_summary: 'Node、Docker 和工具能力的只读运行时快照。',
    sort: { type_order: 70, order_index: 0, stable_id: id },
    scope: { type: 'system', id: 'system', project_id: null },
    sensitivity: 'restricted',
    required_scopes: ['context:read', 'system:read'],
    freshness: { status: 'current', source_updated_at: docker?.updated_at || null, checked_at: timestamp },
    authority: 'observed',
    source_record_hash: sourceHash,
    source_hash: sourceHash,
    current_version_id: null,
    status: 'active',
    resource: { adapter: RUNTIME_ADAPTER, manifest },
    created_at: timestamp,
    updated_at: timestamp
  };
}

async function resolveResourceNode(state, node) {
  if (node.status === 'tombstone') return { tombstone: true, resource: node.resource || null };
  if (node.resource?.adapter === RUNTIME_ADAPTER) return node.resource.manifest;
  if (node.resource?.adapter === BROWSER_ADAPTER) return node.resource.manifest;
  if (node.resource?.adapter === REPOSITORY_MANIFEST_ADAPTER) return node.resource.manifest;
  if (node.resource?.adapter !== REPOSITORY_ADAPTER) throw resourceError('context_resource_adapter_unknown');
  const project = (state.projects || []).find((item) => String(item.id) === String(node.project_id));
  const root = await repositoryRoot(project);
  if (!root) throw resourceError('context_repository_unavailable');
  const file = resolveWithin(root, node.resource.relative_path);
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw resourceError('context_repository_file_unavailable');
  if (node.resource.manifest_only) {
    if (
      stat.size !== Number(node.resource.size_bytes) ||
      stat.mtimeMs !== Number(node.resource.mtime_ms) ||
      stat.ctimeMs !== Number(node.resource.ctime_ms)
    )
      throw resourceError('context_resource_source_changed');
    return {
      resource_type: 'repository_file',
      project_id: String(node.project_id),
      relative_path: node.resource.relative_path,
      resource_content: {
        binary: true,
        manifest_only: true,
        size_bytes: stat.size,
        sha256: null,
        media_type: node.resource.media_type,
        description: node.resource.description
      }
    };
  }
  const bytes = await fsp.readFile(file);
  if (contextHash(bytes) !== node.resource.sha256 || bytes.length !== Number(node.resource.size_bytes))
    throw resourceError('context_resource_source_changed');
  return attachBytes(
    {
      resource_type: 'repository_file',
      project_id: String(node.project_id),
      relative_path: node.resource.relative_path
    },
    bytes,
    node.resource.media_type
  );
}

async function attachFileContent(record, file, { allowedRoot, expectedSha256, mediaType }) {
  const safeFile = resolveExistingWithin(allowedRoot, file);
  const bytes = await fsp.readFile(safeFile).catch(() => {
    throw resourceError('context_resource_file_unavailable');
  });
  if (expectedSha256 && contextHash(bytes) !== expectedSha256) throw resourceError('context_resource_hash_mismatch');
  return attachBytes(record, bytes, mediaType);
}

function attachBytes(record, bytes, mediaType = 'application/octet-stream') {
  const normalizedMediaType = String(mediaType || 'application/octet-stream')
    .split(';')[0]
    .toLowerCase();
  const binary = isBinaryMediaType(normalizedMediaType) || bytes.includes(0);
  return {
    ...structuredClone(record),
    resource_content: binary
      ? {
          binary: true,
          size_bytes: bytes.length,
          sha256: contextHash(bytes),
          media_type: normalizedMediaType,
          description: '二进制内容未写入文本投影'
        }
      : {
          binary: false,
          size_bytes: bytes.length,
          sha256: contextHash(bytes),
          media_type: normalizedMediaType,
          content: bytes.toString('utf8')
        }
  };
}

async function repositoryRoot(project) {
  if (!project?.repo_path) return null;
  const root = path.resolve(String(project.repo_path));
  const stat = await fsp.stat(root).catch(() => null);
  return stat?.isDirectory() ? root : null;
}

async function walkRepository(root, relative, scan) {
  const directory = relative ? resolveWithin(root, relative) : root;
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => {
    scan.unreadableDirectories += 1;
    return [];
  });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      scan.excludedSymlinks += 1;
      continue;
    }
    if (SECRET_FILE.test(entry.name)) {
      scan.excludedSensitive += 1;
      continue;
    }
    const childRelative = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    if (!safeRepositoryRelativePath(childRelative)) {
      scan.excludedSensitive += 1;
      continue;
    }
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) scan.ignoredDirectories += 1;
      else await walkRepository(root, childRelative, scan);
      continue;
    }
    if (!entry.isFile()) continue;
    const fullPath = resolveWithin(root, childRelative);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat?.isFile()) continue;
    scan.files.push({
      relativePath: childRelative,
      fullPath,
      stat,
      manifestOnly: stat.size > MAX_REPOSITORY_FILE_BYTES
    });
  }
}

function repositoryManifestNode(project, projectNodeId, report, timestamp) {
  const id = contextNodeId('repository_manifests', project.id),
    sourceHash = contextHash({ adapter: REPOSITORY_MANIFEST_ADAPTER, report });
  return {
    id,
    uri: contextNodeUri(id),
    kind: 'record',
    source_type: 'resource',
    source_collection: null,
    source_id: `repository_manifest:${project.id}`,
    source_version: 1,
    project_id: String(project.id),
    parent_id: projectNodeId,
    title: '仓库投影清单',
    deterministic_summary:
      report.status === 'truncated'
        ? `仓库投影已截断，收录 ${report.included_file_count} 个文件，遗漏 ${report.omitted_file_count} 个。`
        : `仓库投影已收录 ${report.included_file_count} 个文件。`,
    sort: { type_order: 79, order_index: 0, stable_id: id },
    scope: { type: 'project', id: String(project.id), project_id: String(project.id) },
    sensitivity: 'internal',
    required_scopes: ['context:read', 'files:read'],
    freshness: {
      status: report.status === 'unavailable' ? 'stale' : 'current',
      source_updated_at: null,
      checked_at: timestamp
    },
    authority: 'observed',
    source_record_hash: sourceHash,
    source_hash: sourceHash,
    current_version_id: null,
    status: 'active',
    resource: { adapter: REPOSITORY_MANIFEST_ADAPTER, manifest: report },
    created_at: timestamp,
    updated_at: timestamp
  };
}

function repositoryReport(project, values) {
  return {
    adapter: REPOSITORY_ADAPTER,
    project_id: String(project?.id || ''),
    status: values.status,
    complete: values.status === 'complete' || values.status === 'not_configured',
    discovered_file_count: values.discoveredFiles,
    included_file_count: values.includedFiles,
    omitted_file_count: values.omittedFiles,
    manifest_only_file_count: values.oversizedFiles,
    excluded_sensitive_entry_count: values.excludedSensitive,
    excluded_symlink_count: values.excludedSymlinks,
    ignored_directory_count: values.ignoredDirectories,
    unreadable_directory_count: values.unreadableDirectories,
    file_limit: MAX_REPOSITORY_FILES,
    content_byte_limit: MAX_REPOSITORY_FILE_BYTES
  };
}

function updateRepositoryCoverage(state, reports, { fullRefresh, timestamp }) {
  const byProject = new Map(
    (fullRefresh ? [] : state.context_resource_coverage?.repositories || []).map((item) => [item.project_id, item])
  );
  for (const report of reports) byProject.set(report.project_id, report);
  const repositories = [...byProject.values()].sort((left, right) => left.project_id.localeCompare(right.project_id));
  const warnings = repositories.flatMap((report) => {
    const output = [];
    if (report.status === 'truncated')
      output.push({
        code: 'context_repository_projection_truncated',
        project_id: report.project_id,
        included_file_count: report.included_file_count,
        omitted_file_count: report.omitted_file_count,
        file_limit: report.file_limit
      });
    if (report.status === 'unavailable' || report.unreadable_directory_count > 0)
      output.push({
        code: 'context_repository_projection_incomplete',
        project_id: report.project_id,
        status: report.status,
        unreadable_directory_count: report.unreadable_directory_count
      });
    if (report.manifest_only_file_count > 0)
      output.push({
        code: 'context_repository_content_omitted',
        project_id: report.project_id,
        manifest_only_file_count: report.manifest_only_file_count,
        content_byte_limit: report.content_byte_limit
      });
    return output;
  });
  state.context_resource_coverage = { repositories, warnings, checked_at: timestamp };
}

function safeRepositoryRelativePath(value) {
  const sanitized = sanitizeContextFacts({ relative_path: value }).facts.relative_path;
  return sanitized === value;
}

function resolveExistingWithin(root, file) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(String(file || ''));
  const relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw resourceError('context_resource_path_forbidden');
  return candidate;
}

function resolveWithin(root, relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..'))
    throw resourceError('context_resource_path_forbidden');
  return resolveExistingWithin(root, path.join(root, ...normalized.split('/')));
}

function mediaTypeFor(file) {
  const extension = path.extname(file).toLowerCase();
  return (
    {
      '.json': 'application/json',
      '.jsonl': 'application/x-ndjson',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.tsv': 'text/tab-separated-values',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.cjs': 'text/javascript',
      '.ts': 'text/typescript',
      '.tsx': 'text/typescript',
      '.jsx': 'text/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.xml': 'application/xml',
      '.yaml': 'application/yaml',
      '.yml': 'application/yaml',
      '.toml': 'application/toml',
      '.sql': 'application/sql',
      '.py': 'text/x-python',
      '.go': 'text/x-go',
      '.rs': 'text/x-rust',
      '.java': 'text/x-java',
      '.c': 'text/x-c',
      '.h': 'text/x-c',
      '.cpp': 'text/x-c++',
      '.sh': 'text/x-shellscript',
      '.ps1': 'text/x-powershell',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip'
    }[extension] || 'text/plain'
  );
}

function isBinaryMediaType(mediaType) {
  const value = String(mediaType || '').toLowerCase();
  return (
    (value.startsWith('image/') && value !== 'image/svg+xml') ||
    value.startsWith('audio/') ||
    value.startsWith('video/') ||
    ['application/pdf', 'application/zip', 'application/octet-stream'].includes(value)
  );
}

function boundedEnvironment(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}

function resourceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
