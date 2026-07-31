import { MapPin, MessageSquareMore, Pencil, RotateCcw } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';
import type { AssistOperation } from '../../api/types';
import { useContextMenu, useContextMenuResolver, type ContextMenuAction } from '../../components/common/ContextMenu';

type OperationMenuOptions = {
  operation: AssistOperation;
  busy: boolean;
  onUndo: (force?: boolean) => void;
  onRevise: () => void;
  onContinue: () => void;
};

export function useOperationReceiptMenu(options: OperationMenuOptions) {
  const menu = useContextMenu(),
    more = useRef<HTMLButtonElement>(null),
    menuActions = useMemo(() => buildMenuActions(options), [options]);
  useContextMenuResolver(
    useCallback(
      (context) =>
        context.target.closest<HTMLElement>('[data-operation-receipt]')?.dataset.operationReceipt ===
        options.operation.id
          ? menuActions
          : [],
      [menuActions, options.operation.id]
    )
  );
  const openMenu = () => {
    const trigger = more.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    menu.open(menuActions, { x: rect.right - 8, y: rect.bottom + 5 }, trigger);
  };
  return { menuActions, more, openMenu };
}

function buildMenuActions({ operation, busy, onUndo, onRevise, onContinue }: OperationMenuOptions) {
  const actions: ContextMenuAction[] = [];
  if (operation.result_kind === 'change_proposal' || operation.status === 'committed')
    actions.push({
      id: `operation.${operation.id}.locate`,
      label: operation.result_kind === 'change_proposal' ? '定位工作流' : '定位操作',
      icon: MapPin,
      onSelect: () => navigateTo(locatedRoute(operation))
    });
  if (operation.status === 'committed' && !operation.inverse_of) {
    actions.push(
      { id: `operation.${operation.id}.revise`, label: '直接编辑', icon: Pencil, disabled: busy, onSelect: onRevise },
      {
        id: `operation.${operation.id}.continue`,
        label: '让智能助手继续修改',
        icon: MessageSquareMore,
        disabled: busy,
        onSelect: onContinue
      }
    );
    if (!operation.undone_by)
      actions.push({
        id: `operation.${operation.id}.undo`,
        label: '撤销',
        icon: RotateCcw,
        disabled: busy,
        onSelect: () => onUndo(false)
      });
  }
  return actions;
}

export function localRoute(value: string) {
  return /^\/(?!\/)/.test(value) ? value : '/';
}

export function locatedRoute(operation: AssistOperation) {
  const route = localRoute(operation.locator?.route || operation.route),
    target = operation.locator?.target_id || operation.target_id;
  return target ? `${route}#${encodeURIComponent(target)}` : route;
}

function navigateTo(route: string) {
  window.history.pushState({}, '', route);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
