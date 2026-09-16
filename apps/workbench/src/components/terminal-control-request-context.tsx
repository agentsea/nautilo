import { createContext, useContext, type ReactNode } from "react";

export interface TerminalControlRequestState {
  sessionId: string | null;
  onApprove: () => void | Promise<void>;
  onDeny: () => void | Promise<void>;
  onOpenTerminal: () => void;
}

const TerminalControlRequestContext = createContext<TerminalControlRequestState | null>(null);

export function TerminalControlRequestProvider({
  value,
  children,
}: {
  value: TerminalControlRequestState;
  children: ReactNode;
}) {
  return (
    <TerminalControlRequestContext.Provider value={value}>
      {children}
    </TerminalControlRequestContext.Provider>
  );
}

export function useTerminalControlRequest(): TerminalControlRequestState | null {
  return useContext(TerminalControlRequestContext);
}
