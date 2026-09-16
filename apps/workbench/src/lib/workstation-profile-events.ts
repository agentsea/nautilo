export type WorkstationProfileChangeSource = "settings" | "footer";

const WORKSTATION_PROFILE_CHANGED_EVENT =
  "nautilo:workstation-profile-changed";

/**
 * Renderer-local invalidation only. Active-profile authority remains in
 * Electron and the server; this event carries no profile state or authority.
 */
export function publishWorkstationProfileChanged(
  source: WorkstationProfileChangeSource,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkstationProfileChangeSource>(
      WORKSTATION_PROFILE_CHANGED_EVENT,
      { detail: source },
    ),
  );
}

export function subscribeToWorkstationProfileChanges(
  consumer: WorkstationProfileChangeSource,
  refresh: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const source = (event as CustomEvent<unknown>).detail;
    if ((source === "settings" || source === "footer") && source !== consumer) {
      refresh();
    }
  };
  window.addEventListener(WORKSTATION_PROFILE_CHANGED_EVENT, listener);
  return () =>
    window.removeEventListener(WORKSTATION_PROFILE_CHANGED_EVENT, listener);
}
