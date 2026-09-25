import { expect, mock, test } from "bun:test";
import type { AppLifecycleState } from "@/platform/app-lifecycle";

mock.module("@/lib/api", () => ({ getApiClient: () => { throw new Error("test must inject load"); } }));
mock.module("@/platform/app-lifecycle", () => ({ appLifecycle: {
  currentState: () => "inactive",
  addEventListener: () => ({ remove() {} }),
} }));

const { humanPresenceLabel, humanStatusInRoom, observeRoomPresence, roomPresenceScope } = await import("./use-room-presence");

test("all Human labels, missing status, and distinct identity scopes", () => {
  expect(humanPresenceLabel("online")).toBe("Online");
  expect(humanPresenceLabel("idle")).toBe("Idle");
  expect(humanPresenceLabel("offline")).toBe("Offline");
  expect(humanPresenceLabel(undefined)).toBe("Status unavailable");
  expect(humanStatusInRoom({ members: [{ actorId: "human-a", status: "offline" }] }, "human-a")).toBe("offline");
  expect(humanStatusInRoom(null, "human-a")).toBeUndefined();
  expect(humanStatusInRoom({ members: [] }, "human-a")).toBeUndefined();
  expect(roomPresenceScope("https://a", "room", "viewer")).not.toBe(roomPresenceScope("https://b", "room", "viewer"));
  expect(roomPresenceScope("https://a", "room", "viewer")).not.toBe(roomPresenceScope("https://a", "room", "other"));
});

test("visible active sheet reads, background clears, resume reads, failure clears, disposal stops", async () => {
  let state: AppLifecycleState = "active";
  const subscription = { listener: null as ((state: AppLifecycleState) => void) | null };
  let removed = false;
  let loads = 0;
  const snapshots: Array<string | null> = [];
  const stop = observeRoomPresence({
    visible: true, serverUrl: "https://server", roomId: "room", viewerActorId: "viewer",
    lifecycle: {
      currentState: () => state,
      addEventListener: (_event, callback) => {
        subscription.listener = callback;
        return { remove() { removed = true; subscription.listener = null; } };
      },
    },
    load: async () => {
      loads++;
      if (loads === 1) return { members: [{ actorId: "human-a", status: "online" }] };
      throw new Error("unsupported server");
    },
    onChange: (snapshot) => snapshots.push(snapshot?.members[0]?.status ?? null),
  });
  await Promise.resolve();
  expect(snapshots).toEqual([null, "online"]);
  state = "background";
  subscription.listener?.(state);
  expect(snapshots.at(-1)).toBeNull();
  state = "active";
  subscription.listener?.(state);
  await Promise.resolve();
  expect(loads).toBe(2);
  expect(snapshots.at(-1)).toBeNull();
  stop();
  expect(removed).toBe(true);
  expect(subscription.listener).toBeNull();
});
