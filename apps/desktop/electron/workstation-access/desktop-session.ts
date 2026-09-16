/**
 * D418 foundation — per Electron main-process-launch desktop session identity.
 *
 * One `desktopSessionId` is minted per main-process launch and reused for the
 * lifetime of the process. It is the stable identity the desktop relay binds
 * to its advertised capability state: the server accepts
 * `relay:update-capabilities` only for the exact `desktopSessionId` presented
 * at `relay:register`, so a stable id lets capability updates survive relay
 * reconnects (D340 Current Folder refresh, token re-pair, transient drops)
 * without re-minting and losing the session association.
 *
 * Generation lives here — NOT inside `startRelay` — so reconnecting the relay
 * never manufactures a new session id. `mintDesktopSessionId()` is idempotent:
 * the first call mints, subsequent calls return the same id. The relay calls
 * it during `startRelay`; reconnects call it again and receive the same value.
 */

import { randomUUID } from "node:crypto";

let desktopSessionId: string | null = null;

/**
 * Mint the per-launch desktop session id on first call, then return it for
 * every subsequent call. The id is a UUID v4 string.
 */
export function mintDesktopSessionId(): string {
  if (desktopSessionId === null) {
    desktopSessionId = randomUUID();
  }
  return desktopSessionId;
}

/**
 * Return the current desktop session id, or `null` before `mintDesktopSessionId`
 * has been called. The relay identity is not available until minted.
 */
export function getDesktopSessionId(): string | null {
  return desktopSessionId;
}

/**
 * Test-only reset so each test can simulate a fresh main-process launch. Not
 * part of the production surface; production code never resets the session id.
 */
export function resetDesktopSessionIdForTests(): void {
  desktopSessionId = null;
}
