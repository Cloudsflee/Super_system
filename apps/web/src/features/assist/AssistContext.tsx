import { createContext, useContext, type ReactNode } from 'react';
import type { AssistController } from './useAssistController';

const AssistControllerContext = createContext<AssistController | null>(null);

export function AssistControllerProvider({
  controller,
  children
}: {
  controller: AssistController;
  children: ReactNode;
}) {
  return <AssistControllerContext.Provider value={controller}>{children}</AssistControllerContext.Provider>;
}

export function useAssistCenter() {
  const controller = useContext(AssistControllerContext);
  if (!controller) throw new Error('AssistCenter is missing from the application shell.');
  return controller;
}

export function useOptionalAssistCenter() {
  return useContext(AssistControllerContext);
}
