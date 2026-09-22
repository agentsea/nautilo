/**
 * D302 P7 — same-sender conductor coalescing helper.
 */
import { describe, expect, test } from "bun:test";
import type { RoutingView } from "@nautilo/runtime";
import {
  CONDUCTOR_COALESCE_POLICY,
  ConductorCoalescer,
  conductorCoalesceKey,
  mergeConductorRoutingItems,
  shouldBypassConductorCoalescing,
  type ConductorRoutingItem,
} from "../../src/messaging/conductor-coalescer";

const testSessionToken = Symbol("test-session");

function routingView(content: string): RoutingView {
  return {
    content,
    truncated: false,
    originalLength: content.length,
  };
}

function baseItem(partial: Partial<ConductorRoutingItem> = {}): ConductorRoutingItem {
  const content = partial.content ?? "hello";
  return {
    roomId: "room-1",
    userActorId: "actor-1",
    content,
    voiceMode: false,
    currentFolder: null,
    workspacePath: null,
    activeMiniApp: null,
    attachmentRefs: [],
    artifactRefs: [],
    searchHistoryFlag: false,
    coalescingContext: {
      clientSessionToken: testSessionToken,
      initiatingClientSurface: "workbench.browser",
    },
    persistedHuman: {
      messageId: 1,
      humanTurnId: "turn-1",
      attachments: [],
      coalesced: true,
      routingView: routingView(content),
    },
    ...partial,
    currentFolderRelayId: partial.currentFolderRelayId ?? null,
  };
}

describe("D356 — mergeConductorRoutingItems unions artifactRefs (dedupe by id)", () => {
  test("burst unions refs and dedupes by artifactId", () => {
    const merged = mergeConductorRoutingItems([
      baseItem({
        content: "a",
        artifactRefs: [{ artifactId: "x/1", path: "x/1.md", mimeType: "text/markdown", size: 1 }],
      }),
      baseItem({
        content: "b",
        artifactRefs: [
          { artifactId: "x/1", path: "x/1.md", mimeType: "text/markdown", size: 1 },
          { artifactId: "y/2", path: "y/2.csv", mimeType: "text/csv", size: 2 },
        ],
      }),
    ]);
    expect(merged.artifactRefs.map((r) => r.artifactId)).toEqual(["x/1", "y/2"]);
  });

  test("single item passes refs through unchanged", () => {
    const refs = [{ artifactId: "solo", path: "solo.pdf", mimeType: "application/pdf", size: 5 }];
    const merged = mergeConductorRoutingItems([baseItem({ artifactRefs: refs })]);
    expect(merged.artifactRefs).toEqual(refs);
  });
});

describe("shouldBypassConductorCoalescing", () => {
  test("slash command bypasses", () => {
    expect(shouldBypassConductorCoalescing(baseItem({ content: "/help" }))).toBe(true);
    expect(shouldBypassConductorCoalescing(baseItem({ content: "  /status" }))).toBe(true);
  });

  test("reply target bypasses", () => {
    expect(shouldBypassConductorCoalescing(baseItem({ replyToMessageId: 42 }))).toBe(true);
    expect(shouldBypassConductorCoalescing(baseItem({ replyToMessageId: null }))).toBe(false);
  });

  test("ui-selected bot bypasses", () => {
    expect(
      shouldBypassConductorCoalescing(baseItem({ uiSelectedBotActorId: "bot-actor-1" })),
    ).toBe(true);
    expect(shouldBypassConductorCoalescing(baseItem({ uiSelectedBotActorId: null }))).toBe(false);
  });

  test("@mention-like token bypasses", () => {
    expect(shouldBypassConductorCoalescing(baseItem({ content: "hey @nova" }))).toBe(true);
    expect(shouldBypassConductorCoalescing(baseItem({ content: "plain ambient" }))).toBe(false);
  });

  test("structured Room-wide Human mention bypasses", () => {
    expect(
      shouldBypassConductorCoalescing(baseItem({ mentionEveryone: true })),
    ).toBe(true);
    expect(
      shouldBypassConductorCoalescing(baseItem({ mentionEveryone: false })),
    ).toBe(false);
  });

  test("paired-mobile origin bypasses because one signature covers one exact body", () => {
    expect(shouldBypassConductorCoalescing(baseItem({
      ordinaryOrigin: {
        kind: "paired_mobile",
        serverInstanceId: "server-1",
        serverBindingGeneration: 1,
        userId: "user-1",
        actorId: "actor-1",
        controllerInstallationId: "controller-1",
        installationGeneration: 1,
        requestId: "request-1",
      },
    }))).toBe(true);
  });
});

describe("mergeConductorRoutingItems", () => {
  test("single item preserves identity fields", () => {
    const item = baseItem({ content: "solo" });
    const merged = mergeConductorRoutingItems([item]);
    expect(merged).toEqual({
      ...item,
      burstCount: 1,
      coveredMessageIds: [1],
      coveredHumanTurnIds: ["turn-1"],
      coveredSharedAgentOperationIds: [],
    });
  });

  test("joins content and ORs flags; latest posture/paths; concat attachments", () => {
    const merged = mergeConductorRoutingItems([
      baseItem({
        content: "a",
        voiceMode: true,
        autoApprove: true,
        searchHistoryFlag: false,
        currentFolder: "/a",
        currentFolderRelayId: "relay-a",
        workspacePath: "/w-a",
        activeMiniApp: { appId: "first", updatedAt: 1 },
        attachmentRefs: ["att-1"],
        persistedHuman: {
          messageId: 10,
          humanTurnId: "turn-a",
          sharedAgentOperationId: "shadow-a",
          attachments: [
            {
              id: "att-status-1",
              kind: "text",
              filename: "a.txt",
              decision: "accept",
            },
          ],
          coalesced: true,
          routingView: routingView("a"),
        },
      }),
      baseItem({
        content: "b",
        voiceMode: false,
        autoApprove: false,
        searchHistoryFlag: true,
        currentFolder: "/b",
        currentFolderRelayId: "relay-b",
        workspacePath: "/w-b",
        activeMiniApp: { appId: "second", updatedAt: 2 },
        attachmentRefs: ["att-2"],
        persistedHuman: {
          messageId: 11,
          humanTurnId: "turn-b",
          sharedAgentOperationId: "shadow-b",
          attachments: [
            {
              id: "att-status-2",
              kind: "text",
              filename: "b.txt",
              decision: "accept",
            },
          ],
          coalesced: true,
          routingView: routingView("b"),
        },
      }),
    ]);

    expect(merged.content).toBe("a\n\nb");
    expect(merged.voiceMode).toBe(true);
    expect(merged.autoApprove).toBe(false);
    expect(merged.searchHistoryFlag).toBe(true);
    expect(merged.currentFolder).toBe("/b");
    expect(merged.currentFolderRelayId).toBe("relay-b");
    expect(merged.workspacePath).toBe("/w-b");
    expect(merged.activeMiniApp?.appId).toBe("second");
    expect(merged.attachmentRefs).toEqual(["att-1", "att-2"]);
    expect(merged.persistedHuman.messageId).toBe(11);
    expect(merged.persistedHuman.humanTurnId).toBe("turn-b");
    expect(merged.persistedHuman.attachments.map((a) => a.id)).toEqual([
      "att-status-1",
      "att-status-2",
    ]);
    expect(merged.burstCount).toBe(2);
    expect(merged.coveredMessageIds).toEqual([10, 11]);
    expect(merged.coveredHumanTurnIds).toEqual(["turn-a", "turn-b"]);
    expect(merged.coveredSharedAgentOperationIds).toEqual([
      "shadow-a",
      "shadow-b",
    ]);
  });

  test("latest coalesced posture can enable Auto-Approve", () => {
    const merged = mergeConductorRoutingItems([
      baseItem({ content: "first", autoApprove: false }),
      baseItem({ content: "second", autoApprove: true }),
    ]);
    expect(merged.autoApprove).toBe(true);
  });
});

describe("ConductorCoalescer", () => {
  test("policy is intentionally always-debounce", () => {
    expect(CONDUCTOR_COALESCE_POLICY).toBe("always_debounce");
  });

  test("conductorCoalesceKey is roomId:userActorId", () => {
    expect(conductorCoalesceKey("room-a", "user-b")).toBe("room-a:user-b");
  });

  test("drainKey clears buffer without calling onFlush", () => {
    const flushed: string[] = [];
    const stubTimer = ((_fn: (...args: unknown[]) => void) =>
      999 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;

    const c = new ConductorCoalescer(stubTimer, clearTimeout, (_k, merged) => {
      flushed.push(merged.content);
    }, 100);

    const key = conductorCoalesceKey("room-1", "actor-1");
    c.enqueue(baseItem({ content: "a" }));
    const drained = c.drainKey(key);
    expect(flushed).toEqual([]);
    expect(drained?.content).toBe("a");
    expect(c.drainKey(key)).toBeNull();
  });

  test("single enqueue flushes after firstQuietMs", () => {
    let fired: (() => void) | null = null;
    const flushed: string[] = [];
    const stubTimer = ((fn: (...args: unknown[]) => void, ms?: number) => {
      expect(ms).toBe(500);
      fired = fn as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c = new ConductorCoalescer(stubTimer, clearTimeout, (_k, merged) => {
      flushed.push(merged.content);
    }, 1500, 5000);

    c.enqueue(baseItem({ content: "one" }));
    expect(flushed).toEqual([]);
    (fired as (() => void) | null)?.();
    expect(flushed).toEqual(["one"]);
  });

  test("sliding debounce resets quiet timer on append", () => {
    let t = 0;
    let deadline = 0;
    let onFire: (() => void) | null = null;
    const flushed: string[] = [];
    const stubTimer = ((fn: (...args: unknown[]) => void, ms?: number) => {
      deadline = t + (ms ?? 0);
      onFire = fn as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c = new ConductorCoalescer(
      stubTimer,
      clearTimeout,
      (_k, merged) => flushed.push(merged.content),
      1500,
      5000,
      () => t,
    );

    t = 0;
    c.enqueue(baseItem({ content: "a" }));
    expect(deadline).toBe(500);

    t = 300;
    c.enqueue(baseItem({ content: "b" }));
    expect(deadline).toBe(1800);

    t = 1800;
    (onFire as (() => void) | null)?.();
    expect(flushed).toEqual(["a\n\nb"]);
  });

  test("flushes before a different exact session or surface can join a group burst", () => {
    const flushed: string[] = [];
    const stubTimer = ((_fn: (...args: unknown[]) => void) =>
      1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;
    const c = new ConductorCoalescer(stubTimer, clearTimeout, (_key, merged) => {
      flushed.push(merged.content);
    });
    const mobile = Symbol("mobile");
    const desktop = Symbol("desktop");
    c.enqueue(baseItem({ content: "mobile", coalescingContext: {
      clientSessionToken: mobile, initiatingClientSurface: "mobile.web",
    } }));
    c.enqueue(baseItem({ content: "desktop", coalescingContext: {
      clientSessionToken: desktop, initiatingClientSurface: "workbench.desktop",
    } }));
    expect(flushed).toEqual(["mobile"]);
    expect(c.drainKey(conductorCoalesceKey("room-1", "actor-1"))?.content).toBe("desktop");
  });

  test("flushes before a known surface and an unbound admission can join a group burst", () => {
    const flushed: string[] = [];
    const stubTimer = ((_fn: (...args: unknown[]) => void) =>
      1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;
    const c = new ConductorCoalescer(stubTimer, clearTimeout, (_key, merged) => {
      flushed.push(merged.content);
    });
    c.enqueue(baseItem({ content: "known" }));
    const { coalescingContext: _discardedContext, ...unbound } = baseItem({ content: "unbound" });
    c.enqueue(unbound);
    expect(flushed).toEqual(["known"]);
    expect(c.drainKey(conductorCoalesceKey("room-1", "actor-1"))?.content).toBe("unbound");
  });

  test("late second message after first quiet window becomes a separate burst", () => {
    let onFire: (() => void) | null = null;
    const flushed: string[] = [];
    const stubTimer = ((fn: (...args: unknown[]) => void) => {
      onFire = fn as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c = new ConductorCoalescer(
      stubTimer,
      clearTimeout,
      (_k, merged) => flushed.push(merged.content),
      1500,
      5000,
    );

    c.enqueue(baseItem({ content: "first" }));
    (onFire as (() => void) | null)?.();
    c.enqueue(baseItem({ content: "second" }));
    (onFire as (() => void) | null)?.();
    expect(flushed).toEqual(["first", "second"]);
  });

  test("maxWaitMs ceiling under continuous same-sender stream", () => {
    let t = 0;
    let deadline = 0;
    let onFire: (() => void) | null = null;
    const flushed: string[] = [];
    const stubTimer = ((fn: (...args: unknown[]) => void, ms?: number) => {
      deadline = t + (ms ?? 0);
      onFire = fn as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c = new ConductorCoalescer(
      stubTimer,
      clearTimeout,
      (_k, merged) => flushed.push(merged.content),
      1500,
      5000,
      () => t,
    );

    t = 0;
    c.enqueue(baseItem({ content: "m1" }));
    expect(deadline).toBe(500);

    for (let i = 2; i <= 10; i++) {
      t = (i - 1) * 400;
      c.enqueue(baseItem({ content: `m${i}` }));
      expect(deadline).toBeLessThanOrEqual(5000);
    }

    t = 3600;
    c.enqueue(baseItem({ content: "m11" }));
    expect(deadline).toBe(5000);

    t = 5000;
    (onFire as (() => void) | null)?.();
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toContain("m1");
    expect(flushed[0]).toContain("m11");
  });

  test("bypass flushes pending buffer for same key", () => {
    const flushed: string[] = [];
    const stubTimer = ((_fn: (...args: unknown[]) => void) =>
      1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;

    const c = new ConductorCoalescer(stubTimer, clearTimeout, (_k, merged) => {
      flushed.push(merged.content);
    }, 1500, 5000);

    const key = conductorCoalesceKey("room-1", "actor-1");
    c.enqueue(baseItem({ content: "buffered" }));
    expect(flushed).toEqual([]);

    const result = c.enqueue(baseItem({ content: "@nova hi" }));
    expect(result).toBe("bypass");
    expect(flushed).toEqual(["buffered"]);
    expect(c.drainKey(key)).toBeNull();
  });

  test("flushIfPending runs immediately", () => {
    let cleared = 0;
    let tid = 0 as unknown as ReturnType<typeof setTimeout>;
    const stubTimer = ((fn: (...args: unknown[]) => void) => {
      tid = setTimeout(fn as () => void, 9999) as unknown as ReturnType<typeof setTimeout>;
      return tid;
    }) as unknown as typeof setTimeout;
    const stubClear = ((id: ReturnType<typeof setTimeout>) => {
      cleared++;
      clearTimeout(id);
    }) as typeof clearTimeout;

    const flushed: string[] = [];
    const c = new ConductorCoalescer(stubTimer, stubClear, (_k, merged) => {
      flushed.push(merged.content);
    }, 999, 5000);

    const key = conductorCoalesceKey("room-1", "actor-1");
    c.enqueue(baseItem({ content: "x" }));
    c.flushIfPending(key);
    expect(flushed).toEqual(["x"]);
    c.flushIfPending(key);
    expect(flushed).toEqual(["x"]);
    expect(cleared).toBe(1);
  });

  test("two keys flush independently", async () => {
    const out: string[] = [];
    const stubTimer = ((fn: (...args: unknown[]) => void) => {
      queueMicrotask(fn as () => void);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c = new ConductorCoalescer(stubTimer, clearTimeout, (key, merged) => {
      out.push(`${key}:${merged.content}`);
    }, 5, 5000);

    c.enqueue(baseItem({ roomId: "room-a", userActorId: "u1", content: "1" }));
    c.enqueue(baseItem({ roomId: "room-b", userActorId: "u2", content: "2" }));
    await new Promise((r) => queueMicrotask(r));
    expect(out.sort()).toEqual(["room-a:u1:1", "room-b:u2:2"]);
  });
});
