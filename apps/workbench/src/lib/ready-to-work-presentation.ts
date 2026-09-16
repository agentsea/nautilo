export type ReadyToWorkPresentationMode = "ready" | "individual";

const STORAGE_KEY = "nautilo.ready-to-work.presentation-mode.v1";
const CHANGE_EVENT = "nautilo:ready-to-work-presentation-changed";

/** Missing preference intentionally means the recommended Ready-to-work setup. */
export function readReadyToWorkPresentationMode(): ReadyToWorkPresentationMode {
  if (typeof window === "undefined") return "ready";
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "individual" ? "individual" : "ready";
  } catch {
    return "ready";
  }
}

export function writeReadyToWorkPresentationMode(mode: ReadyToWorkPresentationMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Presentation preference is best-effort; Desktop authority remains in main.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onReadyToWorkPresentationModeChanged(
  callback: (mode: ReadyToWorkPresentationMode) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const notify = () => callback(readReadyToWorkPresentationMode());
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) notify();
  };
  window.addEventListener(CHANGE_EVENT, notify);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, notify);
    window.removeEventListener("storage", onStorage);
  };
}
