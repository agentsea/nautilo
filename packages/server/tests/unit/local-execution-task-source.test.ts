import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { LatticeCrypto, authorizationRevision } from "@nautilo/lattice-crypto";
import type { InitialTaskRuntimeRecipientAuthority } from "@nautilo/lattice-bridge/server";
import type { LocalExecutionDelegation } from "@nautilo/types";
import { createTaskLocalExecutionSourceAssertion, type ProtectedTaskLocalExecutionSourceProof,
  type TaskLocalExecutionSourceAssertionDeps, type TaskLocalExecutionSourcePolicy, type TaskLocalExecutionSourceRecord } from "../../src/local-execution-task-source";
const roomId = "10000000-0000-4000-8000-000000000001";
const callingId = "10000000-0000-4000-8000-000000000002";
const thread = `room:${roomId}`;
const delegation: LocalExecutionDelegation = { version: 1, humanUserId: "human", agentId: "agent", sourceRoomId: roomId,
  sourceConversationId: `${thread}:bot:agent`, rootTaskId: "root", projectGrantId: "grant", ceiling: "basic", profile: null,
  target: { instanceId: "", relayId: "relay", pairingGeneration: "raw-pairing", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" } };
const row: TaskLocalExecutionSourceRecord = { id: "root", ownerId: "agent-owner", requestorId: "human", agentId: "agent", callingRoomId: roomId,
  parentTaskId: null, targetRoomId: null, scheduleKind: "now", status: "running", contentRepresentation: "ordinary", contentRevision: 0,
  localExecutionDelegation: delegation, contentNamespaceId: null, cryptoObjectId: null, cryptoAccessRevision: 0,
  cryptoRequiredNamespaceFingerprint: null, cryptoMappingState: "unmapped" };
const plain: TaskLocalExecutionSourcePolicy = { mode: "plaintext_only", shadowBehavior: "fallback", revision: 1 };
function fixture(overrides: Partial<TaskLocalExecutionSourceAssertionDeps> = {}) {
  let current = structuredClone(row); let policy = structuredClone(plain); let capabilities = ["use_workstation"];
  let sourceVisible = true; let callingHasAgent = true;
  const invocation: Parameters<NonNullable<TaskLocalExecutionSourceAssertionDeps["assertInvocation"]>>[0][] = [];
  const deps: TaskLocalExecutionSourceAssertionDeps = {
    readTask: async () => structuredClone(current), readPolicy: async () => ({ ...policy }),
    assertInvocation: async input => { invocation.push(input); }, getCapabilities: async () => capabilities,
    findHuman: async id => id === "human" ? { id: "human-actor" } : null,
    findRoomByThread: async (_human, id) => id === thread && sourceVisible ? roomId : null,
    findRoom: async id => id === roomId ? sourceVisible ? { id, graphThreadId: thread,
      members: current.callingRoomId === roomId && callingHasAgent ? [{ kind: "agent", agentId: "agent", actorId: "agent-actor" }] : [] } : null
      : id === callingId ? { id, graphThreadId: "task-room-thread", members: callingHasAgent ? [{ kind: "agent", agentId: "agent", actorId: "agent-actor" }] : [] } : null,
    ...overrides,
  };
  return { assert: createTaskLocalExecutionSourceAssertion(deps), deps, invocation,
    get current() { return current; }, set current(value) { current = value; },
    set policy(value: TaskLocalExecutionSourcePolicy) { policy = value; },
    revokeCapability() { capabilities = []; }, revokeSource() { sourceVisible = false; }, removeCallingAgent() { callingHasAgent = false; } };
}
function protectedProof(current: TaskLocalExecutionSourceRecord): ProtectedTaskLocalExecutionSourceProof {
  const device: InitialTaskRuntimeRecipientAuthority["device"] = { userId: "human", humanActorId: "human-actor", deviceId: "device",
    deviceGeneration: 3, signingPublicKey: new Uint8Array(32).fill(1), serverInstanceId: "server", lineageGeneration: 2,
    epoch: 4, securityRevision: 5, headDigest: new Uint8Array(32).fill(2) };
  return { task: structuredClone(current), delegation: structuredClone(delegation), policy: { mode: "encrypted_only", shadowBehavior: "strict", revision: 7 }, device,
    authority: { runner: {} as ProtectedTaskLocalExecutionSourceProof["authority"]["runner"],
      restricted: {} as ProtectedTaskLocalExecutionSourceProof["authority"]["restricted"], crypto: new LatticeCrypto(), serverScope: "https://server.example",
      taskId: current.id, requesterUserId: "human", requesterHumanId: "human-actor", agentId: "agent", contentNamespaceId: "content",
      sourceRoomId: "private-definition-room", targetRoomId: roomId, namespaceIds: ["content"], expectedPolicyRevision: 7, deviceId: "device",
      namespaceRequirements: [{ ordinal: 0, namespaceId: "content", domainId: "domain", operations: ["decrypt", "encrypt"], expectedAccessRevision: 2, expectedPolicyRevision: 7 }],
      domainRequirements: [{ ordinal: 0, domainId: "domain", expectedEpoch: 6, expectedAuthorizationRevision: 8 }], validateCurrentTaskRun: async () => true } };
}
function held(proof: ProtectedTaskLocalExecutionSourceProof): InitialTaskRuntimeRecipientAuthority {
  return { device: structuredClone(proof.device), policyRevision: proof.policy.revision,
    sourceRoomId: proof.authority.sourceRoomId, sourceNamespaceId: proof.authority.contentNamespaceId,
    namespaceRequirements: structuredClone(proof.authority.namespaceRequirements),
    domains: [{ domainId: "domain", sourceNamespaceId: "content", keyClass: "ai", domainKeyGeneration: 6, authorizationRevision: authorizationRevision(8),
      participantDigest: new Uint8Array(32), participantCount: 1, headDigest: new Uint8Array(32),
      activeNamespaceBindingSetDigest: new Uint8Array(32), activeNamespaceBindingCount: 1 }] };
}
function protectedFixture(run?: (proof: ProtectedTaskLocalExecutionSourceProof, input: Parameters<NonNullable<TaskLocalExecutionSourceAssertionDeps["withProtectedAuthority"]>>[0]) => Promise<void>) {
  let calls = 0;
  const f = fixture({ readProtectedSource: async () => proof,
    withProtectedAuthority: async input => { calls++; await run?.(proof, input); return input.use(held(proof), input.restricted); } });
  f.current = { ...f.current, contentRepresentation: "protected", contentRevision: 1, contentNamespaceId: "content", cryptoObjectId: "definition-object",
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(3), cryptoMappingState: "verified" };
  const proof = protectedProof(f.current); f.policy = proof.policy;
  return { assert: f.assert, original: f, proof, get calls() { return calls; } };
}
test("ordinary source uses causal Human rather than Genie owner", async () => {
  const f = fixture(); await f.assert(f.current);
  expect(f.invocation).toEqual([{ humanUserId: "human", agentId: "agent", roomId, origin: "task_dispatch", taskId: "root" },
    { humanUserId: "human", agentId: "agent", roomId, origin: "task_dispatch", taskId: "root" }]);
});
test("nested Agent belongs to calling Room while original Human source remains required", async () => {
  const f = fixture(); f.current = { ...f.current, id: "child", parentTaskId: "root", callingRoomId: callingId };
  await f.assert(f.current); expect(f.invocation[0]?.roomId).toBe(callingId);
  f.revokeSource(); await rejects(f.assert(f.current), /SOURCE_UNAVAILABLE/);
});
test("missing capability, Agent, Human, thread or current definition deny", async () => {
  for (const change of ["capability", "member", "human", "thread", "definition"] as const) {
    const f = fixture(change === "human" ? { findHuman: async () => null } : change === "thread" ? { findRoomByThread: async () => "other-room" } : {});
    const observed = structuredClone(f.current);
    if (change === "capability") f.revokeCapability(); if (change === "member") f.removeCallingAgent();
    if (change === "definition") f.current = { ...f.current, localExecutionDelegation: null };
    await rejects(f.assert(observed), /SOURCE_UNAVAILABLE/);
  }
});
test("ordinary row allows shadow fallback but never encrypted-only or shadow deny", async () => {
  const f = fixture(); f.policy = { mode: "shadow_encryption", shadowBehavior: "fallback", revision: 2 }; await f.assert(f.current);
  for (const mode of ["shadow_encryption", "encrypted_only"] as const) {
    f.policy = { mode, shadowBehavior: "strict", revision: 3 }; await rejects(f.assert(f.current), /SOURCE_UNAVAILABLE/);
  }
});
test("protected row refuses absent metadata proof", async () => {
  const f = fixture(); f.current = { ...f.current, contentRepresentation: "protected", contentRevision: 1 };
  f.policy = { mode: "encrypted_only", shadowBehavior: "strict", revision: 7 }; await rejects(f.assert(f.current), /SOURCE_UNAVAILABLE/);
});
test("retained source reuses original public authority without plaintext recipient", async () => {
  const f = protectedFixture(async (_proof, input) => { expect(input.deviceId).toBe("device");
    expect(input.namespaceRequirements[0]?.expectedAccessRevision).toBe(2); });
  await f.assert(f.original.current); expect(f.calls).toBe(1);
});
test("device, namespace, domain or policy drift refuses original proof", async () => {
  for (const drift of ["device", "namespace", "domain", "policy"] as const) {
    const f = protectedFixture();
    const withProtectedAuthority: NonNullable<TaskLocalExecutionSourceAssertionDeps["withProtectedAuthority"]> = async input => {
      const current = held(f.proof);
      const changed = drift === "device" ? { ...current, device: { ...current.device, securityRevision: 6 } }
        : drift === "namespace" ? { ...current, namespaceRequirements: current.namespaceRequirements.map(item => ({ ...item, expectedAccessRevision: 9 })) }
          : drift === "domain" ? { ...current, domains: current.domains.map(item => ({ ...item, authorizationRevision: authorizationRevision(9) })) }
            : { ...current, policyRevision: 8 };
      return input.use(changed, input.restricted);
    };
    await rejects(createTaskLocalExecutionSourceAssertion({ ...f.original.deps, withProtectedAuthority })(f.original.current), /SOURCE_UNAVAILABLE/);
  }
});
test("source, capability, definition and policy lost during crypto checks suppress admission", async () => {
  for (const revoke of ["source", "capability", "definition", "policy"] as const) {
    const f = protectedFixture(async () => {
      if (revoke === "source") f.original.revokeSource(); if (revoke === "capability") f.original.revokeCapability();
      if (revoke === "definition") f.original.current = { ...f.original.current, contentRevision: 2 };
      if (revoke === "policy") f.original.policy = { ...f.proof.policy, revision: 8 };
    });
    await rejects(f.assert(f.original.current), /SOURCE_UNAVAILABLE/);
  }
});
test("public expectations cannot mutate during awaited checks", async () => {
  const f = protectedFixture(async proof => { Object.assign(proof.device, { securityRevision: 6 }); });
  await rejects(f.assert(f.original.current), /SOURCE_UNAVAILABLE/);
});
test("aborted source refuses before canonical reads", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const f = fixture({ signal: controller.signal, readTask: async () => { calls++; return row; } });
  await rejects(f.assert(f.current)); expect(calls).toBe(0);
});
test("foreign original proof or unavailable protected owner never admits", async () => {
  for (const change of ["human", "task", "delegation", "policy", "owner"] as const) {
    const f = protectedFixture();
    if (change === "human") Object.assign(f.proof.device, { userId: "other-human" });
    if (change === "task") Object.assign(f.proof.task, { contentRevision: 8 });
    if (change === "delegation") Object.assign(f.proof.delegation, { projectGrantId: "other-grant" });
    if (change === "policy") Object.assign(f.proof.policy, { revision: 8 });
    const assert = change === "owner" ? createTaskLocalExecutionSourceAssertion({ ...f.original.deps,
      withProtectedAuthority: async () => null }) : f.assert;
    await rejects(assert(f.original.current), /SOURCE_UNAVAILABLE/);
  }
});
test("normal completion changes bookkeeping without revoking source", async () => {
  const f: ReturnType<typeof fixture> = fixture({ assertInvocation: async () => { f.current = { ...f.current, status: "completed", targetRoomId: "result-room" }; } });
  await f.assert(f.current);
  expect(f.current.status).toBe("completed");
});
test("unrelated Room presentation changes do not invalidate exact source identity", async () => {
  let read = 0;
  const f = fixture({ findRoom: async id => ({ id, graphThreadId: thread,
    members: [{ kind: "agent", agentId: "agent", actorId: "agent-actor" }], label: `Label ${read++}` }) });
  await f.assert(f.current);
  expect(read).toBe(2);
});
