import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  assertAuthenticTaskRuntimeRunResultReadEvidenceV1,
  withTaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadEvidenceInputV1,
} from "../../src/background/task-runtime-run-result-read-evidence-v1.ts";

const NOW = 1_800_500_000_000;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000001";
const JOB = "30000000-0000-4000-8000-000000000001";
type Mutable<T> = T extends Uint8Array ? Uint8Array
  : T extends readonly (infer U)[] ? Mutable<U>[]
  : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Input = Mutable<TaskRuntimeRunResultReadEvidenceInputV1>;
const bytes = (n: number) => new Uint8Array(32).fill(n);
function objectId(revision: 1 | 2): string {
  return `task-run-result:v1:${bytesToHex(sha256(new TextEncoder().encode(
    `nautilo/task-run-result-crypto-object/v1\n${TASK}\n${RUN}\n${revision}`,
  )))}`;
}
function fresh(wake = false): Input {
  const bindingId = `task-run-output:${RUN}`;
  const resultObjectId = objectId(1);
  const operationId = `task-run-delivery-${wake ? "wake" : "message"}:${RUN}`;
  return {
    purpose: "task.runtime.run_result_read",
    workKind: wake ? "task.delivery_wake" : "task.deliver_result",
    requestId: wake ? `task-wake-authorization:${JOB}` : `task-run-delivery-result-authorization:${RUN}`,
    workId: wake ? JOB : RUN, claimId: "read-claim", recipientKeyId: "read-recipient",
    requesterHumanId: "requester-human", episodeId: "destination-session", sourceRoomId: "destination-room",
    claimExpiresAt: NOW + 30_000, recipientExpiresAt: NOW + 20_000,
    authorizationExpiresAt: NOW + 10_000, expiresAt: NOW + 10_000,
    recipientGeneration: 2, policyRevision: 7, hostAuthorizationRevision: 4,
    recipientAuthorizationRevision: 3, authorizationDigest: bytes(1), operations: ["decrypt"],
    result: { taskId: TASK, taskRunId: RUN, terminalStatus: "completed", contentRevision: 1,
      objectId: resultObjectId, cryptoAccessRevision: 0, genesisManifestHash: bytes(2), signerAgentId: "agent",
      namespace: { namespaceId: "private-namespace", domainId: "private-domain", operations: ["decrypt"],
        expectedAccessRevision: 2, expectedPolicyRevision: 7 } },
    invocation: wake ? { kind: "wake", bindingId, operationId, roomId: "destination-room", sessionId: "destination-session",
      jobId: JOB, reference: { kind: "protected_task_delivery_v1", taskId: TASK, taskRunId: RUN,
        bindingId, resultObjectId, wakeOperationId: operationId } }
      : { kind: "raw", bindingId, operationId, roomId: "destination-room", sessionId: "destination-session" },
    resultDomain: { domainId: "private-domain", sourceNamespaceId: "private-namespace", keyClass: "ai",
      participantDigest: bytes(3), participantCount: 1, domainKeyGeneration: 3,
      authorizationRevision: 5, headDigest: bytes(4), activeNamespaceBindingCount: 1,
      activeNamespaceBindingSetDigest: bytes(5) },
    messageWrite: wake ? null : { taskId: TASK, taskRunId: RUN, bindingId,
      messageOperationId: operationId, roomId: "destination-room", sessionId: "destination-session",
      signerAgentId: "agent", namespace: { namespaceId: "foreground-namespace", domainId: "foreground-domain",
        operations: ["encrypt"], expectedAccessRevision: 3, expectedPolicyRevision: 7 },
      domain: { domainId: "foreground-domain", sourceNamespaceId: "foreground-namespace", keyClass: "ai",
        participantDigest: bytes(6), participantCount: 2, domainKeyGeneration: 4, authorizationRevision: 6,
        headDigest: bytes(7), activeNamespaceBindingCount: 2, activeNamespaceBindingSetDigest: bytes(8) } },
  };
}
function run(value: Input, execute: (e: TaskRuntimeRunResultReadEvidenceV1) => unknown = () => undefined,
  now: () => number = () => NOW, signal = new AbortController().signal) {
  return withTaskRuntimeRunResultReadEvidenceV1({ evidence: value as unknown as TaskRuntimeRunResultReadEvidenceInputV1,
    now, signal, execute });
}
async function rejection(value: Promise<unknown>): Promise<unknown> {
  try { await value; } catch (error) { return error; }
  throw new Error("Invalid result-read evidence was accepted");
}
const invalid: Array<[string, (v: Input) => void]> = [
  ["purpose", v => { v.purpose = "other" as typeof v.purpose; }],
  ["Task UUID", v => { v.result.taskId = "bad"; }],
  ["Run UUID", v => { v.result.taskRunId = "bad"; }],
  ["Task UUID suffix", v => { v.result.taskId += "bad"; }],
  ["object", v => { v.result.objectId += "bad"; }],
  ["access revision", v => { v.result.cryptoAccessRevision = -1; }],
  ["terminal status", v => { v.result.terminalStatus = "running" as "completed"; }],
  ["cancelled rev1", v => { v.result.terminalStatus = "cancelled"; }],
  ["completed rev2", v => { v.result.contentRevision = 2; v.result.objectId = objectId(2); }],
  ["errored rev2", v => { v.result.terminalStatus = "errored"; v.result.contentRevision = 2; v.result.objectId = objectId(2); }],
  ["binding", v => { v.invocation.bindingId += "bad"; }],
  ["Room", v => { v.invocation.roomId += "bad"; }],
  ["Session", v => { v.invocation.sessionId += "bad"; }],
  ["deadline minimum", v => { v.expiresAt += 1; }],
  ["global operation", v => { v.operations = ["encrypt"] as unknown as ["decrypt"]; }],
  ["global extra operation", v => { v.operations.push("decrypt"); }],
  ["private operation", v => { v.result.namespace.operations = ["encrypt"] as unknown as ["decrypt"]; }],
  ["private extra operation", v => { v.result.namespace.operations.push("decrypt"); }],
  ["policy", v => { v.result.namespace.expectedPolicyRevision += 1; }],
  ["Domain", v => { v.resultDomain.domainId += "bad"; }],
  ["key class", v => { v.resultDomain.keyClass = "human" as "ai"; }],
  ["work kind", v => { v.workKind = "task.execute" as typeof v.workKind; }],
  ["work ID", v => { v.workId += "bad"; }],
  ["request ID", v => { v.requestId += "bad"; }],
  ["operation ID", v => { v.invocation.operationId += "bad"; }],
  ["invocation kind", v => { v.invocation.kind = "other" as "raw"; }],
];
for (const field of ["requestId", "workId", "claimId", "recipientKeyId", "requesterHumanId", "episodeId", "sourceRoomId"] as const) {
  invalid.push([`empty ${field}`, v => { v[field] = ""; }]);
}
for (const field of ["claimExpiresAt", "recipientExpiresAt", "authorizationExpiresAt", "expiresAt", "recipientGeneration",
  "policyRevision", "hostAuthorizationRevision", "recipientAuthorizationRevision"] as const) {
  for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    invalid.push([`${field}=${bad}`, v => { v[field] = bad; }]);
  }
}
for (const field of ["authorizationDigest"] as const) {
  invalid.push([`short ${field}`, v => { v[field] = new Uint8Array(31); }]);
}
invalid.push(["short genesis hash", v => { v.result.genesisManifestHash = new Uint8Array(31); }]);
for (const field of ["participantDigest", "headDigest", "activeNamespaceBindingSetDigest"] as const) {
  invalid.push([`short ${field}`, v => { v.resultDomain[field] = new Uint8Array(31); }]);
}
for (const field of ["participantCount", "domainKeyGeneration", "authorizationRevision", "activeNamespaceBindingCount"] as const) {
  invalid.push([`negative ${field}`, v => { v.resultDomain[field] = -1; }]);
}
for (const field of ["expectedAccessRevision", "expectedPolicyRevision"] as const) {
  invalid.push([`negative ${field}`, v => { v.result.namespace[field] = -1; }]);
}
invalid.push(["missing raw Message write proof", v => { v.messageWrite = null; }]);
for (const field of ["taskId", "taskRunId", "bindingId", "messageOperationId", "roomId", "sessionId", "signerAgentId"] as const) {
  invalid.push([`Message write ${field}`, v => { v.messageWrite![field] += "bad"; }]);
}
invalid.push(["Message write decrypt operation", v => {
  v.messageWrite!.namespace.operations = ["decrypt"] as unknown as ["encrypt"];
}]);
invalid.push(["Message write extra operation", v => { v.messageWrite!.namespace.operations.push("encrypt"); }]);
invalid.push(["Message write policy", v => { v.messageWrite!.namespace.expectedPolicyRevision += 1; }]);
invalid.push(["Message write Domain", v => { v.messageWrite!.domain.domainId += "bad"; }]);
invalid.push(["Message write Human key", v => { v.messageWrite!.domain.keyClass = "human" as "ai"; }]);
for (const field of ["participantDigest", "headDigest", "activeNamespaceBindingSetDigest"] as const) {
  invalid.push([`Message write short ${field}`, v => { v.messageWrite!.domain[field] = new Uint8Array(31); }]);
}
for (const field of ["expectedAccessRevision", "expectedPolicyRevision"] as const) {
  invalid.push([`Message write negative ${field}`, v => { v.messageWrite!.namespace[field] = -1; }]);
}

describe("closed result-read custody", () => {
  test("revokes Message write authority after its nested digest is changed", async () => {
    expect(await rejection(run(fresh(), evidence => {
      const original = evidence.messageWrite!.domain.headDigest.slice();
      evidence.messageWrite!.domain.headDigest.fill(0);
      expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence)).toThrow(TypeError);
      evidence.messageWrite!.domain.headDigest.set(original);
      expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence)).toThrow(TypeError);
    }))).toBeInstanceOf(TypeError);
  });
  test.each(invalid)("rejects %s before work", async (_name, mutate) => {
    const value = fresh(); mutate(value); let calls = 0;
    expect(await rejection(run(value, () => { calls += 1; }))).toBeInstanceOf(Error);
    expect(calls).toBe(0);
  });
  test.each(["completed", "errored", "cancelled"] as const)("accepts exact %s raw and wake proofs", async status => {
    for (const wake of [false, true]) {
      const value = fresh(wake); value.result.terminalStatus = status;
      value.result.contentRevision = status === "cancelled" ? 2 : 1;
      value.result.objectId = objectId(value.result.contentRevision);
      if (status === "cancelled") value.messageWrite = null;
      if (value.invocation.kind === "wake") value.invocation.reference.resultObjectId = value.result.objectId;
      let escaped: TaskRuntimeRunResultReadEvidenceV1 | undefined;
      expect(await run(value, evidence => {
        assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence); escaped = evidence; return 42;
      })).toBe(42);
      expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(escaped!)).toThrow(TypeError);
    }
  });
  test.each(["jobId", "kind", "taskId", "taskRunId", "bindingId", "resultObjectId", "wakeOperationId", "extra", "symbol"])("rejects wake %s substitution", async field => {
    const value = fresh(true); if (value.invocation.kind !== "wake") throw new Error("fixture");
    if (field === "jobId") value.invocation.jobId = "bad";
    else if (field === "extra") Object.assign(value.invocation.reference, { extra: true });
    else if (field === "symbol") Object.defineProperty(value.invocation.reference, Symbol("extra"), { value: true });
    else Object.assign(value.invocation.reference, { [field]: "bad" });
    expect(await rejection(run(value))).toBeInstanceOf(TypeError);
  });
  test.each(["claimExpiresAt", "recipientExpiresAt", "authorizationExpiresAt"] as const)("accepts each independent minimum %s", async field => {
    const value = fresh(); value[field] = NOW + 1; value.expiresAt = NOW + 1;
    expect(await run(value, () => true)).toBe(true);
  });
  test("copies caller arrays and revokes on callback failure", async () => {
    const value = fresh(); let escaped: TaskRuntimeRunResultReadEvidenceV1 | undefined;
    const failure = new Error("callback failed");
    expect(await rejection(run(value, evidence => {
      escaped = evidence; value.authorizationDigest.fill(0); value.result.genesisManifestHash.fill(0);
      value.resultDomain.participantDigest.fill(0); value.resultDomain.headDigest.fill(0);
      value.resultDomain.activeNamespaceBindingSetDigest.fill(0);
      assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence); throw failure;
    }))).toBe(failure);
    expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(escaped!)).toThrow(TypeError);
    expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(fresh() as unknown as TaskRuntimeRunResultReadEvidenceV1)).toThrow(TypeError);
  });
  test("owns Buffer-backed digest snapshots without aliasing caller storage", async () => {
    const value = fresh();
    value.authorizationDigest = Buffer.from(value.authorizationDigest);
    value.result.genesisManifestHash = Buffer.from(
      value.result.genesisManifestHash);
    for (const field of ["participantDigest", "headDigest",
      "activeNamespaceBindingSetDigest"] as const) {
      value.resultDomain[field] = Buffer.from(value.resultDomain[field]);
      value.messageWrite!.domain[field] = Buffer.from(
        value.messageWrite!.domain[field]);
    }
    const callerDigests = [value.authorizationDigest,
      value.result.genesisManifestHash, value.resultDomain.participantDigest,
      value.resultDomain.headDigest,
      value.resultDomain.activeNamespaceBindingSetDigest,
      value.messageWrite!.domain.participantDigest,
      value.messageWrite!.domain.headDigest,
      value.messageWrite!.domain.activeNamespaceBindingSetDigest];
    const expected = callerDigests.map(digest => Uint8Array.from(digest));
    await run(value, evidence => {
      const snapshots = [evidence.authorizationDigest,
        evidence.result.genesisManifestHash,
        evidence.resultDomain.participantDigest,
        evidence.resultDomain.headDigest,
        evidence.resultDomain.activeNamespaceBindingSetDigest,
        evidence.messageWrite!.domain.participantDigest,
        evidence.messageWrite!.domain.headDigest,
        evidence.messageWrite!.domain.activeNamespaceBindingSetDigest];
      expect(snapshots.every(snapshot => !Buffer.isBuffer(snapshot))).toBe(true);
      for (const digest of callerDigests) digest.fill(0);
      expect(snapshots).toEqual(expected);
      assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence);
    });
    expect(callerDigests.every(digest => digest.every(byte => byte === 0)))
      .toBe(true);
  });
  test.each(["digest", "genesis", "participant", "head", "bindings", "expiry", "abort", "invalid clock"])("revokes on %s during work", async kind => {
    const controller = new AbortController(); let clock = NOW; let escaped: TaskRuntimeRunResultReadEvidenceV1 | undefined;
    expect(await rejection(run(fresh(), evidence => {
      escaped = evidence;
      if (kind === "digest") evidence.authorizationDigest.fill(0);
      if (kind === "genesis") evidence.result.genesisManifestHash.fill(0);
      if (kind === "participant") evidence.resultDomain.participantDigest.fill(0);
      if (kind === "head") evidence.resultDomain.headDigest.fill(0);
      if (kind === "bindings") evidence.resultDomain.activeNamespaceBindingSetDigest.fill(0);
      if (kind === "expiry") clock = evidence.expiresAt;
      if (kind === "abort") controller.abort();
      if (kind === "invalid clock") clock = NaN;
      assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence);
    }, () => clock, controller.signal))).toBeInstanceOf(TypeError);
    expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(escaped!)).toThrow(TypeError);
  });
  test("pre-expired and pre-aborted claims do not enter work", async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    expect(await rejection(run(fresh(), () => { calls += 1; }, () => NOW, controller.signal))).toBeInstanceOf(TypeError);
    expect(await rejection(run(fresh(), () => { calls += 1; }, () => NOW + 10_000))).toBeInstanceOf(TypeError);
    expect(calls).toBe(0);
  });
});


test("rejected mutable evidence cannot regain authority when bytes are restored", async () => {
  expect(await rejection(run(fresh(), evidence => {
    const saved = evidence.authorizationDigest.slice();
    evidence.authorizationDigest.fill(0);
    expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence)).toThrow(TypeError);
    evidence.authorizationDigest.set(saved); saved.fill(0);
    expect(() => assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence)).toThrow(TypeError);
  }))).toBeInstanceOf(TypeError);
});
