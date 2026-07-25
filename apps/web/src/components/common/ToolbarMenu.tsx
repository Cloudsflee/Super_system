import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

type Props = {
  open: boolean;
  label: string;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  focusSelected?: boolean;
};

export function ToolbarMenu({ open, label, triggerRef, onClose, children, className = '', focusSelected = false }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const selector = focusSelected ? '[role="menuitemradio"][aria-checked="true"]' : menuItemSelector;
    queueMicrotask(() => (menuRef.current?.querySelector<HTMLElement>(selector) || menuRef.current?.querySelector<HTMLElement>(menuItemSelector))?.focus());
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) onClose();
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [focusSelected, onClose, open, triggerRef]);

  if (!open) return null;
  return <div ref={menuRef} className={`toolbar-menu ${className}`.trim()} role="menu" aria-label={label} onKeyDown={(event) => navigateMenu(event, onClose, triggerRef)}>{children}</div>;
}

const menuItemSelector = '[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled)';

function navigateMenu(event: KeyboardEvent<HTMLDivElement>, close: () => void, triggerRef: RefObject<HTMLElement | null>) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    queueMicrotask(() => triggerRef.current?.focus());
    return;
  }
  if (event.key === 'Tab') { close(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(menuItemSelector)];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}
