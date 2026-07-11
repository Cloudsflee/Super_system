import { useEffect, useRef } from 'react';
import type { UiAction } from '../../api/types';

type Setter = (value: unknown, args: Record<string, unknown>) => void;
type Control = { label: string; set: Setter; elementId?: string; values?: string[] };
export type AssistSurface = {
  id: string;
  fields?: Record<string, Control>;
  filters?: Record<string, Control>;
  tabs?: Record<string, { label: string; select: () => void }>;
};

const surfaces = new Map<symbol, () => AssistSurface>();

export function useAssistSurface(surface: AssistSurface) {
  const current = useRef(surface);
  current.current = surface;
  useEffect(() => {
    const key = Symbol(surface.id);
    surfaces.set(key, () => current.current);
    return () => { surfaces.delete(key); };
  }, [surface.id]);
}

export async function dispatchSemanticAction(action: UiAction) {
  const args = action.args || {};
  const target = targetId(action.name, args);
  for (const surface of [...surfaces.values()].reverse().map((get) => get())) {
    if (action.name === 'fill_field' || action.name === 'focus_field') {
      const control = surface.fields?.[target];
      if (!control) continue;
      if (action.name === 'fill_field') control.set(args.value, args);
      if (action.name === 'focus_field' && (!control.elementId || !document.getElementById(control.elementId))) return { handled: false, error: 'semantic_field_not_focusable', action: action.name, target };
      focus(control.elementId);
      return { handled: true, surface_id: surface.id, field_id: target };
    }
    if (action.name === 'set_filter') {
      const control = surface.filters?.[target];
      if (!control) continue;
      if (control.values && !control.values.includes(String(args.value))) return { handled: false, error: 'semantic_value_not_allowed', action: action.name, target, value: args.value };
      control.set(args.value, args);
      focus(control.elementId);
      return { handled: true, surface_id: surface.id, filter_id: target };
    }
    if (action.name === 'switch_workspace_tab') {
      const tab = surface.tabs?.[target];
      if (!tab) continue;
      tab.select();
      return { handled: true, surface_id: surface.id, tab: target };
    }
  }
  return { handled: false, error: 'semantic_target_not_available', action: action.name, target };
}

export function describeAssistSurface() {
  const values = [...surfaces.values()].map((get) => get());
  return {
    fields: describe(values, 'fields'),
    filters: describe(values, 'filters'),
    tabs: values.flatMap((surface) => Object.entries(surface.tabs || {}).map(([id, item]) => ({ id, label: item.label, surface: surface.id })))
  };
}

function describe(values: AssistSurface[], key: 'fields' | 'filters') {
  return values.flatMap((surface) => Object.entries(surface[key] || {}).map(([id, item]) => ({ id, label: item.label, values: item.values, surface: surface.id })));
}
function targetId(name: string, args: Record<string, unknown>) {
  if (name === 'switch_workspace_tab') return String(args.tab || args.tab_id || '');
  if (name === 'set_filter') return String(args.filter_id || args.filter || args.name || '');
  return String(args.field_id || args.field || args.name || '');
}
function focus(id?: string) { if (id) window.setTimeout(() => document.getElementById(id)?.focus(), 0); }
