/**
 * M067D Phase 2 — four-verb approval plumbing + HTTP-less resume via
 * `resumeGraphWithAskReply` / `resumeGraphWithApproval` (stub LLM).
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { setConfigOverrides } from "@nautilo/config";
import { JobManager } from "../../src/job-manager";
import { eventBus } from "../../src/event-bus";
import { createPersistingProcessor } from "../../src/executors/persisting-processor";
import {
  __setStubModelForTests,
  createCheckpointSaver,
  createNautiloGraph,
  resumeGraphWithAskReply,
  resumeGraphWithApproval,
  setAgentEventSink,
  setOrdinaryHostResolver,
  setRelayRegistry,
  type ToolRelayRegistry,
} from "@nautilo/agent";
import {
  createAcceptedInvocationAuthority,
  initPolicyResolver,
  PinChallengeProvider,
} from "@nautilo/trust";
import { createDirectDb, standingApprovals, eq } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  cleanupTestUserWithDestructivePermission,
  closeDirectDb,
  pollUntilComplete,
  collectEvents,
  waitForRunningForegroundJob,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb } from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";
import { createApprovalVerbTestPolicy } from "./helpers/approval-verb-test-policy";

const fastCoalesce = { coalescerWindowMs: 45, coalescerFirstSegmentQuietMs: 45 } as const;

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

function activateRunShell(id: string) {
  return {
    type: "tool_call" as const,
    name: "activate_tools",
    args: { names: ["run_shell"], families: [] },
    id,
  };
}

function createTestForegroundJob(laneKey: string, input: Record<string, unknown>) {
  return jobManager.createForegroundJob(
    userId,
    userId,
    laneKey,
    {
      ...input,
      verifiedOrdinaryOrigin: {
        kind: "local_electron",
        userId,
        actorId: userId,
        relayId: "mock-relay-1",
        desktopSessionId: "approval-verbs-desktop",
        pairingGeneration: "approval-verbs-pairing",
        requestId: `approval-verbs-${randomUUID()}`,
      },
    },
    undefined,
    undefined,
    undefined,
    createAcceptedInvocationAuthority(userId),
  );
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  setConfigOverrides({ nautilo_security_level: "standard" });

  jobManager = new JobManager(fastCoalesce);
  const env = await setupAgentTestEnv("approval-verbs");
  userId = env.userId;
  agentId = env.agentId;
  // The shared Agent fixture resets runtime globals while bootstrapping.
  // Install the relay afterwards so the foreground catalog snapshots the
  // same live shell capability that dispatch will revalidate.
  setRelayRegistry(makeMockRelayRegistry());
  setOrdinaryHostResolver({
    resolve: async () => ({
      status: "selected",
      host: {
        relayId: "mock-relay-1",
        pairingGeneration: "approval-verbs-pairing",
        desktopSessionId: "approval-verbs-desktop",
        capabilityRevision: 1,
        workspaceRoot,
        currentFolderRoot: workspaceRoot,
      },
    }),
  });
  initPolicyResolver(createApprovalVerbTestPolicy(userId));

  // M072: post-model's prove_it pre-step now unconditionally calls
  // `isPinEnrolled(userId)` (pre-rip-out the gate was env-gated, so test
  // users without a PIN skipped the check entirely). The new behavior matches production:
  // every Logto-authenticated user must have a PIN before prove_it
  // can fire. Enroll one for the test user up front.
  await new PinChallengeProvider({ persistPath: null }).enroll(userId, "1234");

  workspaceRoot = join(tmpdir(), `m067d-approval-${Date.now()}`);
  await fsp.mkdir(workspaceRoot, { recursive: true });
});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterEach(async () => {
  __setStubModelForTests(null);
  // M037 — clear any standing approvals written by a test so tests stay
  // independent (the DB rules persist across turns by design).
  const db = createDirectDb(1);
  try {
    await db.delete(standingApprovals).where(eq(standingApprovals.createdBy, userId));
  } finally {
    await db.end();
  }
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setOrdinaryHostResolver(null);
  setRelayRegistry(null);
  setAgentEventSink(null);
  setConfigOverrides({});

  await cleanupTestUserWithDestructivePermission(userId);
  await closeDirectDb();
  await closeAgentDb();
  await fsp.rm(workspaceRoot, { recursive: true, force: true });
});

describe("Approval verbs (stub LLM, M067D)", () => {
  test("read_only tool runs without approval.ask (discover_tools)", async () => {
    const stub = createStubProvider({
      responses: [
        { type: "tool_call", name: "discover_tools", args: { query: "x" }, id: "d1" },
        { type: "text", content: "listed tools" },
      ],
    });
    __setStubModelForTests(stub.asChatModel());

    const { events, cleanup } = collectEvents(eventBus);
    try {
      const threadId = `ap-ro-${Date.now()}`;
      await createTestForegroundJob(`lane:${threadId}`, {
        message: "Discover tools briefly.",
        ownerId: userId,
        agentId,
        threadId,
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        turnId: randomUUID(),
      });
      const job = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job, 90_000);
      expect(job.status).toBe("completed");
      expect(events.some((e) => e.type === "approval.ask")).toBe(false);
      expect(events.some((e) => e.type === "prove_it.challenge")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("ask verb: approval.ask then resumeGraphWithAskReply(once) completes", async () => {
    const stub = createStubProvider({
      responses: [
        activateRunShell("activate-ask"),
        {
          type: "tool_call",
          name: "run_shell",
          args: { command: "npm install -g @nautilo/nonexistent-pkg-for-test" },
          id: "sh-ask-1",
        },
        { type: "text", content: "shell approved once" },
      ],
    });
    __setStubModelForTests(stub.asChatModel());

    const { events, cleanup } = collectEvents(eventBus);
    try {
      const threadId = `ap-ask-${Date.now()}`;
      const laneKey = `lane:${threadId}`;
      const turnId = randomUUID();
      await createTestForegroundJob(laneKey, {
        message: "Run a global npm install.",
        ownerId: userId,
        agentId,
        actorRole: "owner",
        threadId,
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        turnId,
      });
      const job = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job, 90_000);
      expect(job.status).toBe("completed");
      expect(events.some((e) => e.type === "approval.ask")).toBe(true);

      const processor = createPersistingProcessor({
        threadId,
        ownerId: userId,
        laneKey: threadId,
        eventBus,
        humanTurnId: turnId,
      });
      await resumeGraphWithAskReply(threadId, "once", processor, threadId);
    } finally {
      cleanup();
    }
  });

  test("D447 approval resume retains activation state without aging its lease", async () => {
    const stub = createStubProvider({
      responses: [
        activateRunShell("activate-prove-it"),
        {
          type: "tool_call",
          name: "activate_tools",
          args: { names: ["run_shell"], families: [] },
          id: "activate-shell",
        },
        {
          type: "tool_call",
          name: "run_shell",
          args: { command: "npm install -g @nautilo/resume-activation-test" },
          id: "shell-after-activation",
        },
        { type: "text", content: "shell approved after activation" },
      ],
    });
    __setStubModelForTests(stub.asChatModel());

    const threadId = `d419-approval-resume-${Date.now()}`;
    const turnId = randomUUID();
    await createTestForegroundJob(`lane:${threadId}`, {
      message: "Activate shell and run it.",
      ownerId: userId,
      agentId,
      actorRole: "owner",
      threadId,
      workspacePath: workspaceRoot,
      currentFolder: workspaceRoot,
      turnId,
    });
    await pollUntilComplete(await waitForRunningForegroundJob(jobManager), 90_000);

    const graph = createNautiloGraph(createCheckpointSaver());
    const config = { configurable: { thread_id: threadId } };
    const stateBeforeResume = await graph.getState(config);
    expect(stateBeforeResume?.values["activatedToolNames"]).toEqual(["run_shell"]);
    expect(stateBeforeResume?.values["activatedToolLeases"]).toEqual([
      { name: "run_shell", idleTurns: 0 },
    ]);
    expect(stateBeforeResume?.values["activationLeasesInitialized"]).toBe(true);
    expect(stateBeforeResume?.values["activationLeasesAgedForTurnId"]).toBe(turnId);
    const activationStateBeforeResume = {
      names: stateBeforeResume?.values["activatedToolNames"],
      leases: stateBeforeResume?.values["activatedToolLeases"],
      initialized: stateBeforeResume?.values["activationLeasesInitialized"],
      agedForTurnId: stateBeforeResume?.values["activationLeasesAgedForTurnId"],
      ...(Object.hasOwn(stateBeforeResume?.values ?? {}, "activationIntentAppliedForTurnId")
        ? { intentAppliedForTurnId: stateBeforeResume?.values["activationIntentAppliedForTurnId"] }
        : {}),
    };

    const processor = createPersistingProcessor({
      threadId,
      ownerId: userId,
      laneKey: threadId,
      eventBus,
      humanTurnId: turnId,
    });
    await resumeGraphWithAskReply(threadId, "once", processor, threadId);

    const stateAfterResume = await graph.getState(config);
    const activationStateAfterResume = {
      names: stateAfterResume?.values["activatedToolNames"],
      leases: stateAfterResume?.values["activatedToolLeases"],
      initialized: stateAfterResume?.values["activationLeasesInitialized"],
      agedForTurnId: stateAfterResume?.values["activationLeasesAgedForTurnId"],
      ...(Object.hasOwn(stateAfterResume?.values ?? {}, "activationIntentAppliedForTurnId")
        ? { intentAppliedForTurnId: stateAfterResume?.values["activationIntentAppliedForTurnId"] }
        : {}),
    };
    expect(activationStateAfterResume).toEqual(activationStateBeforeResume);
    expect(stub.remaining).toBe(0);
  });

  test("prove_it verb: challenge then resumeGraphWithApproval(true)", async () => {
    const stub = createStubProvider({
      responses: [
        activateRunShell("activate-prove-it"),
        {
          type: "tool_call",
          name: "run_shell",
          args: { command: "sudo echo prove_it_gate" },
          id: "sh-pi-1",
        },
        { type: "text", content: "ran privileged shell" },
      ],
    });
    __setStubModelForTests(stub.asChatModel());

    const { events, cleanup } = collectEvents(eventBus);
    try {
      const threadId = `ap-pi-${Date.now()}`;
      const turnId = randomUUID();
      await createTestForegroundJob(`lane:${threadId}`, {
        message: "Run a destructive shell command.",
        ownerId: userId,
        agentId,
        actorRole: "owner",
        threadId,
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        turnId,
      });
      const job = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job, 90_000);
      expect(job.status).toBe("completed");
      expect(events.some((e) => e.type === "prove_it.challenge")).toBe(true);
      expect(events.filter((e) => e.type === "approval.ask").length).toBe(0);

      const processor = createPersistingProcessor({
        threadId,
        ownerId: userId,
        laneKey: threadId,
        eventBus,
        humanTurnId: turnId,
      });
      await resumeGraphWithApproval(threadId, true, processor, threadId);
    } finally {
      cleanup();
    }
  });

  test("block verb: critical shell is denied (no successful tool execution)", async () => {
    const stub = createStubProvider({
      responses: [
        activateRunShell("activate-block"),
        { type: "tool_call", name: "run_shell", args: { command: "rm -rf /" }, id: "b1" },
        { type: "text", content: "refused blocked command" },
      ],
    });
    __setStubModelForTests(stub.asChatModel());

    const threadId = `ap-bl-${Date.now()}`;
    await createTestForegroundJob(`lane:${threadId}`, {
      message: "Attempt a blocked shell command.",
      ownerId: userId,
      agentId,
      threadId,
      workspacePath: workspaceRoot,
      currentFolder: workspaceRoot,
      turnId: randomUUID(),
    });
    const job = await waitForRunningForegroundJob(jobManager);
    await pollUntilComplete(job, 90_000);
    expect(job.status).toBe("completed");
  });

  test("M037 always approval: a later sibling-signature shell command skips approval.ask", async () => {
    // First turn: approve "Always". Second turn: a DIFFERENT command that
    // shares the same generalized signature (same npm install head + same
    // parent dir) must be auto-approved by the DB matcher — proving
    // generalization, not exact-match memory.
    const stub1 = createStubProvider({
      responses: [
        activateRunShell("activate-always-1"),
        { type: "tool_call", name: "run_shell", args: { command: "npm install -g @nautilo/pkg-one" }, id: "s1" },
        { type: "text", content: "first" },
      ],
    });

    const threadId = `ap-always-${Date.now()}`;
    const laneKey = `lane:${threadId}`;
    const turn1 = randomUUID();

    __setStubModelForTests(stub1.asChatModel());
    const { events: ev1, cleanup: c1 } = collectEvents(eventBus);
    try {
      await createTestForegroundJob(laneKey, {
        message: "Run npm global install (always test 1).",
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
      expect(ev1.some((e) => e.type === "approval.ask")).toBe(true);

      const processor = createPersistingProcessor({
        threadId,
        ownerId: userId,
        laneKey: threadId,
        eventBus,
        humanTurnId: turn1,
      });
      await resumeGraphWithAskReply(threadId, "always", processor, threadId);
    } finally {
      c1();
    }

    const stub2 = createStubProvider({
      responses: [
        activateRunShell("activate-always-2"),
        { type: "tool_call", name: "run_shell", args: { command: "npm install -g @nautilo/pkg-two" }, id: "s2" },
        { type: "text", content: "second" },
      ],
    });
    __setStubModelForTests(stub2.asChatModel());
    const { events: ev2, cleanup: c2 } = collectEvents(eventBus);
    try {
      const turn2 = randomUUID();
      await createTestForegroundJob(laneKey, {
        message: "Run a sibling npm global install again.",
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
      expect(ev2.some((e) => e.type === "approval.ask")).toBe(false);
    } finally {
      c2();
    }
  });

  test("M037 once approval does NOT persist: same command re-prompts next time", async () => {
    const args = { command: "npm install -g @nautilo/once-test-pkg" };
    const threadId = `ap-once-${Date.now()}`;
    const laneKey = `lane:${threadId}`;

    const stub1 = createStubProvider({
      responses: [
        activateRunShell("activate-once-1"),
        { type: "tool_call", name: "run_shell", args, id: "o1" },
        { type: "text", content: "first" },
      ],
    });
    __setStubModelForTests(stub1.asChatModel());
    const { events: ev1, cleanup: c1 } = collectEvents(eventBus);
    try {
      const turn1 = randomUUID();
      await createTestForegroundJob(laneKey, {
        message: "once test 1", ownerId: userId, agentId, actorRole: "owner",
        threadId, workspacePath: workspaceRoot, currentFolder: workspaceRoot, turnId: turn1,
      });
      const job1 = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job1, 90_000);
      expect(ev1.some((e) => e.type === "approval.ask")).toBe(true);
      const processor = createPersistingProcessor({
        threadId, ownerId: userId, laneKey: threadId, eventBus, humanTurnId: turn1,
      });
      await resumeGraphWithAskReply(threadId, "once", processor, threadId);
    } finally {
      c1();
    }

    const stub2 = createStubProvider({
      responses: [
        activateRunShell("activate-once-2"),
        { type: "tool_call", name: "run_shell", args, id: "o2" },
        { type: "text", content: "second" },
      ],
    });
    __setStubModelForTests(stub2.asChatModel());
    const { events: ev2, cleanup: c2 } = collectEvents(eventBus);
    try {
      const turn2 = randomUUID();
      await createTestForegroundJob(laneKey, {
        message: "once test 2", ownerId: userId, agentId, actorRole: "owner",
        threadId, workspacePath: workspaceRoot, currentFolder: workspaceRoot, turnId: turn2,
      });
      const job2 = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job2, 90_000);
      // No lane memory after "once" → ask fires again.
      expect(ev2.some((e) => e.type === "approval.ask")).toBe(true);
    } finally {
      c2();
    }
  });

  test("SECURITY backstop: an Always rule does NOT bypass prove_it (sudo)", async () => {
    // Seed an Always rule via a benign command, then fire a high-severity
    // sudo command. The matcher is never consulted on the prove_it path, so
    // the PIN challenge still fires.
    {
      const seedThread = `ap-seed-${Date.now()}`;
      const stubSeed = createStubProvider({
        responses: [
          activateRunShell("activate-seed"),
          { type: "tool_call", name: "run_shell", args: { command: "npm install -g @nautilo/seed" }, id: "seed1" },
          { type: "text", content: "seeded" },
        ],
      });
      __setStubModelForTests(stubSeed.asChatModel());
      const { cleanup } = collectEvents(eventBus);
      try {
        const t = randomUUID();
        await createTestForegroundJob(`lane:${seedThread}`, {
          message: "seed always", ownerId: userId, agentId, actorRole: "owner",
          threadId: seedThread, workspacePath: workspaceRoot, currentFolder: workspaceRoot, turnId: t,
        });
        const job = await waitForRunningForegroundJob(jobManager);
        await pollUntilComplete(job, 90_000);
        const processor = createPersistingProcessor({
          threadId: seedThread, ownerId: userId, laneKey: seedThread, eventBus, humanTurnId: t,
        });
        await resumeGraphWithAskReply(seedThread, "always", processor, seedThread);
      } finally {
        cleanup();
      }
    }

    const stub = createStubProvider({
      responses: [
        activateRunShell("activate-backstop"),
        { type: "tool_call", name: "run_shell", args: { command: "sudo apt update" }, id: "bk1" },
        { type: "text", content: "ran" },
      ],
    });
    __setStubModelForTests(stub.asChatModel());
    const { events, cleanup } = collectEvents(eventBus);
    try {
      const threadId = `ap-backstop-${Date.now()}`;
      await createTestForegroundJob(`lane:${threadId}`, {
        message: "Run sudo despite an always rule.", ownerId: userId, agentId, actorRole: "owner",
        threadId, workspacePath: workspaceRoot, currentFolder: workspaceRoot, turnId: randomUUID(),
      });
      const job = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job, 90_000);
      expect(job.status).toBe("completed");
      // prove_it still fires; it was NOT auto-approved by the standing rule.
      expect(events.some((e) => e.type === "prove_it.challenge")).toBe(true);
      expect(events.some((e) => e.type === "approval.ask")).toBe(false);
    } finally {
      cleanup();
    }
  });
});
