/**
 * Stable Desktop relay identity persistence with an explicit storage boundary.
 * Local MCP rows and filesystem access grants bind to this id, so it must remain
 * stable across launches without crossing an Electron profile boundary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface ResolvePersistedRelayIdOptions {
  identityFilePath: string;
  /** One-shot compatibility source for the default Desktop tuple only. */
  legacyIdentityFilePath?: string | undefined;
  uuid?: (() => string) | undefined;
}

export function readPersistedRelayId(identityFilePath: string): string | null {
  try {
    const existing = fs.readFileSync(identityFilePath, "utf8").trim();
    return existing.length > 0 ? existing : null;
  } catch {
    return null;
  }
}

export function resolvePersistedRelayId(options: ResolvePersistedRelayIdOptions): string {
  const existing = readPersistedRelayId(options.identityFilePath);
  if (existing) return existing;

  const migrated = options.legacyIdentityFilePath
    ? readPersistedRelayId(options.legacyIdentityFilePath)
    : null;
  const id = migrated ?? (options.uuid ?? randomUUID)();
  try {
    fs.mkdirSync(path.dirname(options.identityFilePath), { recursive: true });
    fs.writeFileSync(options.identityFilePath, id, { mode: 0o600 });
  } catch {
    // Best-effort; use the session id if the tuple directory isn't writable.
  }
  return id;
}
