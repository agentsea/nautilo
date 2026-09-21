/**
 * D318 C2 — real durable Task dispatch through the generic harness router and
 * the v15 in-memory ACP transport.  This intentionally owns its small DB seed:
 * it does not boot the app fixture/observer, and does not borrow runtime test
 * helpers, so the exact Task -> TaskRun -> Job lifecycle remains visible here.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  actors,
  agents,
  and,
  createDirectDb,
  createTask,
  ensureDatabase,
  eq,
  getTaskById,
  getTaskRuns,
  jobs,
  namespaces,
  roomMembers,
  rooms,
  seedTrustPersonal,
  sessionMessages,
  sessions,
  tasks,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  InMemoryRelayRegistry,
  InMemoryLaneLock,
  JobManager,
  renderDelegatedTaskFailureReceipt,
  createHumanApiTaskCreationProvenance,
  getPlaintextTaskCreationAdmission,
  createTask as runtimeCreateTask,
  dispatchTaskRun,
  eventBus,
} from "@nautilo/runtime";
import {
  PersonalPolicyResolver,
  createAcceptedInvocationAuthority,
} from "@nautilo/trust";
import type { RelayCapabilities, RelayServerMessage } from "@nautilo/relay";
import type { ServerEvent } from "@nautilo/types";
import { createOpenCodeAcpHarnessTask } from "../../src/acp/opencode-harness-task";
import { createOpenCodeAcpTaskExecutionRouteRegistration } from "../../src/acp/opencode-task-execution-composition";
import { createCodexCanonicalFactsReader } from "../../src/codex/canonical-facts";
import { createTaskHarnessExecutionRouteSelector } from "../../src/harness/task-execution-route";
import { createTaskHarnessExecutionRouteStore } from "../../src/harness/task-execution-route-store";

const RELAY_ID = "d318-opencode-relay";
const DESKTOP_SESSION_ID = "d318-opencode-desktop";
const PAIRING_GENERATION = "d318-opencode-pair";
const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  acp: { version: 2, hostKind: "electron", registrations: ["hermes-acp", "opencode-acp"] },
};

type Db = ReturnType<typeof createDirectDb>;
type Fixture = {
  userId: string;
  agentId: string;
  roomId: string;
  namespaceId: string;
};

let db: Db;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
});

afterAll(async () => {
  await db?.end();
});

async function seedFixture(label: string): Promise<Fixture> {
  const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
  const [user] = await db.insert(users).values({
    name: `D318 ${label}`,
    email: `d318-${label}-${suffix}@test.local`,
    handle: `d318${suffix}`.slice(0, 48),
    externalId: `d318-${suffix}`,
  }).returning({ id: users.id });
  if (!user) throw new Error("D318 fixture user insert failed");
  await seedTrustPersonal(user.id, `D318 ${label}`);
  const [userActor] = await db.select({ id: actors.id }).from(actors)
    .where(and(eq(actors.ownerId, user.id), eq(actors.kind, "user"))).limit(1);
  if (!userActor) throw new Error("D318 fixture user actor missing");
  const [agent] = await db.insert(agents).values({ handle: `d318-agent-${suffix}` }).returning({ id: agents.id });
  if (!agent) throw new Error("D318 fixture agent insert failed");
  const [agentActor] = await db.insert(actors).values({
    ownerId: user.id,
    displayName: "D318 OpenCode agent",
    trustState: "verified",
    kind: "agent",
    agentId: agent.id,
  }).returning({ id: actors.id });
  if (!agentActor) throw new Error("D318 fixture agent actor insert failed");
  const [namespace] = await db.insert(namespaces).values({
    scope: "private",
    label: `d318-opencode-${suffix}`,
  }).returning({ id: namespaces.id });
  if (!namespace) throw new Error("D318 fixture namespace insert failed");
  const [room] = await db.insert(rooms).values({
    ownerId: user.id,
    type: "private",
    kind: "private",
    label: `D318 OpenCode ${label}`,
    graphThreadId: `room:d318:${suffix}`,
    namespaceId: namespace.id,
    humanActorIds: [userActor.id],
    createdBy: userActor.id,
  }).returning({ id: rooms.id });
  if (!room) throw new Error("D318 fixture room insert failed");
  await db.insert(roomMembers).values([
    { roomId: room.id, actorId: userActor.id, roomRole: "admin" },
    { roomId: room.id, actorId: agentActor.id, roomRole: "member" },
  ]);
  return { userId: user.id, agentId: agent.id, roomId: room.id, namespaceId: namespace.id };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  const roomSessions = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, fixture.roomId));
  if (roomSessions.length > 0) {
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, roomSessions[0]!.id));
    await db.delete(sessions).where(eq(sessions.roomId, fixture.roomId));
  }
  await db.delete(roomMembers).where(eq(roomMembers.roomId, fixture.roomId));
  await db.delete(tasks).where(eq(tasks.ownerId, fixture.userId));
  await db.delete(jobs).where(eq(jobs.ownerId, fixture.userId));
  await db.delete(rooms).where(eq(rooms.id, fixture.roomId));
  await db.delete(namespaces).where(eq(namespaces.id, fixture.namespaceId));
  await db.delete(agents).where(eq(agents.id, fixture.agentId));
  await db.delete(actors).where(eq(actors.ownerId, fixture.userId));
  await db.delete(users).where(eq(users.id, fixture.userId));
}

const permissiveMaintenanceGate = {
  isAcceptingWork: async () => true,
  assertAcceptingNewWork: async () => undefined,
};

/** Real JobManager / Job execution with the supported local persistence sinks.
 * The production defaults use the same instance, but explicit sinks keep this
 * isolated scratch fixture independent of shared direct-db initialization. */
function realJobManager(): JobManager {
  return new JobManager({
    laneLock: new InMemoryLaneLock(),
    maintenanceGate: permissiveMaintenanceGate,
    persist: async (payload) => {
      const [job] = await db.insert(jobs).values({ ...payload, status: "queued" }).returning({ id: jobs.id });
      if (!job) throw new Error("D318 Job.persist returned no row");
      return job.id;
    },
    updateStatus: async (jobId, status, fields) => {
      const terminal = status === "completed" || status === "failed" || status === "timed_out" || status === "cancelled";
      await db.update(jobs).set({
        status,
        message: fields?.message ?? null,
        result: fields?.result ?? null,
        ...(status === "running" ? { startedAt: new Date() } : {}),
        ...(terminal ? { completedAt: new Date() } : {}),
      }).where(eq(jobs.id, jobId));
    },
  });
}

async function eventually<T>(description: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`D318 timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function terminalRun(taskId: string) {
  return eventually("terminal TaskRun with exact Job", async () => {
    const [run] = await getTaskRuns(db, taskId);
    return run?.jobId && (run.status === "completed" || run.status === "errored") ? run : undefined;
  });
}

async function terminalJob(jobId: string) {
  return eventually("terminal Job", async () => {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    return job && (job.status === "completed" || job.status === "failed") ? job : undefined;
  });
}

type TransportMode = "success" | "failed";

async function registerOpenCodeTransport(
  fixture: Fixture,
  mode: TransportMode,
  timeline: string[] = [],
): Promise<{ registry: InMemoryRelayRegistry; sent: RelayServerMessage[] }> {
  const registry = new InMemoryRelayRegistry();
  const sent: RelayServerMessage[] = [];
  const accept = (message: Parameters<InMemoryRelayRegistry["acceptAcpMessage"]>[0]["message"]) =>
    registry.acceptAcpMessage({ relayId: RELAY_ID, userId: fixture.userId, message });
  await registry.register(RELAY_ID, fixture.userId, capabilities, (command) => {
    sent.push(command);
    if (command.type === "relay:acp-readiness") {
      expect(accept({ type: "relay:acp-readiness-result", requestId: command.requestId, registrationId: "opencode-acp", scope: command.scope, state: "ready" })).toEqual({ ok: true });
      return;
    }
    if (command.type === "relay:acp-prepare") {
      expect(accept({ type: "relay:acp-prepared", requestId: command.requestId, registrationId: "opencode-acp", scope: command.scope, binding: command.binding, workspace: { workspaceReceiptId: "d318-receipt", workspaceRevision: "d318-revision", workspaceFingerprint: "d318-fingerprint", workspaceExpiresAt: "2035-01-01T00:00:00.000Z" } })).toEqual({ ok: true });
      return;
    }
    if (command.type !== "relay:acp-start") return;
    if (command.registrationId !== "opencode-acp") throw new Error("D318 OpenCode registration mismatch");
    expect(command.executionProfile).toBe("autonomous");
    const process = { connectionId: "d318-connection", processGeneration: 1, acpSessionId: "d318-acp", turnGeneration: 1, turnRef: "d318-turn" } as const;
    expect(accept({ type: "relay:acp-started", registrationId: "hermes-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: "wrong-provider", eventSequence: 1 }).ok).toBeFalse();
    expect(accept({ type: "relay:acp-started", registrationId: "opencode-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: "started", eventSequence: 1 })).toEqual({ ok: true });
    if (mode === "failed") {
      timeline.push("failed-terminal-received");
      expect(accept({ type: "relay:acp-terminal", registrationId: "opencode-acp", scope: command.scope, process, status: "failed", code: "upstream_failure", eventId: "failed", eventSequence: 2 })).toEqual({ ok: true });
      return;
    }
    expect(accept({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: "delta", eventSequence: 2, payload: { kind: "output_delta", vendorItemId: "d318-delta", text: "Inspecting task" } })).toEqual({ ok: true });
    expect(accept({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: "command", eventSequence: 3, payload: { kind: "command_summary", vendorItemId: "d318-command", commands: [{ summary: "Checked the workspace", status: "completed" }] } })).toEqual({ ok: true });
    expect(accept({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: "candidate", eventSequence: 4, payload: { kind: "assistant_completed", vendorItemId: "d318-final", text: "OpenCode completed the requested work." } })).toEqual({ ok: true });
    expect(accept({ type: "relay:acp-terminal", registrationId: "opencode-acp", scope: command.scope, process, status: "completed", eventId: "completed", eventSequence: 5 })).toEqual({ ok: true });
  }, 15, DESKTOP_SESSION_ID, 7, PAIRING_GENERATION);
  return { registry, sent };
}

/** Disconnect immediately after accepting the exact started frame, before the
 * executor can attach its subscription. This is the Electron-restart race:
 * the registry retains/fences that exact turn while the durable lifecycle must
 * still reach one canonical error terminal. */
async function registerStartDisconnectingOpenCodeTransport(
  fixture: Fixture,
): Promise<{
  registry: InMemoryRelayRegistry;
  sent: RelayServerMessage[];
  started: () => { scope: Extract<RelayServerMessage, { type: "relay:acp-start" }>["scope"]; process: { connectionId: string; processGeneration: number; acpSessionId: string; turnGeneration: number; turnRef: string } } | null;
}> {
  const registry = new InMemoryRelayRegistry();
  const sent: RelayServerMessage[] = [];
  let active: { scope: Extract<RelayServerMessage, { type: "relay:acp-start" }>["scope"]; process: { connectionId: string; processGeneration: number; acpSessionId: string; turnGeneration: number; turnRef: string } } | null = null;
  const accept = (message: Parameters<InMemoryRelayRegistry["acceptAcpMessage"]>[0]["message"]) =>
    registry.acceptAcpMessage({ relayId: RELAY_ID, userId: fixture.userId, message });
  await registry.register(RELAY_ID, fixture.userId, capabilities, (command) => {
    sent.push(command);
    if (command.type === "relay:acp-readiness") {
      expect(accept({ type: "relay:acp-readiness-result", requestId: command.requestId, registrationId: "opencode-acp", scope: command.scope, state: "ready" })).toEqual({ ok: true });
      return;
    }
    if (command.type === "relay:acp-prepare") {
      expect(accept({ type: "relay:acp-prepared", requestId: command.requestId, registrationId: "opencode-acp", scope: command.scope, binding: command.binding, workspace: { workspaceReceiptId: "d318-disconnect-receipt", workspaceRevision: "d318-disconnect-revision", workspaceFingerprint: "d318-disconnect-fingerprint", workspaceExpiresAt: "2035-01-01T00:00:00.000Z" } })).toEqual({ ok: true });
      return;
    }
    if (command.type !== "relay:acp-start") return;
    const process = { connectionId: "d318-disconnect-connection", processGeneration: 1, acpSessionId: "d318-disconnect-acp", turnGeneration: 1, turnRef: "d318-disconnect-turn" } as const;
    active = { scope: command.scope, process };
    expect(accept({ type: "relay:acp-started", registrationId: "opencode-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: "disconnect-started", eventSequence: 1 })).toEqual({ ok: true });
    // unregister is synchronous internally; it faults the exact broker turn
    // before the requestAcpStart continuation can subscribe to it.
    void registry.unregister(RELAY_ID);
  }, 15, DESKTOP_SESSION_ID, 7, PAIRING_GENERATION);
  return { registry, sent, started: () => active };
}

/**
 * A deterministic v15 OpenCode peer which deliberately holds each terminal
 * until the test releases it.  That makes the real JobManager's per-thread
 * serialize route observable: a second accepted Task may become durable, but
 * its host turn cannot start before the preceding Task's report-back retires.
 */
async function registerQueuedOpenCodeTransport(
  fixture: Fixture,
  timeline: string[],
): Promise<{
  registry: InMemoryRelayRegistry;
  sent: RelayServerMessage[];
  starts: Extract<RelayServerMessage, { type: "relay:acp-start" }>[];
  processes: Array<{ connectionId: string; processGeneration: number; acpSessionId: string; turnGeneration: number; turnRef: string }>;
  eventIds: string[];
  complete: (ordinal: number) => void;
}> {
  const registry = new InMemoryRelayRegistry();
  const sent: RelayServerMessage[] = [];
  const starts: Extract<RelayServerMessage, { type: "relay:acp-start" }>[] = [];
  const processes: Array<{ connectionId: string; processGeneration: number; acpSessionId: string; turnGeneration: number; turnRef: string }> = [];
  const eventIds: string[] = [];
  const pending = new Map<number, {
    command: Extract<RelayServerMessage, { type: "relay:acp-start" }>;
    process: { connectionId: string; processGeneration: number; acpSessionId: string; turnGeneration: number; turnRef: string };
  }>();
  const accept = (message: Parameters<InMemoryRelayRegistry["acceptAcpMessage"]>[0]["message"]) =>
    registry.acceptAcpMessage({ relayId: RELAY_ID, userId: fixture.userId, message });
  await registry.register(RELAY_ID, fixture.userId, capabilities, (command) => {
    sent.push(command);
    if (command.type === "relay:acp-readiness") {
      expect(accept({ type: "relay:acp-readiness-result", requestId: command.requestId, registrationId: "opencode-acp", scope: command.scope, state: "ready" })).toEqual({ ok: true });
      return;
    }
    if (command.type === "relay:acp-prepare") {
      expect(accept({ type: "relay:acp-prepared", requestId: command.requestId, registrationId: "opencode-acp", scope: command.scope, binding: command.binding, workspace: { workspaceReceiptId: "d318-queued-receipt", workspaceRevision: "d318-queued-revision", workspaceFingerprint: "d318-queued-fingerprint", workspaceExpiresAt: "2035-01-01T00:00:00.000Z" } })).toEqual({ ok: true });
      return;
    }
    if (command.type !== "relay:acp-start") return;
    if (command.registrationId !== "opencode-acp") throw new Error("D318 queued OpenCode registration mismatch");
    expect(command.executionProfile).toBe("autonomous");
    const ordinal = starts.length + 1;
    const process = {
      connectionId: `d318-queued-connection-${ordinal}`,
      processGeneration: ordinal,
      acpSessionId: `d318-queued-acp-${ordinal}`,
      turnGeneration: ordinal,
      turnRef: `d318-queued-turn-${ordinal}`,
    } as const;
    starts.push(command);
    processes.push(process);
    const startedEventId = `started-${ordinal}`;
    const deltaEventId = `delta-${ordinal}`;
    const candidateEventId = `candidate-${ordinal}`;
    eventIds.push(startedEventId, deltaEventId, candidateEventId, `completed-${ordinal}`);
    expect(accept({ type: "relay:acp-started", registrationId: "opencode-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: startedEventId, eventSequence: 1 })).toEqual({ ok: true });
    expect(accept({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: deltaEventId, eventSequence: 2, payload: { kind: "output_delta", vendorItemId: `d318-queued-delta-${ordinal}`, text: `Inspecting queued task ${ordinal}` } })).toEqual({ ok: true });
    expect(accept({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope: command.scope, process, capabilities: { requests: "unsupported" }, eventId: candidateEventId, eventSequence: 3, payload: { kind: "assistant_completed", vendorItemId: `d318-queued-final-${ordinal}`, text: `OpenCode queued turn ${ordinal} completed.` } })).toEqual({ ok: true });
    pending.set(ordinal, { command, process });
    timeline.push(`started:${ordinal}`);
  }, 15, DESKTOP_SESSION_ID, 7, PAIRING_GENERATION);
  return {
    registry,
    sent,
    starts,
    processes,
    eventIds,
    complete: (ordinal) => {
      const active = pending.get(ordinal);
      if (!active) throw new Error(`D318 queued OpenCode turn ${ordinal} is not pending`);
      pending.delete(ordinal);
      expect(accept({ type: "relay:acp-terminal", registrationId: "opencode-acp", scope: active.command.scope, process: active.process, status: "completed", eventId: `completed-${ordinal}`, eventSequence: 4 })).toEqual({ ok: true });
    },
  };
}

/** Observe (but do not replace) the real registry subscription / containment
 * calls, establishing report-back -> terminal acknowledgement -> containment
 * ordering without introducing a transport fake. */
function observeTerminalOrder(registry: InMemoryRelayRegistry, timeline: string[]) {
  const subscribe = registry.subscribeAcpExecution.bind(registry);
  const contain = registry.containAcpExecution.bind(registry);
  const subscribeSpy = spyOn(registry, "subscribeAcpExecution").mockImplementation((scope, process, registrationId) => {
    expect(registrationId).toBe("opencode-acp");
    const subscription = subscribe(scope, process, registrationId);
    if (!subscription) return null;
    return {
      next: () => subscription.next(),
      acknowledge: (eventId, eventSequence) => {
        timeline.push(`ack:${eventId}`);
        subscription.acknowledge(eventId, eventSequence);
      },
      close: () => subscription.close(),
    };
  });
  const containSpy = spyOn(registry, "containAcpExecution").mockImplementation((scope, process, registrationId) => {
    expect(registrationId).toBe("opencode-acp");
    timeline.push("contain-invoked");
    return contain(scope, process, registrationId);
  });
  return { restore: () => { subscribeSpy.mockRestore(); containSpy.mockRestore(); } };
}

function selectorFor(registry: InMemoryRelayRegistry) {
  return createTaskHarnessExecutionRouteSelector({
    tasks: createTaskHarnessExecutionRouteStore(db),
    registrations: [createOpenCodeAcpTaskExecutionRouteRegistration(db, registry)],
  });
}

async function admitOpenCodeTask(
  fixture: Fixture,
  registry: InMemoryRelayRegistry,
  prompt = "Complete the local OpenCode task.",
) {
  const created = await createOpenCodeAcpHarnessTask({
    facts: createCodexCanonicalFactsReader(db),
    relay: registry,
    createTask: (input) => runtimeCreateTask({
      db,
      observer: { kick: () => undefined },
      invocationAuthority: createAcceptedInvocationAuthority(input.requestorId),
      provenance: createHumanApiTaskCreationProvenance({ ownerId: input.ownerId }),
      admission: getPlaintextTaskCreationAdmission(),
    }, input),
    mintRequestId: randomUUID,
  }, {
    ownerId: fixture.userId,
    requestorId: fixture.userId,
    agentId: fixture.agentId,
    prompt,
    callingRoomId: fixture.roomId,
    harness: "opencode-acp",
    executionProfile: "autonomous",
  });
  const task = await getTaskById(db, created.taskId);
  if (!task) throw new Error("D318 admitted OpenCode Task missing");
  return task;
}

async function seedNativeTask(fixture: Fixture) {
  return createTask(db, {
    ownerId: fixture.userId, requestorId: fixture.userId, agentId: fixture.agentId,
    prompt: "Complete the local Native task.", scheduleKind: "now",
    targetChat: "last_in_namespace", targetRoomId: fixture.roomId,
    targetUserIds: [fixture.userId], callingRoomId: fixture.roomId,
    resultDelivery: "raw", toolsMode: "none", nextFireAt: new Date(),
    status: "pending", metadata: {},
  });
}

describe("D318 C2 OpenCode ACP durable Task execution", () => {
  test("terminalizes the exact durable TaskRun when Electron disconnects between start and subscription, and fences late old-generation events", async () => {
    const fixture = await seedFixture("disconnect");
    const observed: ServerEvent[] = [];
    const observe = (event: ServerEvent) => observed.push(event);
    eventBus.on(observe);
    try {
      const transport = await registerStartDisconnectingOpenCodeTransport(fixture);
      const task = await admitOpenCodeTask(fixture, transport.registry);
      await dispatchTaskRun(task, {
        db,
        jobManager: realJobManager(),
        resolver: new PersonalPolicyResolver(fixture.userId),
        maintenanceGate: permissiveMaintenanceGate,
        executionRouteSelector: selectorFor(transport.registry),
      });

      const run = await terminalRun(task.id);
      const job = await terminalJob(run.jobId!);
      const persistedTask = await getTaskById(db, task.id);
      expect(persistedTask).toMatchObject({ status: "errored", lastError: "ACP_EXECUTION_FAILED" });
      const failureResult = renderDelegatedTaskFailureReceipt({ provider: "OpenCode", reason: "desktop_disconnected", phase: "running", processStarted: true, commandActivityCount: 0, outputObserved: false, containmentRequested: false });
      expect(run).toMatchObject({ taskId: task.id, jobId: job.id, status: "errored", lastError: "ACP_EXECUTION_FAILED", resultText: failureResult });
      expect(job.status).toBe("failed");
      expect(observed.filter((event) => event.type === "task.errored")).toHaveLength(1);
      const raw = await db.select({ content: sessionMessages.content }).from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(eq(sessions.roomId, fixture.roomId));
      expect(raw).toEqual([{ content: failureResult }]);

      const started = transport.started();
      if (!started) throw new Error("D318 disconnect start missing");
      await transport.registry.register(RELAY_ID, fixture.userId, capabilities, () => undefined, 15, DESKTOP_SESSION_ID, 8, PAIRING_GENERATION);
      expect(transport.registry.acceptAcpMessage({
        relayId: RELAY_ID,
        userId: fixture.userId,
        message: { type: "relay:acp-terminal", registrationId: "opencode-acp", scope: started.scope, process: started.process, status: "failed", code: "upstream_failure", eventId: "late-disconnect-terminal", eventSequence: 2 },
      })).toEqual({ ok: false, error: "ACP_CONTEXT_STALE" });
      expect(observed.filter((event) => event.type === "task.errored")).toHaveLength(1);
    } finally {
      eventBus.off(observe);
      await cleanupFixture(fixture);
    }
  });

  test("routes the real TaskRun through readiness, prepare, start, progress, raw report-back, and terminal acknowledgement", async () => {
    const fixture = await seedFixture("success");
    const observed: ServerEvent[] = [];
    const eventTimeline: string[] = [];
    const observe = (event: ServerEvent) => {
      observed.push(event);
      if (event.type === "task.progress") eventTimeline.push("progress");
      if (event.type === "message.new" && "content" in event && event.content === "OpenCode completed the requested work.") eventTimeline.push("raw-report-back");
    };
    eventBus.on(observe);
    let terminalObserver: ReturnType<typeof observeTerminalOrder> | null = null;
    try {
      const { registry, sent } = await registerOpenCodeTransport(fixture, "success");
      const timeline = eventTimeline;
      terminalObserver = observeTerminalOrder(registry, timeline);
      const task = await admitOpenCodeTask(fixture, registry);
      await dispatchTaskRun(task, {
        db,
        jobManager: realJobManager(),
        resolver: new PersonalPolicyResolver(fixture.userId),
        maintenanceGate: permissiveMaintenanceGate,
        executionRouteSelector: selectorFor(registry),
      });

      const run = await terminalRun(task.id);
      const job = await terminalJob(run.jobId!);
      const persistedTask = await getTaskById(db, task.id);
      expect(persistedTask?.status).toBe("completed");
      expect(run).toMatchObject({ taskId: task.id, jobId: job.id, status: "completed", modelId: null, resultText: "OpenCode completed the requested work." });
      expect(job).toMatchObject({ status: "completed", ownerId: fixture.userId, requestorId: fixture.userId, roomId: fixture.roomId });
      expect((job.input as Record<string, unknown>)?.["modelId"]).toBeNull();
      expect(observed.filter((event) => event.type === "task.progress").map((event) => event.detail))
        .toEqual(["Inspecting task", "Checked the workspace"]);
      const raw = await db.select({ content: sessionMessages.content }).from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(and(eq(sessions.roomId, fixture.roomId), eq(sessionMessages.content, "OpenCode completed the requested work.")));
      expect(raw).toHaveLength(1);
      expect(sent.map((message) => message.type)).toEqual([
        "relay:acp-readiness", "relay:acp-readiness", "relay:acp-prepare", "relay:acp-start",
      ]);
      const progressIndex = observed.findIndex((event) => event.type === "task.progress");
      const rawMessageIndex = observed.findIndex((event) => event.type === "message.new" && "content" in event && event.content === "OpenCode completed the requested work.");
      expect(progressIndex).toBeGreaterThanOrEqual(0);
      expect(rawMessageIndex).toBeGreaterThan(progressIndex);
      expect(timeline.indexOf("raw-report-back")).toBeGreaterThan(timeline.indexOf("progress"));
      expect(timeline.indexOf("ack:completed")).toBeGreaterThanOrEqual(0);
      expect(timeline.indexOf("ack:completed")).toBeGreaterThan(timeline.indexOf("raw-report-back"));
      // The terminal is acknowledged after canonical raw report-back and is
      // then retired from the real registry.
      const start = sent.find((message): message is Extract<RelayServerMessage, { type: "relay:acp-start" }> => message.type === "relay:acp-start");
      if (!start) throw new Error("D318 OpenCode start missing");
      expect(registry.subscribeAcpExecution(start.scope, { connectionId: "d318-connection", processGeneration: 1, acpSessionId: "d318-acp", turnGeneration: 1, turnRef: "d318-turn" }, "opencode-acp")).toBeNull();
      expect(sent.some((message) => message.type === "relay:acp-contain")).toBeFalse();
    } finally {
      terminalObserver?.restore();
      eventBus.off(observe);
      await cleanupFixture(fixture);
    }
  });

  test("serializes queued OpenCode Tasks on their isolated per-Room harness thread", async () => {
    const fixture = await seedFixture("queued-follow-up");
    const timeline: string[] = [];
    const observed: ServerEvent[] = [];
    const firstResult = "OpenCode queued turn 1 completed.";
    const secondResult = "OpenCode queued turn 2 completed.";
    const observe = (event: ServerEvent) => {
      observed.push(event);
      if (event.type === "message.new" && "content" in event && event.content === firstResult) timeline.push("raw-report-back:1");
      if (event.type === "message.new" && "content" in event && event.content === secondResult) timeline.push("raw-report-back:2");
    };
    eventBus.on(observe);
    let terminalObserver: ReturnType<typeof observeTerminalOrder> | null = null;
    try {
      const transport = await registerQueuedOpenCodeTransport(fixture, timeline);
      terminalObserver = observeTerminalOrder(transport.registry, timeline);
      const firstTask = await admitOpenCodeTask(
        fixture,
        transport.registry,
        "Complete the first serialized OpenCode task.",
      );
      const secondTask = await admitOpenCodeTask(
        fixture,
        transport.registry,
        "Complete the queued OpenCode follow-up.",
      );
      const jobManager = realJobManager();
      const executionDeps = {
        db,
        jobManager,
        resolver: new PersonalPolicyResolver(fixture.userId),
        maintenanceGate: permissiveMaintenanceGate,
        executionRouteSelector: selectorFor(transport.registry),
      } as const;

      const firstDispatch = await dispatchTaskRun(firstTask, executionDeps);
      await eventually("first queued OpenCode host turn", async () => transport.starts[0]);
      const secondDispatch = await dispatchTaskRun(secondTask, executionDeps);

      // Sibling OpenCode Tasks share an isolated harness queue. That preserves
      // their ordered report-back contract without occupying Moxie's Room
      // checkpoint, which remains available for task controls.
      expect(firstDispatch.runId).not.toBe(secondDispatch.runId);
      expect(firstDispatch.graphThreadId).toBe(secondDispatch.graphThreadId);
      expect(firstDispatch.graphThreadId).toBe(`subagent:harness:opencode-acp:room:${fixture.roomId}:agent:${fixture.agentId}`);
      expect(firstDispatch.graphThreadId).not.toBe(`room:${fixture.roomId}:bot:${fixture.agentId}`);
      expect(transport.starts).toHaveLength(1);
      expect(timeline).toContain("started:1");
      expect(timeline).not.toContain("started:2");
      expect(timeline).not.toContain("raw-report-back:1");
      expect(timeline).not.toContain("raw-report-back:2");

      transport.complete(1);
      const firstRun = await terminalRun(firstTask.id);
      const firstJob = await terminalJob(firstRun.jobId!);
      await eventually("second queued OpenCode host turn after first report-back", async () => transport.starts[1]);
      expect(timeline.indexOf("raw-report-back:1")).toBeGreaterThanOrEqual(0);
      expect(timeline.indexOf("started:2")).toBeGreaterThan(timeline.indexOf("raw-report-back:1"));
      expect(timeline.indexOf("ack:completed-1")).toBeGreaterThan(timeline.indexOf("raw-report-back:1"));
      expect(timeline.indexOf("started:2")).toBeGreaterThan(timeline.indexOf("ack:completed-1"));
      expect(observed.filter((event) => event.type === "message.new" && "content" in event && event.content === secondResult)).toEqual([]);
      const firstStartAtHandoff = transport.starts[0];
      if (!firstStartAtHandoff) throw new Error("D318 first queued OpenCode start missing at handoff");
      expect(transport.registry.subscribeAcpExecution(firstStartAtHandoff.scope, transport.processes[0]!, "opencode-acp")).toBeNull();

      transport.complete(2);
      const secondRun = await terminalRun(secondTask.id);
      const secondJob = await terminalJob(secondRun.jobId!);
      const [persistedFirst, persistedSecond] = await Promise.all([
        getTaskById(db, firstTask.id),
        getTaskById(db, secondTask.id),
      ]);
      expect(persistedFirst?.status).toBe("completed");
      expect(persistedSecond?.status).toBe("completed");
      expect(firstRun).toMatchObject({ taskId: firstTask.id, jobId: firstJob.id, status: "completed", modelId: null, resultText: firstResult });
      expect(secondRun).toMatchObject({ taskId: secondTask.id, jobId: secondJob.id, status: "completed", modelId: null, resultText: secondResult });
      expect(firstRun.id).not.toBe(secondRun.id);
      expect(firstJob.id).not.toBe(secondJob.id);
      expect((firstJob.input as Record<string, unknown>)["modelId"]).toBeNull();
      expect((secondJob.input as Record<string, unknown>)["modelId"]).toBeNull();

      const starts = transport.starts;
      const [firstStart, secondStart] = starts;
      if (!firstStart || !secondStart) throw new Error("D318 queued OpenCode starts missing");
      expect(firstStart.scope.socket).toEqual(secondStart.scope.socket);
      expect(firstStart.scope.workspace).toEqual(secondStart.scope.workspace);
      expect(firstStart.scope.binding).toMatchObject({ ownerId: fixture.userId, taskId: firstTask.id, taskRunId: firstRun.id, jobId: firstJob.id });
      expect(secondStart.scope.binding).toMatchObject({ ownerId: fixture.userId, taskId: secondTask.id, taskRunId: secondRun.id, jobId: secondJob.id });
      expect(firstStart.scope.binding.bindingId).not.toBe(secondStart.scope.binding.bindingId);
      expect(firstStart.scope.binding.bindingGeneration).not.toBe(secondStart.scope.binding.bindingGeneration);
      expect(transport.processes).toHaveLength(2);
      expect(new Set(transport.processes.map((process) => JSON.stringify(process))).size).toBe(2);
      expect(new Set(transport.eventIds).size).toBe(transport.eventIds.length);

      const raw = await db.select({ content: sessionMessages.content }).from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(eq(sessions.roomId, fixture.roomId));
      expect(raw.map((message) => message.content).sort()).toEqual([firstResult, secondResult]);
      expect(raw.map((message) => message.content)).not.toContain("Inspecting queued task 1");
      expect(raw.map((message) => message.content)).not.toContain("Inspecting queued task 2");
      expect(observed.filter((event) => event.type === "message.new" && "content" in event && [firstResult, secondResult].includes(event.content))).toHaveLength(2);

      expect(transport.sent.map((message) => message.type)).toEqual([
        "relay:acp-readiness", "relay:acp-readiness",
        "relay:acp-readiness", "relay:acp-prepare", "relay:acp-start",
        "relay:acp-readiness", "relay:acp-prepare", "relay:acp-start",
      ]);
      expect(transport.sent.filter((message) => message.type === "relay:acp-contain")).toEqual([]);
      expect(transport.registry.subscribeAcpExecution(firstStart.scope, transport.processes[0]!, "opencode-acp")).toBeNull();
      expect(transport.registry.subscribeAcpExecution(secondStart.scope, transport.processes[1]!, "opencode-acp")).toBeNull();
    } finally {
      terminalObserver?.restore();
      eventBus.off(observe);
      await cleanupFixture(fixture);
    }
  });

  test("reports an authenticated failed terminal before its one final containment attempt and retires it after acknowledgement", async () => {
    const fixture = await seedFixture("failure");
    const observed: ServerEvent[] = [];
    const eventTimeline: string[] = [];
    const failureResult = renderDelegatedTaskFailureReceipt({ provider: "OpenCode", reason: "ended_without_result", phase: "running", processStarted: true, commandActivityCount: 0, outputObserved: false, containmentRequested: false });
    const observe = (event: ServerEvent) => {
      observed.push(event);
      if (event.type === "message.new" && "content" in event && event.content === failureResult) eventTimeline.push("safe-failure-report");
      if (event.type === "task.errored") eventTimeline.push("error-report-back");
    };
    eventBus.on(observe);
    let terminalObserver: ReturnType<typeof observeTerminalOrder> | null = null;
    try {
      const timeline = eventTimeline;
      const { registry, sent } = await registerOpenCodeTransport(fixture, "failed", timeline);
      terminalObserver = observeTerminalOrder(registry, timeline);
      const task = await admitOpenCodeTask(fixture, registry);
      await dispatchTaskRun(task, {
        db,
        jobManager: realJobManager(),
        resolver: new PersonalPolicyResolver(fixture.userId),
        maintenanceGate: permissiveMaintenanceGate,
        executionRouteSelector: selectorFor(registry),
      });
      const run = await terminalRun(task.id);
      const job = await terminalJob(run.jobId!);
      const persistedTask = await getTaskById(db, task.id);
      expect(persistedTask).toMatchObject({ status: "errored", lastError: "ACP_EXECUTION_FAILED" });
      expect(run).toMatchObject({ taskId: task.id, jobId: job.id, status: "errored", lastError: "ACP_EXECUTION_FAILED", resultText: failureResult });
      expect(job.status).toBe("failed");
      expect(observed.filter((event) => event.type === "task.progress")).toEqual([]);
      const raw = await db.select({ content: sessionMessages.content }).from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(eq(sessions.roomId, fixture.roomId));
      expect(raw).toEqual([{ content: failureResult }]);
      expect(sent.filter((message) => message.type === "relay:acp-contain")).toHaveLength(0);
      expect(timeline).toContain("failed-terminal-received");
      expect(timeline).toContain("safe-failure-report");
      expect(timeline).toContain("error-report-back");
      expect(timeline).toContain("ack:failed");
      expect(timeline.filter((item) => item === "contain-invoked")).toHaveLength(1);
      const reportBackIndex = observed.findIndex((event) => event.type === "task.errored");
      expect(reportBackIndex).toBeGreaterThanOrEqual(0);
      // The real executor invokes containment only after canonical error
      // report-back and terminal acknowledgement; a terminal relay turn needs
      // no second outbound contain frame once it is already terminal.
      expect(timeline.indexOf("error-report-back")).toBeGreaterThan(timeline.indexOf("safe-failure-report"));
      expect(timeline.indexOf("ack:failed")).toBeGreaterThan(timeline.indexOf("error-report-back"));
      expect(timeline.indexOf("contain-invoked")).toBeGreaterThan(timeline.indexOf("ack:failed"));
      const start = sent.find((message): message is Extract<RelayServerMessage, { type: "relay:acp-start" }> => message.type === "relay:acp-start");
      if (!start) throw new Error("D318 failed OpenCode start missing");
      expect(registry.subscribeAcpExecution(start.scope, { connectionId: "d318-connection", processGeneration: 1, acpSessionId: "d318-acp", turnGeneration: 1, turnRef: "d318-turn" }, "opencode-acp")).toBeNull();
    } finally {
      terminalObserver?.restore();
      eventBus.off(observe);
      await cleanupFixture(fixture);
    }
  });

  test("keeps metadata-less Native Tasks on the generic selector's undefined path", async () => {
    const fixture = await seedFixture("native");
    try {
      const task = await seedNativeTask(fixture);
      const registry = new InMemoryRelayRegistry();
      await registry.register(RELAY_ID, fixture.userId, capabilities, () => undefined, 15, DESKTOP_SESSION_ID, 7, PAIRING_GENERATION);
      expect(await selectorFor(registry)({
        taskId: task.id,
        taskRunId: randomUUID(),
        parentTaskId: null,
        ownerId: fixture.userId,
        requestorId: fixture.userId,
        agentId: fixture.agentId,
        roomId: fixture.roomId,
        laneKey: `task:${task.id}`,
        graphThreadId: `room:${fixture.roomId}`,
      })).toBeUndefined();
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
