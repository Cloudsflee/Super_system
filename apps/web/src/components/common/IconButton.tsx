import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; active?: boolean };

export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton({ label, children, active, className = '', ...props }, ref) {
  return <Tooltip label={label}>
    <button
      ref={ref}
      type="button"
      className={`icon-button ${active ? 'active' : ''} ${className}`}
      aria-label={label}
      {...props}
    >{children}</button>
  </Tooltip>;
});
