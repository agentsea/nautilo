import { describe, expect, test } from "bun:test";
import type { ProtectedTaskRunningOccurrence, ProtectedTaskJobReferenceV1 } from "@nautilo/runtime";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { CodexExecutionAdmissionFactory } from "../../src/codex/admission-factory";
import { assertCodexExecutionAdmission } from "../../src/codex/execution-admission";
import { createProtectedTaskCodexProvider, type ProtectedTaskCodexProviderInput } from "../../src/routes/protected-task-codex-execution";
import { parseProtectedTaskCodexSelection } from "../../src/routes/protected-task-codex-selection";

const NOW = Date.parse("2026-07-27T10:00:00.000Z");
const TASK = "50000000-0000-4000-8000-000000000005";
const RUN = "60000000-0000-4000-8000-000000000006";
const JOB = "job";
const OWNER = "owner";
const ROOM = "room";
const AGENT = "agent";
const PROFILE = "profile";
const reference: ProtectedTaskJobReferenceV1 = { kind: "protected_task_run_v1", taskId: TASK, taskRunId: RUN,
  inputObjectId: `task-definition:v1:${"a".repeat(64)}`, resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
  authorizationRequestId: `task-run-authorization:${RUN}`, policyRevision: 7, executionSegment: 1 };
const occurrence: ProtectedTaskRunningOccurrence = {
  task: { id: TASK, ownerId: OWNER, requestorId: OWNER, agentId: AGENT, callingRoomId: ROOM,
    scheduleKind: "now", contentRepresentation: "protected", contentNamespaceId: "namespace",
    contentRevision: 1, cryptoObjectId: reference.inputObjectId, cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32) },
  run: { id: RUN, taskId: TASK, jobId: JOB, graphThreadId: "graph", status: "running", startedAt: new Date(NOW) },
};
const selection = parseProtectedTaskCodexSelection({ execution: { version: 1, harnessId: "codex", source: "genie",
  collaborationMode: "work", harnessModelId: "model", readiness: { relayId: "relay", pairingGenerationRef: "pairing", capabilityRevision: 4 } } })!;
function fixture() {
  const calls: string[] = [];
  const control = { current: true, now: NOW, enabled: true, failPreflight: false, live: true,
    model: "gpt-5", jobInput: { ...reference } as Readonly<Record<string, unknown>>, agentMember: true,
    protectedScope: null as Readonly<Record<string, unknown>> | null, protectedScopeClosed: false,
    afterFactory: () => {}, afterStart: () => {} };
  const profile = { id: PROFILE, userId: OWNER, relayId: "relay", profileHandle: PROFILE,
    profileGeneration: 2, accountGeneration: 3, authState: "signed_in", removalState: "active" };
  const session = { relayId: "relay", userId: OWNER, relaySessionId: "socket", pairingGenerationRef: "pairing",
    desktopSessionId: "desktop", selectedProtocolVersion: 8, capability: { version: 1, hostKind: "electron" },
    capabilityRevision: 4, currentCapabilityRevision: 4, currentRuntimeGeneration: 5,
    statusCorrelation: { relayId: "relay", relaySessionId: "socket", desktopSessionId: "desktop",
      pairingGenerationRef: "pairing", selectedProtocolVersion: 8, capabilityRevision: 4 },
    status: { state: "ready" as const, compatibility: "certified" as const,
      features: { stableConversation: true, explicitSteer: true, codexApprovals: true, requestUserInput: true, collaborationMode: true },
      runtimeGeneration: 5, profiles: [{ profileHandle: PROFILE, profileGeneration: 2, accountGeneration: 3,
        childGeneration: 6, state: "signed_in" as const }],
      workspace: { state: "bound" as const, receipt: { workspaceRef: "workspace", revision: 7, fingerprint: "fingerprint",
        issuedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString() } } } };
  const factory = new CodexExecutionAdmissionFactory({ bindings: { getActiveTaskBinding: async () => null }, mintId: () => "real-binding" });
  const input: ProtectedTaskCodexProviderInput = {
    now: () => control.now,
    preferences: { getOwnerPreference: async owner => { expect(owner).toBe(OWNER); return { enabled: control.enabled,
      accountProfileId: PROFILE, defaultPosture: "codex_default" }; }, getProfile: async () => profile },
    preflight: { prepare: async actual => { calls.push("preflight"); expect(actual.profileHandle).toBe(PROFILE);
      if (control.failPreflight) throw new Error("offline"); } },
    models: { list: async () => ({ models: [{ id: "model", model: control.model }] }) },
    limits: { resolve: async modelId => ({ modelId, catalogVersion: "signed-1", contextTokens: 100, maxOutputTokens: 50 }) },
    canonicalReader: {
      getTask: async () => ({ id: TASK, ownerId: OWNER, requestorId: OWNER, agentId: AGENT, parentTaskId: null, targetRoomId: ROOM }),
      getTaskRun: async () => ({ id: RUN, taskId: TASK, jobId: JOB, graphThreadId: "graph" }),
      getJob: async () => ({ id: JOB, ownerId: OWNER, requestorId: OWNER, roomId: ROOM, laneKey: `task:${TASK}`, input: control.jobInput }),
      roomExists: async () => true, isAgentMember: async () => control.agentMember, getAgentOwner: async () => OWNER,
      getProfile: async () => ({ ...profile, homeHandle: "private-profile-home" }),
    },
    sessions: { getCodexSession: () => session },
    mutations: { insert: async () => { throw new Error("Must not mutate bindings during authority proof"); },
      replace: async () => { throw new Error("unexpected replace"); }, update: async () => { throw new Error("unexpected update"); },
      archive: async () => { throw new Error("unexpected archive"); }, rebind: async () => { throw new Error("unexpected rebind"); } },
    admissionFactory: { create: async value => { calls.push("admission"); const result = await factory.create(value); control.afterFactory(); return result; } },
    execution: { async *start(admission) { assertCodexExecutionAdmission(admission); calls.push("provider");
      expect(control.protectedScope).toMatchObject({ relayId: "relay", bindingId: "real-binding",
        bindingGeneration: 0, taskId: TASK, jobId: JOB });
      expect(admission.prompt).toBe("private prompt"); expect(admission.codex.workingDirectory).toBe("/user/workspace");
      expect(admission.binding).toEqual({ id: "real-binding", generation: "0" });
      control.afterStart();
      yield { kind: "assistant_completed", text: "answer", attribution: { taskId: TASK, roomId: ROOM,
        bindingId: "real-binding", bindingGeneration: "0", vendorSessionId: "session", vendorTurnId: "turn", vendorItemId: "item" } };
    }, respond: async (_response, invocation) => { expect(invocation).toBeDefined(); calls.push("respond"); } },
    requestBroker: { hasLiveRequest: (id, owner) => control.live && id === "request" && owner === OWNER },
    requestPartition: { protect: identity => {
      expect(control.protectedScope).toBeNull();
      control.protectedScope = { ...identity };
      calls.push("protect");
      return { close() { control.protectedScopeClosed = true; calls.push("retire"); } };
    } },
  };
  const provider = createProtectedTaskCodexProvider(input);
  const abort = new AbortController();
  const context = { occurrence, reference, jobId: JOB, signal: abort.signal,
    assertCurrent: async () => { calls.push("current"); if (!control.current) throw new Error("grant expired"); },
    payload: { formatVersion: 1 as const, prompt: "private prompt", expectedOutput: null,
      protectedMetadata: { execution: { workingDirectory: "/user/workspace" } } } };
  const start = async () => {
    const admission = await provider.admit(OWNER, selection);
    if (!admission) throw new Error("test admission unavailable");
    return provider.start({ ...context, admission });
  };
  return { provider, context, start, input, control, session, profile, calls, abort };
}
async function rejects(operation: () => unknown, message?: string) {
  try { await operation(); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (message !== undefined) expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error("Expected protected Codex refusal");
}
async function drain(outputs: AsyncIterable<unknown>) { const result = []; for await (const output of outputs) result.push(output); return result; }

describe("protected Codex provider", () => {
  test("uses genuine canonical authority/admission and discloses only at stream consumption", async () => {
    const f = fixture(); const session = await f.start();
    expect(f.calls).not.toContain("provider");
    expect(session.attribution).toEqual({ taskId: TASK, roomId: ROOM, bindingId: "real-binding", bindingGeneration: "0" });
    expect(await drain(session.outputs)).toHaveLength(1);
    expect(f.control.protectedScopeClosed).toBeTrue();
    expect(f.calls.indexOf("protect")).toBeLessThan(f.calls.indexOf("provider"));
    expect(f.calls.indexOf("retire")).toBeGreaterThan(f.calls.indexOf("provider"));
    expect(f.calls.filter(x => x === "provider")).toHaveLength(1);
    expect(session.hasLiveRequest("request", OWNER)).toBe(true);
    expect(session.hasLiveRequest("request", "other")).toBe(false);
    await session.respond({ kind: "user_input_required", requestId: "request", ownerId: OWNER, answers: {} }, createAcceptedInvocationAuthority(OWNER));
    expect(f.calls).toContain("respond");
  });
  test("fresh compatible socket and capability revision can resume the same sealed pairing before effects", async () => {
    const f = fixture();
    f.session.relaySessionId = "reconnected"; f.session.desktopSessionId = "relaunched";
    f.session.capabilityRevision = 8; f.session.currentCapabilityRevision = 8;
    Object.assign(f.session.statusCorrelation, { relaySessionId: "reconnected", desktopSessionId: "relaunched", capabilityRevision: 8 });
    const admission = await f.provider.admit(OWNER, selection);
    expect(admission?.session).toMatchObject({ relaySessionId: "reconnected", desktopSessionId: "relaunched", capabilityRevision: 8 });
    const session = await f.start(); expect(await drain(session.outputs)).toHaveLength(1);
    expect(f.calls.filter(call => call === "provider")).toHaveLength(1);
  });
  test("a different machine or re-pairing cannot refresh the sealed provider intent", async () => {
    for (const change of [(f: ReturnType<typeof fixture>) => { f.profile.relayId = "other-machine"; },
      (f: ReturnType<typeof fixture>) => { f.session.pairingGenerationRef = "new-pairing"; f.session.statusCorrelation.pairingGenerationRef = "new-pairing"; }]) {
      const f = fixture(); change(f); expect(await f.provider.admit(OWNER, selection)).toBeNull();
      expect(f.calls).not.toContain("provider");
    }
  });
  test("preflight failure or disabled/foreign profile prevents admission", async () => {
    for (const change of [(f: ReturnType<typeof fixture>) => { f.control.enabled = false; },
      (f: ReturnType<typeof fixture>) => { f.control.failPreflight = true; },
      (f: ReturnType<typeof fixture>) => { f.profile.userId = "other"; },
      (f: ReturnType<typeof fixture>) => { f.profile.authState = "signed_out"; }]) {
      const f = fixture(); change(f); expect(await f.provider.admit(OWNER, selection)).toBeNull(); expect(f.calls).not.toContain("provider");
    }
  });
  test("rejects copied admission, reused admission, or private metadata substitution", async () => {
    const f = fixture(); const admission = (await f.provider.admit(OWNER, selection))!;
    await rejects(() => f.provider.start({ ...f.context, admission: structuredClone(admission) }), "admission changed");
    await f.provider.start({ ...f.context, admission });
    await rejects(() => f.provider.start({ ...f.context, admission }), "admission changed");
    const second = (await f.provider.admit(OWNER, selection))!;
    await rejects(() => f.provider.start({ ...f.context, admission: second, payload: { ...f.context.payload,
      protectedMetadata: { execution: { prompt: "substitute" } } } }), "content is unsupported");
    expect(f.calls).not.toContain("provider");
  });
  test("detects mutation of the captured public provider snapshot", async () => {
    const f = fixture(); const admission = (await f.provider.admit(OWNER, selection))!;
    Reflect.set(admission.session, "relaySessionId", "substituted");
    await rejects(() => f.provider.start({ ...f.context, admission }), "admission changed");
    expect(f.calls).not.toContain("provider");
  });

  test("exact accepted reference and canonical membership cannot be replaced by valid-looking input", async () => {
    for (const change of [(f: ReturnType<typeof fixture>) => { f.control.jobInput = { ...reference, policyRevision: 8 }; },
      (f: ReturnType<typeof fixture>) => { f.control.jobInput = { ...reference, authorizationRequestId: "other" }; },
      (f: ReturnType<typeof fixture>) => { f.control.agentMember = false; },
      (f: ReturnType<typeof fixture>) => { f.control.jobInput = { taskId: TASK, taskRunId: RUN,
        agentId: AGENT, roomId: ROOM, graphThreadId: "graph" }; }]) {
      const f = fixture(); change(f); await rejects(() => f.start()); expect(f.calls).not.toContain("provider");
    }
  });
  test("changed model, profile or relay socket between preflight and start denies disclosure", async () => {
    for (const change of [(f: ReturnType<typeof fixture>) => { f.control.model = "gpt-6"; },
      (f: ReturnType<typeof fixture>) => { f.profile.accountGeneration++; },
      (f: ReturnType<typeof fixture>) => { f.session.relaySessionId = "new-socket"; f.session.statusCorrelation.relaySessionId = "new-socket"; }]) {
      const f = fixture(); const admission = (await f.provider.admit(OWNER, selection))!; change(f);
      await rejects(() => f.provider.start({ ...f.context, admission })); expect(f.calls).not.toContain("provider");
    }
  });
  test("rechecks authority at first disclosure and after provider events", async () => {
    for (const when of ["before", "after"] as const) {
      const f = fixture(); const session = await f.start();
      if (when === "before") f.control.current = false;
      else f.control.afterStart = () => { f.control.current = false; };
      await rejects(() => drain(session.outputs), "grant expired");
      expect(f.calls.filter(x => x === "provider")).toHaveLength(when === "before" ? 0 : 1);
      expect(f.control.protectedScopeClosed).toBeTrue();
    }
  });
  test("rejects host drift during admission factory and rejects expired or aborted custody", async () => {
    const f = fixture(); f.control.afterFactory = () => { f.session.currentRuntimeGeneration++; };
    const session = await f.start(); await rejects(() => drain(session.outputs)); expect(f.calls).not.toContain("provider");
    const expired = fixture(); const ready = await expired.start(); expired.control.now += 60_000;
    await rejects(() => drain(ready.outputs)); expect(expired.calls).not.toContain("provider");
    const aborted = fixture(); const pending = await aborted.start(); aborted.abort.abort();
    await rejects(() => drain(pending.outputs)); expect(aborted.calls).not.toContain("provider");
  });
  test("response revalidation refuses revoked custody before forwarding", async () => {
    const f = fixture(); const session = await f.start(); f.control.current = false;
    await rejects(() => session.respond({ kind: "user_input_required", requestId: "request", ownerId: OWNER, answers: {} },
      createAcceptedInvocationAuthority(OWNER)), "grant expired");
    expect(f.calls).not.toContain("respond");
  });
  test("response cancellation during awaited provider revalidation prevents forwarding", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const original = f.context.assertCurrent;
    let hold = false;
    f.context.assertCurrent = async () => {
      await original();
      if (hold) {
        hold = false;
        entered!();
        await new Promise<void>(resolve => { release = resolve; });
      }
    };
    const session = await f.start();
    hold = true;
    const response = new AbortController();
    const pending = session.respond({ kind: "user_input_required", requestId: "request", ownerId: OWNER, answers: {} },
      createAcceptedInvocationAuthority(OWNER), { signal: response.signal });
    const refusal = rejects(() => pending);
    await waiting;
    response.abort();
    release!();
    await refusal;
    expect(f.calls).not.toContain("respond");
    expect(f.abort.signal.aborted).toBe(false);
  });
});
