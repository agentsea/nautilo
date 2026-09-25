import { createHumanActivityTracker } from "@nautilo/realtime-client";

const ACTIVITY_EVENTS = ["keydown", "pointerdown", "pointermove", "scroll"] as const;

/** Observe interactions without consuming them; the socket reads the clock on each ping. */
export function observeWorkbenchHumanActivity(target: Pick<Document, "addEventListener" | "removeEventListener">, now?: () => number) {
  const tracker = createHumanActivityTracker(now);
  const record = () => tracker.recordInteraction();
  for (const event of ACTIVITY_EVENTS) target.addEventListener(event, record, true);
  return {
    isIdle: () => tracker.isIdle(),
    reset: () => tracker.recordInteraction(),
    dispose: () => {
      for (const event of ACTIVITY_EVENTS) target.removeEventListener(event, record, true);
    },
  };
}
