import { afterEach, describe, expect, test } from "bun:test";

import {
  __setPushDeliveryWorkerForTests,
  requestPushDeliveryPump,
  startPushDeliveryRuntime,
  stopPushDeliveryRuntime,
} from "../../src/push/push-delivery-runtime";
import { backgroundBadgeForPushDelivery } from "../../src/push/push-delivery-worker";

const idle = {
  didWork: false,
  candidatesProcessed: 0,
  testsProcessed: 0,
  sendsClaimed: 0,
  receiptsClaimed: 0,
} as const;

async function flushPump(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  __setPushDeliveryWorkerForTests(undefined);
});

describe("D468 push-delivery runtime lifecycle", () => {
  test("badges only real iOS message pushes when the installation opted in", () => {
    expect(backgroundBadgeForPushDelivery({ platform: "ios", badgeEnabled: true, kind: "important_message", unreadCount: 7 })).toBe(7);
    expect(backgroundBadgeForPushDelivery({ platform: "ios", badgeEnabled: true, kind: "important_message", unreadCount: 0 })).toBeUndefined();
    expect(backgroundBadgeForPushDelivery({ platform: "ios", badgeEnabled: false, kind: "important_message", unreadCount: 7 })).toBeUndefined();
    expect(backgroundBadgeForPushDelivery({ platform: "android", badgeEnabled: true, kind: "important_message", unreadCount: 7 })).toBeUndefined();
    expect(backgroundBadgeForPushDelivery({ platform: "ios", badgeEnabled: true, kind: "test", unreadCount: 7 })).toBeUndefined();
    expect(backgroundBadgeForPushDelivery({ platform: "ios", badgeEnabled: true, kind: "needs_you", unreadCount: 7 })).toBeUndefined();
  });

  test("starts one pump, is idempotent, and never starts work after shutdown", async () => {
    let calls = 0;
    __setPushDeliveryWorkerForTests({
      runOnce: async () => {
        calls += 1;
        return idle;
      },
    });

    startPushDeliveryRuntime();
    startPushDeliveryRuntime();
    await flushPump();
    expect(calls).toBe(1);

    stopPushDeliveryRuntime();
    requestPushDeliveryPump();
    await flushPump();
    expect(calls).toBe(1);
  });
});
