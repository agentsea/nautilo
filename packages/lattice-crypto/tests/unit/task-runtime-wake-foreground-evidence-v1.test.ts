import { expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  withTaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadEvidenceInputV1,
} from "../../src/background/task-runtime-run-result-read-evidence-v1.ts";
import {
  assertAuthenticTaskRuntimeWakeForegroundEvidenceV1,
  withTaskRuntimeWakeForegroundEvidenceV1,
  type TaskRuntimeWakeForegroundEvidenceV1,
} from "../../src/background/task-runtime-wake-foreground-evidence-v1.ts";

const NOW = 1_800_500_000_000;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000001";
const JOB = "b863875e-d415-573f-8fb6-7b2f08303f3f";
const bytes = (value: number) => new Uint8Array(32).fill(value);
function readInput(): TaskRuntimeRunResultReadEvidenceInputV1 {
  const objectId = `task-run-result:v1:${bytesToHex(sha256(new TextEncoder().encode(
    `nautilo/task-run-result-crypto-object/v1\n${TASK}\n${RUN}\n1`,
  )))}`;
  const bindingId = `task-run-output:${RUN}`;
  const operationId = `task-run-delivery-wake:${RUN}`;
  return {
    purpose: "task.runtime.run_result_read", workKind: "task.delivery_wake",
    requestId: `task-wake-authorization:${JOB}`, workId: JOB,
    claimId: "claim", claimExpiresAt: NOW + 30, recipientExpiresAt: NOW + 20,
    authorizationExpiresAt: NOW + 10, expiresAt: NOW + 10,
    recipientGeneration: 1, recipientKeyId: "recipient", authorizationDigest: bytes(1),
    requesterHumanId: "human", policyRevision: 7, episodeId: "session", sourceRoomId: "room",
    hostAuthorizationRevision: 2, recipientAuthorizationRevision: 3, operations: ["decrypt"],
    result: { taskId: TASK, taskRunId: RUN, terminalStatus: "completed", contentRevision: 1,
      objectId, cryptoAccessRevision: 0, genesisManifestHash: bytes(2), signerAgentId: "agent",
      namespace: { namespaceId: "private", domainId: "private-domain", operations: ["decrypt"],
        expectedAccessRevision: 4, expectedPolicyRevision: 7 } },
    invocation: { kind: "wake", bindingId, operationId, roomId: "room", sessionId: "session", jobId: JOB,
      reference: { kind: "protected_task_delivery_v1", taskId: TASK, taskRunId: RUN,
        bindingId, resultObjectId: objectId, wakeOperationId: operationId } },
    resultDomain: domain("private-domain", "private"), messageWrite: null,
  };
}
function domain(domainId = "foreground-domain", sourceNamespaceId = "foreground") {
  return { domainId, sourceNamespaceId, keyClass: "ai" as const, participantCount: 2,
    participantDigest: bytes(3), domainKeyGeneration: 4, authorizationRevision: 5,
    headDigest: bytes(6), activeNamespaceBindingCount: 1, activeNamespaceBindingSetDigest: bytes(7) };
}
function foreground() {
  return { committerDeviceId: "device", committerDeviceSigningGeneration: 2,
    committerDeviceSigningPublicKeyHash: bytes(8),
    namespaceRequirements: [{ ordinal: 1, namespaceId: "foreground", domainId: "foreground-domain",
      operations: ["decrypt", "encrypt"] as readonly ("decrypt" | "encrypt")[],
      expectedAccessRevision: 4, expectedPolicyRevision: 7 }],
    domainRequirements: [domain()],
  };
}
async function rejected(work: Promise<unknown>) {
  try { await work; } catch (error) { return error; }
  throw new Error("Invalid wake authority was accepted");
}
function run(execute: (e: TaskRuntimeWakeForegroundEvidenceV1) => unknown,
  value = foreground(), read = readInput(), now: () => number = () => NOW,
  signal = new AbortController().signal) {
  return withTaskRuntimeRunResultReadEvidenceV1({ evidence: read, now, signal,
    execute: readEvidence => withTaskRuntimeWakeForegroundEvidenceV1({ ...value, readEvidence, execute }),
  });
}

test("wake evidence owns snapshots, carries only the foreground partition and expires with its parent", async () => {
  const value = foreground();
  let retained: TaskRuntimeWakeForegroundEvidenceV1 | undefined;
  expect(await run(evidence => {
    retained = evidence;
    value.domainRequirements[0]!.headDigest.fill(0);
    value.committerDeviceSigningPublicKeyHash.fill(0);
    assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(evidence);
    expect(evidence.workId).toBe(JOB);
    expect(evidence.sourceContentRevision).toBe(1);
    expect(evidence.namespaceRequirements.map(n => n.namespaceId)).toEqual(["foreground"]);
    expect(evidence.domainRequirements[0]!.headDigest).toEqual(bytes(6));
    expect(evidence.committerDeviceSigningPublicKeyHash).toEqual(bytes(8));
    expect(evidence.expiresAt).toBe(NOW + 10);
    expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1({ ...evidence })).toThrow();
    expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(structuredClone(evidence))).toThrow();
    return 42;
  }, value)).toBe(42);
  expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(retained!)).toThrow();
});

test.each(["expiry", "abort", "failure", "mutation"])("revokes wake authority on %s", async reason => {
  const controller = new AbortController(); let now = NOW;
  let retained: TaskRuntimeWakeForegroundEvidenceV1 | undefined;
  expect(await rejected(run(evidence => {
    retained = evidence;
    if (reason === "failure") throw new Error("callback failed");
    if (reason === "expiry") now = NOW + 10;
    if (reason === "abort") controller.abort();
    if (reason === "mutation") {
      const mutable = evidence as { sourceContentRevision: number };
      mutable.sourceContentRevision = 2;
      expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(evidence)).toThrow();
      mutable.sourceContentRevision = 1;
    }
    expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(evidence)).toThrow();
  }, foreground(), readInput(), () => now, controller.signal))).toBeInstanceOf(Error);
  expect(() => assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(retained!)).toThrow();
});

test("requires genuine live read evidence and the canonical stable wake Job", async () => {
  let calls = 0;
  expect(await rejected(withTaskRuntimeWakeForegroundEvidenceV1({ ...foreground(),
    readEvidence: readInput() as never, execute: () => { calls++; },
  }))).toBeInstanceOf(TypeError);
  const read = readInput();
  if (read.invocation.kind !== "wake") throw new Error("fixture");
  const other = "30000000-0000-4000-8000-000000000003";
  expect(await rejected(run(() => { calls++; }, foreground(), { ...read,
    workId: other, requestId: `task-wake-authorization:${other}`,
    invocation: { ...read.invocation, jobId: other },
  }))).toBeInstanceOf(TypeError);
  expect(calls).toBe(0);
});

test.each(["empty namespaces", "empty Domains", "duplicate Domain", "extra Domain", "policy", "missing Domain",
  "unsupported operation", "decrypt only", "extra operation", "duplicate Namespace", "bad counter", "bad digest", "Device"])(
  "rejects %s before lending foreground authority", async changed => {
    const value = foreground(); const namespace = value.namespaceRequirements[0]!;
    if (changed === "empty namespaces") value.namespaceRequirements = [];
    if (changed === "empty Domains") value.domainRequirements = [];
    if (changed === "duplicate Domain") value.domainRequirements.push(domain());
    if (changed === "extra Domain") value.domainRequirements.push(domain("other", "other"));
    if (changed === "policy") namespace.expectedPolicyRevision++;
    if (changed === "missing Domain") namespace.domainId = "other";
    if (changed === "unsupported operation") namespace.operations = ["sign"] as never;
    if (changed === "decrypt only") namespace.operations = ["decrypt"];
    if (changed === "extra operation") namespace.operations = ["decrypt", "encrypt", "encrypt"];
    if (changed === "duplicate Namespace") value.namespaceRequirements.push({ ...namespace, ordinal: 2 });
    if (changed === "bad counter") namespace.expectedAccessRevision = -1;
    if (changed === "bad digest") value.domainRequirements[0]!.headDigest = new Uint8Array(31);
    if (changed === "Device") value.committerDeviceId = "";
    let calls = 0;
    expect(await rejected(run(() => { calls++; }, value))).toBeInstanceOf(Error);
    expect(calls).toBe(0);
  });

test("authentic raw read evidence cannot mint foreground execution", async () => {
  const read = readInput();
  const invocation = { kind: "raw" as const, bindingId: read.invocation.bindingId,
    operationId: `task-run-delivery-message:${RUN}`, roomId: "room", sessionId: "session" };
  const raw: TaskRuntimeRunResultReadEvidenceInputV1 = { ...read, workKind: "task.deliver_result",
    workId: RUN, requestId: `task-run-delivery-result-authorization:${RUN}`, invocation,
    messageWrite: { taskId: TASK, taskRunId: RUN, bindingId: invocation.bindingId,
      messageOperationId: invocation.operationId, roomId: "room", sessionId: "session", signerAgentId: "agent",
      namespace: { namespaceId: "foreground", domainId: "foreground-domain", operations: ["encrypt"],
        expectedAccessRevision: 4, expectedPolicyRevision: 7 }, domain: domain() },
  };
  let calls = 0;
  expect(await rejected(run(() => { calls++; }, foreground(), raw))).toBeInstanceOf(TypeError);
  expect(calls).toBe(0);
});
