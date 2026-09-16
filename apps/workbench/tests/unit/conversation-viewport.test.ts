import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  conversationViewportScopeKey,
  createConversationTranscriptHydrationCoordinator,
  freezeConversationViewportForRoomSwitch,
  isConversationViewportAway,
  isConversationViewportAtPhysicalLiveEdge,
  isConversationViewportReadyForRead,
  isConversationViewportScopeReady,
  isConversationViewportFollowing,
  isConversationViewportOperationCurrent,
  materializeFirstConversationAnchor,
  scheduleConversationLiveTailScroll,
  selectFirstSurvivingConversationAnchor,
  selectVisibleConversationAnchor,
  shouldScheduleConversationLiveTailScroll,
  shouldConversationTranscriptFollowTail,
  shouldAutoLoadOlderConversationHistory,
  storeConversationSnapshotForReadyScope,
  transitionConversationViewport,
  type ConversationViewportEvent,
  type ConversationViewportMode,
} from "../../src/components/conversation-viewport";

describe("D528 reader-owned conversation viewport", () => {
  const remoteEvents: readonly ConversationViewportEvent[] = [
    { type: "remote-human-message" },
    { type: "remote-agent-run" },
    { type: "stream-growth" },
    { type: "layout-growth" },
    { type: "history-prepend" },
    { type: "message-reconciliation" },
    { type: "reconnect" },
  ];

  test("captures the first visible stable message with its bounded pixel offset", () => {
    expect(selectVisibleConversationAnchor({
      viewportTop: 100,
      viewportBottom: 700,
      messages: [
        { messageId: "above", top: 0, bottom: 80 },
        { messageId: "stable-42", top: 76, bottom: 180 },
        { messageId: "later", top: 180, bottom: 260 },
      ],
    })).toEqual({ messageId: "stable-42", offsetPx: -24 });
  });

  test("a prior Room's bottom state cannot mark the newly selected Room before restore", () => {
    expect(isConversationViewportReadyForRead({
      activeRoomId: "room-a",
      readyRoomId: "room-a",
      viewportAtBottom: true,
      followingLiveEdge: true,
    })).toBe(true);

    // Room B owns a saved reader-away anchor, but assistant-ui can still expose
    // Room A's bottom state until B's nested restore frame has committed.
    expect(isConversationViewportReadyForRead({
      activeRoomId: "room-b",
      readyRoomId: null,
      viewportAtBottom: true,
      followingLiveEdge: true,
    })).toBe(false);
    expect(isConversationViewportReadyForRead({
      activeRoomId: "room-b",
      readyRoomId: "room-b",
      viewportAtBottom: false,
      followingLiveEdge: true,
    })).toBe(false);
    expect(isConversationViewportReadyForRead({
      activeRoomId: "room-b",
      readyRoomId: "room-b",
      viewportAtBottom: true,
      followingLiveEdge: true,
    })).toBe(true);
    expect(isConversationViewportReadyForRead({
      activeRoomId: "room-b",
      readyRoomId: "room-b",
      viewportAtBottom: true,
      followingLiveEdge: false,
    })).toBe(false);
  });

  test("a prior Room's follow intent cannot operate before the selected Room restore settles", () => {
    expect(isConversationViewportFollowing({
      mode: "following",
      activeScopeKey: conversationViewportScopeKey("room-b"),
      readyScopeKey: conversationViewportScopeKey("room-a"),
    })).toBe(false);
    expect(isConversationViewportFollowing({
      mode: "following",
      activeScopeKey: conversationViewportScopeKey("room-b"),
      readyScopeKey: conversationViewportScopeKey("room-b"),
    })).toBe(true);
  });

  test("a Room switch cannot overwrite its saved snapshot from stale viewport geometry", () => {
    const snapshots = new Map([["b", { anchorId: "saved-b" }]]);
    let captures = 0;
    expect(isConversationViewportScopeReady({
      activeScopeKey: "room:b",
      readyScopeKey: "room:a",
    })).toBe(false);
    expect(storeConversationSnapshotForReadyScope({
      activeRoomId: "b",
      activeScopeKey: "room:b",
      readyScopeKey: "room:a",
      activeVisitId: 2,
      readyVisitId: 1,
      snapshots,
      createSnapshot: () => {
        captures += 1;
        return { anchorId: "stale-tail" };
      },
    })).toBe(false);
    expect(snapshots.get("b")).toEqual({ anchorId: "saved-b" });
    expect(captures).toBe(0);
    expect(isConversationViewportScopeReady({
      activeScopeKey: "room:b",
      readyScopeKey: "room:b",
    })).toBe(true);
    expect(storeConversationSnapshotForReadyScope({
      activeRoomId: "b",
      activeScopeKey: "room:b",
      readyScopeKey: "room:b",
      activeVisitId: 2,
      readyVisitId: 2,
      snapshots,
      createSnapshot: () => {
        captures += 1;
        return { anchorId: "new-human-anchor" };
      },
    })).toBe(true);
    expect(snapshots.get("b")).toEqual({ anchorId: "new-human-anchor" });
    expect(captures).toBe(1);

    // B ready -> A unsettled -> B: the scope string matches the prior visit,
    // but its old ready token must not admit a transient tail/reset capture.
    expect(storeConversationSnapshotForReadyScope({
      activeRoomId: "b",
      activeScopeKey: "room:b",
      readyScopeKey: "room:b",
      activeVisitId: 4,
      readyVisitId: 2,
      snapshots,
      createSnapshot: () => {
        captures += 1;
        return { anchorId: "prior-visit-tail" };
      },
    })).toBe(false);
    expect(snapshots.get("b")).toEqual({ anchorId: "new-human-anchor" });
    expect(captures).toBe(1);
  });

  test("canonical navigation freezes before an old AUI scroll can overwrite the outgoing anchor", () => {
    const snapshots = new Map([["b", { anchorId: "initial" }]]);
    let readyVisitId: number | null = 7;
    freezeConversationViewportForRoomSwitch({
      activeRoomId: "b",
      activeScopeKey: "room:b",
      readyScopeKey: "room:b",
      activeVisitId: 7,
      readyVisitId,
      snapshots,
      createSnapshot: () => ({ anchorId: "stable-b" }),
      freeze: () => { readyVisitId = null; },
    });

    // Shared assistant-ui may synchronously emit its destination tail/reset
    // scroll before React rerenders the new active Room.
    expect(storeConversationSnapshotForReadyScope({
      activeRoomId: "b",
      activeScopeKey: "room:b",
      readyScopeKey: "room:b",
      activeVisitId: 7,
      readyVisitId,
      snapshots,
      createSnapshot: () => ({ anchorId: "destination-tail" }),
    })).toBe(false);
    expect(snapshots.get("b")).toEqual({ anchorId: "stable-b" });
  });

  test("a delayed history prepend cannot write after Room re-entry or newer Human intent", () => {
    const viewport = {};
    const captured = {
      capturedViewport: viewport,
      currentViewport: viewport,
      capturedScopeKey: "room:b",
      currentScopeKey: "room:b",
      capturedGeneration: 4,
    };
    expect(isConversationViewportOperationCurrent({
      ...captured,
      currentGeneration: 4,
    })).toBe(true);
    // B -> A -> B can produce the same scope and DOM node; the visit generation
    // must still reject the old async prepend completion.
    expect(isConversationViewportOperationCurrent({
      ...captured,
      currentGeneration: 6,
    })).toBe(false);
    expect(isConversationViewportOperationCurrent({
      ...captured,
      currentGeneration: 5,
    })).toBe(false);
  });

  test("a stale prior-Room away mode cannot expose Return while restore is pending", () => {
    expect(isConversationViewportAway({
      mode: "reader-away",
      activeScopeKey: "room:b",
      readyScopeKey: null,
    })).toBe(false);
    expect(isConversationViewportAway({
      mode: "reader-away",
      activeScopeKey: "room:b",
      readyScopeKey: "room:b",
    })).toBe(true);
  });

  test("tail restoration trusts physical bottom while the viewport store catches up", () => {
    expect(isConversationViewportAtPhysicalLiveEdge({
      scrollHeight: 1_500,
      scrollTop: 900,
      clientHeight: 600,
    })).toBe(true);
    expect(isConversationViewportAtPhysicalLiveEdge({
      scrollHeight: 1_500,
      scrollTop: 899,
      clientHeight: 600,
    })).toBe(true);
    expect(isConversationViewportAtPhysicalLiveEdge({
      scrollHeight: 1_500,
      scrollTop: 898,
      clientHeight: 600,
    })).toBe(false);
  });

  test("older history prefetch starts one viewport before the hard top", () => {
    expect(shouldAutoLoadOlderConversationHistory({
      scrollTop: 700,
      clientHeight: 700,
    })).toBe(true);
    expect(shouldAutoLoadOlderConversationHistory({
      scrollTop: 701,
      clientHeight: 700,
    })).toBe(false);
    expect(shouldAutoLoadOlderConversationHistory({
      scrollTop: 80,
      clientHeight: 0,
    })).toBe(true);
  });

  test("the initialized legacy chat scope follows, stays away, and returns on local send", () => {
    const legacyScope = conversationViewportScopeKey(null);
    expect(isConversationViewportFollowing({
      mode: "following",
      activeScopeKey: legacyScope,
      readyScopeKey: legacyScope,
    })).toBe(true);
    expect(isConversationViewportFollowing({
      mode: "reader-away",
      activeScopeKey: legacyScope,
      readyScopeKey: legacyScope,
    })).toBe(false);
    expect(isConversationViewportFollowing({
      mode: transitionConversationViewport("reader-away", { type: "local-send" }),
      activeScopeKey: legacyScope,
      readyScopeKey: legacyScope,
    })).toBe(true);
  });

  test.each(remoteEvents)("$type cannot resume following", (event) => {
    expect(transitionConversationViewport("reader-away", event)).toBe("reader-away");
    expect(transitionConversationViewport("target-pinned", event)).toBe("target-pinned");
  });

  test("a deliberate local send and explicit return request the live edge", () => {
    expect(transitionConversationViewport("reader-away", { type: "local-send" })).toBe(
      "returning",
    );
    expect(
      transitionConversationViewport("target-pinned", { type: "return-to-latest" }),
    ).toBe("returning");
    expect(
      transitionConversationViewport("returning", {
        type: "viewport-observed",
        atLiveEdge: true,
      }),
    ).toBe("following");
  });

  test("layout lag cannot cancel an atomic return, while Human scrolling can", () => {
    expect(
      transitionConversationViewport("returning", {
        type: "viewport-observed",
        atLiveEdge: false,
      }),
    ).toBe("returning");
    expect(
      transitionConversationViewport("returning", {
        type: "viewport-observed",
        atLiveEdge: false,
        origin: "human",
      }),
    ).toBe("reader-away");
  });

  test("the physical live edge always clears reader-away state", () => {
    expect(
      transitionConversationViewport("reader-away", {
        type: "viewport-observed",
        atLiveEdge: true,
        origin: "layout",
      }),
    ).toBe("following");
    expect(
      transitionConversationViewport("reader-away", {
        type: "viewport-observed",
        atLiveEdge: true,
        origin: "human",
      }),
    ).toBe("following");
  });

  test("a deleted saved anchor restores the nearest surviving identity after inserts", () => {
    const candidates = [
      { messageId: "deleted-anchor", offsetPx: -20 },
      { messageId: "stable-next", offsetPx: 80 },
      { messageId: "stable-previous", offsetPx: -120 },
    ];
    const idsAfterRemoteInsertAndDelete = new Set([
      "remote-insert-1",
      "remote-insert-2",
      "stable-next",
      "stable-previous",
    ]);
    expect(
      selectFirstSurvivingConversationAnchor(
        candidates,
        (messageId) => idsAfterRemoteInsertAndDelete.has(messageId),
      ),
    ).toEqual({ messageId: "stable-next", offsetPx: 80 });
  });

  test("Room restore retries stable identity materialization across a delayed transcript commit", async () => {
    let committed = false;
    let waits = 0;
    const released: string[] = [];
    const restored = await materializeFirstConversationAnchor({
      candidates: [
        { messageId: "saved-anchor", offsetPx: 12 },
        { messageId: "stable-neighbor", offsetPx: 80 },
      ],
      materializeById: (messageId) => committed && messageId === "stable-neighbor",
      findTarget: (messageId) => committed && messageId === "stable-neighbor"
        ? { messageId }
        : null,
      releaseMaterializedTarget: (messageId) => released.push(messageId),
      waitForCommit: async () => {
        waits += 1;
        committed = true;
      },
      isCurrent: () => true,
    });

    expect(waits).toBeGreaterThan(0);
    expect(restored).toEqual({
      anchor: { messageId: "stable-neighbor", offsetPx: 80 },
      target: { messageId: "stable-neighbor" },
    });
    expect(released).toEqual([]);
  });

  test("Room restore hydrates around an anchor absent from the latest Room page", async () => {
    const available = new Set<string>();
    const aroundLoads: string[] = [];
    const restored = await materializeFirstConversationAnchor({
      candidates: [
        { messageId: "deleted-anchor", offsetPx: -18 },
        { messageId: "stable-older-neighbor", offsetPx: 64 },
      ],
      materializeById: (messageId) => available.has(messageId),
      findTarget: (messageId) => available.has(messageId) ? { messageId } : null,
      releaseMaterializedTarget: () => {},
      waitForCommit: () => Promise.resolve(),
      loadHistoryAround: async (messageId) => {
        aroundLoads.push(messageId);
        if (messageId !== "stable-older-neighbor") return false;
        available.add(messageId);
        return true;
      },
      isCurrent: () => true,
      maxAttempts: 1,
    });

    expect(aroundLoads).toEqual(["deleted-anchor", "stable-older-neighbor"]);
    expect(restored).toEqual({
      anchor: { messageId: "stable-older-neighbor", offsetPx: 64 },
      target: { messageId: "stable-older-neighbor" },
    });
  });

  test("a newer Human viewport intent supersedes a delayed around restore", async () => {
    let generation = 4;
    let resolveAround!: (loaded: boolean) => void;
    const around = new Promise<boolean>((resolve) => {
      resolveAround = resolve;
    });
    let targetAvailable = false;
    const restore = materializeFirstConversationAnchor({
      candidates: [{ messageId: "saved-anchor", offsetPx: 22 }],
      materializeById: () => targetAvailable,
      findTarget: () => targetAvailable ? { id: "saved-anchor" } : null,
      releaseMaterializedTarget: () => {},
      waitForCommit: () => Promise.resolve(),
      loadHistoryAround: () => around,
      isCurrent: () => generation === 4,
      maxAttempts: 1,
    });

    generation += 1;
    targetAvailable = true;
    resolveAround(true);

    expect(await restore).toBeNull();
  });

  test("transcript hydration restarts on B to A to B and waits for the stable ID commit", async () => {
    const coordinator = createConversationTranscriptHydrationCoordinator();
    const ready: string[] = [];
    const loads: string[] = [];
    const commit = (scopeKey: string, committedMessageIds: string[]) => coordinator.commit({
      scopeKey,
      snapshotAnchorIds: ["saved-b"],
      committedMessageIds,
      loadHistoryAround: async (messageId) => {
        loads.push(`${scopeKey}:${messageId}`);
        return true;
      },
      isCurrent: () => true,
      onReady: () => ready.push(scopeKey),
    });

    coordinator.beginVisit("room:b");
    commit("room:b", ["latest-b"]);
    await Promise.resolve();
    expect(ready).toEqual([]);
    coordinator.beginVisit("room:a");
    coordinator.beginVisit("room:b");
    commit("room:b", ["latest-b"]);
    await Promise.resolve();
    commit("room:b", ["saved-b", "latest-b"]);

    expect(loads).toEqual(["room:b:saved-b", "room:b:saved-b"]);
    expect(ready).toEqual(["room:b"]);
  });

  test.each(["return", "local-send", "human-scroll"])(
    "%s permanently supersedes a pending saved snapshot for the Room visit",
    async () => {
      const coordinator = createConversationTranscriptHydrationCoordinator();
      let resolveAround!: (loaded: boolean) => void;
      const around = new Promise<boolean>((resolve) => { resolveAround = resolve; });
      let loads = 0;
      let ready = 0;
      coordinator.beginVisit("room:b");
      coordinator.commit({
        scopeKey: "room:b",
        snapshotAnchorIds: ["saved-b"],
        committedMessageIds: ["latest-b"],
        loadHistoryAround: () => {
          loads += 1;
          return around;
        },
        isCurrent: () => true,
        onReady: () => { ready += 1; },
      });

      coordinator.supersede("room:b");
      resolveAround(true);
      await around;
      await Promise.resolve();
      coordinator.commit({
        scopeKey: "room:b",
        snapshotAnchorIds: ["saved-b"],
        committedMessageIds: ["saved-b", "latest-b"],
        loadHistoryAround: async () => {
          loads += 1;
          return true;
        },
        isCurrent: () => true,
        onReady: () => { ready += 1; },
      });

      expect(coordinator.isSuperseded("room:b")).toBe(true);
      expect(loads).toBe(1);
      expect(ready).toBe(1);
    },
  );

  test("manual scrolling and target navigation remain distinct reader-away modes", () => {
    expect(
      transitionConversationViewport("following", { type: "reader-scrolled-away" }),
    ).toBe("reader-away");
    expect(transitionConversationViewport("following", { type: "target-navigation" })).toBe(
      "target-pinned",
    );
    expect(
      transitionConversationViewport("target-pinned", {
        type: "viewport-observed",
        atLiveEdge: false,
        origin: "human",
      }),
    ).toBe("target-pinned");
    expect(
      transitionConversationViewport("target-pinned", {
        type: "viewport-observed",
        atLiveEdge: true,
        origin: "layout",
      }),
    ).toBe("following");
    expect(
      transitionConversationViewport("target-pinned", {
        type: "viewport-observed",
        atLiveEdge: true,
        origin: "human",
      }),
    ).toBe("following");
  });

  test("layout growth cannot invent reader-away intent while following", () => {
    expect(
      transitionConversationViewport("following", {
        type: "viewport-observed",
        atLiveEdge: false,
        origin: "layout",
      }),
    ).toBe("following");
    expect(
      transitionConversationViewport("following", {
        type: "viewport-observed",
        atLiveEdge: false,
        origin: "human",
      }),
    ).toBe("reader-away");
  });

  test("bounded transcript keeps following through the layout gap before tail scroll", () => {
    // A long persisted wake reply can move the physical viewport away from the
    // new bottom before assistant-ui applies its tail scroll. Windowing must
    // consume the still-authoritative reader intent rather than that transient
    // geometry, or it evicts the very tail the pending scroll needs to reach.
    expect(shouldConversationTranscriptFollowTail(true)).toBe(true);
    expect(shouldConversationTranscriptFollowTail(false)).toBe(false);
    expect(shouldConversationTranscriptFollowTail(undefined)).toBe(true);
  });

  test("a new live tail schedules a supported viewport scroll after commit", () => {
    const current = {
      followingLiveEdge: true,
      activeScopeKey: "room:a",
      activeVisitId: 4,
      readyScopeKey: "room:a",
      readyVisitId: 4,
      committedScopeKey: "room:a",
      committedVisitId: 4,
      previousTailMessageId: "tool-call-1",
      committedTailMessageId: "assistant-final-1",
    } as const;
    expect(shouldScheduleConversationLiveTailScroll(current)).toBe(true);
    expect(shouldScheduleConversationLiveTailScroll({
      ...current,
      followingLiveEdge: false,
    })).toBe(false);
    expect(shouldScheduleConversationLiveTailScroll({
      ...current,
      readyVisitId: 3,
    })).toBe(false);
    expect(shouldScheduleConversationLiveTailScroll({
      ...current,
      committedTailMessageId: "tool-call-1",
    })).toBe(false);
  });

  test("the live-tail correction executes through the scheduled viewport seam", () => {
    let pending: (() => void) | null = null;
    let cancelled = false;
    let current = true;
    let scrolls = 0;
    const cancel = scheduleConversationLiveTailScroll({
      schedule: (callback) => {
        pending = callback;
        return () => { cancelled = true; };
      },
      isCurrent: () => current,
      scrollToBottom: () => { scrolls += 1; },
    });

    expect(scrolls).toBe(0);
    pending?.();
    expect(scrolls).toBe(1);
    current = false;
    pending?.();
    expect(scrolls).toBe(1);
    cancel();
    expect(cancelled).toBe(true);
  });

  test.each([
    ["following", true, "following"],
    ["reader-away", true, "following"],
    ["target-pinned", true, "following"],
    ["returning", true, "following"],
    ["following", false, "reader-away"],
    ["reader-away", false, "reader-away"],
    ["target-pinned", false, "reader-away"],
    ["returning", false, "reader-away"],
  ] as const)("%s before Room restore atLiveEdge=%s produces %s", (mode, restoredAtLiveEdge, expected) => {
    expect(
      transitionConversationViewport(mode, {
        type: "room-switch",
        restoredAtLiveEdge,
      }),
    ).toBe(expected satisfies ConversationViewportMode);
  });

  test("the retired transcript observer pin cannot silently return", () => {
    const source = readFileSync(
      new URL("../../src/components/conversation.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("if (stick) el.scrollTop = el.scrollHeight");
    expect(source).not.toContain("const mo = new MutationObserver(pin)");
  });
});
