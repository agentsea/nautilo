import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { LatticeCrypto, authorizationRevision, createDomainForegroundAuthorizationPlan,
  cryptoDeviceId, humanId } from "@nautilo/lattice-crypto";
import { createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1 } from "@nautilo/lattice-crypto/background";
import { attachBackgroundAuthorizationRecipient, claimBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest, createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationGrantReady, markBackgroundAuthorizationRunning, parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3 } from "@nautilo/runtime";
import { candidate, ids } from "../fixtures/protected-task-pending-attention";
import { resolveProtectedTaskCheckpointAadBinding } from "../../src/routes/protected-task-checkpoint-aad-binding";

const binding = Object.freeze({ version: 1 as const, namespaceId: ids.namespace,
  domainId: "checkpoint-domain", namespaceAccessRevision: 2, policyRevision: 3 });
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function legacy() {
  const c = candidate();
  const requestId = `task-run-authorization:${ids.run}`;
  const expected = { ...c, priorJob: { ...c.priorJob, generation: 0,
    reference: { ...c.priorJob.reference, authorizationRequestId: requestId } } };
  const now = c.priorJob.parkedAt.getTime() - 10;
  const crypto = new LatticeCrypto();
  const keys = await crypto.generateEncryptionKeyPair();
  try {
    const publicKey = Buffer.from(keys.publicKey).toString("base64url");
    const plan = createDomainForegroundAuthorizationPlan(crypto, {
      authorizationId: requestId, policyRevision: 3, sessionId: "checkpoint-episode",
      roomId: ids.room, subjectHumanId: humanId(ids.actor), committerDeviceId: cryptoDeviceId("checkpoint-device"),
      committerDeviceSigningGeneration: 1, hostAuthorizationRevision: authorizationRevision(1),
      recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
      recipientAuthorizationRevision: authorizationRevision(0), recipientRuntimeGeneration: 0,
      recipientKeyId: "checkpoint-recipient", operations: ["decrypt", "encrypt"], issuedAt: now,
      deadlineAt: now + 60_000, maximumSecretBytes: 4096,
      domains: [{ domainId: binding.domainId, sourceNamespaceId: ids.namespace,
        participantDigest: new Uint8Array(32).fill(1), participantCount: 1, keyClass: "ai",
        domainKeyGeneration: 1, authorizationRevision: authorizationRevision(1), headDigest: new Uint8Array(32).fill(2),
        activeNamespaceBindingSetDigest: new Uint8Array(32).fill(3), activeNamespaceBindingCount: 1 }],
    });
    const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(createTaskRuntimeBackgroundAuthorizationRequestV1({
      requestId, workId: ids.run, workKind: "task.execute", workPurpose: "task.execute",
      recipientGeneration: 0, episodeId: plan.sessionId, sourceRoomId: ids.room,
      recipientKeyId: plan.recipientKeyId, recipientPublicKey: keys.publicKey,
      authorizationPlan: plan, issuedAt: now, deadlineAt: now + 60_000,
    }));
    const responseBytes = new Uint8Array([1, 2, 3]);
    const initial = createBackgroundAuthorizationTaskRuntimeRequestV3({ requestId, workId: ids.run,
      namespaceId: ids.namespace, now });
    const awaiting = attachBackgroundAuthorizationRecipient(initial, { recipientGeneration: 0,
      recipientKeyId: plan.recipientKeyId, recipientPublicKey: publicKey, descriptorDigest: digest(descriptorBytes),
      expiresAt: now + 60_000, now: now + 1 });
    const ready = markBackgroundAuthorizationGrantReady(awaiting, { kind: "runtime", requestId,
      descriptorDigest: digest(descriptorBytes), recipientKeyId: plan.recipientKeyId, recipientPublicKey: publicKey,
      expiresAt: now + 60_000, responseDigest: digest(responseBytes), credentialDigest: "ab".repeat(32),
      issuingHumanId: ids.actor, issuingDeviceId: "checkpoint-device", recipientGeneration: 0, now: now + 2 });
    const running = markBackgroundAuthorizationRunning(claimBackgroundAuthorizationRequest(ready,
      "checkpoint-claim", now + 3, now + 30_000), now + 4);
    const snapshot = completeBackgroundAuthorizationRequest(running, c.priorJob.parkedAt.getTime());
    if (snapshot.formatVersion !== 3 || snapshot.credentialSubject.kind !== "runtime") throw new Error("runtime snapshot changed family");
    const record: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      snapshot: { ...snapshot, credentialSubject: snapshot.credentialSubject }, workIdentityHash: new Uint8Array(32).fill(5),
      idempotencyKey: `task-runtime-stable-v1:${ids.run}:${"a".repeat(43)}`,
      workKind: "task.execute", purpose: "task.execute", domainId: binding.domainId,
      processorAuthorizationRevision: null, expectedDomainEpoch: 1, expectedNamespaceAccessRevision: 2,
      expectedPolicyRevision: 3, descriptorBytes,
      acceptedMaterial: { responseBytes, credentialId: "checkpoint-credential", issuingDeviceAuthorizationRevision: 1,
        issuerSigningPublicKeyHash: new Uint8Array(32).fill(4), authorizationExpiresAt: now + 60_000 },
      finishedAt: c.priorJob.parkedAt.getTime(), authoritySet: {
        namespaceRequirements: [{ ordinal: 0, namespaceId: ids.namespace, domainId: binding.domainId,
          operations: ["decrypt", "encrypt"], expectedAccessRevision: 2, expectedPolicyRevision: 3 }],
        domainRequirements: [{ ordinal: 0, domainId: binding.domainId, expectedEpoch: 1, expectedAuthorizationRevision: 1 }],
      },
    };
    parseBackgroundAuthorizationRecord(record);
    return { expected, record };
  } finally { keys.privateKey.fill(0); }
}

test("sealed metadata is copied without reopening an expired grant", async () => {
  const c = candidate();
  const expected = { ...c, priorJob: { ...c.priorJob, checkpointAadBinding: binding } };
  const result = await resolveProtectedTaskCheckpointAadBinding(expected, { get: () => { throw new Error("no old grant needed"); } });
  expect(result).toEqual(binding);
  expect(result).not.toBe(binding);
  expect(Object.isFrozen(result)).toBe(true);
  for (const changed of [{ ...binding, namespaceId: ids.room }, { ...binding, policyRevision: 4 },
    { ...binding, namespaceAccessRevision: -1 }]) {
    expect(await resolveProtectedTaskCheckpointAadBinding({ ...expected,
      priorJob: { ...expected.priorJob, checkpointAadBinding: changed } }, { get: async () => null })).toBeNull();
  }
});

test("legacy metadata comes only from exact completed accepted grant/Job coordinates", async () => {
  const { expected, record } = await legacy();
  expect(await resolveProtectedTaskCheckpointAadBinding(expected, { get: async () => record })).toEqual(binding);
  expect(await resolveProtectedTaskCheckpointAadBinding(expected, { get: async () => null })).toBeNull();
  for (const changed of [{ ...record, finishedAt: record.finishedAt! + 1 },
    { ...record, expectedPolicyRevision: 4 }, { ...record, descriptorBytes: new Uint8Array([0]) },
    { ...record, acceptedMaterial: null }, { ...record, domainId: "other-domain" }]) {
    expect(await resolveProtectedTaskCheckpointAadBinding(expected, { get: async () => changed })).toBeNull();
  }
  expect(await resolveProtectedTaskCheckpointAadBinding({ ...expected,
    priorJob: { ...expected.priorJob, generation: 1 } }, { get: async () => record })).toBeNull();
});
