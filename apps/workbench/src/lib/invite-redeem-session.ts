export const STORAGE_KEY = "nautilo.inviteRedeem";

const MAX_AGE_MS = 30 * 60 * 1000;

/**
 * M107 Phase 3: the persisted shape now carries `handle` (not `email`)
 * and is tagged with `version: 2`. Legacy `version: 1` payloads (or
 * any payload missing the version marker but with `email`) are
 * discarded on load — the user has to restart the flow once during
 * the release window. The wizard re-mints fresh state on the next
 * preview-step submit, so this is a one-time UX cost rather than a
 * permanent loss.
 */
export interface InviteRedeemSession {
  version: 2;
  token: string;
  state: string;
  handle: string;
  stage: "awaiting-signup" | "awaiting-bind" | "profile";
  startedAt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStage(v: unknown): v is InviteRedeemSession["stage"] {
  return v === "awaiting-signup" || v === "awaiting-bind" || v === "profile";
}

function parseSession(raw: string): InviteRedeemSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  // Discard legacy v1 / unmarked payloads (M107). A v1 payload carries
  // `email` instead of `handle`; reading it as-is would surface a stale
  // email value the wizard now has no UI for. Force a clean restart.
  if (parsed.version !== 2) {
    return null;
  }
  const token = parsed.token;
  const state = parsed.state;
  const handle = parsed.handle;
  const stage = parsed.stage;
  const startedAt = parsed.startedAt;
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof state !== "string" || state.length === 0) return null;
  if (typeof handle !== "string") return null;
  if (!isStage(stage)) return null;
  if (typeof startedAt !== "string" || startedAt.length === 0) return null;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t) || Date.now() - t > MAX_AGE_MS) {
    return null;
  }
  return { version: 2, token, state, handle, stage, startedAt };
}

function readFrom(storage: Storage | undefined): InviteRedeemSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null || raw.length === 0) return null;
    const parsed = parseSession(raw);
    if (!parsed) storage.removeItem(STORAGE_KEY);
    return parsed;
  } catch {
    return null;
  }
}

function writeTo(storage: Storage | undefined, serialized: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, serialized);
    return storage.getItem(STORAGE_KEY) === serialized;
  } catch {
    return false;
  }
}

function removeFrom(storage: Storage | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function browserSessionStorage(): Storage | undefined {
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
}

function browserLocalStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/**
 * Read the short-lived invite handoff. `sessionStorage` is preferred, with
 * `localStorage` as a same-origin fallback for browsers that lose or isolate
 * session storage during the external Logto navigation. Both copies are
 * bounded by `MAX_AGE_MS` and cleared when the flow completes.
 */
export function readSession(): InviteRedeemSession | null {
  return (
    readFrom(browserSessionStorage()) ??
    readFrom(browserLocalStorage())
  );
}

/**
 * Persist the invite handoff redundantly and verify at least one copy.
 * Returning false lets the wizard fail before leaving for Logto instead of
 * creating an unbound identity that cannot resume.
 */
export function writeSession(s: InviteRedeemSession): boolean {
  const serialized = JSON.stringify(s);
  const sessionWritten = writeTo(browserSessionStorage(), serialized);
  const localWritten = writeTo(browserLocalStorage(), serialized);
  return sessionWritten || localWritten;
}

export function clearSession(): void {
  removeFrom(browserSessionStorage());
  removeFrom(browserLocalStorage());
}
