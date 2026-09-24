/** Root touch and composer events reach only the currently authenticated socket scope. */
let currentRecorder: (() => void) | null = null;

export function recordMobileHumanActivity(): void {
  currentRecorder?.();
}

/** The root observes a touch but never claims its responder from a child. */
export function observeMobileTouchStart(): false {
  recordMobileHumanActivity();
  return false;
}

export function observeMobileHumanActivity(record: () => void): () => void {
  currentRecorder = record;
  return () => {
    if (currentRecorder === record) currentRecorder = null;
  };
}
