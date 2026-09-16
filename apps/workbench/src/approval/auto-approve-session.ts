export const AUTO_APPROVE_SESSION_KEY = "nautilo.autoApprove.v1";

interface AutoApproveSessionEnvelope {
  readonly version: 1;
  readonly userId: string;
  readonly enabled: true;
}

function remove(storage: Storage | undefined): void {
  try {
    storage?.removeItem(AUTO_APPROVE_SESSION_KEY);
  } catch {
    // Session storage is optional in embedded and hardened browser contexts.
  }
}

function browserSessionStorage(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Restore Auto-Approve only for the exact verified human who enabled it in
 * this renderer session. Invalid or differently scoped state fails closed.
 */
export function readAutoApproveSession(
  userId: string | null,
  storage: Storage | undefined = browserSessionStorage(),
): boolean {
  if (!userId || !storage) return false;
  try {
    const raw = storage.getItem(AUTO_APPROVE_SESSION_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<AutoApproveSessionEnvelope>;
    if (parsed.version !== 1 || parsed.enabled !== true || parsed.userId !== userId) {
      remove(storage);
      return false;
    }
    return true;
  } catch {
    remove(storage);
    return false;
  }
}

export function writeAutoApproveSession(
  userId: string | null,
  enabled: boolean,
  storage: Storage | undefined = browserSessionStorage(),
): boolean {
  if (!userId || !enabled) {
    remove(storage);
    return false;
  }
  const envelope: AutoApproveSessionEnvelope = { version: 1, userId, enabled: true };
  try {
    storage?.setItem(AUTO_APPROVE_SESSION_KEY, JSON.stringify(envelope));
    return storage?.getItem(AUTO_APPROVE_SESSION_KEY) === JSON.stringify(envelope);
  } catch {
    return false;
  }
}

export function clearAutoApproveSession(
  storage: Storage | undefined = browserSessionStorage(),
): void {
  remove(storage);
}
