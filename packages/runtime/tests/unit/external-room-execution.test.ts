import { afterEach, expect, spyOn, test } from "bun:test";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { externalRoomExecutor, getCurrentExternalRoomExecution, type ExternalRoomExecutionCandidate } from "../../src/external-room-execution";
import { installForegroundChatFundingPort, openExternalRoomFundingSession, uninstallForegroundChatFundingPort } from "../../src/foreground-chat-funding-port";
import { JobManager } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import { randomUUID } from "node:crypto";
import { eventBus } from "../../src/event-bus";
import type { ServerEvent } from "@nautilo/types";
import { processStreamEvent } from "../../src/executors/langgraph-executor";
import { externalRoomExecutionInput } from "../../src/executors/external-room-context";
import { TokenBatcher, ToolCallTracker } from "../../src/utils/token-batcher";

afterEach(uninstallForegroundChatFundingPort);

function candidate(): ExternalRoomExecutionCandidate {
  const reference = { kind: "external_room_turn_v1" as const, receiptId: "receipt", bindingId: "binding",
    bindingRevision: 1, connectionGeneration: 1, acceptanceId: "acceptance", roomId: "room", agentId: "agent", turnId: "turn" };
  return {
    jobId: "job", reference, sponsorUserId: "sponsor",
    invocationAuthority: createAcceptedInvocationAuthority("sponsor"),
    verifyPersisted: async () => {}, linkAcceptance: async () => {}, updateStatus: async status => status,
    hydrate: async () => ({ input: { message: "canonical", causalHumanUserId: null }, context: {
      reference, sponsorUserId: "sponsor", assertSponsorship: async () => {}, complete: async () => {},
      origin: { kind: "external_message", version: 1, provider: "bolter", origin: "https://bolter.chat",
        connectionId: "connection", bindingId: "binding", providerAgentId: "provider-agent", chatId: "chat",
        threadRootId: null, messageId: "message", senderId: "sender", senderType: "user", senderLabel: "Visitor",
        createdAt: "2026-01-01T00:00:00.000Z" },
    } }),
  };
}

test("hydrates canonical input and keeps trusted origin scoped to every generator continuation", async () => {
  const seen: unknown[] = [];
  const run = externalRoomExecutor(candidate(), async function* (input) { yield* [];
    seen.push(input, getCurrentExternalRoomExecution()?.sponsorUserId);
    await Promise.resolve();
    seen.push(getCurrentExternalRoomExecution()?.origin.senderLabel);
  });
  for await (const _event of run({ message: "forged", externalOrigin: {} }, "job", null, new AbortController().signal)) { /* drain */ }
  expect(seen).toEqual([{ message: "canonical", causalHumanUserId: null }, "sponsor", "Visitor"]);
  expect(getCurrentExternalRoomExecution()).toBeUndefined();
});

test("external funding rejects a missing or null port rather than falling through to server funding", async () => {
  const input = { modelId: "model", roomId: "room", agentId: "agent" };
  expect(openExternalRoomFundingSession(input)).rejects.toThrow();
  const run = externalRoomExecutor(candidate(), async function* () { yield* [];
    expect(openExternalRoomFundingSession(input)).rejects.toThrow();
    installForegroundChatFundingPort({ openSession: async () => null });
    expect(openExternalRoomFundingSession(input)).rejects.toThrow();
  });
  for await (const _event of run({}, "job", null, new AbortController().signal)) { /* drain */ }
});

test("external funding uses the sponsor with an explicit entrypoint and current sponsorship callback", async () => {
  let opened: unknown;
  const session = { kind: "server" as const, recheckAttempt: async () => {}, runAttempt: async () => { throw new Error("not invoked"); } };
  installForegroundChatFundingPort({ openSession: async input => { opened = input; await input.assertExternalRoomSponsorship!(); return session; } });
  const run = externalRoomExecutor(candidate(), async function* () { yield* [];
    expect(await openExternalRoomFundingSession({ modelId: "model", roomId: "room", agentId: "agent" })).toBe(session);
  });
  for await (const _event of run({}, "job", null, new AbortController().signal)) { /* drain */ }
  expect(opened).toMatchObject({ humanUserId: "sponsor", entrypoint: "foreground.external_room", hasImages: false });
});

test("JobManager adopts exact Jobs once and serializes the bound checkpoint without inserting another Job", async () => {
  const manager = new JobManager({ laneLock: new InMemoryLaneLock(), checkInvocationAccess: async () => true,
    persist: async () => { throw new Error("Adoption must not INSERT a Job"); }, updateStatus: async () => {},
    acceptanceSinks: { insertAcceptance: async () => { throw new Error("Adoption must not INSERT acceptance"); },
      linkAcceptancesToJob: async () => { throw new Error("External linkage must use its exact receipt"); },
      userCancelAcceptedWork: async () => 0, terminalizeAllAcceptedWork: async () => 0 } });
  const roomId = randomUUID();
  const first = candidate();
  const second = candidate();
  const firstEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const calls: string[] = [];
  const make = (base: ExternalRoomExecutionCandidate, jobId: string): ExternalRoomExecutionCandidate => ({
    ...base, jobId, reference: { ...base.reference, roomId, turnId: jobId, acceptanceId: randomUUID() },
    invocationAuthority: createAcceptedInvocationAuthority("sponsor", { originRoomId: roomId }),
    async updateStatus(status) { if (jobId === "second" && status === "completed") finished.resolve(); return status; },
  });
  const firstCandidate = make(first, "first");
  const executor = async function* (_input: Record<string, unknown>, jobId: string) {
    yield* [];
    calls.push(jobId);
    if (jobId === "first") { firstEntered.resolve(); await releaseFirst.promise; }
    else secondEntered.resolve();
  };
  await Promise.all([manager.adoptExternalRoomJob(firstCandidate, executor), manager.adoptExternalRoomJob(firstCandidate, executor)]);
  await firstEntered.promise;
  await manager.adoptExternalRoomJob(make(second, "second"), executor);
  expect(calls).toEqual(["first"]);
  releaseFirst.resolve();
  await secondEntered.promise;
  await finished.promise;
  expect(calls).toEqual(["first", "second"]);
});

test("a losing persist-time verification never emits failed for another owner's durable Job", async () => {
  const checked = Promise.withResolvers<void>();
  let calls = 0;
  const base = candidate();
  const jobId = randomUUID();
  const roomId = randomUUID();
  const execution: ExternalRoomExecutionCandidate = { ...base, jobId,
    reference: { ...base.reference, roomId },
    invocationAuthority: createAcceptedInvocationAuthority("sponsor", { originRoomId: roomId }),
    async verifyPersisted() {
      calls += 1;
      if (calls > 1) { checked.resolve(); throw new Error("Another owner started the Job"); }
    } };
  const manager = new JobManager({ laneLock: new InMemoryLaneLock(), checkInvocationAccess: async () => true,
    persist: async () => { throw new Error("Unexpected insert"); }, updateStatus: async () => {} });
  const events: ServerEvent[] = [];
  const receive = (event: ServerEvent) => { events.push(event); };
  eventBus.on(receive);
  try {
    await manager.adoptExternalRoomJob(execution, async function* () { yield* []; throw new Error("Must not execute"); });
    await checked.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events.filter(event => event.type === "job.status" && event.jobId === jobId)).toEqual([]);
    expect(manager.getJob(jobId)).toBeUndefined();
  } finally { eventBus.off(receive); }
});

test("Stop still settles the precreated queued Job after transient persistence verification failure", async () => {
  const checked = Promise.withResolvers<void>();
  const roomId = randomUUID();
  const base = candidate();
  let verifications = 0;
  let durable = "queued";
  let executed = false;
  const execution: ExternalRoomExecutionCandidate = { ...base, jobId: randomUUID(),
    reference: { ...base.reference, roomId },
    invocationAuthority: createAcceptedInvocationAuthority("sponsor", { originRoomId: roomId }),
    async verifyPersisted() { if (++verifications > 1) { checked.resolve(); throw new Error("Synthetic transient read failure"); } },
    async updateStatus(status) { durable = status; return status; } };
  const manager = new JobManager({ laneLock: new InMemoryLaneLock(), checkInvocationAccess: async () => true,
    persist: async () => { throw new Error("Unexpected insert"); }, updateStatus: async () => {} });
  await manager.adoptExternalRoomJob(execution, async function* () { yield* []; executed = true; });
  await checked.promise;
  await new Promise(resolve => setTimeout(resolve, 0));
  await manager.stopRoom(roomId);
  expect(durable).toBe("cancelled");
  expect(executed).toBe(false);
});


test("throwing dispatch and status subscribers cannot strand external execution or its room lane", async () => {
  const manager = new JobManager({ laneLock: new InMemoryLaneLock(), checkInvocationAccess: async () => true,
    persist: async () => { throw new Error("Unexpected insert"); }, updateStatus: async () => {} });
  const roomId = randomUUID();
  const completed = Promise.withResolvers<void>();
  let calls = 0;
  const receive = (event: ServerEvent) => {
    if (event.type === "job.dispatched" || event.type === "job.status") throw new Error("Synthetic observer failure");
  };
  eventBus.on(receive);
  try {
    for (let index = 0; index < 2; index++) {
      const base = candidate();
      await manager.adoptExternalRoomJob({ ...base, jobId: randomUUID(),
        reference: { ...base.reference, roomId, acceptanceId: randomUUID() },
        invocationAuthority: createAcceptedInvocationAuthority("sponsor", { originRoomId: roomId }),
        async updateStatus(status) { if (status === "completed" && calls === 2) completed.resolve(); return status; },
      }, async function* () { yield* []; calls += 1; });
    }
    await completed.promise;
    expect(calls).toBe(2);
  } finally { eventBus.off(receive); }
});


test("Stop continues after a remote-owned candidate rejects cancellation", async () => {
  const roomId = randomUUID();
  const checks = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const states = ["running", "queued"];
  const manager = new JobManager({ laneLock: new InMemoryLaneLock(), checkInvocationAccess: async () => true,
    persist: async () => { throw new Error("Unexpected insert"); }, updateStatus: async () => {} });
  for (let index = 0; index < 2; index++) {
    const base = candidate();
    let verifications = 0;
    await manager.adoptExternalRoomJob({ ...base, jobId: randomUUID(),
      reference: { ...base.reference, roomId, acceptanceId: randomUUID() },
      invocationAuthority: createAcceptedInvocationAuthority("sponsor", { originRoomId: roomId }),
      async verifyPersisted() {
        if (++verifications > 1) { checks[index]!.resolve(); throw new Error("Synthetic persistence verification failure"); }
      },
      async updateStatus(status) {
        if (index === 0) throw new Error("Another process owns this Job");
        states[index] = status;
        return status;
      },
    }, async function* () { yield* []; throw new Error("Must not execute"); });
    await checks[index]!.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  await manager.stopRoom(roomId);
  expect(states).toEqual(["running", "cancelled"]);
});

test("a busy durable receipt retries after remote claim release and retains its own failed release proof", async () => {
  const roomId = randomUUID();
  let held: string | null = "remote-owner";
  let failRelease = true;
  let acquisitions = 0;
  let calls = 0;
  const manager = new JobManager({ laneLock: new InMemoryLaneLock(), checkInvocationAccess: async () => true,
    persist: async () => { throw new Error("Unexpected insert"); }, updateStatus: async () => {},
    externalRoomClaims: {
      async acquire(_user, jobId) {
        if (held) return { kind: "busy" };
        held = jobId;
        acquisitions += 1;
        return { kind: "claimed", roomId, jobId, token: `private-${jobId}` };
      },
      async release(_user, claim) {
        if (failRelease) { failRelease = false; throw new Error("Synthetic transient release failure"); }
        if (held !== claim.jobId || claim.token !== `private-${claim.jobId}`) return false;
        held = null;
        return true;
      },
    },
  });
  const base = candidate();
  const execution = { ...base, jobId: randomUUID(), reference: { ...base.reference, roomId, acceptanceId: randomUUID() },
    invocationAuthority: createAcceptedInvocationAuthority("sponsor", { originRoomId: roomId }) };
  const executor = async function* () { yield* []; calls += 1; };
  const idle = async () => {
    const deadline = Date.now() + 1_000;
    while (manager.hasLocalExternalRoomWork(execution.jobId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    expect(manager.hasLocalExternalRoomWork(execution.jobId)).toBe(false);
  };
  await manager.adoptExternalRoomJob(execution, executor);
  await idle();
  expect(calls).toBe(0);
  expect(await manager.retryQuiescentExternalRoomClaims()).toBe(0);
  expect(held).toBe("remote-owner");
  held = null; // The remote owner releases only after its own executor finishes.
  await manager.adoptExternalRoomJob(execution, executor);
  await idle();
  expect(await manager.retryQuiescentExternalRoomClaims()).toBe(0);
  expect(acquisitions).toBe(1);
  expect(calls).toBe(1);
  expect(held).toBeNull();
});


test("external execution suppresses opt-in raw model stream diagnostics", async () => {
  const previous = process.env["NAUTILO_DEBUG_FIREWORKS_STREAM"];
  process.env["NAUTILO_DEBUG_FIREWORKS_STREAM"] = "1";
  const logs: unknown[][] = [];
  const spies = (["log", "warn", "error", "debug"] as const).map(method =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); }));
  try {
    const run = externalRoomExecutor(candidate(), async function* () { yield* [];
      processStreamEvent({ event: "on_chat_model_stream", name: "ChatModel",
        data: { chunk: { content: "", reasoning_content: "PRIVATE_EXTERNAL_REASONING" } } },
      new TokenBatcher({ laneKey: "room:room" }), new ToolCallTracker("room:room"));
    });
    for await (const _event of run({}, "job", null, new AbortController().signal)) { /* drain */ }
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_EXTERNAL_REASONING");
    expect(JSON.stringify(logs)).not.toContain("on_chat_model_stream");
  } finally {
    for (const spy of spies) spy.mockRestore();
    if (previous === undefined) delete process.env["NAUTILO_DEBUG_FIREWORKS_STREAM"];
    else process.env["NAUTILO_DEBUG_FIREWORKS_STREAM"] = previous;
  }
});

test("operator control completes durably without forwarding executor events to the room", async () => {
  const base = candidate();
  let completed = false;
  const control: ExternalRoomExecutionCandidate = { ...base, async hydrate() {
    const loaded = await base.hydrate();
    return { ...loaded, context: { ...loaded.context, operatorControl: "operator_control_v1",
      async complete(result) { expect(result).toBe("private decision"); completed = true; } } };
  } };
  const run = externalRoomExecutor(control, async function* () {
    yield { type: "message.new", laneKey: "room:room", messageId: "1", role: "ai", content: "private decision" } as ServerEvent;
    await getCurrentExternalRoomExecution()!.complete("private decision");
  });
  const events: ServerEvent[] = [];
  for await (const event of run({}, "job", null, new AbortController().signal)) events.push(event);
  expect(events).toEqual([]);
  expect(completed).toBe(true);
});


test("operator receipt checkpoints never reuse the historical room conversation checkpoint", async () => {
  const roomInput = { roomId: "room", ownerId: "sponsor", agentId: "agent", threadId: "room:room:bot:agent",
    memoryAccessEnvelope: { ownerId: "sponsor", actorId: "human", agentId: "agent", roomId: "room",
      readableNamespaces: ["namespace"], mutableNamespaces: [], writableNamespaces: [], toolPolicy: {} } };
  const deps = { policy: async () => ({ roomId: "room", namespaceId: "namespace" }),
    assertTextMode: async () => {}, assertAccess: async () => {} };
  const threads: unknown[] = [];
  for (const receiptId of ["first", "second"]) {
    const base = candidate();
    const control = { ...base, async hydrate() {
      const loaded = await base.hydrate();
      return { ...loaded, context: { ...loaded.context, operatorControl: "operator_control_v1" as const,
        reference: { ...loaded.context.reference, receiptId } } };
    } };
    const run = externalRoomExecutor(control, async function* () {
      yield* [];
      threads.push((await externalRoomExecutionInput(roomInput, deps)).input["threadId"]);
    });
    for await (const _event of run({}, "job", null, new AbortController().signal)) { /* drain */ }
  }
  expect(threads).toEqual(["room:room:operator:first", "room:room:operator:second"]);
  expect((await externalRoomExecutionInput(roomInput, deps)).input["threadId"]).toBe("room:room:bot:agent");
});
