import { describe, expect, test } from "bun:test";
import {
  canCommitProtectedHistoryAuthorityDemand,
  canAcknowledgeInitialHistoryTranscriptCommit,
  createDomainKeyRecipientSyncScheduler,
  initialHistoryServerDisposition,
  mountedKeyWaitingHistorySelection,
  mountedKeyWaitingHistorySelections,
  refreshMountedKeyWaitingHistorySnapshot,
  protectedHistoryRecipientSyncCoordinate,
  replayableProtectedHistoryAuthorityDemand,
  roomHistoryContainsUnavailableMessage,
  roomHistoryWaitsOnlyForKeys,
  roomInitialHistoryAdmission,
  shouldDemandProtectedHistoryAuthority,
  shouldRefreshInitialHistoryAfterDomainDelivery,
  shouldDeferBackgroundHistoryProjection,
} from "./nautilo-runtime";
import type { RoomInitialHydrationScope, RoomInitialHydrationState } from "./room-initial-hydration";
import { replaceRefreshedRoomMessage } from "./room-history-around";

function scope(overrides: Partial<RoomInitialHydrationScope> = {}): RoomInitialHydrationScope {
  return {
    origin: "https://server-a.example",
    viewerKey: "viewer-a",
    viewerGeneration: 3,
    roomId: "room-a",
    generation: 8,
    ...overrides,
  };
}

function admission(state: RoomInitialHydrationState | null, overrides = {}) {
  return roomInitialHistoryAdmission({
    state,
    origin: "https://server-a.example",
    viewerKey: "viewer-a",
    viewerGeneration: 3,
    roomId: "room-a",
    ...overrides,
  });
}

describe("D530 runtime initial-history admission", () => {
  test("keeps token bootstrap pending and treats live arrival during an empty page as ready", () => {
    expect(initialHistoryServerDisposition({ status: "no-token" })).toBe("pending");
    expect(initialHistoryServerDisposition({ status: "empty", reconciledMessageCount: 0 })).toBe("empty");
    expect(initialHistoryServerDisposition({ status: "empty", reconciledMessageCount: 1 })).toBe("ready");
    expect(initialHistoryServerDisposition({ status: "failed" })).toBe("recoverable-error");
    expect(initialHistoryServerDisposition({ status: "failed", failureClass: "key_waiting" }))
      .toBe("waiting-for-authority");
    expect(initialHistoryServerDisposition({ status: "ok", containsUnavailableHistory: true }))
      .toBe("waiting-for-authority");
    expect(initialHistoryServerDisposition({ status: "unauthorized" })).toBe("access-terminal-error");
    expect(initialHistoryServerDisposition({ status: "not-found" })).toBe("access-terminal-error");
  });

  test("acknowledges timing only after the exact selected generation rendered its frame", () => {
    const active = scope();
    expect(canAcknowledgeInitialHistoryTranscriptCommit({
      activeScope: active,
      pendingScope: active,
      projectedMessageIds: ["a", "b"],
      renderedMessageIds: ["a", "b"],
    })).toBe(true);
    expect(canAcknowledgeInitialHistoryTranscriptCommit({
      activeScope: scope({ generation: 9 }),
      pendingScope: active,
      projectedMessageIds: ["a"],
      renderedMessageIds: ["a"],
    })).toBe(false);
    expect(canAcknowledgeInitialHistoryTranscriptCommit({
      activeScope: active,
      pendingScope: active,
      projectedMessageIds: ["a"],
      renderedMessageIds: ["b"],
    })).toBe(false);
  });

  test("defers a normal background projection when a stream begins after dispatch", () => {
    expect(shouldDeferBackgroundHistoryProjection({
      backgroundRefresh: true,
      hasActiveStream: true,
      isRunning: false,
      resultStatus: "ok",
    })).toBe(true);
    expect(shouldDeferBackgroundHistoryProjection({
      backgroundRefresh: true,
      hasActiveStream: false,
      isRunning: true,
      resultStatus: "empty",
    })).toBe(true);
    expect(shouldDeferBackgroundHistoryProjection({
      backgroundRefresh: true,
      hasActiveStream: true,
      isRunning: true,
      resultStatus: "not-found",
    })).toBe(false);
    expect(shouldDeferBackgroundHistoryProjection({
      backgroundRefresh: false,
      hasActiveStream: true,
      isRunning: true,
      resultStatus: "ok",
    })).toBe(false);
  });

  test("shows a cache-backed syncing transcript but never admits send", () => {
    expect(admission({ kind: "syncing", scope: scope() })).toEqual({
      displayTranscript: true,
      sendAuthorized: false,
    });
  });

  test("treats a context for another Room, viewer generation, or server as unresolved", () => {
    const ready: RoomInitialHydrationState = { kind: "ready", scope: scope() };

    for (const input of [
      { roomId: "room-b" },
      { viewerGeneration: 4 },
      { origin: "https://server-b.example" },
    ]) {
      expect(admission(ready, input)).toEqual({
        displayTranscript: false,
        sendAuthorized: false,
      });
    }
  });

  test("authoritative success and empty states both admit the exact selected Room", () => {
    expect(admission({ kind: "ready", scope: scope() })).toEqual({
      displayTranscript: true,
      sendAuthorized: true,
    });
    expect(admission({ kind: "empty", scope: scope() })).toEqual({
      displayTranscript: true,
      sendAuthorized: true,
    });
  });

  test("recoverable failures only retain a permitted stale cache frame and never send", () => {
    expect(admission({
      kind: "recoverable-error",
      scope: scope(),
      retainsCachedFrame: true,
    })).toEqual({ displayTranscript: true, sendAuthorized: false });
    expect(admission({
      kind: "recoverable-error",
      scope: scope(),
      retainsCachedFrame: false,
    })).toEqual({ displayTranscript: false, sendAuthorized: false });
  });

  test("authority waiting preserves a resolved partial transcript and its separately gated send path", () => {
    expect(admission({
      kind: "waiting-for-authority",
      scope: scope(),
      sendAuthorized: true,
    })).toEqual({
      displayTranscript: true,
      sendAuthorized: true,
    });
    expect(admission({
      kind: "waiting-for-authority",
      scope: scope(),
      sendAuthorized: false,
    })).toEqual({
      displayTranscript: true,
      sendAuthorized: false,
    });
  });

  test("verified Domain delivery selects an exact waiting row without replacing its page", () => {
    const unavailable = [{
      id: "42",
      role: "user" as const,
      content: [{ type: "text" as const, text: "Encrypted history is unavailable on this device." }],
      metadata: { custom: { historyUnavailable: true, historyUnavailableReason: "key_waiting" } },
    }];
    expect(roomHistoryContainsUnavailableMessage(unavailable)).toBe(true);
    expect(roomHistoryWaitsOnlyForKeys(unavailable)).toBe(true);
    expect(mountedKeyWaitingHistorySelection("room-a", unavailable)).toEqual({
      roomId: "room-a",
      messageId: 42,
      revision: 0,
    });
    expect(mountedKeyWaitingHistorySelection("room-a", [{
      ...unavailable[0]!,
      metadata: { custom: { historyUnavailable: true, historyUnavailableReason: "integrity" } },
    }])).toBeNull();
    expect(shouldRefreshInitialHistoryAfterDomainDelivery({
      eventRoomId: "room-a",
      activeRoomId: "room-a",
      hydrationState: { kind: "waiting-for-authority", scope: scope(), sendAuthorized: false },
    })).toBe(true);
    expect(shouldRefreshInitialHistoryAfterDomainDelivery({
      eventRoomId: "room-b",
      activeRoomId: "room-a",
      hydrationState: { kind: "waiting-for-authority", scope: scope(), sendAuthorized: false },
    })).toBe(false);
    expect(shouldRefreshInitialHistoryAfterDomainDelivery({
      eventRoomId: "room-a",
      activeRoomId: "room-a",
      hydrationState: { kind: "waiting-for-authority", scope: scope(), sendAuthorized: true },
    })).toBe(false);

    expect(roomHistoryWaitsOnlyForKeys([
      ...unavailable,
      {
        id: "43",
        role: "user",
        content: [{ type: "text", text: "Encrypted history is unavailable on this device." }],
        metadata: { custom: { historyUnavailable: true, historyUnavailableReason: "integrity" } },
      },
    ])).toBe(false);
  });

  test("exact delivery refresh preserves loaded older and live-tail projections", () => {
    const older = { id: "11", role: "user" as const, content: [{ type: "text" as const, text: "older" }] };
    const waiting = {
      id: "42",
      role: "user" as const,
      content: [{ type: "text" as const, text: "Encrypted history is unavailable on this device." }],
      metadata: { custom: { historyUnavailable: true, historyUnavailableReason: "key_waiting" } },
    };
    const liveTail = { id: "local-live", role: "user" as const, content: [{ type: "text" as const, text: "draft send" }] };
    const verified = { id: "42", role: "user" as const, content: [{ type: "text" as const, text: "opened" }] };

    const refreshed = replaceRefreshedRoomMessage(
      [older, waiting, liveTail],
      [verified],
      "42",
    );

    expect(refreshed).toEqual([older, verified, liveTail]);
    expect(refreshed[0]).toBe(older);
    expect(refreshed[2]).toBe(liveTail);
  });

  test("Full delivery refreshes the finite mounted snapshot without a backfill scheduler", async () => {
    const messages = [11, 42, 77].map((id, index) => ({
      id: String(id),
      role: "user" as const,
      content: [{ type: "text" as const, text: "Encrypted history is unavailable on this device." }],
      metadata: { custom: {
        historyUnavailable: true,
        historyUnavailableReason: "key_waiting",
        editRevision: index,
      } },
    }));
    const selections = mountedKeyWaitingHistorySelections("room-a", messages);
    const refreshed: number[] = [];

    expect(await refreshMountedKeyWaitingHistorySnapshot({
      selections,
      isCurrent: () => true,
      refresh: async (selection) => {
        refreshed.push(selection.messageId);
        return "refreshed";
      },
    })).toBe("completed");
    expect(refreshed).toEqual([11, 42, 77]);
    expect(selections.map((selection) => selection.revision)).toEqual([0, 1, 2]);
  });

  test("delivery snapshot stops on retry, ignored work, and a Room/viewer generation switch", async () => {
    const selections = [11, 42, 77].map((messageId) => ({
      roomId: "room-a",
      messageId,
      revision: 0,
    }));
    const retryCalls: number[] = [];
    expect(await refreshMountedKeyWaitingHistorySnapshot({
      selections,
      isCurrent: () => true,
      refresh: async (selection) => {
        retryCalls.push(selection.messageId);
        return selection.messageId === 42 ? "retry" : "refreshed";
      },
    })).toBe("retry");
    expect(retryCalls).toEqual([11, 42]);

    const ignoredCalls: number[] = [];
    expect(await refreshMountedKeyWaitingHistorySnapshot({
      selections,
      isCurrent: () => true,
      refresh: async (selection) => {
        ignoredCalls.push(selection.messageId);
        return selection.messageId === 42 ? "ignored" : "refreshed";
      },
    })).toBe("ignored");
    expect(ignoredCalls).toEqual([11, 42]);

    let current = true;
    const cancelledCalls: number[] = [];
    expect(await refreshMountedKeyWaitingHistorySnapshot({
      selections,
      isCurrent: () => current,
      refresh: async (selection) => {
        cancelledCalls.push(selection.messageId);
        current = false;
        return "refreshed";
      },
    })).toBe("cancelled");
    expect(cancelledCalls).toEqual([11]);
  });

  test("cold authority demand keeps display and top-level source Room coordinates distinct", () => {
    expect(protectedHistoryRecipientSyncCoordinate("room-open", {
      id: "room-open",
      namespaceId: "namespace-open",
      kind: "open",
      parentRoomId: null,
    })).toEqual({
      displayRoomId: "room-open",
      sourceRoomId: "room-open",
      namespaceId: "namespace-open",
    });
    expect(protectedHistoryRecipientSyncCoordinate("room-child", {
      id: "room-child",
      namespaceId: "namespace-open",
      kind: "subthread",
      parentRoomId: "room-open",
    })).toEqual({
      displayRoomId: "room-child",
      sourceRoomId: "room-open",
      namespaceId: "namespace-open",
    });
    expect(protectedHistoryRecipientSyncCoordinate("room-other", {
      id: "room-child",
      namespaceId: "namespace-open",
      kind: "subthread",
      parentRoomId: "room-open",
    })).toBeNull();
    expect(protectedHistoryRecipientSyncCoordinate("room-access", {
      id: "room-access",
      namespaceId: "namespace-access",
      kind: "access",
      parentRoomId: null,
    })).toBeNull();
  });

  test("a terminal stream transition re-demands waiting authority only after every stream is gone", () => {
    const waiting = { kind: "waiting-for-authority", scope: scope(), sendAuthorized: true } as const;
    const base = {
      admissionReady: true,
      wsState: "open" as const,
      activeRoomId: "room-a",
      hydrationState: waiting,
    };

    expect(shouldDemandProtectedHistoryAuthority({
      ...base,
      isRunning: true,
      activeStreamCount: 1,
    })).toBe(false);
    expect(shouldDemandProtectedHistoryAuthority({
      ...base,
      isRunning: false,
      activeStreamCount: 1,
    })).toBe(false);
    expect(shouldDemandProtectedHistoryAuthority({
      ...base,
      isRunning: false,
      activeStreamCount: 0,
    })).toBe(true);

    expect(shouldDemandProtectedHistoryAuthority({
      ...base,
      wsState: "closed",
      isRunning: false,
      activeStreamCount: 0,
    })).toBe(false);
    expect(shouldDemandProtectedHistoryAuthority({
      ...base,
      admissionReady: false,
      isRunning: false,
      activeStreamCount: 0,
    })).toBe(false);
    expect(shouldDemandProtectedHistoryAuthority({
      ...base,
      activeRoomId: "room-b",
      isRunning: false,
      activeStreamCount: 0,
    })).toBe(false);
  });

  test("an asynchronous authority-demand lookup commits only to its exact Room, viewer, and origin", () => {
    const base = {
      admissionCurrent: true,
      requestedDisplayRoomId: "room-a",
      activeRoomId: "room-a",
      requestedViewerKey: "viewer-a",
      currentViewerKey: "viewer-a",
      requestedViewerGeneration: 3,
      currentViewerGeneration: 3,
      requestedOrigin: "https://server-a.example",
      currentOrigin: "https://server-a.example",
    };

    expect(canCommitProtectedHistoryAuthorityDemand(base)).toBe(true);
    for (const changed of [
      { admissionCurrent: false },
      { activeRoomId: "room-b" },
      { currentViewerKey: "viewer-b" },
      { currentViewerGeneration: 4 },
      { currentOrigin: "https://server-b.example" },
    ]) {
      expect(canCommitProtectedHistoryAuthorityDemand({ ...base, ...changed })).toBe(false);
    }
  });

  test("an observed authority wait replays when the recipient client becomes ready", () => {
    expect(replayableProtectedHistoryAuthorityDemand({
      observedRoomId: "room-a",
      activeRoomId: "room-a",
      recipientSyncReady: false,
    })).toBeNull();
    expect(replayableProtectedHistoryAuthorityDemand({
      observedRoomId: "room-a",
      activeRoomId: "room-a",
      recipientSyncReady: true,
    })).toBe("room-a");
    expect(replayableProtectedHistoryAuthorityDemand({
      observedRoomId: "room-a",
      activeRoomId: "room-b",
      recipientSyncReady: true,
    })).toBeNull();
    expect(replayableProtectedHistoryAuthorityDemand({
      observedRoomId: null,
      activeRoomId: "room-a",
      recipientSyncReady: true,
    })).toBeNull();
  });

  test("recipient sync retries false results and wakes only the successful display Room", async () => {
    const scheduled: Array<() => void> = [];
    const calls: string[] = [];
    const readyRooms: string[] = [];
    let ready = false;
    const scheduler = createDomainKeyRecipientSyncScheduler({
      service: async (roomId, namespaceId, keyClass) => {
        calls.push(`${roomId}:${namespaceId}:${keyClass}`);
        return ready;
      },
      onReady: (roomId) => readyRooms.push(roomId),
      schedule: (run) => {
        scheduled.push(run);
        return () => undefined;
      },
    });
    try {
      scheduler.enqueue("room-child", "namespace-open", "room-open");
      expect(scheduled).toHaveLength(1);
      scheduled.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toEqual([
        "room-open:namespace-open:human",
        "room-open:namespace-open:ai",
      ]);
      expect(readyRooms).toEqual([]);
      expect(scheduled).toHaveLength(1);

      ready = true;
      scheduled.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(readyRooms).toEqual(["room-child"]);
      expect(scheduled).toHaveLength(0);
    } finally {
      scheduler.dispose();
    }
  });

  test("an authoritative reconnect or post-PIN ready projection restores display and send", () => {
    const recovered: RoomInitialHydrationState = { kind: "ready", scope: scope() };

    expect(admission(recovered)).toEqual({
      displayTranscript: true,
      sendAuthorized: true,
    });
    expect(initialHistoryServerDisposition({ status: "not-found" })).toBe("access-terminal-error");
  });
});
