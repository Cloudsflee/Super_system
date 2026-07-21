import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { api, json } from '../../api/client';
import type { AssistOperationExecution, UiAction } from '../../api/types';

type Writer = (value: unknown, args: Record<string, unknown>) => void | Promise<void>;
type Control = {
  label: string; read?: () => unknown | Promise<unknown>; write?: Writer; set?: Writer;
  normalize?: (value: unknown) => unknown; elementId?: string; allowedValues?: unknown[]; values?: unknown[];
  risk?: 'low' | 'high' | 'submit' | 'delete' | 'permission' | 'external'; sensitivity?: 'public' | 'private' | 'secret';
  persist?: () => void | Promise<void>; reversible?: boolean;
};
type TabControl = Control & { select?: () => void | Promise<void> };
export type AssistSurface = { id: string; revision?: string; repository_workspace_id?: string | null; fields?: Record<string, Control>; filters?: Record<string, Control>; tabs?: Record<string, TabControl> };

type RegisteredSurface = { key: symbol; get: () => AssistSurface; revision: string };
const surfaces = new Map<symbol, RegisteredSurface>();
let revisionSequence = 0;
let registryRevision = 0;

export function useAssistSurface(surface: AssistSurface) {
  const current = useRef(surface); current.current = surface;
  useEffect(() => {
    const key = Symbol(surface.id), registered = { key, get: () => current.current, revision: surface.revision || `${Date.now().toString(36)}-${++revisionSequence}` };
    surfaces.set(key, registered); registryRevision++;
    return () => { if (surfaces.delete(key)) registryRevision++; };
  }, [surface.id, surface.revision]);
}

export async function dispatchSemanticAction(action: UiAction) {
  const args = action.args || {}, target = targetId(action.name, args);
  const located = findControl(action.name === 'set_filter' ? 'filter' : action.name === 'switch_workspace_tab' ? 'tab' : 'field', target);
  if (!located) return { handled: false, error: 'semantic_target_not_available', action: action.name, target };
  const value = args.value;
  if (action.name === 'focus_field') { focus(located.control.elementId); return { handled: true, surface_id: located.surface.id, field_id: target }; }
  await writeControl(located.control, action.name === 'switch_workspace_tab' ? target : value, args);
  focus(located.control.elementId); return { handled: true, surface_id: located.surface.id, target_id: target };
}

export function describeAssistSurface() {
  const registered = [...surfaces.values()], primary = registered.at(-1), controls = registered.flatMap((item) => describeControls(item));
  return {
    id: primary?.get().id || 'empty', revision: registered.length > 1 ? `page-${registryRevision}` : primary?.revision || 'empty', browser_instance_id: browserInstanceId(),
    repository_workspace_id: primary?.get().repository_workspace_id || null,
    fields: controls.filter((item) => item.kind === 'field'), filters: controls.filter((item) => item.kind === 'filter'), tabs: controls.filter((item) => item.kind === 'tab'), controls
  };
}

export async function executeAssistOperation(operationId: string, route: string) {
  const surface = describeAssistSurface(), browser = surface.browser_instance_id;
  const locator = { browser_instance_id: browser, route, surface_id: surface.id, surface_revision: surface.revision };
  const execution = await api<AssistOperationExecution>(`/assist/v3/operations/${operationId}/claim`, json('POST', locator, { name: '认领 Assist 界面操作', feedback: 'background', timeoutMs: 120_000 }));
  if (window.location.pathname !== execution.route || route !== execution.route) return submitFailure(execution, browser, 'assist_operation_route_changed');
  const claimedSurface = describeAssistSurface();
  if (claimedSurface.id !== execution.surface_id || claimedSurface.revision !== execution.surface_revision) return submitFailure(execution, browser, 'assist_operation_surface_changed');
  const kind = execution.tool.endsWith('set_field') ? 'field' : execution.tool.endsWith('set_filter') ? 'filter' : 'tab';
  const executionTarget = kind === 'tab' ? String(execution.value ?? '') : execution.target_id;
  const located = findControl(kind, executionTarget);
  if (!located) return submitFailure(execution, browser, 'assist_operation_target_unavailable');
  const control = located.control;
  try {
    const before = normalize(control, await readControl(control));
    if (execution.expected_current_hash && !execution.forced) {
      // The authoritative canonical comparison is repeated by the server. This fast path
      // avoids a write only when the browser can prove a mismatch with WebCrypto.
      const currentHash = await canonicalHash(before);
      if (currentHash !== execution.expected_current_hash) return api(`/assist/v3/operations/${operationId}/result`, json('POST', { ...locator, ok: true, persisted: true, before, after: before, current: before, conflict: true }, { name: '同步 Assist 冲突结果', feedback: 'background', timeoutMs: 120_000 }));
    }
    await writeControlFlushed(control, execution.value, { operation_id: operationId, inverse_of: execution.inverse_of });
    await control.persist?.(); await persistedFrame();
    const current = findControl(kind, executionTarget);
    if (!current) return submitFailure(execution, browser, 'assist_operation_target_unavailable');
    const after = normalize(current.control, await readControl(current.control));
    return api(`/assist/v3/operations/${operationId}/result`, json('POST', { ...locator, ok: true, persisted: true, before, after, current: after }, { name: '同步 Assist 操作结果', feedback: 'background', timeoutMs: 120_000 }));
  } catch (error) { return submitFailure(execution, browser, (error as Error).message || 'assist_operation_browser_failed'); }
}

function describeControls(item: RegisteredSurface) {
  const surface = item.get();
  return ([['field', surface.fields], ['filter', surface.filters], ['tab', surface.tabs]] as const).flatMap(([kind, values]) => Object.entries(values || {}).flatMap(([id, control]) => {
    const readable = Boolean(control.read || readableElement(control.elementId));
    const writable = Boolean(control.write || control.set || (kind === 'tab' && (control as TabControl).select));
    if (!readable || !writable || control.sensitivity === 'secret' || control.reversible === false) return [];
    return [{ id, target_id: id, kind, capability_id: kind === 'field' ? 'surface.field.set' : kind === 'filter' ? 'surface.filter.set' : 'surface.tab.select', label: control.label, allowedValues: kind === 'tab' ? Object.keys(values || {}) : control.allowedValues || control.values, risk: control.risk || 'low', sensitivity: control.sensitivity || 'public', readable: true, reversible: true, surface: surface.id }];
  }));
}
function findControl(kind: string, target: string) { for (const registered of [...surfaces.values()].reverse()) { const surface = registered.get(), control = kind === 'field' ? surface.fields?.[target] : kind === 'filter' ? surface.filters?.[target] : surface.tabs?.[target]; if (control) return { surface, control, revision: registered.revision }; } return null; }
async function readControl(control: Control) { if (control.read) return control.read(); const element = readableElement(control.elementId); if (!element) throw new Error('assist_operation_before_unreadable'); if (element instanceof HTMLInputElement && element.type === 'checkbox') return element.checked; return element.value; }
async function writeControlFlushed(control: TabControl, value: unknown, args: Record<string, unknown>) { let pending: Promise<void> | undefined; flushSync(() => { pending = writeControl(control, value, args); }); await pending; flushSync(() => undefined); }
async function writeControl(control: TabControl, value: unknown, args: Record<string, unknown>) { const normalized = normalize(control, value); const allowed = control.allowedValues || control.values; if (allowed?.length && !allowed.some((item) => JSON.stringify(item) === JSON.stringify(normalized))) throw new Error('semantic_value_not_allowed'); if (control.write) await control.write(normalized, args); else if (control.set) await control.set(normalized, args); else if (control.select) await control.select(); else throw new Error('semantic_target_not_writable'); }
function normalize(control: Control, value: unknown) { return control.normalize ? control.normalize(value) : value; }
function readableElement(id?: string) { if (!id) return null; const element = document.getElementById(id); return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element : null; }
function targetId(name: string, args: Record<string, unknown>) { if (name === 'switch_workspace_tab') return String(args.tab || args.tab_id || ''); if (name === 'set_filter') return String(args.filter_id || args.filter || args.name || ''); return String(args.field_id || args.field || args.name || ''); }
function focus(id?: string) { if (id) window.setTimeout(() => document.getElementById(id)?.focus(), 0); }
function browserInstanceId() { const key = 'aiws-browser-instance-v1'; let value = sessionStorage.getItem(key); if (!value) { value = `browser-${crypto.randomUUID()}`; sessionStorage.setItem(key, value); } return value; }
async function submitFailure(execution: AssistOperationExecution, browser: string, error: string) { return api(`/assist/v3/operations/${execution.operation_id}/result`, json('POST', { browser_instance_id: browser, route: execution.route, surface_id: execution.surface_id, surface_revision: execution.surface_revision, ok: false, persisted: false, error }, { name: '同步 Assist 失败结果', feedback: 'background', timeoutMs: 120_000 })); }
function persistedFrame() { return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); }
async function canonicalHash(value: unknown) { const encoded = new TextEncoder().encode(canonicalJson(value)), digest = await crypto.subtle.digest('SHA-256', encoded); return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join(''); }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value) ?? 'null'; }
