const SERVER_GUIDE_SESSION_KEY = "nautilo.serverGuideSession.v1";
const SERVER_GUIDE_COMPLETED_PREFIX = "nautilo.serverGuideCompleted.v1:";
const SERVER_GUIDE_SESSION_EVENT = "nautilo:server-guide-session-changed";

function store(): Storage | undefined {
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
}

export function isServerGuideSessionActive(): boolean {
  try {
    return store()?.getItem(SERVER_GUIDE_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function beginServerGuideSession(): void {
  try {
    store()?.setItem(SERVER_GUIDE_SESSION_KEY, "1");
  } catch {
    // Navigation support is optional; the guide itself remains usable.
  }
  notifyServerGuideSessionChanged();
}

function durableStore(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function completedKey(instanceId: string): string {
  return `${SERVER_GUIDE_COMPLETED_PREFIX}${encodeURIComponent(instanceId)}`;
}

/** Completion belongs to one server and survives route changes and reloads. */
export function isServerGuideCompleted(instanceId: string): boolean {
  try {
    return durableStore()?.getItem(completedKey(instanceId)) === "1";
  } catch {
    return false;
  }
}

/** Start first-owner navigation unless this server's guide was already finished. */
export function beginIncompleteServerGuideSession(instanceId: string): void {
  if (isServerGuideCompleted(instanceId)) {
    endServerGuideSession();
    return;
  }
  beginServerGuideSession();
}

export function completeServerGuide(instanceId: string): void {
  try {
    durableStore()?.setItem(completedKey(instanceId), "1");
  } catch {
    // The current session can still end when durable storage is unavailable.
  }
  endServerGuideSession();
}

export function endServerGuideSession(): void {
  try {
    store()?.removeItem(SERVER_GUIDE_SESSION_KEY);
  } catch {
    // Best effort only.
  }
  notifyServerGuideSessionChanged();
}

function notifyServerGuideSessionChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SERVER_GUIDE_SESSION_EVENT));
  }
}

export function subscribeToServerGuideSession(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SERVER_GUIDE_SESSION_EVENT, onChange);
  return () => window.removeEventListener(SERVER_GUIDE_SESSION_EVENT, onChange);
}
