import { CircleAlert, Info, X } from 'lucide-react';
import { useEffect } from 'react';
import { useUi } from '../../state/ui';

export function ToastHost() {
  const { toasts, dismissToast } = useUi();
  useEffect(() => {
    const timers = toasts.map((toast) => window.setTimeout(() => dismissToast(toast.id), 5000));
    return () => timers.forEach(window.clearTimeout);
  }, [toasts, dismissToast]);
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`toast ${toast.tone}`} key={toast.id}>
          {toast.tone === 'error' ? <CircleAlert size={17} /> : <Info size={17} />}
          <span>{toast.message}</span>
          <button aria-label="关闭通知" onClick={() => dismissToast(toast.id)}>
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
