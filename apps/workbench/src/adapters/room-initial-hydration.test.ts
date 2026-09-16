import { describe, expect, test } from "bun:test";
import {
  beginRoomInitialHydration,
  deriveRoomInitialHydrationDisclosure,
  transitionRoomInitialHydration,
  type RoomInitialHydrationScope,
} from "./room-initial-hydration";

function scope(overrides: Partial<RoomInitialHydrationScope> = {}): RoomInitialHydrationScope {
  return {
    origin: "https://server-a.example",
    viewerKey: "viewer-a",
    viewerGeneration: 7,
    roomId: "room-a",
    generation: 1,
    ...overrides,
  };
}

describe("room initial hydration", () => {
  test("models selection, cache, and terminal hydration outcomes", () => {
    const active = scope();
    const cases = [
      {
        name: "select leaves the Room unresolved",
        state: beginRoomInitialHydration(active),
        transition: null,
        expected: { kind: "unresolved" },
      },
      {
        name: "cache hit synchronizes the stale frame",
        state: beginRoomInitialHydration(active),
        transition: { kind: "cache-hit", scope: active } as const,
        expected: { kind: "syncing" },
      },
      {
        name: "cache miss remains unresolved instead of becoming empty",
        state: beginRoomInitialHydration(active),
        transition: { kind: "cache-miss", scope: active } as const,
        expected: { kind: "unresolved" },
      },
      {
        name: "server success is ready",
        state: beginRoomInitialHydration(active),
        transition: { kind: "server-success", scope: active } as const,
        expected: { kind: "ready" },
      },
      {
        name: "server empty is authoritative empty",
        state: beginRoomInitialHydration(active),
        transition: { kind: "server-empty", scope: active } as const,
        expected: { kind: "empty" },
      },
      {
        name: "key convergence is a calm nonterminal wait",
        state: beginRoomInitialHydration(active),
        transition: {
          kind: "server-waiting-for-authority",
          scope: active,
          sendAuthorized: true,
        } as const,
        expected: { kind: "waiting-for-authority", sendAuthorized: true },
      },
      {
        name: "a cache-miss server failure is retryable without stale content",
        state: beginRoomInitialHydration(active),
        transition: { kind: "server-failure", scope: active, retainCachedFrame: true } as const,
        expected: { kind: "recoverable-error", retainsCachedFrame: false },
      },
      {
        name: "a permitted cache-hit failure retains the stale frame",
        state: transitionRoomInitialHydration(beginRoomInitialHydration(active), {
          kind: "cache-hit",
          scope: active,
        }),
        transition: { kind: "server-failure", scope: active, retainCachedFrame: true } as const,
        expected: { kind: "recoverable-error", retainsCachedFrame: true },
      },
      {
        name: "unauthorized clears stale content through an access terminal state",
        state: transitionRoomInitialHydration(beginRoomInitialHydration(active), {
          kind: "cache-hit",
          scope: active,
        }),
        transition: { kind: "access-terminal", scope: active, reason: "unauthorized" } as const,
        expected: { kind: "access-terminal-error", reason: "unauthorized" },
      },
      {
        name: "not found clears stale content through an access terminal state",
        state: transitionRoomInitialHydration(beginRoomInitialHydration(active), {
          kind: "cache-hit",
          scope: active,
        }),
        transition: { kind: "access-terminal", scope: active, reason: "not-found" } as const,
        expected: { kind: "access-terminal-error", reason: "not-found" },
      },
    ];

    for (const { name, state, transition, expected } of cases) {
      const result = transition === null ? state : transitionRoomInitialHydration(state, transition);
      expect(result, name).toMatchObject({ ...expected, scope: active });
    }
  });

  test("retry begins a fresh unresolved generation", () => {
    const first = scope();
    const failed = transitionRoomInitialHydration(beginRoomInitialHydration(first), {
      kind: "server-failure",
      scope: first,
      retainCachedFrame: false,
    });
    const retried = beginRoomInitialHydration(scope({ generation: 2 }));

    expect(failed.kind).toBe("recoverable-error");
    expect(retried).toMatchObject({ kind: "unresolved", scope: { generation: 2 } });
  });

  test("superseded cache and server transitions cannot replace the active Room", () => {
    const active = scope({ roomId: "room-b", generation: 3 });
    const selected = beginRoomInitialHydration(active);
    const superseded = [
      scope({ roomId: "room-a", generation: 2 }),
      scope({ roomId: "room-b", generation: 2 }),
      scope({ roomId: "room-b", viewerGeneration: 6, generation: 3 }),
      scope({ roomId: "room-b", origin: "https://server-b.example", generation: 3 }),
    ];

    for (const staleScope of superseded) {
      for (const transition of [
        { kind: "cache-hit", scope: staleScope } as const,
        { kind: "server-success", scope: staleScope } as const,
      ]) {
        expect(transitionRoomInitialHydration(selected, transition)).toBe(selected);
      }
    }
  });

  test("a terminal result cannot be rewound without a new generation", () => {
    const active = scope();
    const ready = transitionRoomInitialHydration(beginRoomInitialHydration(active), {
      kind: "server-success",
      scope: active,
    });

    expect(transitionRoomInitialHydration(ready, { kind: "cache-hit", scope: active })).toBe(ready);
    expect(
      transitionRoomInitialHydration(ready, {
        kind: "server-failure",
        scope: active,
        retainCachedFrame: false,
      }),
    ).toBe(ready);
  });

  test("authority waiting resumes within the same fenced generation", () => {
    const active = scope();
    const waiting = transitionRoomInitialHydration(beginRoomInitialHydration(active), {
      kind: "server-waiting-for-authority",
      scope: active,
      sendAuthorized: true,
    });

    expect(transitionRoomInitialHydration(waiting, {
      kind: "server-success",
      scope: active,
    })).toEqual({ kind: "ready", scope: active });
  });

  test("derives exactly one loading disclosure for each loading state", () => {
    const active = scope();
    expect(deriveRoomInitialHydrationDisclosure(beginRoomInitialHydration(active))).toBe("skeletons");
    expect(
      deriveRoomInitialHydrationDisclosure(
        transitionRoomInitialHydration(beginRoomInitialHydration(active), {
          kind: "cache-hit",
          scope: active,
        }),
      ),
    ).toBe("syncing-latest");
    expect(deriveRoomInitialHydrationDisclosure({
      kind: "waiting-for-authority",
      scope: active,
      sendAuthorized: true,
    })).toBe("waiting-for-authority");
  });
});
