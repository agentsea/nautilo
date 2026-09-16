// D373 / Stack 137 — launch adapter for the terminal work surface.
// Mirrors `open-saas-app-ref.ts`: a module-level dispatcher the shell
// registers on mount, so any launcher (rail icon, command palette, a
// dev-console call, or a future agent hook) can request opening a
// terminal without importing the shell.

export interface OpenTerminalTarget {
  /** Attach to an existing session id; omit to spawn a fresh session. */
  sessionId?: string;
}

type OpenTerminalDispatcher = (target: OpenTerminalTarget) => void;

let dispatcher: OpenTerminalDispatcher | null = null;

export function setOpenTerminalDispatcher(fn: OpenTerminalDispatcher | null): void {
  dispatcher = fn;
}

export function requestOpenTerminal(target: OpenTerminalTarget = {}): boolean {
  if (!dispatcher) return false;
  dispatcher(target);
  return true;
}
