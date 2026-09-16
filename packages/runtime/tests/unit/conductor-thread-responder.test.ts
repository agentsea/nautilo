import { describe, expect, test } from "bun:test";
import {
  routeRoomMessage,
  type ConductorContext,
  type ConductorDecision,
  type RoomMemberView,
  type RouteRoomMessageDeps,
  type SubthreadRootAffinity,
} from "@nautilo/runtime";

const ROOM_ID = "subthread-1";
const USER_ACTOR_ID = "user-1";
const NOVA = "actor-nova";
const ALEPO = "actor-alepo";

function agent(
  actorId: string,
  handle: string,
  mode: RoomMemberView["agentResponseMode"] = "active",
): RoomMemberView {
  return { kind: "agent", actorId, agentId: `agent-${actorId}`, handle, agentResponseMode: mode };
}

function user(actorId: string): RoomMemberView {
  return { kind: "user", actorId, handle: actorId };
}

function subthreadCtx(
  overrides: Partial<ConductorContext> & { message?: Partial<ConductorContext["message"]> } = {},
): ConductorContext {
  const { message: messageOverrides, ...rest } = overrides;
  return {
    roomId: ROOM_ID,
    userActorId: USER_ACTOR_ID,
    message: { content: "ordinary follow-up", sourceMessageId: 101, ...messageOverrides },
    members: [user(USER_ACTOR_ID), agent(NOVA, "nova")],
    now: new Date("2026-07-22T12:00:00.000Z"),
    roomKind: "subthread",
    parentRoomId: "parent-1",
    threadRootMessageId: 100,
    ...rest,
  };
}

function defaultDeps(overrides: Partial<RouteRoomMessageDeps> = {}): RouteRoomMessageDeps {
  return { loadActiveFoci: async () => [], ...overrides };
}

function expectWake(
  decision: ConductorDecision,
  botActorId: string,
  reason: string,
): void {
  expect(decision.kind).toBe("wake");
  if (decision.kind !== "wake") return;
  expect(decision.botActorIds).toEqual([botActorId]);
  expect(decision.source).toBe("inferred");
  expect(decision.writeFocus).toBe(true);
  expect(decision.reason).toBe(reason);
}

describe("routeRoomMessage child-room focus and root affinity (D426)", () => {
  test("an active child-room focus gets first refusal before root affinity", async () => {
    let affinityCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [{
          focusId: "focus-1",
          botActorId: NOVA,
          expiresAt: new Date("2026-07-22T12:01:00.000Z"),
          openedSource: "mention",
        }],
        resolveSubthreadRootAffinity: async () => {
          affinityCalled = true;
          return { botActorId: ALEPO, available: true };
        },
      }),
      subthreadCtx({ members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")] }),
    );

    expectWake(decision, NOVA, "single active focus");
    expect(affinityCalled).toBe(false);
  });

  test("focus absence or expiry falls through to the first-reply root affinity and writes normal focus", async () => {
    const calls: Array<[string, Date, number | null]> = [];
    const affinity: SubthreadRootAffinity = { botActorId: NOVA, available: true };
    const decision = await routeRoomMessage(
      defaultDeps({
        // The trust focus loader has already swept expired focus, so no row is
        // returned here and the root fallback may apply.
        loadActiveFoci: async () => [],
        resolveSubthreadRootAffinity: async (...args) => {
          calls.push(args);
          return affinity;
        },
      }),
      subthreadCtx(),
    );

    expectWake(decision, NOVA, "thread affinity");
    expect(calls).toEqual([[ROOM_ID, new Date("2026-07-22T12:00:00.000Z"), 101]]);
  });

  test("a human-authored root has no affinity and falls through to normal arbitration", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        resolveSubthreadRootAffinity: async () => ({ botActorId: null, available: false }),
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "floor manager" };
        },
      }),
      subthreadCtx(),
    );

    expect(floorCalled).toBe(true);
    expect(decision).toEqual({ kind: "silent", reason: "floor manager" });
  });

  test("explicit addressing wins before child focus and affinity", async () => {
    let affinityCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [{
          focusId: "focus-nova",
          botActorId: NOVA,
          expiresAt: new Date("2026-07-22T12:01:00.000Z"),
          openedSource: "ui",
        }],
        resolveSubthreadRootAffinity: async () => {
          affinityCalled = true;
          return { botActorId: NOVA, available: true };
        },
      }),
      subthreadCtx({
        message: { content: "@alepo can you take this?", sourceMessageId: 101 },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
      }),
    );

    expect(decision).toEqual({
      kind: "wake",
      botActorIds: [ALEPO],
      source: "mention",
      writeFocus: true,
      reason: "mention",
    });
    expect(affinityCalled).toBe(false);
  });

  test("an unavailable first-reply root remains controlled-silent", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        resolveSubthreadRootAffinity: async () => ({ botActorId: NOVA, available: false }),
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "floor manager" };
        },
      }),
      subthreadCtx(),
    );

    expect(decision).toEqual({ kind: "silent", reason: "thread affinity unavailable" });
    expect(floorCalled).toBe(false);
  });

  test("child focus lookup remains keyed to the requesting human", async () => {
    const focusLoads: Array<{ roomId: string; userActorId: string }> = [];
    const deps = defaultDeps({
      loadActiveFoci: async (roomId, userActorId) => {
        focusLoads.push({ roomId, userActorId });
        return userActorId === USER_ACTOR_ID
          ? [{
              focusId: "alex-focus",
              botActorId: NOVA,
              expiresAt: new Date("2026-07-22T12:01:00.000Z"),
              openedSource: "ui",
            }]
          : [];
      },
      resolveSubthreadRootAffinity: async () => ({ botActorId: ALEPO, available: true }),
    });

    const first = await routeRoomMessage(deps, subthreadCtx({
      members: [user(USER_ACTOR_ID), user("user-2"), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
    }));
    const second = await routeRoomMessage(deps, subthreadCtx({
      userActorId: "user-2",
      message: { content: "my first reply", sourceMessageId: 102 },
      members: [user(USER_ACTOR_ID), user("user-2"), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
    }));

    expectWake(first, NOVA, "single active focus");
    expectWake(second, ALEPO, "thread affinity");
    expect(focusLoads).toEqual([
      { roomId: ROOM_ID, userActorId: USER_ACTOR_ID },
      { roomId: ROOM_ID, userActorId: "user-2" },
    ]);
  });

  test("root affinity never runs for a parent Room", async () => {
    let affinityCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        resolveSubthreadRootAffinity: async () => {
          affinityCalled = true;
          return { botActorId: NOVA, available: true };
        },
      }),
      subthreadCtx({ roomKind: "group" }),
    );

    expect(decision).toEqual({ kind: "silent", reason: "no deterministic route" });
    expect(affinityCalled).toBe(false);
  });
});
