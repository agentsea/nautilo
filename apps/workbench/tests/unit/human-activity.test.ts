import { expect, test } from "bun:test";
import { observeWorkbenchHumanActivity } from "../../src/adapters/human-activity";
import { HUMAN_IDLE_AFTER_MS } from "@nautilo/realtime-client";

test("keyboard, pointer, and scroll listeners are passive observers and disposed", () => {
  const target = new EventTarget();
  let now = 0;
  const activity = observeWorkbenchHumanActivity(target as Document, () => now);
  for (const type of ["keydown", "pointerdown", "pointermove", "scroll"]) {
    const event = new Event(type, { cancelable: true });
    expect(target.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  }
  now = HUMAN_IDLE_AFTER_MS;
  expect(activity.isIdle()).toBe(true);
  activity.reset();
  expect(activity.isIdle()).toBe(false);
  activity.dispose();
  now += HUMAN_IDLE_AFTER_MS;
  target.dispatchEvent(new Event("keydown"));
  expect(activity.isIdle()).toBe(true);
  expect(target.dispatchEvent(new Event("keydown", { cancelable: true }))).toBe(true);
});
