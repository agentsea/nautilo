import { expect, test } from "bun:test";
import { observeMobileHumanActivity, observeMobileTouchStart, recordMobileHumanActivity } from "./human-activity";

test("touch and composer observations stay in the active socket scope", () => {
  let first = 0;
  let second = 0;
  const removeFirst = observeMobileHumanActivity(() => { first += 1; });
  recordMobileHumanActivity();
  expect(observeMobileTouchStart()).toBe(false);
  const removeSecond = observeMobileHumanActivity(() => { second += 1; });
  removeFirst();
  recordMobileHumanActivity();
  removeSecond();
  recordMobileHumanActivity();
  expect(first).toBe(2);
  expect(second).toBe(1);
});
