import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { FastifyRequest } from "fastify";
import { setLogOutput } from "@nautilo/logger";
import { getAgentTurnContextByKey } from "@nautilo/agent";
import {
  createMaintenanceAcceptanceAuthority,
  notifyRedirectCompletion,
  turnContextKey,
  type RoomMemberView,
} from "@nautilo/runtime";
import {
  createAcceptedInvocationAuthority,
  type ActiveFocus,
  type FocusDb,
} from "@nautilo/trust";
import type { ChatRoutesDeps } from "../../src/routes/chat";
import { executeAgentMediatedRoomMessage } from "../../src/messaging/agent-mediated";
import {
  AGENT_REDIRECT_PENDING_TIMEOUT_MS,
  _resetAgentRedirectHandlerForTests,
  _setAgentRedirectPendingTimeoutMsForTests,
  getPendingAgentRedirect,
  installAgentRedirectCompletionHandler,
  isRedirectAllowedForConductorWake,
  pendingAgentRedirectCount,
  registerPendingAgentRedirect,
  type PendingAgentRedirectContext,
  type RedirectHandlerDeps,
  uninstallAgentRedirectCompletionHandler,
} from "../../src/messaging/agent-redirect-handler";

const TURN = "human-turn-1";
const SOURCE_AGENT = "agent-source";
const SOURCE_ACTOR = "actor-source";
const TARGET_AGENT = "agent-target";
const TARGET_ACTOR = "actor-target";
const KEY = turnContextKey(TURN, SOURCE_AGENT);

const source: RoomMemberView = {
  kind: "agent",
  actorId: SOURCE_ACTOR,
  agentId: SOURCE_AGENT,
  handle: "source",
  agentResponseMode: "active",
};
const target: RoomMemberView = {
  kind: "agent",
  actorId: TARGET_ACTOR,
  agentId: TARGET_AGENT,
  handle: "target",
  agentResponseMode: "active",
};

type Emitted = Parameters<RedirectHandlerDeps["emit"]>[0];

function hasReceipt(events: Emitted[], reasonCode: string): boolean {
  return events.some(
    (event) =>
      event.type === "conductor.decision" && event.reasonCode === reasonCode,
  );
}

function setup(overrides: {
  members?: RoomMemberView[];
  silence?: Array<{ botActorId: string | null; kind: "mute" | "deaf" }>;
  active?: ActiveFocus[];
  enqueueError?: Error;
  redirectAllowed?: boolean;
  sourceDepth?: number;
  sourceWakeAccepted?: boolean;
  rosterError?: Error;
  silenceError?: Error;
  focusError?: Error;
} = {}) {
  const emitted: Emitted[] = [];
  const enqueues: Array<{
    target: { actorId: string; agentId: string; handle: string };
    original: PendingAgentRedirectContext["original"];
    continuation: {
      humanTurnId: string;
      persistedMessageId: number | null;
      acceptanceAuthority: ReturnType<typeof createMaintenanceAcceptanceAuthority>;
      invocationAuthority: ReturnType<typeof createAcceptedInvocationAuthority>;
      humanAlreadyPersisted: true;
      redirectDepth: 1;
      redirectAllowed: false;
    };
  }> = [];
  const clears: string[] = [];
  const opens: string[] = [];
  const loadFoci: RedirectHandlerDeps["loadActiveFoci"] = async () => {
    if (overrides.focusError) throw overrides.focusError;
    return overrides.active ?? [
      {
        focusId: "focus-source",
        botActorId: SOURCE_ACTOR,
        expiresAt: new Date(Date.now() + 60_000),
        openedSource: "inferred",
      },
      {
        focusId: "focus-unrelated",
        botActorId: "actor-unrelated",
        expiresAt: new Date(Date.now() + 60_000),
        openedSource: "inferred",
      },
    ];
  };
  const clearSourceFocus: RedirectHandlerDeps["clearFocus"] = async (
    _db,
    args,
  ) => {
    clears.push(args.focusId);
    return { botActorId: SOURCE_ACTOR };
  };
  const openTargetFocus: RedirectHandlerDeps["openOrExtendFocus"] = async (
    _db,
    args,
  ) => {
    opens.push(args.botActorId);
    return {
      focusId: "focus-target",
      expiresAt: new Date(Date.now() + 60_000),
      created: true,
    };
  };
  const deps: Partial<RedirectHandlerDeps> = {
    getDb: () => ({}) as FocusDb,
    loadActiveFoci: loadFoci,
    clearFocus: clearSourceFocus,
    openOrExtendFocus: openTargetFocus,
    emit: (event) => emitted.push(event),
    now: () => new Date("2026-07-19T18:00:00.000Z"),
  };
  installAgentRedirectCompletionHandler(deps);
  const authority = createMaintenanceAcceptanceAuthority();
  const invocationAuthority = createAcceptedInvocationAuthority("user-1");
  const original: PendingAgentRedirectContext["original"] = {
    content: "full original content",
    voiceMode: true,
    currentFolder: "/workspace/current",
    workspacePath: "/workspace",
    activeMiniApp: { appId: "app-1", updatedAt: 1 },
    liveMiniAppSession: null,
    attachmentRefs: ["attachment-1"],
    artifactRefs: [
      {
        artifactId: "artifact-1",
        path: "docs/a.md",
        mimeType: "text/markdown",
        size: 10,
      },
    ],
    focusedResources: [
      { kind: "workspace-artifact", artifactId: "artifact-2" },
    ],
    model: "anthropic:test",
    replyToMessageId: 77,
    subthreadParentRoomId: "room-parent",
    subthreadAnchorMessageId: 66,
    transcriptOwnerId: "user-1",
    canonicalMemoryAccessEnvelope: {
      ownerId: "user-1",
      actorId: "actor-user",
      actorRole: "owner",
      agentId: SOURCE_AGENT,
      roomId: "room-1",
      laneKey: "room:room-1:user:actor-user:bot:agent-source",
      readableNamespaceIds: ["ns-1"],
      writableNamespaceIds: ["ns-1"],
    },
  } as unknown as PendingAgentRedirectContext["original"];
  const context: PendingAgentRedirectContext = {
    roomId: "room-1",
    senderActorId: "actor-user",
    senderUserId: "user-1",
    sourceAgentId: SOURCE_AGENT,
    sourceAgentActorId: SOURCE_ACTOR,
    sourceHandle: "source",
    persistedMessageId: 42,
    humanTurnId: TURN,
    acceptanceAuthority: authority,
    invocationAuthority,
    redirectAllowed: (overrides.redirectAllowed ?? true) as true,
    sourceRedirectDepth: (overrides.sourceDepth ?? 0) as 0,
    sourceWakeReady: Promise.resolve(overrides.sourceWakeAccepted ?? true),
    original,
    loadLiveMembers: () => {
      if (overrides.rosterError) return Promise.reject(overrides.rosterError);
      return Promise.resolve(overrides.members ?? [source, target]);
    },
    loadActiveSilence: () => {
      if (overrides.silenceError) return Promise.reject(overrides.silenceError);
      return Promise.resolve(overrides.silence ?? []);
    },
    enqueueTarget: async (targetMember, originalPayload, continuation) => {
      if (overrides.enqueueError) throw overrides.enqueueError;
      enqueues.push({
        target: targetMember,
        original: originalPayload,
        continuation,
      });
    },
  };
  registerPendingAgentRedirect(KEY, context);
  return { emitted, enqueues, clears, opens, context, authority, invocationAuthority };
}

async function fulfill(targetHandle = "target") {
  await notifyRedirectCompletion({
    kind: "fulfilled",
    turnContextId: KEY,
    humanTurnId: TURN,
    sourceAgentId: SOURCE_AGENT,
    request: { targetHandle, depth: 1 },
  });
}

beforeEach(() => {
  _resetAgentRedirectHandlerForTests();
});
afterEach(() => {
  _resetAgentRedirectHandlerForTests();
});

describe("D421 redirect completion — accepted path", () => {
  test("enqueues exactly one target with original payload/authority/depth and transfers source focus only", async () => {
    const fx = setup();
    await fulfill();

    expect(fx.enqueues).toHaveLength(1);
    expect(fx.enqueues[0]?.target).toEqual({
      actorId: TARGET_ACTOR,
      agentId: TARGET_AGENT,
      handle: "target",
    });
    expect(fx.enqueues[0]?.original).toBe(fx.context.original);
    expect(fx.enqueues[0]?.continuation).toEqual({
      humanTurnId: TURN,
      persistedMessageId: 42,
      acceptanceAuthority: fx.authority,
      invocationAuthority: fx.invocationAuthority,
      humanAlreadyPersisted: true,
      redirectDepth: 1,
      redirectAllowed: false,
    });
    expect(fx.clears).toEqual(["focus-source"]);
    expect(fx.opens).toEqual([TARGET_ACTOR]);
    expect(pendingAgentRedirectCount()).toBe(0);

    const receipt = fx.emitted.find((event) => event.type === "conductor.decision");
    expect(receipt).toMatchObject({
      userId: "user-1",
      roomId: "room-1",
      outcome: "wake",
      reasonCode: "redirected",
      selectedHandles: ["@target"],
    });
    const focusEvents = fx.emitted.filter(
      (event) => event.type === "conductor.focus_changed",
    );
    expect(focusEvents.map((event) => event.change)).toEqual(["cleared", "opened"]);
  });

  test("same completion cannot enqueue twice", async () => {
    const fx = setup();
    await fulfill();
    await fulfill();
    expect(fx.enqueues).toHaveLength(1);
    expect(pendingAgentRedirectCount()).toBe(0);
  });
});

describe("D421 redirect target — canonical foreground job", () => {
  test("uses same human turn/message, depth 1, redirect disabled, and original D420 authority", async () => {
    const authority = createMaintenanceAcceptanceAuthority();
    const invocationAuthority = createAcceptedInvocationAuthority("user-1");
    const calls: unknown[][] = [];
    const deps = {
      assertInvocation: async (input: { humanUserId: string; agentId?: string }) => {
        expect(input.humanUserId).toBe("user-1");
        expect(input.agentId).toBe(TARGET_AGENT);
      },
      createForegroundJob: async (...args: unknown[]) => {
        calls.push(args);
        return { id: "job-target", virtualJobId: "job-target" };
      },
      loadRoomRoster: async () => [],
    } as unknown as ChatRoutesDeps;
    const request = {
      sessionUserId: "user-1",
      sessionActorId: "actor-user",
      memoryEnvelope: null,
      policyContext: { actorRole: "owner" },
      ip: "127.0.0.1",
      headers: {},
      body: {},
    } as FastifyRequest;

    await executeAgentMediatedRoomMessage({
      request,
      deps,
      content: "full original content",
      voiceMode: true,
      autoApprove: true,
      currentFolder: "/workspace/current",
      workspacePath: "/workspace",
      ordinaryOrigin: {
        kind: "local_electron",
        userId: "user-1",
        actorId: "actor-user",
        relayId: "relay-local",
        desktopSessionId: "desktop-session-local",
        pairingGeneration: "pairing-generation-local",
        requestId: "request-local",
      },
      activeMiniApp: { appId: "app-1", updatedAt: 1 },
      liveMiniAppSession: null,
      attachmentRefs: [],
      artifactRefs: [],
      focusedResources: [],
      model: "anthropic:test",
      replyToMessageId: 77,
      canonicalRoomId: "room-1",
      canonicalAgentId: TARGET_AGENT,
      canonicalGraphThreadId: "room:room-1:bot:agent-target",
      canonicalRoomRoster: [],
      canonicalLaneKey: "room:room-1:user:actor-user:bot:agent-target",
      transcriptOwnerId: "user-1",
      sharedTurnId: TURN,
      humanAlreadyPersisted: true,
      currentMessageId: 42,
      acceptanceAuthority: authority,
      invocationAuthority,
      redirectDepth: 1,
      redirectAllowed: false,
    });

    expect(calls).toHaveLength(1);
    const jobInput = calls[0]?.[3] as Record<string, unknown>;
    expect(jobInput).toMatchObject({
      message: "full original content",
      autoApprove: true,
      agentId: TARGET_AGENT,
      roomId: "room-1",
      turnId: TURN,
      currentMessageId: 42,
      humanAlreadyPersisted: true,
      redirectDepth: 1,
      currentFolder: "/workspace/current",
      workspacePath: "/workspace",
      replyToMessageId: 77,
      model: "anthropic:test",
    });
    expect(jobInput["redirectAllowed"]).toBeUndefined();
    expect(calls[0]?.[5]).toBe(authority);
    expect(
      getAgentTurnContextByKey(turnContextKey(TURN, TARGET_AGENT)),
    ).toBeUndefined();
  });
});

describe("D421 redirect authority — source wake gating", () => {
  const authority = createMaintenanceAcceptanceAuthority();
  const wake = (sourceKind: "mention" | "reply" | "ui" | "inferred") => ({
    kind: "wake" as const,
    botActorIds: ["actor-source"],
    source: sourceKind,
    writeFocus: true,
    reason: "controlled",
  });

  test("only an inferred single wake with original acceptance authority is allowed", () => {
    expect(isRedirectAllowedForConductorWake(wake("inferred"), 1, authority)).toBe(true);
    expect(isRedirectAllowedForConductorWake(wake("mention"), 1, authority)).toBe(false);
    expect(isRedirectAllowedForConductorWake(wake("reply"), 1, authority)).toBe(false);
    expect(isRedirectAllowedForConductorWake(wake("ui"), 1, authority)).toBe(false);
    expect(isRedirectAllowedForConductorWake(wake("inferred"), 2, authority)).toBe(false);
    expect(isRedirectAllowedForConductorWake(wake("inferred"), 1, undefined)).toBe(false);
  });
});

describe("D421 redirect hook lifecycle", () => {
  test("production pending timeout is one-hour leak defense", () => {
    expect(AGENT_REDIRECT_PENDING_TIMEOUT_MS).toBe(3_600_000);
  });

  test("multiple app installs share one hook until the final teardown", async () => {
    const fx = setup();
    installAgentRedirectCompletionHandler();
    uninstallAgentRedirectCompletionHandler();
    await fulfill();
    expect(fx.enqueues).toHaveLength(1);
    uninstallAgentRedirectCompletionHandler();
  });

  test("test reset clears manually registered pending state while uninstalled", () => {
    const fx = setup();
    uninstallAgentRedirectCompletionHandler();
    registerPendingAgentRedirect(KEY, fx.context);
    expect(pendingAgentRedirectCount()).toBe(1);
    _resetAgentRedirectHandlerForTests();
    expect(pendingAgentRedirectCount()).toBe(0);
  });
});

describe("D421 redirect completion — canonical revalidation", () => {
  test.each([
    ["unknown", [source], "missing", "redirect_rejected_no_target"],
    [
      "ambiguous",
      [source, target, { ...target, actorId: "actor-target-2", agentId: "agent-target-2" }],
      "target",
      "redirect_rejected_no_target",
    ],
    [
      "non-agent",
      [source, { kind: "user", actorId: "actor-human", handle: "target" }],
      "target",
      "redirect_rejected_ineligible_target",
    ],
    ["self", [source, target], "source", "redirect_rejected_same_source"],
    [
      "observe",
      [source, { ...target, agentResponseMode: "observe" }],
      "target",
      "redirect_rejected_ineligible_target",
    ],
  ])("%s target rejects without enqueue", async (_name, members, handle, reasonCode) => {
    const fx = setup({ members: members as RoomMemberView[] });
    await fulfill(handle);
    expect(fx.enqueues).toHaveLength(0);
    expect(fx.clears).toHaveLength(0);
    expect(fx.opens).toHaveLength(0);
    expect(hasReceipt(fx.emitted, reasonCode)).toBe(true);
    expect(pendingAgentRedirectCount()).toBe(0);
  });

  test.each(["mute", "deaf"] as const)(
    "%s window rejects the current target",
    async (kind) => {
      const fx = setup({ silence: [{ botActorId: TARGET_ACTOR, kind }] });
      await fulfill();
      expect(fx.enqueues).toHaveLength(0);
      expect(
        hasReceipt(fx.emitted, "redirect_rejected_ineligible_target"),
      ).toBe(true);
    },
  );

  test("server depth authority rejects a depth-1 source as duplicate", async () => {
    const fx = setup({ sourceDepth: 1 });
    await fulfill();
    expect(fx.enqueues).toHaveLength(0);
    expect(hasReceipt(fx.emitted, "redirect_rejected_duplicate")).toBe(true);
  });

  test("source identity mismatch rejects server-side", async () => {
    const fx = setup();
    await notifyRedirectCompletion({
      kind: "fulfilled",
      turnContextId: KEY,
      humanTurnId: TURN,
      sourceAgentId: "wrong-source",
      request: { targetHandle: "target", depth: 1 },
    });
    expect(fx.enqueues).toHaveLength(0);
    expect(
      hasReceipt(fx.emitted, "redirect_rejected_ineligible_target"),
    ).toBe(true);
  });

  test("visible source output is rejected server-side", async () => {
    const fx = setup();
    await notifyRedirectCompletion({
      kind: "fulfilled",
      turnContextId: KEY,
      humanTurnId: TURN,
      sourceAgentId: SOURCE_AGENT,
      sourceAssistantVisibleOutput: true,
      request: { targetHandle: "target", depth: 1 },
    });
    expect(fx.enqueues).toHaveLength(0);
    expect(hasReceipt(fx.emitted, "redirect_rejected_visible_output")).toBe(
      true,
    );
  });
});

describe("D421 redirect completion — cleanup/failure", () => {
  test.each(["completed_no_request", "error", "aborted"] as const)(
    "%s cleans without a receipt",
    async (kind) => {
      const fx = setup();
      await notifyRedirectCompletion({
        kind,
        turnContextId: KEY,
        humanTurnId: TURN,
        sourceAgentId: SOURCE_AGENT,
      });
      expect(fx.enqueues).toHaveLength(0);
      expect(fx.emitted).toHaveLength(0);
      expect(pendingAgentRedirectCount()).toBe(0);
    },
  );

  test("source enqueue cancellation cleans and never redirects", async () => {
    const fx = setup({ sourceWakeAccepted: false });
    await fulfill();
    expect(fx.enqueues).toHaveLength(0);
    expect(fx.emitted).toHaveLength(0);
    expect(pendingAgentRedirectCount()).toBe(0);
  });

  test("target enqueue failure leaves focus unchanged and emits controlled failure", async () => {
    const fx = setup({ enqueueError: new Error("provider secret") });
    await fulfill();
    expect(fx.clears).toHaveLength(0);
    expect(fx.opens).toHaveLength(0);
    expect(hasReceipt(fx.emitted, "redirect_rejected_enqueue_failed")).toBe(
      true,
    );
    expect(JSON.stringify(fx.emitted)).not.toContain("provider secret");
    expect(pendingAgentRedirectCount()).toBe(0);
  });

  test.each([
    ["live roster", { rosterError: new Error("SECRET roster query") }],
    ["silence load", { silenceError: new Error("SECRET silence query") }],
  ])("%s failure emits controlled receipt without raw error", async (_name, overrides) => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    setLogOutput("stderr");
    try {
      const fx = setup(overrides);
      await fulfill();
      expect(fx.enqueues).toHaveLength(0);
      expect(
        hasReceipt(fx.emitted, "redirect_rejected_enqueue_failed"),
      ).toBe(true);
      expect(pendingAgentRedirectCount()).toBe(0);
      const output = stderr.mock.calls.flat().join(" ");
      expect(output).toContain("completion_processing_failed");
      expect(output).not.toContain("SECRET");
    } finally {
      stderr.mockRestore();
    }
  });

  test("focus failure logs fixed code and keeps accepted receipt truthful", async () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    setLogOutput("stderr");
    try {
      const fx = setup({ focusError: new Error("SECRET focus DB query") });
      await fulfill();
      expect(fx.enqueues).toHaveLength(1);
      expect(hasReceipt(fx.emitted, "redirected")).toBe(true);
      expect(fx.clears).toHaveLength(0);
      expect(fx.opens).toHaveLength(0);
      const output = stderr.mock.calls.flat().join(" ");
      expect(output).toContain("focus_transfer_failed");
      expect(output).not.toContain("SECRET focus DB query");
      expect(pendingAgentRedirectCount()).toBe(0);
    } finally {
      stderr.mockRestore();
    }
  });

  test("bounded timeout clears pending context without a receipt", async () => {
    _setAgentRedirectPendingTimeoutMsForTests(20);
    const fx = setup();
    expect(getPendingAgentRedirect(KEY)).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getPendingAgentRedirect(KEY)).toBeUndefined();
    expect(fx.emitted).toHaveLength(0);
  });
});
