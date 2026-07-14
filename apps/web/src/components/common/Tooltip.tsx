import { cloneElement, type ReactElement } from 'react';

export function Tooltip({ label, children }: { label: string; children: ReactElement<Record<string, unknown>> }) {
  return cloneElement(children, { 'data-tooltip': label, 'aria-label': children.props['aria-label'] || label });
}
