import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Tooltip } from './Tooltip';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; active?: boolean };

export function IconButton({ label, children, active, className = '', ...props }: Props) {
  return <Tooltip label={label}>
    <button
      type="button"
      className={`icon-button ${active ? 'active' : ''} ${className}`}
      aria-label={label}
      {...props}
    >{children}</button>
  </Tooltip>;
}
