import { beforeEach, describe, expect, test } from "bun:test";
import type { TaskCreationReturnContext } from "@nautilo/agent";
import type { TaskCreationLiveMiniAppContext } from "@nautilo/agent";
import type { RelayCapabilities } from "@nautilo/relay";
import {
  registerTaskReturnBinding,
  registerTaskLiveMiniAppBinding,
  advanceTaskLiveMiniAppBindingDocumentVersion,
  beginTaskWriterReviewVerification,
  registerTaskWriterReviewProposal,
  claimTaskWriterReviewAcceptance,
  finishTaskWriterReviewModel,
  failTaskWriterReviewsForSession,
  isPendingTaskWriterReviewProposal,
  removeTaskReturnBindingsForRelay,
  removeTaskReturnBinding,
  releaseTaskWriterReviewAcceptanceClaim,
  hasTaskWriterReviewAcceptanceClaim,
  hasTaskWriterReviewBindingForTaskRun,
  resolveTaskWriterReviewProposal,
  failTaskWriterReviewAcceptedContinuation,
  resolveTaskReturnBinding,
  resolveTaskLiveMiniAppBinding,
  hasWriterReviewAcceptedContinuation,
  recordTaskWriterReviewReadCoverage,
  taskWriterReviewVerificationCoverageState,
  parseLiveMiniAppTaskDelegationIntent,
  taskWriterReviewProposalState,
  taskReturnBindingRegistryForTests,
} from "../../src/tasks/task-return-binding";

const context: TaskCreationReturnContext = {
  ownerId: "owner-1",
  relayId: "relay-1",
  relaySessionId: "socket-1",
  desktopSessionId: "desktop-1",
  pairingGeneration: "pairing-1",
  currentFolder: "/repo",
  workspacePath: "/workspace",
};

const liveWriterContext: TaskCreationLiveMiniAppContext = {
  ownerId: "owner-1",
  activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
  liveMiniAppSession: {
    appId: "nautilo-writer",
    sessionToken: "writer-token",
    sessionId: "writer-session",
    documentVersion: { kind: "artifact_revision", revision: 1 },
    instructions: "Writer",
  },
};

function relay(overrides: Partial<{
  userId: string | null;
  relaySessionId: string | null;
  desktopSessionId: string | null;
  pairingGeneration: string | null;
  fresh: boolean;
  capabilities: RelayCapabilities | null;
}> = {}) {
  const state = {
    userId: "owner-1" as string | null,
    relaySessionId: "socket-1" as string | null,
    desktopSessionId: "desktop-1" as string | null,
    pairingGeneration: "pairing-1" as string | null,
    fresh: true,
    capabilities: {
      profile: "desktop-agent",
      canReadWorkspace: true,
      canRunShell: true,
      canUseTerminal: true,
      canControlBrowser: true,
      currentFolderRoot: "/repo",
      workspaceRoot: "/workspace",
      browserSessionId: "browser-1",
    } as RelayCapabilities | null,
    ...overrides,
  };
  return {
    getUserId: () => state.userId,
    getRelaySessionId: () => state.relaySessionId,
    getDesktopSessionId: () => state.desktopSessionId,
    getPairingGeneration: () => state.pairingGeneration,
    getCapabilities: () => state.capabilities,
    isRelayHeartbeatFresh: () => state.fresh,
  };
}

beforeEach(() => taskReturnBindingRegistryForTests.clear());

describe("M286 live Task return binding", () => {
  test("captures and resolves the exact same live relay, roots, and Browser", () => {
    const live = relay();
    const capturedAt = Date.now();
    expect(registerTaskReturnBinding("task-1", { ...context, browserSessionId: "browser-1" }, live, capturedAt)).toBe(true);
    expect(resolveTaskReturnBinding("task-1", "owner-1", live, capturedAt)).toEqual({
      status: "available",
      browserStatus: "available",
      relayId: "relay-1",
      relaySessionId: "socket-1",
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-1",
      currentFolder: "/repo",
      workspacePath: "/workspace",
      browserSessionId: "browser-1",
      bindingCapturedAt: capturedAt,
    });
  });

  test.each([
    ["heartbeat stale", { fresh: false }, "relay_disconnected"],
    ["owner changed", { userId: "owner-2" }, "relay_owner_mismatch"],
    ["socket replaced", { relaySessionId: "socket-2" }, "relay_replaced"],
    ["Desktop replaced", { desktopSessionId: "desktop-2" }, "relay_replaced"],
    ["pairing replaced", { pairingGeneration: "pairing-2" }, "relay_replaced"],
    ["folder changed", { capabilities: { ...relay().getCapabilities()!, currentFolderRoot: "/other" } }, "folder_changed"],
    ["workspace changed", { capabilities: { ...relay().getCapabilities()!, workspaceRoot: "/other" } }, "folder_invalid"],
    ["all continuation capabilities revoked", { capabilities: {
      ...relay().getCapabilities()!,
      canReadWorkspace: false,
      canRunShell: false,
      canUseTerminal: false,
      canControlBrowser: false,
    } }, "capability_revoked"],
  ] as const)("degrades on %s", (_label, change, status) => {
    const initial = relay();
    expect(registerTaskReturnBinding("task-1", context, initial)).toBe(true);
    expect(resolveTaskReturnBinding("task-1", "owner-1", relay(change))).toEqual({ status });
  });

  test("does not substitute a changed Browser but preserves exact folder continuation", () => {
    const initial = relay();
    expect(registerTaskReturnBinding("task-1", { ...context, browserSessionId: "browser-1" }, initial)).toBe(true);
    const changed = relay({
      capabilities: { ...initial.getCapabilities()!, browserSessionId: "browser-2" },
    });
    expect(resolveTaskReturnBinding("task-1", "owner-1", changed)).toMatchObject({
      status: "available",
      browserStatus: "browser_session_expired",
      relayId: "relay-1",
    });
    expect(resolveTaskReturnBinding("task-1", "owner-1", changed).browserSessionId)
      .toBeUndefined();
  });

  test("refuses to capture a replacement socket or Browser during Task creation", () => {
    expect(registerTaskReturnBinding(
      "task-socket",
      { ...context, relaySessionId: "socket-old" },
      relay(),
    )).toBe(false);
    expect(registerTaskReturnBinding(
      "task-browser",
      { ...context, browserSessionId: "browser-old" },
      relay(),
    )).toBe(false);
    expect(taskReturnBindingRegistryForTests.size()).toBe(0);
  });

  test("disconnect cleanup removes every binding for that exact relay", () => {
    const live = relay();
    registerTaskReturnBinding("task-1", context, live);
    registerTaskReturnBinding("task-2", context, live);
    removeTaskReturnBindingsForRelay("relay-1");
    expect(taskReturnBindingRegistryForTests.size()).toBe(0);
  });

  test("relay cleanup retains an already-invalidated Writer review until its model leg settles", () => {
    const live = relay();
    expect(registerTaskReturnBinding("task-review-close", context, live)).toBe(true);
    expect(registerTaskLiveMiniAppBinding(
      "task-review-close",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    )).toBe(true);
    expect(registerTaskWriterReviewProposal({
      taskId: "task-review-close",
      taskRunId: "run-review-close",
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-review-close",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    })).toBe(true);
    expect(failTaskWriterReviewsForSession(
      "writer-session",
      "LIVE_WRITER_REVIEW_RELAY_DISCONNECTED",
    )).toEqual([]);

    removeTaskReturnBindingsForRelay("relay-1");

    expect(finishTaskWriterReviewModel("task-review-close", "run-review-close")).toMatchObject({
      resolution: {
        outcome: "failed",
        code: "LIVE_WRITER_REVIEW_RELAY_DISCONNECTED",
      },
      modelFinished: true,
    });
  });

  test("registers and re-resolves an exact Writer live session without serializing it", () => {
    expect(registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    )).toBe(true);
    expect(resolveTaskLiveMiniAppBinding("task-writer", "owner-1")).toEqual({
      status: "available",
      context: liveWriterContext,
    });
  });

  test("advances only the exact process-local Writer version after canonical acceptance", () => {
    let validation = liveWriterContext.liveMiniAppSession;
    expect(registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => validation,
    )).toBe(true);

    validation = {
      ...validation,
      documentVersion: { kind: "artifact_revision", revision: 2 },
    };
    expect(advanceTaskLiveMiniAppBindingDocumentVersion({
      taskId: "task-writer",
      ownerId: "owner-1",
      sessionId: "writer-session",
      previousDocumentVersion: { kind: "artifact_revision", revision: 1 },
      resultDocumentVersion: { kind: "artifact_revision", revision: 2 },
    })).toBe(true);
    expect(resolveTaskLiveMiniAppBinding("task-writer", "owner-1")).toEqual({
      status: "available",
      context: {
        ...liveWriterContext,
        liveMiniAppSession: {
          ...liveWriterContext.liveMiniAppSession,
          documentVersion: { kind: "artifact_revision", revision: 2 },
        },
      },
    });

    expect(advanceTaskLiveMiniAppBindingDocumentVersion({
      taskId: "task-writer",
      ownerId: "owner-1",
      sessionId: "writer-session",
      previousDocumentVersion: { kind: "artifact_revision", revision: 1 },
      resultDocumentVersion: { kind: "artifact_revision", revision: 3 },
    })).toBe(false);
  });

  test("refuses to advance when the server validator has not committed the result", () => {
    expect(registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    )).toBe(true);
    expect(advanceTaskLiveMiniAppBindingDocumentVersion({
      taskId: "task-writer",
      ownerId: "owner-1",
      sessionId: "writer-session",
      previousDocumentVersion: { kind: "artifact_revision", revision: 1 },
      resultDocumentVersion: { kind: "artifact_revision", revision: 2 },
    })).toBe(false);
    expect(resolveTaskLiveMiniAppBinding("task-writer", "owner-1")).toMatchObject({
      status: "available",
      context: { liveMiniAppSession: { documentVersion: { revision: 1 } } },
    });
  });

  test("requires complete exact-version coverage before a Writer verification Task can succeed", () => {
    const validation = {
      ...liveWriterContext.liveMiniAppSession,
      documentVersion: { kind: "artifact_revision" as const, revision: 2 },
    };
    const captured = {
      ...liveWriterContext,
      liveMiniAppSession: validation,
    };
    expect(registerTaskLiveMiniAppBinding("task-verify", captured, () => validation)).toBe(true);
    expect(beginTaskWriterReviewVerification({
      taskId: "task-verify", taskRunId: "run-verify", ownerId: "owner-1",
    })).toBe(true);
    expect(taskWriterReviewVerificationCoverageState({
      taskId: "task-verify", taskRunId: "run-verify", ownerId: "owner-1",
    })).toBe("incomplete");

    // A read from the proposal's old revision and a partial reread are both
    // structurally insufficient for this exact verification run.
    expect(recordTaskWriterReviewReadCoverage({
      taskId: "task-verify", taskRunId: "run-verify", ownerId: "owner-1",
      coverage: {
        kind: "block_range",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        blockCount: 2,
        blockIndexes: [0, 1],
      },
    })).toBe(false);
    expect(recordTaskWriterReviewReadCoverage({
      taskId: "task-verify", taskRunId: "run-verify", ownerId: "owner-1",
      coverage: {
        kind: "block_range",
        documentVersion: { kind: "artifact_revision", revision: 2 },
        blockCount: 2,
        blockIndexes: [0],
      },
    })).toBe(true);
    expect(taskWriterReviewVerificationCoverageState({
      taskId: "task-verify", taskRunId: "run-verify", ownerId: "owner-1",
    })).toBe("incomplete");

    expect(recordTaskWriterReviewReadCoverage({
      taskId: "task-verify", taskRunId: "run-verify", ownerId: "owner-1",
      coverage: {
        kind: "block_range",
        documentVersion: { kind: "artifact_revision", revision: 2 },
        blockCount: 2,
        blockIndexes: [1],
      },
    })).toBe(true);
    expect(taskWriterReviewVerificationCoverageState({
      taskId: "task-verify", taskRunId: "run-verify", ownerId: "owner-1",
    })).toBe("complete");
  });

  test("requires every paginated table page as part of complete Writer verification coverage", () => {
    const validation = {
      ...liveWriterContext.liveMiniAppSession,
      documentVersion: { kind: "artifact_revision" as const, revision: 2 },
    };
    expect(registerTaskLiveMiniAppBinding("task-table-verify", {
      ...liveWriterContext,
      liveMiniAppSession: validation,
    }, () => validation)).toBe(true);
    expect(beginTaskWriterReviewVerification({
      taskId: "task-table-verify", taskRunId: "run-table-verify", ownerId: "owner-1",
    })).toBe(true);
    const version = { kind: "artifact_revision" as const, revision: 2 };
    const start = { rowIndex: 0, colIndex: 0, blockIndex: 0, sliceIndex: 0 };
    const second = { rowIndex: 50, colIndex: 0, blockIndex: 0, sliceIndex: 0 };
    expect(recordTaskWriterReviewReadCoverage({
      taskId: "task-table-verify", taskRunId: "run-table-verify", ownerId: "owner-1",
      coverage: { kind: "block_range", documentVersion: version, blockCount: 2, blockIndexes: [0] },
    })).toBe(true);
    expect(recordTaskWriterReviewReadCoverage({
      taskId: "task-table-verify", taskRunId: "run-table-verify", ownerId: "owner-1",
      coverage: { kind: "table_page", documentVersion: version, blockCount: 2, tableBlockIndex: 1, cursor: start, nextCursor: second },
    })).toBe(true);
    expect(taskWriterReviewVerificationCoverageState({
      taskId: "task-table-verify", taskRunId: "run-table-verify", ownerId: "owner-1",
    })).toBe("incomplete");
    expect(recordTaskWriterReviewReadCoverage({
      taskId: "task-table-verify", taskRunId: "run-table-verify", ownerId: "owner-1",
      coverage: { kind: "table_page", documentVersion: version, blockCount: 2, tableBlockIndex: 1, cursor: second, nextCursor: null },
    })).toBe(true);
    expect(taskWriterReviewVerificationCoverageState({
      taskId: "task-table-verify", taskRunId: "run-table-verify", ownerId: "owner-1",
    })).toBe("complete");
  });

  test("counts a Task with both return and Writer bindings only once", () => {
    expect(registerTaskReturnBinding("task-writer", context, relay())).toBe(true);
    expect(registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    )).toBe(true);
    expect(taskReturnBindingRegistryForTests.size()).toBe(1);
  });

  test.each([
    ["closed", null],
    ["stale", { ...liveWriterContext.liveMiniAppSession, documentVersion: { kind: "artifact_revision" as const, revision: 2 } }],
  ])("fails closed when Writer session is %s", (_label, nextValidation) => {
    let validation: typeof liveWriterContext.liveMiniAppSession | null = liveWriterContext.liveMiniAppSession;
    registerTaskLiveMiniAppBinding("task-writer", liveWriterContext, () => validation);
    validation = nextValidation;
    expect(resolveTaskLiveMiniAppBinding("task-writer", "owner-1")).toEqual({ status: "session_unavailable" });
  });

  test("uses dynamic captured app identity for a live review binding", () => {
    const genericContext = {
      ...liveWriterContext,
      activeMiniApp: { appId: "example-live-app", updatedAt: 1 },
      liveMiniAppSession: { ...liveWriterContext.liveMiniAppSession, appId: "example-live-app" },
    };
    expect(registerTaskLiveMiniAppBinding(
      "task-generic-live-app",
      genericContext,
      () => genericContext.liveMiniAppSession,
    )).toBe(true);
    expect(resolveTaskLiveMiniAppBinding("task-generic-live-app", "owner-1")).toMatchObject({
      status: "available",
      context: genericContext,
    });
    expect(registerTaskWriterReviewProposal({
      taskId: "task-generic-live-app",
      taskRunId: "run-generic",
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-generic",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    })).toBe(true);
  });

  test("parses only the compact durable live-app delegation intent", () => {
    expect(parseLiveMiniAppTaskDelegationIntent({
      liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" },
    })).toEqual({ version: 1, appId: "nautilo-writer" });
    expect(parseLiveMiniAppTaskDelegationIntent({
      liveMiniAppTaskDelegation: { version: 2, appId: "nautilo-writer", sessionToken: "nope" },
    })).toBeNull();
  });

  test("projects only a complete accepted Writer receipt into continuation truth", () => {
    expect(hasWriterReviewAcceptedContinuation({
      writerReviewAcceptedReceipt: {
        version: 1,
        taskRunId: "run-accepted",
        proposalId: "proposal-accepted",
        acceptedResultRevision: { kind: "sha256", sha256: "receipt-secret" },
      },
    })).toBe(true);
    expect(hasWriterReviewAcceptedContinuation({
      writerReviewAcceptedReceipt: {
        version: 1,
        taskRunId: "run-without-result",
        proposalId: "proposal-without-result",
      },
    })).toBe(false);
    expect(hasWriterReviewAcceptedContinuation({
      writerReviewAcceptedReceipt: {
        version: 2,
        taskRunId: "run-wrong-version",
        proposalId: "proposal-wrong-version",
        acceptedResultRevision: {},
      },
    })).toBe(false);
  });

  test("binds a proposal to the exact TaskRun and waits for persisted acceptance", () => {
    expect(registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    )).toBe(true);
    expect(registerTaskWriterReviewProposal({
      taskId: "task-writer",
      taskRunId: "run-1",
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    })).toBe(true);

    expect(hasTaskWriterReviewBindingForTaskRun({
      taskId: "task-writer",
      taskRunId: "run-1",
      ownerId: "owner-1",
    })).toBe(true);
    expect(hasTaskWriterReviewBindingForTaskRun({
      taskId: "task-writer",
      taskRunId: "different-run",
      ownerId: "owner-1",
    })).toBe(false);
    expect(hasTaskWriterReviewBindingForTaskRun({
      taskId: "task-writer",
      taskRunId: "run-1",
      ownerId: "different-owner",
    })).toBe(false);
    expect(hasTaskWriterReviewBindingForTaskRun({
      taskId: "different-task",
      taskRunId: "run-1",
      ownerId: "owner-1",
    })).toBe(false);

    expect(finishTaskWriterReviewModel("task-writer", "wrong-run")).toBeNull();
    expect(finishTaskWriterReviewModel("task-writer", "run-1")).toMatchObject({
      modelFinished: true,
      resolution: null,
    });
    expect(isPendingTaskWriterReviewProposal({
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    })).toBe(true);
    expect(resolveTaskWriterReviewProposal({
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision", revision: 1 },
      resolution: {
        outcome: "accepted",
        documentVersion: { kind: "artifact_revision", revision: 2 },
      },
    })).toMatchObject({
      status: "resolved",
      finalizeNow: true,
      binding: { taskId: "task-writer", taskRunId: "run-1" },
    });
    expect(isPendingTaskWriterReviewProposal({
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    })).toBe(false);
  });

  test("fails closed across owners, versions, conflicting duplicates, and superseded proposals", () => {
    registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    );
    registerTaskWriterReviewProposal({
      taskId: "task-writer",
      taskRunId: "run-1",
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-old",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    });
    registerTaskWriterReviewProposal({
      taskId: "task-writer",
      taskRunId: "run-1",
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-new",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    });
    const base = {
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-new",
      documentVersion: { kind: "artifact_revision" as const, revision: 1 },
      resolution: { outcome: "rejected" as const },
    };
    expect(resolveTaskWriterReviewProposal({ ...base, proposalId: "proposal-old" }))
      .toEqual({ status: "not_found" });
    expect(taskWriterReviewProposalState({
      ...base,
      ownerId: "owner-2",
    })).toBe("closed");
    expect(taskWriterReviewProposalState({
      ...base,
      documentVersion: { kind: "artifact_revision", revision: 2 },
    })).toBe("closed");
    expect(resolveTaskWriterReviewProposal({ ...base, ownerId: "owner-2" }))
      .toEqual({ status: "conflict" });
    expect(resolveTaskWriterReviewProposal({
      ...base,
      documentVersion: { kind: "artifact_revision", revision: 2 },
    })).toEqual({ status: "conflict" });
    expect(resolveTaskWriterReviewProposal(base)).toMatchObject({
      status: "resolved",
      finalizeNow: false,
    });
    expect(taskWriterReviewProposalState(base)).toBe("closed");
    expect(resolveTaskWriterReviewProposal(base)).toMatchObject({
      status: "resolved",
      finalizeNow: false,
    });
    expect(resolveTaskWriterReviewProposal({
      ...base,
      resolution: {
        outcome: "accepted",
        documentVersion: { kind: "artifact_revision", revision: 2 },
      },
    })).toEqual({ status: "conflict" });
  });

  test("session closure turns unresolved reviews into exact failures", () => {
    registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    );
    registerTaskWriterReviewProposal({
      taskId: "task-writer",
      taskRunId: "run-1",
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-1",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    });
    finishTaskWriterReviewModel("task-writer", "run-1");
    const failed = failTaskWriterReviewsForSession("writer-session", "SESSION_CLOSED");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      taskId: "task-writer",
      resolution: { outcome: "failed", code: "SESSION_CLOSED" },
    });
  });

  test("retains exact bounded invalidation identity after Task lifecycle cleanup", () => {
    registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    );
    registerTaskWriterReviewProposal({
      taskId: "task-writer",
      taskRunId: "run-1",
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-stopped",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    });
    removeTaskReturnBinding("task-writer");
    expect(claimTaskWriterReviewAcceptance({
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-stopped",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    })).toEqual({ status: "invalidated", taskId: "task-writer", taskRunId: "run-1" });
  });

  test("acceptance claim fences cleanup until the exact failed save releases it", () => {
    registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    );
    registerTaskWriterReviewProposal({
      taskId: "task-writer",
      taskRunId: "run-1",
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-claim",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    });
    const exact = {
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-claim",
      documentVersion: { kind: "artifact_revision" as const, revision: 1 },
    };
    expect(claimTaskWriterReviewAcceptance(exact)).toMatchObject({ status: "pending" });
    expect(hasTaskWriterReviewAcceptanceClaim("task-writer")).toBe(true);
    removeTaskReturnBinding("task-writer");
    expect(claimTaskWriterReviewAcceptance(exact)).toMatchObject({ status: "pending" });
    expect(releaseTaskWriterReviewAcceptanceClaim(exact)).toBe(true);
    expect(hasTaskWriterReviewAcceptanceClaim("task-writer")).toBe(false);
    removeTaskReturnBinding("task-writer");
    expect(claimTaskWriterReviewAcceptance(exact)).toMatchObject({ status: "invalidated" });
  });

  test("acceptance claim fences rejection and session loss, then admits an exact accepted retry", () => {
    registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    );
    registerTaskWriterReviewProposal({
      taskId: "task-writer",
      taskRunId: "run-1",
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-accepted-claim",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    });
    const exact = {
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-accepted-claim",
      documentVersion: { kind: "artifact_revision" as const, revision: 1 },
    };
    expect(claimTaskWriterReviewAcceptance(exact)).toMatchObject({ status: "pending" });
    expect(resolveTaskWriterReviewProposal({
      ...exact,
      resolution: { outcome: "rejected" },
    })).toEqual({ status: "conflict" });
    expect(failTaskWriterReviewsForSession("writer-session", "SESSION_CLOSED")).toEqual([]);
    expect(resolveTaskWriterReviewProposal({
      ...exact,
      resolution: {
        outcome: "accepted",
        documentVersion: { kind: "artifact_revision", revision: 2 },
      },
    })).toMatchObject({ status: "resolved", finalizeNow: false });
    expect(releaseTaskWriterReviewAcceptanceClaim(exact)).toBe(false);
    expect(claimTaskWriterReviewAcceptance(exact)).toMatchObject({ status: "pending" });
  });

  test("server-owned post-write failure releases an exact acceptance claim without requeue authority", () => {
    registerTaskLiveMiniAppBinding(
      "task-writer",
      liveWriterContext,
      () => liveWriterContext.liveMiniAppSession,
    );
    registerTaskWriterReviewProposal({
      taskId: "task-writer",
      taskRunId: "run-post-write-failure",
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-post-write-failure",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    });
    const admission = claimTaskWriterReviewAcceptance({
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-post-write-failure",
      documentVersion: { kind: "artifact_revision", revision: 1 },
    });
    expect(admission.status).toBe("pending");
    if (admission.status !== "pending") return;
    expect(failTaskWriterReviewAcceptedContinuation(
      admission.binding,
      "LIVE_WRITER_VERIFICATION_SESSION_UNAVAILABLE",
    )).toMatchObject({
      status: "resolved",
      finalizeNow: false,
      binding: {
        acceptanceClaimed: false,
        resolution: {
          outcome: "failed",
          code: "LIVE_WRITER_VERIFICATION_SESSION_UNAVAILABLE",
        },
      },
    });
    expect(resolveTaskWriterReviewProposal({
      ownerId: "owner-1",
      sessionId: "writer-session",
      proposalId: "proposal-post-write-failure",
      documentVersion: { kind: "artifact_revision", revision: 1 },
      resolution: {
        outcome: "accepted",
        documentVersion: { kind: "artifact_revision", revision: 2 },
      },
    })).toEqual({ status: "conflict" });
  });

  test("fails closed for a different owner", () => {
    registerTaskLiveMiniAppBinding("task-writer", liveWriterContext, () => liveWriterContext.liveMiniAppSession);
    expect(resolveTaskLiveMiniAppBinding("task-writer", "owner-2")).toEqual({ status: "session_unavailable" });
  });
});
