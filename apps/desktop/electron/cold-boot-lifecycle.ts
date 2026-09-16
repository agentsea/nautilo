/**
 * D514 Phase 0 — executable ordering seam for the local cold-boot shell.
 *
 * This owns no URL, identity, persistence, IPC, or retry policy. It simply
 * makes the critical ordering testable: initiate local-shell load, observe in main,
 * pause/project recovery until a main-owned continuation resumes, then hand a
 * verified result to the existing boot tail.
 */
export type ColdBootLifecycleState =
  | "observing"
  | "paused"
  | "resuming"
  | "complete";

export type ColdBootLaunchGateOptions<T> = {
  createLocalShell: () => void | Promise<void>;
  observe: () => Promise<T>;
  isLive: (observation: T) => boolean;
  projectRecovery: () => void | Promise<void>;
  waitForRecoveryContinuation: () => Promise<void>;
  currentObservation: () => T;
  setLifecycle: (state: ColdBootLifecycleState) => void;
};

/**
 * Runs exactly the pre-release gate. Callers retain the live setup/auth/
 * profile/onboarding tail and must release remote navigation only afterwards.
 */
export async function runColdBootLaunchGate<T>(
  options: ColdBootLaunchGateOptions<T>,
): Promise<T> {
  options.setLifecycle("observing");
  await options.createLocalShell();
  let observation = await options.observe() as T;
  while (!options.isLive(observation)) {
    options.setLifecycle("paused");
    await options.projectRecovery();
    await options.waitForRecoveryContinuation();
    observation = options.currentObservation();
  }
  options.setLifecycle("resuming");
  return observation;
}
