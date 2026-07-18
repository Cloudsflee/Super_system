import path from 'node:path';
import { spawn } from 'node:child_process';
import { id } from '../../../packages/shared/index.mjs';
import { ROOT } from './config.mjs';
import { codexContainerProxyEnv } from './codex-container-network.mjs';
import { DEFAULT_RUNNER_IMAGE, isContainerized } from './container-runtime-config.mjs';
import { inspectCodexRuntimeCached, invalidateCodexRuntimeCache } from './codex-runtime-status.mjs';
import { buildFailure, buildPhase, classifyBuildFailure, sanitizeBuildLog } from './codex-build-domain.mjs';
export { classifyBuildFailure, sanitizeBuildLog } from './codex-build-domain.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class CodexBuildManager {
  constructor(options = {}) {
    this.spawnProcess = options.spawnProcess || spawn; this.killProcessTree = options.killProcessTree || killProcessTree;
    this.buildCommand = options.buildCommand || 'docker';
    this.buildArgsPrefix = options.buildArgsPrefix || [];
    this.inspectRuntime = options.inspectRuntime || ((input) => inspectCodexRuntimeCached(input));
    this.invalidateRuntime = options.invalidateRuntime || invalidateCodexRuntimeCache;
    this.onTerminal = options.onTerminal || (async () => undefined);
    this.containerized = options.containerized || isContainerized;
    this.proxyEnv = options.proxyEnv || codexContainerProxyEnv;
    this.root = options.root || ROOT;
    this.dockerfile = options.dockerfile || path.join(this.root, 'docker', 'codex-runner.Dockerfile');
    this.timeoutMs = Number(options.timeoutMs || 600_000);
    this.forceKillMs = Number(options.forceKillMs || 5_000);
    this.maxLogLines = Number(options.maxLogLines || 200);
    this.maxLogBytes = Number(options.maxLogBytes || 64 * 1024);
    this.operations = new Map();
    this.activeByImage = new Map();
  }

  async ensure({ image = process.env.AIWS_CODEX_DOCKER_IMAGE || DEFAULT_RUNNER_IMAGE } = {}) {
    const existing = this.activeByImage.get(image);
    if (existing && existing.status === 'running') return { immediate: false, attached: true, operation: this.snapshot(existing) };
    const runtime = await this.inspectRuntime({ image, maxAgeMs: 1500 });
    if (runtime.ready) return { immediate: true, runtime };
    const raced = this.activeByImage.get(image);
    if (raced && raced.status === 'running') return { immediate: false, attached: true, operation: this.snapshot(raced) };
    const operation = this.#create(image, runtime);
    this.operations.set(operation.id, operation);
    this.activeByImage.set(image, operation);
    queueMicrotask(() => { void this.#run(operation); });
    return { immediate: false, attached: false, operation: this.snapshot(operation) };
  }

  get(idValue) { const operation = this.operations.get(idValue); return operation ? this.snapshot(operation) : null; }
  getActive(image) {
    if (image) { const operation = this.activeByImage.get(image); return operation?.status === 'running' ? this.snapshot(operation) : null; }
    const operation = [...this.activeByImage.values()].find((item) => item.status === 'running');
    return operation ? this.snapshot(operation) : null;
  }

  cancel(idValue) {
    const operation = this.operations.get(idValue);
    if (!operation) return null;
    if (TERMINAL.has(operation.status)) return this.snapshot(operation);
    operation.stopReason = 'cancelled';
    operation.updatedAt = Date.now();
    this.#emit(operation, 'phase', { ...operation.phase, message: '正在取消构建' });
    this.#stopChild(operation);
    return this.snapshot(operation);
  }

  shutdown() {
    for (const operation of this.activeByImage.values()) {
      if (operation.status !== 'running') continue;
      operation.stopReason = 'cancelled';
      this.#stopChild(operation);
    }
  }

  eventsSince(idValue, after = 0) {
    const operation = this.operations.get(idValue);
    if (!operation) return null;
    const first = operation.events[0]?.id || operation.nextEventId;
    return { gap: after > 0 && after < first - 1, events: operation.events.filter((event) => event.id > after), snapshot: this.snapshot(operation) };
  }

  subscribe(idValue, listener) {
    const operation = this.operations.get(idValue);
    if (!operation) return null;
    operation.listeners.add(listener);
    return () => operation.listeners.delete(listener);
  }

  snapshot(operation) {
    return {
      operation_id: operation.id,
      image: operation.image,
      status: operation.status,
      phase: { ...operation.phase },
      started_at: new Date(operation.startedAt).toISOString(),
      updated_at: new Date(operation.updatedAt).toISOString(),
      completed_at: operation.completedAt ? new Date(operation.completedAt).toISOString() : null,
      elapsed_ms: (operation.completedAt || Date.now()) - operation.startedAt,
      error_code: operation.errorCode,
      message: operation.message,
      action: operation.action,
      retryable: operation.retryable,
      latest_log: operation.logs.at(-1)?.text || '',
      logs: operation.logs.map(({ at, stream, text }) => ({ at, stream, text })),
      last_event_id: operation.nextEventId - 1
    };
  }

  #create(image, runtime) {
    const startedAt = Date.now();
    return {
      id: id('cdxbuild'), image, status: 'running', phase: buildPhase(0), startedAt, updatedAt: startedAt, completedAt: null,
      errorCode: null, message: '正在检查 Docker 运行时', action: null, retryable: false, runtime,
      logs: [], logBytes: 0, events: [], nextEventId: 1, listeners: new Set(), child: null, forceTimer: null,
      finishBuild: null, stopReason: null, streamBuffers: { stdout: '', stderr: '' }
    };
  }

  async #run(operation) {
    try {
      this.#setPhase(operation, 0, '正在检查 Docker 引擎和目标镜像');
      if (operation.stopReason === 'cancelled') return this.#cancelled(operation);
      if (!operation.runtime?.docker?.ok) return this.#fail(operation, buildFailure('docker_unavailable'));
      if (this.containerized()) return this.#fail(operation, buildFailure('docker_image_missing_in_deployment'));

      this.#setPhase(operation, 1, '正在准备 Docker Build 参数');
      const proxy = this.proxyEnv(process.env);
      const args = ['build', '--progress=plain'];
      for (const key of Object.keys(proxy)) args.push('--build-arg', key);
      args.push('-f', this.dockerfile, '-t', operation.image, '.');
      if (operation.stopReason === 'cancelled') return this.#cancelled(operation);

      this.#setPhase(operation, 2, 'Docker Build 正在运行');
      const result = await this.#spawnBuild(operation, args, proxy);
      if (operation.stopReason === 'cancelled') return this.#cancelled(operation);
      if (operation.stopReason === 'timeout') return this.#fail(operation, buildFailure('docker_build_timeout'));
      if (result.error || result.code !== 0) return this.#fail(operation, classifyBuildFailure(`${result.error || ''}\n${operation.logs.map((item) => item.text).join('\n')}`));

      this.#setPhase(operation, 3, '正在确认镜像可以被 Docker 读取');
      this.invalidateRuntime(operation.image);
      const runtime = await this.inspectRuntime({ image: operation.image, force: true, maxAgeMs: 0 });
      operation.runtime = runtime;
      if (!runtime.ready) return this.#fail(operation, buildFailure('docker_image_verification_failed'));
      await this.#complete(operation);
    } catch (error) {
      this.#appendLog(operation, 'stderr', error?.message || String(error));
      await this.#fail(operation, classifyBuildFailure(error?.message || String(error)));
    }
  }

  #spawnBuild(operation, args, proxy) {
    return new Promise((resolve) => {
      let settled = false, timeout = null;
      const finish = (value) => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(operation.forceTimer); operation.child = null; operation.finishBuild = null; this.#flushStreams(operation); resolve(value); };
      operation.finishBuild = finish;
      try {
        operation.child = this.spawnProcess(this.buildCommand, [...this.buildArgsPrefix, ...args], { cwd: this.root, env: { ...process.env, ...proxy }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { finish({ code: null, error: error.message }); return; }
      for (const stream of ['stdout', 'stderr']) operation.child[stream]?.on('data', (chunk) => this.#consumeChunk(operation, stream, chunk));
      operation.child.once('error', (error) => finish({ code: null, error: error.message }));
      operation.child.once('close', (code, signal) => finish({ code, signal, error: null }));
      timeout = setTimeout(() => { operation.stopReason = 'timeout'; operation.updatedAt = Date.now(); this.#emit(operation, 'phase', { ...operation.phase, message: '构建已超时，正在终止 Docker Build' }); this.#stopChild(operation); }, this.timeoutMs);
      timeout.unref?.();
    });
  }

  #stopChild(operation) {
    if (!operation.child) return;
    this.killProcessTree(operation.child, false);
    clearTimeout(operation.forceTimer);
    operation.forceTimer = setTimeout(() => { if (operation.child) this.killProcessTree(operation.child, true); operation.finishBuild?.({ code: null, signal: 'SIGKILL', error: null }); }, this.forceKillMs);
    operation.forceTimer.unref?.();
  }

  #consumeChunk(operation, stream, chunk) {
    let combined = `${operation.streamBuffers[stream]}${String(chunk)}`;
    while (combined.length > 8192 && !/[\r\n]/.test(combined.slice(0, 4097))) {
      this.#appendLog(operation, stream, combined.slice(0, 4096));
      combined = combined.slice(4096);
    }
    const lines = combined.split(/\r?\n/);
    operation.streamBuffers[stream] = lines.pop() || '';
    for (const line of lines) this.#appendLog(operation, stream, line);
  }

  #flushStreams(operation) {
    for (const stream of ['stdout', 'stderr']) {
      if (operation.streamBuffers[stream]) this.#appendLog(operation, stream, operation.streamBuffers[stream]);
      operation.streamBuffers[stream] = '';
    }
  }

  #appendLog(operation, stream, raw) {
    const text = sanitizeBuildLog(raw).slice(0, 4096);
    if (!text) return;
    const item = { at: new Date().toISOString(), stream, text };
    const bytes = Buffer.byteLength(text, 'utf8');
    operation.logs.push(item); operation.logBytes += bytes;
    while (operation.logs.length > this.maxLogLines || operation.logBytes > this.maxLogBytes) {
      const removed = operation.logs.shift(); operation.logBytes -= Buffer.byteLength(removed.text, 'utf8');
      const eventIndex = operation.events.findIndex((event) => event.type === 'log');
      if (eventIndex >= 0) operation.events.splice(eventIndex, 1);
    }
    this.#emit(operation, 'log', item);
  }

  #setPhase(operation, index, message) {
    operation.phase = buildPhase(index); operation.message = message; operation.updatedAt = Date.now();
    this.#emit(operation, 'phase', { ...operation.phase, message });
  }

  async #complete(operation) {
    this.#setPhase(operation, 4, 'Codex 隔离镜像已构建并验证');
    operation.status = 'completed'; operation.completedAt = operation.updatedAt = Date.now();
    await this.#terminal(operation);
    this.#emit(operation, 'completed', this.snapshot(operation));
  }

  async #cancelled(operation) {
    operation.status = 'cancelled'; operation.errorCode = 'docker_build_cancelled'; operation.message = 'Codex 镜像构建已取消'; operation.action = '可以重新开始构建。'; operation.retryable = true; operation.completedAt = operation.updatedAt = Date.now();
    await this.#terminal(operation);
    this.#emit(operation, 'cancelled', this.snapshot(operation));
  }

  async #fail(operation, failure) {
    operation.status = 'failed'; operation.errorCode = failure.error_code; operation.message = failure.message; operation.action = failure.action; operation.retryable = failure.retryable; operation.completedAt = operation.updatedAt = Date.now();
    await this.#terminal(operation);
    this.#emit(operation, 'failed', this.snapshot(operation));
  }

  async #terminal(operation) {
    clearTimeout(operation.forceTimer);
    if (this.activeByImage.get(operation.image) === operation) this.activeByImage.delete(operation.image);
    try { await this.onTerminal(this.snapshot(operation), operation.runtime); }
    catch (error) { this.#appendLog(operation, 'stderr', `状态更新失败: ${error?.message || error}`); }
    this.#prune();
  }

  #emit(operation, type, data) {
    const event = { id: operation.nextEventId++, type, at: new Date().toISOString(), data };
    operation.events.push(event);
    if (operation.events.length > 260) operation.events.splice(0, operation.events.length - 260);
    for (const listener of operation.listeners) listener(event);
  }

  #prune() {
    const completed = [...this.operations.values()].filter((item) => TERMINAL.has(item.status)).sort((left, right) => right.completedAt - left.completedAt);
    for (const operation of completed.slice(20)) this.operations.delete(operation.id);
  }
}

function killProcessTree(child, force) { const signal = force ? 'SIGKILL' : 'SIGTERM';
  if (process.platform === 'win32' && Number.isInteger(child?.pid)) try {
    const args = ['/pid', String(child.pid), '/T', '/F'];
    const killer = spawn('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' }); const fallback = () => { try { child.kill(signal); } catch { /* Process already exited. */ } };
    killer.once('error', fallback); killer.once('exit', (code) => { if (code) fallback(); }); killer.unref?.(); return true;
  } catch { /* Fall through to the ChildProcess API. */ }
  try { return child.kill(signal); } catch { return false; }
}
