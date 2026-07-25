import { Container, Laptop, Monitor, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { TerminalCapabilities } from '../../api/types';
import { runtimeUnavailableReasonLabel } from '../../components/common/display-labels';

export function TerminalRuntimeSelector({
  capabilities,
  onClose,
  onSelect
}: {
  capabilities?: TerminalCapabilities;
  onClose: () => void;
  onSelect: (value: 'linux_container' | 'windows_bridge' | 'host_dev') => void;
}) {
  const values = [
    { id: 'linux_container' as const, label: 'Linux 容器', icon: Container, data: capabilities?.linux_container },
    { id: 'windows_bridge' as const, label: 'Windows 本机', icon: Monitor, data: capabilities?.windows_bridge },
    { id: 'host_dev' as const, label: '宿主机开发环境', icon: Laptop, data: capabilities?.host_dev }
  ];
  const dialog = useRef<HTMLElement>(null),
    runtimeButtons = useRef<Array<HTMLButtonElement | null>>([]),
    returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (
      runtimeButtons.current.find((item) => item && !item.disabled) ||
      dialog.current?.querySelector<HTMLButtonElement>('button')
    )?.focus();
    return () => {
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, []);
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [
      ...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')
    ];
    const first = focusable[0],
      last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  return (
    <div
      className="terminal-runtime-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="terminal-runtime-selector"
        role="dialog"
        aria-modal="true"
        aria-label="选择终端运行环境"
        onKeyDown={keyDown}
      >
        <header>
          <div>
            <strong>终端运行环境</strong>
            <small>命令行与智能助手共享当前变更批次</small>
          </div>
          <button aria-label="关闭运行环境选择器" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        {values.map(({ id, label, icon: Icon, data }, index) => (
          <button
            ref={(node) => {
              runtimeButtons.current[index] = node;
            }}
            key={id}
            disabled={!data?.available}
            onClick={() => onSelect(id)}
          >
            <Icon size={18} />
            <span>
              <strong>
                {label}
                {id === 'linux_container' ? ' · 默认' : ''}
              </strong>
              <small>{data?.available ? '可用' : runtimeUnavailableReasonLabel(data?.reason)}</small>
            </span>
          </button>
        ))}
      </section>
    </div>
  );
}
