/**
 * Redacted post-completion browser marker.
 *
 * It exists only to make a hard refresh of the one-time recovery-code page
 * truthful. It is session-scoped, carries no capability or Human data, and is
 * consumed by the existing chosen terminal navigation.
 */
import type { OwnerClaimFinish } from "./owner-claim-machine";

export const OWNER_CLAIM_TERMINAL_STORAGE_KEY = "nautilo.ownerClaimTerminal.v1";

export interface OwnerClaimTerminalMarker {
  readonly schemaVersion: 1;
  readonly finish: OwnerClaimFinish;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(raw: string): OwnerClaimTerminalMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || value["schemaVersion"] !== 1
    || (value["finish"] !== "guide" && value["finish"] !== "product")) {
    return null;
  }
  return { schemaVersion: 1, finish: value["finish"] };
}

function sessionStore(): Storage | undefined {
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
}

export function readOwnerClaimTerminalMarker(): OwnerClaimTerminalMarker | null {
  try {
    const raw = sessionStore()?.getItem(OWNER_CLAIM_TERMINAL_STORAGE_KEY);
    if (!raw) return null;
    const marker = parse(raw);
    if (marker === null) clearOwnerClaimTerminalMarker();
    return marker;
  } catch {
    return null;
  }
}

/** Only canonical direct/reobserved completion is allowed to create this marker. */
export function writeOwnerClaimTerminalMarker(marker: OwnerClaimTerminalMarker): boolean {
  if (parse(JSON.stringify(marker)) === null) return false;
  try {
    const store = sessionStore();
    if (store === undefined) return false;
    const serialized = JSON.stringify(marker);
    store.setItem(OWNER_CLAIM_TERMINAL_STORAGE_KEY, serialized);
    return store.getItem(OWNER_CLAIM_TERMINAL_STORAGE_KEY) === serialized;
  } catch {
    return false;
  }
}

export function clearOwnerClaimTerminalMarker(): void {
  try {
    sessionStore()?.removeItem(OWNER_CLAIM_TERMINAL_STORAGE_KEY);
  } catch {
    // Session storage is only a refresh aid; it never controls server truth.
  }
}
