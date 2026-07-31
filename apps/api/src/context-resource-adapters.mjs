import { cloneStateValue as structuredClone } from './state-clone.mjs';
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
import * as resourcePath from './context-resource-paths.mjs';

const REPOSITORY_ADAPTER = 'repository_file.v1';
const REPOSITORY_MANIFEST_ADAPTER = 'repository_manifest.v1';
const RUNTIME_ADAPTER = 'runtime_environment.v1';
const BROWSER_ADAPTER = 'browser_semantic_state.v1';
const MAX_REPOSITORY_FILES = resourcePath.boundedEnvironment('AIWS_CONTEXT_REPOSITORY_FILE_LIMIT', 2000, 0, 20_000);
const MAX_REPOSITORY_FILE_BYTES = resourcePath.boundedEnvironment(
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
  /(?:^|[._-])(?:\.env|credentials?|secrets?|tokens?|cookies?|id_rsa|id_ed25519|private[_-]?key)(?:[._-]|$)|\.(?:pem|p12|pfx|key)$|^(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc)$/i;

export async function refreshContextResourcesInState(
  state,
  { projectId = null, projectIds = null, timestamp = now(), includeRepositoryFiles = true } = {}
) {
  const allowedProjects = projectIds == null ? null : new Set([...projectIds].map(String));
  const projects = selectedProjects(state, projectId, allowedProjects);
  const repositories = await projectRepositoryResources(state, projects, timestamp, includeRepositoryFiles);
  const desired = [runtimeResourceNode(state, timestamp), ...repositories.nodes];
  updateRepositoryCoverage(state, repositories.reports, {
    fullRefresh: !projectId && allowedProjects == null,
    timestamp
  });
  let dirty = upsertResourceNodes(state, desired);
  const refreshedProjectIds = new Set(projects.map((project) => String(project.id)));
  dirty += tombstoneMissingResources(state, desired, refreshedProjectIds, {
    scoped: Boolean(projectId || allowedProjects),
    timestamp
  });
  return {
    dirty,
    resources: desired.length,
    repository_files: desired.filter((node) => node.resource?.adapter === REPOSITORY_ADAPTER).length,
    repository_reports: repositories.reports
  };
}

function selectedProjects(state, projectId, allowedProjects) {
  return (state.projects || []).filter(
    (project) =>
      !project.deleted_at &&
      (!projectId || String(project.id) === String(projectId)) &&
      (!allowedProjects || allowedProjects.has(String(project.id)))
  );
}

async function projectRepositoryResources(state, projects, timestamp, includeRepositoryFiles) {
  const nodes = [];
  const reports = [];
  if (!includeRepositoryFiles) return { nodes, reports };
  for (const project of projects) {
    const projection = await repositoryResourceNodes(state, project, timestamp);
    if (projection.manifestNode) nodes.push(projection.manifestNode);
    nodes.push(...projection.nodes);
    reports.push(projection.report);
  }
  return { nodes, reports };
}

function upsertResourceNodes(state, desired) {
  let dirty = 0;
  for (const next of desired) {
    const existing = state.context_nodes.find((node) => node.id === next.id);
    const changed =
      !existing ||
      (existing.source_record_hash || existing.source_hash) !== next.source_record_hash ||
      existing.status !== 'active';
    if (existing) updateResourceNode(existing, next);
    else state.context_nodes.push(next);
    if (changed) dirty += 1;
  }
  return dirty;
}

function updateResourceNode(existing, next) {
  Object.assign(existing, next, {
    current_version_id: existing.current_version_id || null,
    created_at: existing.created_at || next.created_at
  });
}

function tombstoneMissingResources(state, desired, refreshedProjectIds, { scoped, timestamp }) {
  const desiredIds = new Set(desired.map((node) => node.id));
  let dirty = 0;
  for (const node of state.context_nodes) {
    if (!isManagedResource(node, refreshedProjectIds, scoped)) continue;
    if (desiredIds.has(node.id) || node.status === 'tombstone') continue;
    tombstoneResourceNode(node, timestamp);
    dirty += 1;
  }
  return dirty;
}

function isManagedResource(node, refreshedProjectIds, scoped) {
  if (node.resource?.adapter === RUNTIME_ADAPTER) return true;
  if (![REPOSITORY_ADAPTER, REPOSITORY_MANIFEST_ADAPTER].includes(node.resource?.adapter)) return false;
  return scoped ? refreshedProjectIds.has(String(node.project_id)) : true;
}

function tombstoneResourceNode(node, timestamp) {
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
  const root = await repositoryRoot(project);
  const projectNodeId = contextNodeId('projects', project.id);
  if (!root) return unavailableRepositoryProjection(project, projectNodeId, timestamp);

  const previous = previousRepositoryNodes(state, project.id);
  const scan = await scanRepository(root);
  const files = scan.files.slice(0, MAX_REPOSITORY_FILES);
  const report = repositoryScanReport(project, scan, files);
  const nodes = [];
  for (const file of files)
    nodes.push(await repositoryFileNode(project, projectNodeId, file, previous.get(file.relativePath), timestamp));
  return { nodes, manifestNode: repositoryManifestNode(project, projectNodeId, report, timestamp), report };
}

function unavailableRepositoryProjection(project, projectNodeId, timestamp) {
  const configured = project?.managed_workspace_state !== 'empty' && Boolean(project?.repo_path);
  const report = repositoryReport(project, {
    status: configured ? 'unavailable' : 'not_configured',
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
    manifestNode: configured ? repositoryManifestNode(project, projectNodeId, report, timestamp) : null,
    report
  };
}

function previousRepositoryNodes(state, projectId) {
  return new Map(
    state.context_nodes
      .filter((node) => node.resource?.adapter === REPOSITORY_ADAPTER && String(node.project_id) === String(projectId))
      .map((node) => [node.resource.relative_path, node])
  );
}

async function scanRepository(root) {
  const scan = {
    files: [],
    excludedSensitive: 0,
    excludedSymlinks: 0,
    ignoredDirectories: 0,
    unreadableDirectories: 0
  };
  await walkRepository(root, '', scan);
  scan.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return scan;
}

function repositoryScanReport(project, scan, files) {
  return repositoryReport(project, {
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
}

async function repositoryFileNode(project, projectNodeId, file, prior, timestamp) {
  const sha256 = await repositoryFileHash(file, prior);
  const mediaType = resourcePath.mediaTypeFor(file.relativePath);
  const binary = file.manifestOnly || resourcePath.isBinaryMediaType(mediaType);
  const id = contextNodeId('repository_files', `${project.id}:${file.relativePath}`);
  const resource = repositoryFileResource(project.id, file, sha256, mediaType, binary);
  const sourceHash = repositoryFileSourceHash(file, sha256, mediaType);
  return {
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
    deterministic_summary: `${file.relativePath} 的仓库${repositoryProjectionKind(file, binary)}投影。`,
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
  };
}

async function repositoryFileHash(file, prior) {
  if (file.manifestOnly) return null;
  const priorResource = prior?.resource;
  const unchanged =
    priorResource?.sha256 &&
    Number(priorResource.size_bytes) === file.stat.size &&
    Number(priorResource.mtime_ms) === file.stat.mtimeMs &&
    Number(priorResource.ctime_ms) === file.stat.ctimeMs;
  if (unchanged) return priorResource.sha256;
  return contextHash(await fsp.readFile(file.fullPath));
}

function repositoryFileResource(projectId, file, sha256, mediaType, binary) {
  return {
    adapter: REPOSITORY_ADAPTER,
    project_id: String(projectId),
    relative_path: file.relativePath,
    sha256,
    size_bytes: file.stat.size,
    mtime_ms: file.stat.mtimeMs,
    ctime_ms: file.stat.ctimeMs,
    media_type: mediaType,
    binary,
    manifest_only: file.manifestOnly,
    description: repositoryFileDescription(file, binary)
  };
}

function repositoryFileDescription(file, binary) {
  if (file.manifestOnly) return '文件超过内容读取上限，仅投影元数据清单。';
  return binary ? '仓库二进制文件，仅投影清单。' : '仓库文本文件，只读投影。';
}

function repositoryProjectionKind(file, binary) {
  if (file.manifestOnly) return '元数据清单';
  return binary ? '二进制清单' : '文本';
}

function repositoryFileSourceHash(file, sha256, mediaType) {
  return contextHash({
    adapter: REPOSITORY_ADAPTER,
    sha256,
    size_bytes: file.stat.size,
    media_type: mediaType,
    manifest_only: file.manifestOnly,
    ...(file.manifestOnly ? { mtime_ms: file.stat.mtimeMs, ctime_ms: file.stat.ctimeMs } : {})
  });
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
  const manifest = staticResourceManifest(node);
  if (manifest.matched) return manifest.value;
  if (node.resource?.adapter !== REPOSITORY_ADAPTER)
    throw resourcePath.resourceError('context_resource_adapter_unknown');
  return resolveRepositoryResourceNode(state, node);
}

function staticResourceManifest(node) {
  const adapters = [RUNTIME_ADAPTER, BROWSER_ADAPTER, REPOSITORY_MANIFEST_ADAPTER];
  return adapters.includes(node.resource?.adapter)
    ? { matched: true, value: node.resource.manifest }
    : { matched: false, value: null };
}

async function resolveRepositoryResourceNode(state, node) {
  const project = (state.projects || []).find((item) => String(item.id) === String(node.project_id));
  const root = await repositoryRoot(project);
  if (!root) throw resourcePath.resourceError('context_repository_unavailable');
  const file = resourcePath.resolveWithin(root, node.resource.relative_path);
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw resourcePath.resourceError('context_repository_file_unavailable');
  if (node.resource.manifest_only) return resolveRepositoryManifest(node, stat);
  const bytes = await fsp.readFile(file);
  if (contextHash(bytes) !== node.resource.sha256 || bytes.length !== Number(node.resource.size_bytes))
    throw resourcePath.resourceError('context_resource_source_changed');
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

function resolveRepositoryManifest(node, stat) {
  const unchanged =
    stat.size === Number(node.resource.size_bytes) &&
    stat.mtimeMs === Number(node.resource.mtime_ms) &&
    stat.ctimeMs === Number(node.resource.ctime_ms);
  if (!unchanged) throw resourcePath.resourceError('context_resource_source_changed');
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

async function attachFileContent(record, file, { allowedRoot, expectedSha256, mediaType }) {
  const safeFile = resourcePath.resolveExistingWithin(allowedRoot, file);
  const bytes = await fsp.readFile(safeFile).catch(() => {
    throw resourcePath.resourceError('context_resource_file_unavailable');
  });
  if (expectedSha256 && contextHash(bytes) !== expectedSha256)
    throw resourcePath.resourceError('context_resource_hash_mismatch');
  return attachBytes(record, bytes, mediaType);
}

function attachBytes(record, bytes, mediaType = 'application/octet-stream') {
  const normalizedMediaType = String(mediaType || 'application/octet-stream')
    .split(';')[0]
    .toLowerCase();
  const binary = resourcePath.isBinaryMediaType(normalizedMediaType) || bytes.includes(0);
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
  const directory = relative ? resourcePath.resolveWithin(root, relative) : root;
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
    if (!resourcePath.safeRepositoryRelativePath(childRelative)) {
      scan.excludedSensitive += 1;
      continue;
    }
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) scan.ignoredDirectories += 1;
      else await walkRepository(root, childRelative, scan);
      continue;
    }
    if (!entry.isFile()) continue;
    const fullPath = resourcePath.resolveWithin(root, childRelative);
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
