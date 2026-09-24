/** Only a local timestamp is retained. Input content never enters the presence frame. */
export const HUMAN_IDLE_AFTER_MS = 5 * 60 * 1_000;

export function createHumanActivityTracker(now: () => number = Date.now) {
  let lastInteractionAt = now();
  return {
    recordInteraction(): void {
      lastInteractionAt = now();
    },
    isIdle(): boolean {
      return now() - lastInteractionAt >= HUMAN_IDLE_AFTER_MS;
    },
  };
}
