import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const RouteToolbarContext = createContext<HTMLElement | null | undefined>(undefined);

export function RouteToolbarHostProvider({ host, children }: { host: HTMLElement | null; children: ReactNode }) {
  return <RouteToolbarContext.Provider value={host}>{children}</RouteToolbarContext.Provider>;
}

export function RouteToolbarPortal({ children }: { children: ReactNode }) {
  const host = useContext(RouteToolbarContext);
  if (host === undefined) return <div className="route-toolbar-fallback">{children}</div>;
  return host ? createPortal(children, host) : null;
}
