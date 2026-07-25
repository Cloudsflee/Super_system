import { Check, Copy, MessageCircleQuestion, MousePointer2, Scissors, Sparkles } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useUi } from '../../state/ui';
import { publishSelectionAsk } from './selection-ask';

export type ContextMenuAction = { id: string; label: string; icon?: typeof Copy; disabled?: boolean; danger?: boolean; separator?: boolean; onSelect: () => void | Promise<void> };
export type ContextMenuResolver = (context: ContextMenuTarget) => ContextMenuAction[];
export type ContextMenuTarget = { target: HTMLElement; selection: string; selectionRect: DOMRect | null; sensitive: boolean };
type Point = { x: number; y: number };
type ContextValue = { open: (actions: ContextMenuAction[], point: Point, target?: HTMLElement | null) => void; register: (resolver: ContextMenuResolver) => () => void };

const ContextMenuContext = createContext<ContextValue | null>(null);
const fallbackContext: ContextValue = { open: () => undefined, register: () => () => undefined };

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ actions: ContextMenuAction[]; point: Point } | null>(null);
  const resolvers = useRef(new Set<ContextMenuResolver>()), restoreFocus = useRef<HTMLElement | null>(null), menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setMenu(null); queueMicrotask(() => restoreFocus.current?.focus({ preventScroll: true })); }, []);
  const open = useCallback((actions: ContextMenuAction[], point: Point, target?: HTMLElement | null) => {
    if (!actions.length) return;
    restoreFocus.current = target || document.activeElement as HTMLElement | null;
    setMenu({ actions, point: clampPoint(point) });
  }, []);
  const register = useCallback((resolver: ContextMenuResolver) => { resolvers.current.add(resolver); return () => { resolvers.current.delete(resolver); }; }, []);

  useEffect(() => {
    const contextMenu = (event: MouseEvent) => {
      if (event.shiftKey) return;
      const target = event.target instanceof HTMLElement ? event.target : document.body;
      const context = menuTarget(target);
      const actions = [...resolvers.current].flatMap((resolver) => resolver(context));
      actions.push(...defaultActions(context));
      event.preventDefault(); open(uniqueActions(actions), { x: event.clientX, y: event.clientY }, target);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu) { event.preventDefault(); close(); return; }
      if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
      const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body, rect = target.getBoundingClientRect(), context = menuTarget(target);
      event.preventDefault(); open(uniqueActions([...resolvers.current].flatMap((resolver) => resolver(context)).concat(defaultActions(context))), { x: rect.left + Math.min(20, rect.width / 2), y: rect.top + Math.min(20, rect.height / 2) }, target);
    };
    const pointer = (event: PointerEvent) => { if (menu && !menuRef.current?.contains(event.target as Node)) close(); };
    window.addEventListener('contextmenu', contextMenu); window.addEventListener('keydown', keyboard, true); window.addEventListener('pointerdown', pointer);
    return () => { window.removeEventListener('contextmenu', contextMenu); window.removeEventListener('keydown', keyboard, true); window.removeEventListener('pointerdown', pointer); };
  }, [close, menu, open]);
  useEffect(() => { if (menu) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()); }, [menu]);
  const value = useMemo(() => ({ open, register }), [open, register]);
  return <ContextMenuContext.Provider value={value}>{children}{menu && <div ref={menuRef} className="context-menu" role="menu" aria-label="上下文菜单" style={{ left: menu.point.x, top: menu.point.y }} onKeyDown={(event) => navigateMenu(event, close)}>
    {menu.actions.map((action) => action.separator ? <hr key={action.id} /> : <button key={action.id} type="button" role="menuitem" disabled={action.disabled} className={action.danger ? 'danger' : ''} onClick={() => { close(); void action.onSelect(); }}>{action.icon && <action.icon size={15} />}<span>{action.label}</span>{action.disabled && <small>不可用</small>}</button>)}
  </div>}</ContextMenuContext.Provider>;
}

export function useContextMenu() { return useContext(ContextMenuContext) || fallbackContext; }
export function useContextMenuResolver(resolver: ContextMenuResolver) { const menu = useContextMenu(); useEffect(() => menu.register(resolver), [menu, resolver]); }

function defaultActions(context: ContextMenuTarget) {
  const actions: ContextMenuAction[] = [];
  if (context.selection && !context.sensitive) actions.push({ id: 'selection.ask', label: '询问智能助手', icon: Sparkles, onSelect: () => askSelection(context) }, { id: 'selection.copy', label: '复制选区', icon: Copy, onSelect: () => copyText(context.selection) });
  const editable = editableTarget(context.target);
  if (editable && !isPassword(editable)) actions.push(
    { id: 'input.cut', label: '剪切', icon: Scissors, onSelect: () => editCommand(editable, 'cut') },
    { id: 'input.copy', label: '复制', icon: Copy, onSelect: () => editCommand(editable, 'copy') },
    { id: 'input.paste', label: '粘贴', icon: MessageCircleQuestion, onSelect: () => pasteInto(editable) },
    { id: 'input.select-all', label: '全选', icon: Check, onSelect: () => selectAll(editable) }
  );
  actions.push({ id: 'page.assist', label: '打开智能助手', icon: MousePointer2, onSelect: () => useUi.getState().setAssist(true) }, { id: 'page.copy-link', label: '复制页面链接', icon: Copy, onSelect: () => copyText(window.location.href) });
  return actions;
}
function menuTarget(target: HTMLElement): ContextMenuTarget {
  const selection = window.getSelection(), text = selection?.toString().trim().slice(0, 20_000) || '', range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const sensitive = [target, nodeElement(selection?.anchorNode), nodeElement(selection?.focusNode), nodeElement(range?.commonAncestorContainer)].some((item) => item?.closest('input[type="password"], [data-sensitive="true"], [data-secret="true"]'));
  return { target, selection: text, selectionRect: range && typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null, sensitive: Boolean(sensitive) };
}
function nodeElement(value: Node | null | undefined) { return value instanceof HTMLElement ? value : value?.parentElement || null; }
function askSelection(context: ContextMenuTarget) { useUi.getState().setAssist(true); publishSelectionAsk({ selection: context.selection, rect: context.selectionRect ? { left: context.selectionRect.left, top: context.selectionRect.top, bottom: context.selectionRect.bottom, width: context.selectionRect.width } : null, pageUrl: window.location.href }); }
function editableTarget(target: HTMLElement) { return target.closest('input, textarea, [contenteditable="true"]') as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null; }
function isPassword(target: HTMLElement) { return target instanceof HTMLInputElement && target.type === 'password'; }
function editCommand(target: HTMLElement, command: 'cut' | 'copy') { target.focus(); document.execCommand(command); }
async function pasteInto(target: HTMLElement) { const text = await navigator.clipboard.readText(); if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) { target.setRangeText(text, target.selectionStart || 0, target.selectionEnd || 0, 'end'); target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text })); } else { target.focus(); document.execCommand('insertText', false, text); } }
function selectAll(target: HTMLElement) { target.focus(); if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.select(); else { const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(target); selection?.removeAllRanges(); selection?.addRange(range); } }
function copyText(value: string) { return navigator.clipboard.writeText(value); }
function uniqueActions(actions: ContextMenuAction[]) { const seen = new Set<string>(); return actions.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id))); }
function clampPoint(point: Point) { return { x: Math.max(8, Math.min(point.x, window.innerWidth - 230)), y: Math.max(8, Math.min(point.y, window.innerHeight - 310)) }; }
function navigateMenu(event: React.KeyboardEvent<HTMLDivElement>, close: () => void) {
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[next]?.focus(); }
  else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); }
}
