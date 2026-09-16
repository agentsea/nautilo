import type { ClientSessionEventV1 } from "@nautilo/types";

let currentClientActionSessionId: string | null = null;

/** Retain only the server-minted id for the current authenticated socket. */
export function installClientActionSession(event: ClientSessionEventV1): void {
  currentClientActionSessionId = event.clientActionSessionId;
}

/** Clear before reconnect/server switch so an old socket cannot stamp a new request. */
export function clearClientActionSession(): void {
  currentClientActionSessionId = null;
}

/** Strip a caller-supplied id and stamp only the currently authenticated socket's id. */
export function withCurrentClientActionSession<T extends Record<string, unknown>>(
  body: T,
): Omit<T, "clientActionSessionId"> & { clientActionSessionId?: string } {
  const { clientActionSessionId: _callerSupplied, ...withoutCallerValue } = body;
  return currentClientActionSessionId
    ? { ...withoutCallerValue, clientActionSessionId: currentClientActionSessionId }
    : withoutCallerValue;
}
