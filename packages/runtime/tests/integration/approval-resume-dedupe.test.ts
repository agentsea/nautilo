/**
 * Cross-package approval-ask resume cycles
 * with a fixed tool_call_id must not leave duplicate ToolMessages in
 * checkpoint `messages` / `preparedMessages` (LangGraph #4397 family).
 *
 * The fixture uses the cloud `file` tool with `zone: "workspace"`
 * (distinct paths under the temp workspaceRoot) so gated tools reach
 * approval without a connected relay; `once` resume may execute writes.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { setConfigOverrides } from "@nautilo/config";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import {
  __setStubModelForTests,
  resumeGraphWithAskReply,
  createNautiloGraph,
  createCheckpointSaver,
  collectPendingInterruptEvents,
  defaultPostModelDeps,
  processHistory,
  type HistoryConfig,
  setAgentEventSink,
  setRelayRegistry,
  type ToolRelayRegistry,
} from "@nautilo/agent";
import { assertMessageInvariants } from "@nautilo/message-invariants";
import { JobManager } from "../../src/job-manager";
import { eventBus } from "../../src/event-bus";
import { createPersistingProcessor } from "../../src/executors/persisting-processor";
import { initPolicyResolver, PinChallengeProvider, getPolicyResolver } from "@nautilo/trust";
import { createDirectDb, standingApprovals, eq } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { ServerEvent } from "@nautilo/types";
import {
  cleanupTestUser,
  closeDirectDb,
  pollUntilComplete,
  collectEvents,
  waitForRunningForegroundJob,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";
import { createApprovalVerbTestPolicy } from "./helpers/approval-verb-test-policy";

type StructuredSshPrepareInput = Parameters<NonNullable<ToolRelayRegistry["prepareStructuredSsh"]>>[1];
type StructuredSshPrepareResponse = Awaited<ReturnType<NonNullable<ToolRelayRegistry["prepareStructuredSsh"]>>>;

const fastCoalesce = { coalescerWindowMs: 45, coalescerFirstSegmentQuietMs: 45 } as const;

const historyProbeConfig: HistoryConfig = {
  validationEnabled: true,
  pruningEnabled: false,
  maxMessageTokens: 900_000,
};

const DUP_ID = "toolu_TEST_DUP_1";
const CYCLE_ONE_FILE = "approval-resume-cycle-one.txt";
const CYCLE_TWO_FILE = "approval-resume-cycle-two.txt";

let userId: string;
let agentId: string;
let jobManager: JobManager;
let workspaceRoot: string;

function makeMockRelayRegistry(): ToolRelayRegistry {
  return {
    findByCapabilityForUser: () => ["mock-relay-1"],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
      allowedRoots: ["/"],
      securityLevel: "standard",
    }),
    dispatch: async () => ({ status: "ok" as const, result: "mock-shell-ok\n" }),
  };
}

function structuredSshPrepareResponse(
  input: StructuredSshPrepareInput,
  preparationId: string,
  overrides: Partial<Pick<StructuredSshPrepareResponse, "approval" | "subject">> = {},
): StructuredSshPrepareResponse {
  return {
    version: 2,
    requestId: `structured-ssh-request-${preparationId}`,
    toolCallId: input.toolCallId,
    approvedRequestDigest: input.approvedRequestDigest,
    operation: input.operation,
    subject: {
      userId: input.userId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      agentId: input.agentId,
      executionEntrypoint: "foreground.main",
      instanceId: input.instanceId,
      relayId: "structured-ssh-relay",
      relaySessionId: "structured-ssh-relay-session",
      desktopSessionId: "structured-ssh-desktop-session",
      pairingGenerationRef: "structured-ssh-pairing-generation",
      capabilityRevision: 1,
    },
    preparationId,
    approval: {
      requestedDestination: input.approvedRequest.args.destination,
      host: "deploy.example.test",
      port: 22,
      remoteUser: "deploy",
      operation: input.operation,
      hostKeyFingerprint: "SHA256:D500INITIALFINGERPRINT",
      hostTrust: "unknown",
    },
    ...overrides,
  };
}

async function parkStructuredSshReview(
  threadId: string,
  toolCallId: string,
): Promise<{
  graph: ReturnType<typeof createNautiloGraph>;
  config: { configurable: { thread_id: string }; version: "v2" };
  approval: Extract<ServerEvent, { type: "approval.ask" }>;
}> {
  const config = { configurable: { thread_id: threadId }, version: "v2" as const };
  const graph = createNautiloGraph(
    createCheckpointSaver(),
    getPolicyResolver(),
    defaultPostModelDeps,
  );
  const policyContext = await getPolicyResolver()!.resolveContext("workbench", userId, agentId);
  const sshCall = {
    id: toolCallId,
    name: "structured_ssh_exec",
    args: {
      destination: { host: "deploy.example.test", user: "deploy" },
      program: "true",
      argv: [],
    },
    type: "tool_call" as const,
  };

  // Seed the production graph at the accepted post-model checkpoint. This is
  // the same compiled tools-node/resume path as a foreground turn after tool
  // admission, while keeping the test free of model/network dependencies.
  await graph.updateState(config, {
    messages: [
      new HumanMessage("Run the harmless exact SSH command."),
      new AIMessage({ content: "", tool_calls: [sshCall] }),
    ],
    approvedToolCalls: [sshCall],
    requiredHostRelays: { [toolCallId]: "structured-ssh-relay" },
    userId,
    personaId: "owner",
    actorRole: "owner",
    agentId,
    turnId: randomUUID(),
    roomId: "",
    memoryAccessEnvelope: policyContext.memoryAccess,
    // A real turn's pre-model node activates this explicitly requested tool
    // before post-model admits it; this fixture starts after that admission.
    activatedToolNames: ["structured_ssh_exec"],
    activatedToolLeases: [],
    engagedSkillNames: [],
    // Match buildRuntimeCapabilityTokens(): relay presence grants the generic
    // high-impact token while the ready desktop grants structured SSH itself.
    relayCapabilities: { use_high_impact_tools: true, canUseStructuredSsh: true },
    trustedExecutionEntrypoint: "foreground.main",
    autoApprove: false,
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId,
      actorId: userId,
      relayId: "structured-ssh-relay",
      desktopSessionId: "structured-ssh-desktop-session",
      pairingGeneration: "structured-ssh-pairing-generation",
      requestId: "structured-ssh-request",
    },
  }, "post_model");

  for await (const _ of graph.streamEvents(null, config)) {
    // Draining reaches the exact structured-SSH review interrupt.
  }

  const parked = await graph.getState(config);
  const approvals = collectPendingInterruptEvents(
    parked as unknown as { tasks?: Array<Record<string, unknown>> },
    threadId,
    threadId,
  ).filter(
    (event): event is Extract<ServerEvent, { type: "approval.ask" }> => event.type === "approval.ask",
  );
  expect(approvals).toHaveLength(1);
  expect(approvals[0]?.structuredSsh).toBeDefined();
  // The model omitted a timeout, as it did in the packaged regression. The
  // broker normalizes the finite budget into the exact Human-review DTO; the
  // interrupt mapper must preserve that valid field instead of stranding it.
  expect(approvals[0]?.structuredSsh?.timeoutSeconds).toBe(300);
  return { graph, config, approval: approvals[0]! };
}

function maxToolDupCount(messages: BaseMessage[]): number {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m instanceof ToolMessage && m.tool_call_id) {
      const id = m.tool_call_id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  let max = 0;
  for (const n of counts.values()) max = Math.max(max, n);
  return max;
}

/**
 * Counts the
 * maximum number of AIMessages that claim the same tool_call_id in
 * their tool_calls[] arrays. The Anthropic-side invariant requires
 * this to be ≤ 1 — multiple AIMessage sources for one tool_call_id
 * means multiple `tool_use` blocks share an id across the conversation,
 * which Anthropic rejects with "messages.X: tool_use already has a
 * result" / "Too many tool_result blocks" depending on the resulting
 * pair shape. This counter validates the AIMessage side as well as the
 * ToolMessage side.
 */
function maxAIMessageToolCallDupCount(messages: BaseMessage[]): number {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (AIMessage.isInstance(m) && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id) counts.set(tc.id, (counts.get(tc.id) ?? 0) + 1);
      }
    }
  }
  let max = 0;
  for (const n of counts.values()) max = Math.max(max, n);
  return max;
}

async function readCheckpointSlices(threadId: string): Promise<{
  messages: BaseMessage[];
  preparedMessages: BaseMessage[];
}> {
  const saver = createCheckpointSaver();
  const graph = createNautiloGraph(saver, getPolicyResolver(), defaultPostModelDeps);
  const st = await graph.getState({ configurable: { thread_id: threadId } });
  const values = st?.values;
  const messagesRaw = values?.["messages"];
  const preparedRaw = values?.["preparedMessages"];
  return {
    messages: Array.isArray(messagesRaw) ? (messagesRaw as BaseMessage[]) : [],
    preparedMessages: Array.isArray(preparedRaw) ? (preparedRaw as BaseMessage[]) : [],
  };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  setRelayRegistry(makeMockRelayRegistry());
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  setConfigOverrides({ nautilo_security_level: "standard" });

  jobManager = new JobManager(fastCoalesce);
  const env = await setupAgentTestEnv("approval-resume-approval-dedupe");
  userId = env.userId;
  agentId = env.agentId;
  initPolicyResolver(createApprovalVerbTestPolicy(userId));

  await new PinChallengeProvider({ persistPath: null }).enroll(userId, "1234");

  workspaceRoot = join(tmpdir(), `approval-resume-approval-dedupe-${Date.now()}`);
  await fsp.mkdir(workspaceRoot, { recursive: true });
});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterEach(() => {
  __setStubModelForTests(null);
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setRelayRegistry(null);
  setAgentEventSink(null);
  setConfigOverrides({});

  // Drop any standing approvals this user accumulated; the
  // `standing_approvals.created_by → users.id` FK has no cascade, so a
  // leftover rule would block cleanupTestUser's user delete.
  {
    const db = createDirectDb(1);
    try {
      await db.delete(standingApprovals).where(eq(standingApprovals.createdBy, userId));
    } finally {
      await db.end();
    }
  }
  await cleanupTestUser(userId);
  await closeDirectDb();
  await closeAgentDb();
  await fsp.rm(workspaceRoot, { recursive: true, force: true });
});

describe("approval-ask resume and checkpoint deduplication", () => {
  test("two approval-ask resume cycles leave no duplicate tool_call_id in checkpoint", async () => {
    const stub = createStubProvider({
      responses: [
        {
          type: "tool_call",
          name: "file",
          args: {
            command: "write",
            zone: "workspace",
            path: CYCLE_ONE_FILE,
            content: "cycle one marker\n",
          },
          id: DUP_ID,
        },
        { type: "text", content: "after first write" },
        {
          type: "tool_call",
          name: "file",
          args: {
            command: "write",
            zone: "workspace",
            path: CYCLE_TWO_FILE,
            content: "cycle two marker\n",
          },
          id: DUP_ID,
        },
        { type: "text", content: "after second write" },
      ],
    });
    __setStubModelForTests(stub.asChatModel());

    const { events, cleanup } = collectEvents(eventBus);
    try {
      const threadId = `approval-resume-dup-${Date.now()}`;
      const laneKey = `lane:${threadId}`;

      const turn1 = randomUUID();
      await jobManager.createForegroundJob(userId, userId, laneKey, {
        message: "Write a workspace file (cycle one).",
        ownerId: userId,
        agentId,
        actorRole: "owner",
        threadId,
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        turnId: turn1,
      });
      const job1 = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job1, 90_000);
      expect(job1.status).toBe("completed");
      expect(events.some((e) => e.type === "approval.ask")).toBe(true);

      const processor1 = createPersistingProcessor({
        threadId,
        ownerId: userId,
        laneKey: threadId,
        eventBus,
        humanTurnId: turn1,
      });
      // Use "once" so the second cycle re-prompts (an "always"/"room"
      // rule would auto-approve the sibling-signature second call, collapsing
      // this two-cycle checkpoint-dedupe test to a single ask).
      await resumeGraphWithAskReply(threadId, "once", processor1, threadId);

      const turn2 = randomUUID();
      await jobManager.createForegroundJob(userId, userId, laneKey, {
        message: "Write another workspace file (cycle two).",
        ownerId: userId,
        agentId,
        actorRole: "owner",
        threadId,
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        turnId: turn2,
      });
      const job2 = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job2, 90_000);
      expect(job2.status).toBe("completed");
      expect(events.filter((e) => e.type === "approval.ask").length).toBeGreaterThanOrEqual(2);

      const processor2 = createPersistingProcessor({
        threadId,
        ownerId: userId,
        laneKey: threadId,
        eventBus,
        humanTurnId: turn2,
      });
      await resumeGraphWithAskReply(threadId, "once", processor2, threadId);

      const { messages, preparedMessages } = await readCheckpointSlices(threadId);
      expect(maxToolDupCount(messages)).toBeLessThanOrEqual(1);
      if (preparedMessages.length > 0) {
        expect(maxToolDupCount(preparedMessages)).toBeLessThanOrEqual(1);
      }

      // Reviewer blocker (post-extension): assert the FULL invariant,
      // not merely ToolMessage uniqueness. Specifically:
      //   (a) No two AIMessages claim the same tool_call_id in
      //       their tool_calls[] arrays.
      //   (b) Every AIMessage tool_call has exactly one ToolMessage
      //       pair (or has been stripped if unfulfilled).
      // The stub LLM in this test emits the SAME DUP_ID across both
      // cycles → without the extended invariant, two AIMessages
      // would both carry tc=DUP_ID and Anthropic would reject.
      expect(maxAIMessageToolCallDupCount(messages)).toBeLessThanOrEqual(1);
      if (preparedMessages.length > 0) {
        expect(maxAIMessageToolCallDupCount(preparedMessages)).toBeLessThanOrEqual(1);
      }

      expect(() => assertMessageInvariants(messages, "approval-resume.checkpoint.messages")).not.toThrow();
      if (preparedMessages.length > 0) {
        expect(() =>
          assertMessageInvariants(preparedMessages, "approval-resume.checkpoint.preparedMessages"),
        ).not.toThrow();
      }

      const probed = processHistory(preparedMessages.length > 0 ? preparedMessages : messages, historyProbeConfig);
      expect(maxToolDupCount(probed.messages)).toBeLessThanOrEqual(1);
      expect(maxAIMessageToolCallDupCount(probed.messages)).toBeLessThanOrEqual(1);

      const failedJobs = events.filter(
        (e: ServerEvent) => e.type === "job.status" && e.status === "failed",
      );
      expect(failedJobs.length).toBe(0);
    } finally {
      cleanup();
    }
    expect(stub.remaining).toBe(0);
  });

  test("assertMessageInvariants throws on duplicate ToolMessages (cross-package smoke)", () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "test";
    try {
      expect(() =>
        assertMessageInvariants(
          [
            new ToolMessage({ content: "a", tool_call_id: "toolu_COLLIDE" }),
            new ToolMessage({ content: "b", tool_call_id: "toolu_COLLIDE" }),
          ],
          "approval-resume.duplicate_smoke",
        ),
      ).toThrow(/duplicate ToolMessage/);
    } finally {
      if (prev === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = prev;
    }
  });

  test("STRUCTURED-SSH: a completed read in a batch remains checkpointed before a later identity interrupt", async () => {
    const stub = createStubProvider({
      responses: [{ type: "text", content: "Identity verification completed." }],
    });
    __setStubModelForTests(stub.asChatModel());

    const threadId = `structured-ssh-batch-checkpoint-${Date.now()}`;
    const config = { configurable: { thread_id: threadId }, version: "v2" as const };
    const graph = createNautiloGraph(
      createCheckpointSaver(),
      getPolicyResolver(),
      defaultPostModelDeps,
    );
    const policyContext = await getPolicyResolver()!.resolveContext(
      "workbench",
      userId,
      agentId,
    );
    const completedReadId = "structured-ssh-completed-read";
    const laterInterruptId = "structured-ssh-later-identity";
    const batch = [
      { id: completedReadId, name: "discover_tools", args: { query: "identity" }, type: "tool_call" as const },
      { id: laterInterruptId, name: "verify_identity", args: { claim: "owner" }, type: "tool_call" as const },
    ];

    // Seed the accepted batch at the post-model checkpoint, matching the
    // state immediately before the tools lane begins. The first call is a
    // normal read; the second uses the production identity challenge
    // interrupt, which makes LangGraph replay its current node on resume.
    await graph.updateState(config, {
      messages: [
        new HumanMessage("Inspect available identity tools, then verify me."),
        new AIMessage({ content: "", tool_calls: batch }),
      ],
      approvedToolCalls: batch,
      requiredHostRelays: {},
      userId,
      personaId: "owner",
      actorRole: "owner",
      agentId,
      turnId: randomUUID(),
      roomId: "",
      memoryAccessEnvelope: policyContext.memoryAccess,
      activatedToolNames: [],
      activatedToolLeases: [],
      engagedSkillNames: [],
      relayCapabilities: {},
    }, "post_model");

    for await (const _ of graph.streamEvents(null, config)) {
      // Draining reaches the identity interrupt after the read checkpoint.
    }

    const parked = await graph.getState(config);
    const parkedMessages = (parked?.values["messages"] ?? []) as BaseMessage[];
    expect(parkedMessages.filter(
      (message) => message instanceof ToolMessage && message.tool_call_id === completedReadId,
    )).toHaveLength(1);
    expect(parked?.values["approvedToolCalls"]).toEqual([batch[1]]);

    for await (const _ of graph.streamEvents(
      new Command({ resume: { verified: true } }),
      config,
    )) {
      // The resumed identity call completes, then the stub provides the final response.
    }

    const resumed = await graph.getState(config);
    const messages = (resumed?.values["messages"] ?? []) as BaseMessage[];
    expect(messages.filter(
      (message) => message instanceof ToolMessage && message.tool_call_id === completedReadId,
    )).toHaveLength(1);
    expect(messages.filter(
      (message) => message instanceof ToolMessage && message.tool_call_id === laterInterruptId,
    )).toHaveLength(1);
    expect(() => assertMessageInvariants(messages, "structured-ssh.batch-checkpoint.resume")).not.toThrow();
    expect(stub.remaining).toBe(0);
  });

  test("STRUCTURED-SSH: Auto-Approve runs a prior read and chained trusted SSH calls without an interrupt or replay", async () => {
    const stub = createStubProvider({
      responses: [{ type: "text", content: "Both exact SSH commands completed." }],
    });
    __setStubModelForTests(stub.asChatModel());

    const preparations: StructuredSshPrepareResponse[] = [];
    const dispatches: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
    setRelayRegistry({
      findByCapabilityForUser: () => ["structured-ssh-relay"],
      getCapabilities: () => null,
      prepareStructuredSsh: async (_relayId, input) => {
        const prepared = structuredSshPrepareResponse(
          input,
          `structured-ssh-auto-approve-preparation-${preparations.length + 1}`,
          {
            approval: {
              requestedDestination: input.approvedRequest.args.destination,
              host: "deploy.example.test",
              port: 22,
              remoteUser: "deploy",
              operation: input.operation,
              hostKeyFingerprint: "SHA256:D500TRUSTEDFINGERPRINT",
              hostTrust: "trusted",
            },
          },
        );
        preparations.push(prepared);
        return prepared;
      },
      dispatch: async (_relayId, request) => {
        dispatches.push(request);
        return { status: "ok", result: `remote ${request.sshBinding?.toolCallId} completed\n` };
      },
    });

    const threadId = `structured-ssh-auto-approve-batch-${Date.now()}`;
    const config = { configurable: { thread_id: threadId }, version: "v2" as const };
    const completedReadId = "structured-ssh-auto-approve-prior-read";
    const firstSshId = "structured-ssh-auto-approve-first-ssh";
    const secondSshId = "structured-ssh-auto-approve-second-ssh";
    const batch = [
      // The captured failure used search_memory. This fixture instead uses
      // discover_tools, the nearest existing deterministic core read: an exact
      // search_memory result requires persisted/envelope-scoped memory data and
      // would make this lifecycle regression data-dependent. Live acceptance
      // must still exercise search_memory, because only it proves the original
      // memory-read call's production result survives this same batch shape.
      { id: completedReadId, name: "discover_tools", args: { query: "identity" }, type: "tool_call" as const },
      {
        id: firstSshId,
        name: "structured_ssh_exec",
        args: {
          destination: { host: "deploy.example.test", user: "deploy" },
          program: "true",
          argv: [],
        },
        type: "tool_call" as const,
      },
      {
        id: secondSshId,
        name: "structured_ssh_exec",
        args: {
          destination: { host: "deploy.example.test", user: "deploy" },
          program: "printf",
          argv: ["structured-ssh chained SSH"],
        },
        type: "tool_call" as const,
      },
    ];

    try {
      const graph = createNautiloGraph(
        createCheckpointSaver(),
        getPolicyResolver(),
        defaultPostModelDeps,
      );
      const policyContext = await getPolicyResolver()!.resolveContext("workbench", userId, agentId);

      // Seed the accepted batch at the production post-model checkpoint. This
      // executes the compiled tools node one call at a time, so any interrupt
      // would replay the exact lifecycle shape that originally duplicated the
      // prior read before reaching chained structured SSH calls.
      await graph.updateState(config, {
        messages: [
          new HumanMessage("Check available identity tools, then run two harmless exact SSH commands."),
          new AIMessage({ content: "", tool_calls: batch }),
        ],
        approvedToolCalls: batch,
        requiredHostRelays: { [firstSshId]: "structured-ssh-relay", [secondSshId]: "structured-ssh-relay" },
        userId,
        personaId: "owner",
        actorRole: "owner",
        agentId,
        turnId: randomUUID(),
        roomId: "",
        memoryAccessEnvelope: policyContext.memoryAccess,
        activatedToolNames: ["structured_ssh_exec"],
        activatedToolLeases: [],
        engagedSkillNames: [],
        relayCapabilities: { use_high_impact_tools: true, canUseStructuredSsh: true },
        trustedExecutionEntrypoint: "foreground.main",
        autoApprove: true,
        verifiedOrdinaryOrigin: {
          kind: "local_electron",
          userId,
          actorId: userId,
          relayId: "structured-ssh-relay",
          desktopSessionId: "structured-ssh-desktop-session",
          pairingGeneration: "structured-ssh-pairing-generation",
          requestId: "structured-ssh-auto-approve-request",
        },
      }, "post_model");

      for await (const _ of graph.streamEvents(null, config)) {
        // Trusted-host Auto-Approve must complete the whole batch without a resume.
      }

      const completed = await graph.getState(config);
      const messages = (completed?.values["messages"] ?? []) as BaseMessage[];
      const completedRead = messages.filter(
        (message) => message instanceof ToolMessage && message.tool_call_id === completedReadId,
      );
      expect(completedRead).toHaveLength(1);
      expect(completedRead[0]?.content).toContain("verify_identity");
      expect(messages.filter(
        (message) => message instanceof ToolMessage && message.tool_call_id === firstSshId,
      )).toHaveLength(1);
      expect(messages.filter(
        (message) => message instanceof ToolMessage && message.tool_call_id === secondSshId,
      )).toHaveLength(1);
      expect(messages.findIndex(
        (message) => message instanceof ToolMessage && message.tool_call_id === completedReadId,
      )).toBeLessThan(messages.findIndex(
        (message) => message instanceof ToolMessage && message.tool_call_id === firstSshId,
      ));

      const pendingInterrupts = collectPendingInterruptEvents(
        completed as unknown as { tasks?: Array<Record<string, unknown>> },
        threadId,
        threadId,
      ).filter((event) => event.type === "approval.ask");
      expect(pendingInterrupts).toHaveLength(0);
      expect(preparations).toHaveLength(2);
      expect(dispatches.map((request) => request.sshBinding?.toolCallId)).toEqual([firstSshId, secondSshId]);
      expect(stub.remaining).toBe(0);
    } finally {
      setRelayRegistry(makeMockRelayRegistry());
    }
  });

  test("STRUCTURED-SSH: delayed unknown-host approval refreshes unchanged preparation and dispatches exactly once", async () => {
    const stub = createStubProvider({
      responses: [{ type: "text", content: "The exact SSH command completed." }],
    });
    __setStubModelForTests(stub.asChatModel());

    const preparations: StructuredSshPrepareResponse[] = [];
    const dispatches: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
    setRelayRegistry({
      findByCapabilityForUser: () => ["structured-ssh-relay"],
      getCapabilities: () => null,
      prepareStructuredSsh: async (_relayId, input) => {
        const prepared = structuredSshPrepareResponse(input, `structured-ssh-preparation-${preparations.length + 1}`);
        preparations.push(prepared);
        return prepared;
      },
      dispatch: async (_relayId, request) => {
        dispatches.push(request);
        return { status: "ok", result: "remote true completed\n" };
      },
    });

    const threadId = `structured-ssh-delayed-unchanged-${Date.now()}`;
    const toolCallId = "structured-ssh-delayed-unchanged-call";
    try {
      const { graph, config, approval } = await parkStructuredSshReview(threadId, toolCallId);
      expect(approval.structuredSsh?.hostTrust).toBe("unknown");
      expect(approval.structuredSsh?.preparationId).toBe("structured-ssh-preparation-1");
      expect(preparations).toHaveLength(1);
      expect(dispatches).toHaveLength(0);

      // There is intentionally no human-review TTL. Advance a test-only wall
      // clock beyond the retired 45-second boundary; never sleep the suite.
      const realNow = Date.now;
      const parkedAt = realNow();
      Date.now = () => parkedAt + 46_000;
      const resumedEvents: ServerEvent[] = [];
      try {
        await resumeGraphWithAskReply(
          threadId,
          "once",
          {
            process: () => undefined,
            flush: () => undefined,
            emit: (event) => resumedEvents.push(event),
          },
          threadId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          approval.approvalId,
        );
      } finally {
        Date.now = realNow;
      }

      expect(preparations).toHaveLength(2);
      expect(preparations[1]?.approval).toEqual(preparations[0]?.approval);
      expect(preparations[1]?.preparationId).not.toBe(preparations[0]?.preparationId);
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]).toMatchObject({
        executionClass: "structured-ssh",
        sshBinding: { toolCallId, preparationId: "structured-ssh-preparation-2" },
      });
      expect(resumedEvents.filter((event) => event.type === "approval.ask")).toHaveLength(0);

      const resumed = await graph.getState(config);
      const messages = (resumed?.values["messages"] ?? []) as BaseMessage[];
      expect(messages.filter(
        (message) => message instanceof ToolMessage && message.tool_call_id === toolCallId,
      )).toHaveLength(1);
      expect(stub.remaining).toBe(0);
    } finally {
      setRelayRegistry(makeMockRelayRegistry());
    }
  });

  test("STRUCTURED-SSH: changed refreshed host trust re-parks an exact review before dispatch", async () => {
    const stub = createStubProvider({
      responses: [{ type: "text", content: "This response must not run before renewed review." }],
    });
    __setStubModelForTests(stub.asChatModel());

    const preparations: StructuredSshPrepareResponse[] = [];
    const dispatches: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
    setRelayRegistry({
      findByCapabilityForUser: () => ["structured-ssh-relay"],
      getCapabilities: () => null,
      prepareStructuredSsh: async (_relayId, input) => {
        const prepared = preparations.length === 0
          ? structuredSshPrepareResponse(input, "structured-ssh-preparation-before-change")
          : structuredSshPrepareResponse(input, "structured-ssh-preparation-after-change", {
              approval: {
                requestedDestination: input.approvedRequest.args.destination,
                host: "deploy.example.test",
                port: 22,
                remoteUser: "deploy",
                operation: input.operation,
                hostKeyFingerprint: "SHA256:D500CHANGEDFINGERPRINT",
                previousHostKeyFingerprint: "SHA256:D500INITIALFINGERPRINT",
                hostTrust: "changed",
              },
            });
        preparations.push(prepared);
        return prepared;
      },
      dispatch: async (_relayId, request) => {
        dispatches.push(request);
        return { status: "ok", result: "unexpected SSH dispatch\n" };
      },
    });

    const threadId = `structured-ssh-refresh-changed-${Date.now()}`;
    const toolCallId = "structured-ssh-refresh-changed-call";
    try {
      const { graph, config, approval } = await parkStructuredSshReview(threadId, toolCallId);
      const resumedEvents: ServerEvent[] = [];
      await resumeGraphWithAskReply(
        threadId,
        "once",
        {
          process: () => undefined,
          flush: () => undefined,
          emit: (event) => resumedEvents.push(event),
        },
        threadId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        approval.approvalId,
      );

      expect(preparations).toHaveLength(2);
      expect(dispatches).toHaveLength(0);
      const refreshedReviews = resumedEvents.filter(
        (event): event is Extract<ServerEvent, { type: "approval.ask" }> => event.type === "approval.ask",
      );
      expect(refreshedReviews).toHaveLength(1);
      expect(refreshedReviews[0]?.approvalId).not.toBe(approval.approvalId);
      expect(refreshedReviews[0]?.structuredSsh).toMatchObject({
        toolCallId,
        preparationId: "structured-ssh-preparation-after-change",
        hostTrust: "changed",
        hostKeyFingerprint: "SHA256:D500CHANGEDFINGERPRINT",
        previousHostKeyFingerprint: "SHA256:D500INITIALFINGERPRINT",
      });

      const parkedAgain = await graph.getState(config);
      const stillParked = collectPendingInterruptEvents(
        parkedAgain as unknown as { tasks?: Array<Record<string, unknown>> },
        threadId,
        threadId,
      ).filter(
        (event): event is Extract<ServerEvent, { type: "approval.ask" }> => event.type === "approval.ask",
      );
      expect(stillParked).toHaveLength(1);
      expect(stillParked[0]?.approvalId).toBe(refreshedReviews[0]?.approvalId);
      expect(stub.remaining).toBe(1);
    } finally {
      setRelayRegistry(makeMockRelayRegistry());
    }
  });
});
