import { describe, expect, test } from "bun:test";
import type { TaskOrdinaryFallbackPreparedCreateRequestV1 } from "@nautilo/api-client";
import type { DirectDatabase, PostgresJsBridgeConnection, Task } from "@nautilo/db";
import {
  bindEncryptionDataOperationOwner,
  digestHumanTaskOrdinaryFallbackRequestV1,
  encodeTaskPayloadV1,
  fingerprintHumanTaskOrdinaryFallbackContentV1,
  fingerprintHumanTaskOrdinaryFallbackPlanV1,
  fingerprintTaskOperationalFieldsV1,
  prepareHumanTaskOrdinaryFallbackRequestV1,
  type HumanTaskOrdinaryFallbackPlanV1,
} from "@nautilo/lattice-bridge";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createTaskOrdinaryFallbackPorts,
  fingerprintTaskOrdinaryFallbackSourceV1,
  importTaskOrdinaryFallbackSubmissionV1,
  isTaskOrdinaryFallbackMutableV1,
} from "../../src/routes/task-ordinary-fallback-composition";

const TASK = "81000000-0000-8000-8000-000000000001";
const authority = { userId: "owner", subjectHumanId: "human", actorId: "human",
  agentId: "genie", deviceId: "device", deviceGeneration: 1 };
const crypto = new LatticeCrypto();
const signer = crypto.generateSigningKeyPair();
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");

function source(overrides: Partial<Task & { mutationVersion: string }> = {}): Task & { mutationVersion: string } {
  return {
    id: TASK, ownerId: "owner", requestorId: "owner", agentId: "genie",
    prompt: "original", expectedOutput: null, preset: "task", scheduleKind: "one_shot",
    runAt: new Date("2099-01-01T00:00:00.000Z"), cron: null, timezone: "UTC", catchup: "skip",
    callingRoomId: null, targetChat: "orphan", targetChatHandle: null, targetRoomId: null,
    targetUserIds: [], resultDelivery: "wake", useScope: false, scopeId: null,
    toolsMode: "auto", toolsWhitelist: [], awaitResponse: false, selectionProfile: "balanced",
    selectionSpec: null, requestedModelId: null, fundingMode: "legacy_server", timeLimitSeconds: null,
    parentTaskId: null, depth: 0, status: "pending", nextFireAt: null, lastFiredAt: null,
    fireLockId: null, fireLockedAt: null, pauseRequestId: null, pauseRequestedAt: null,
    pauseReason: null, lastError: null, localExecutionDelegation: null, metadata: {},
    contentRepresentation: "ordinary", contentNamespaceId: null, contentRevision: 0,
    cryptoObjectId: null, cryptoAccessRevision: 0, cryptoRequiredNamespaceFingerprint: null,
    cryptoMappingState: "unmapped", ordinaryFallbackOperationId: null,
    ordinaryFallbackRequestDigest: null, ordinaryFallbackReason: null,
    ordinaryFallbackPolicyRevision: null, ordinaryFallbackCompletedAt: null,
    createdAt: new Date("2026-10-19T00:00:00.000Z"), updatedAt: new Date("2026-10-19T00:00:00.000Z"),
    cancelledAt: null, mutationVersion: "123", ...overrides,
  };
}

function prepared(): TaskOrdinaryFallbackPreparedCreateRequestV1 {
  const content = encodeTaskPayloadV1({ formatVersion: 1, prompt: "new", expectedOutput: null, protectedMetadata: {} });
  const plan: HumanTaskOrdinaryFallbackPlanV1 = {
    formatVersion: 1, purpose: "task.ordinary_fallback.create", reason: "target_encryption_not_ready",
    operationId: "task:fallback:one", taskId: TASK,
    sourceDigest: new Uint8Array(32), operationalFieldsDigest: fingerprintTaskOperationalFieldsV1("create", {}),
    expectedContentRevision: 0, expectedCryptoAccessRevision: 0, expectedUpdatedAt: null,
    policyRevision: 25, subjectHumanId: authority.subjectHumanId, committerDeviceId: authority.deviceId,
    committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: 1,
    planIssuedAt: 1_000, planDeadlineAt: 31_000,
  };
  const signed = prepareHumanTaskOrdinaryFallbackRequestV1(crypto, {
    ...plan, planDigest: fingerprintHumanTaskOrdinaryFallbackPlanV1(plan),
    taskDefinitionContentDigest: fingerprintHumanTaskOrdinaryFallbackContentV1(content),
    issuedAt: 1_001, deadlineAt: 31_000, signingPrivateKey: signer.privateKey,
  });
  return { requestVersion: 1, representation: "ordinary_fallback", operationId: plan.operationId,
    taskId: TASK, task: {}, ordinaryPayloadBytesBase64url: b64(content),
    signedOrdinaryFallbackRequestBytesBase64url: b64(signed.bytes),
    authenticatedRequestDigestBase64url: b64(digestHumanTaskOrdinaryFallbackRequestV1(signed.bytes)) };
}

describe("Task ordinary fallback admission", () => {
  test("binds transport content, execution fields, operation, Human and Device to signed metadata", () => {
    const request = prepared();
    const accepted = importTaskOrdinaryFallbackSubmissionV1({ authority, prepared: request, operation: "create" });
    expect(accepted.content.payload.prompt).toBe("new");
    for (const change of [
      { operationId: "task:fallback:other" },
      { taskId: "81000000-0000-8000-8000-000000000002" },
      { task: { resultDelivery: "raw" as const } },
      { ordinaryPayloadBytesBase64url: b64(encodeTaskPayloadV1({ formatVersion: 1,
        prompt: "substituted", expectedOutput: null, protectedMetadata: {} })) },
      { authenticatedRequestDigestBase64url: b64(new Uint8Array(32)) },
      { signedOrdinaryFallbackRequestBytesBase64url: "e30" },
    ]) expect(() => importTaskOrdinaryFallbackSubmissionV1({ authority,
      prepared: { ...request, ...change }, operation: "create" })).toThrow("invalid");
    for (const change of [{ subjectHumanId: "other" }, { deviceId: "other" }, { deviceGeneration: 2 }]) {
      expect(() => importTaskOrdinaryFallbackSubmissionV1({ authority: { ...authority, ...change },
        prepared: request, operation: "create" })).toThrow("invalid");
    }
    expect(() => importTaskOrdinaryFallbackSubmissionV1({ authority, prepared: request, operation: "update" })).toThrow("invalid");
  });

  test("fingerprints complete persisted source and CAS coordinates", () => {
    const identity = { taskId: TASK, subjectHumanId: authority.subjectHumanId, agentId: authority.agentId };
    const baseline = fingerprintTaskOrdinaryFallbackSourceV1(crypto, source(), identity);
    for (const change of [
      { mutationVersion: "124" }, { prompt: "changed" }, { metadata: { instructions: "changed" } },
      { callingRoomId: "room" }, { targetUserIds: ["recipient"] }, { fundingMode: "caller" as const },
      { localExecutionDelegation: { version: 1 } as Task["localExecutionDelegation"] },
      { contentRevision: 2 }, { ordinaryFallbackOperationId: "older:fallback" },
      { ordinaryFallbackRequestDigest: new Uint8Array(32).fill(1) },
      { updatedAt: new Date("2026-10-19T00:00:00.001Z") },
    ]) expect(fingerprintTaskOrdinaryFallbackSourceV1(crypto, source(change), identity)).not.toEqual(baseline);
    expect(fingerprintTaskOrdinaryFallbackSourceV1(crypto, null, identity)).not.toEqual(baseline);
    expect(fingerprintTaskOrdinaryFallbackSourceV1(crypto, source(), { ...identity, agentId: "other" })).not.toEqual(baseline);
  });

  test("retains mapped history only for owner root Tasks that are not executing", () => {
    expect(isTaskOrdinaryFallbackMutableV1(source())).toBe(true);
    const mapped = source({ contentRepresentation: "dual", contentNamespaceId: "namespace",
      contentRevision: 3, cryptoObjectId: "object:3", cryptoRequiredNamespaceFingerprint: new Uint8Array(32),
      cryptoMappingState: "verified" });
    expect(isTaskOrdinaryFallbackMutableV1(mapped)).toBe(true);
    expect(isTaskOrdinaryFallbackMutableV1({ ...mapped, cryptoMappingState: "stale" })).toBe(true);
    for (const change of [
      { status: "running" as const }, { fireLockId: "run" }, { requestorId: "another" },
      { parentTaskId: TASK }, { depth: 1 }, { contentNamespaceId: null },
      { cryptoRequiredNamespaceFingerprint: new Uint8Array(31) }, { cryptoMappingState: "unmapped" as const },
    ]) expect(isTaskOrdinaryFallbackMutableV1({ ...mapped, ...change })).toBe(false);
  });

  test("Plain and Full publication reject before Device or product access", async () => {
    const idle = new Proxy({}, { get: () => { throw new Error("No database access expected"); } });
    for (const mode of ["plaintext_only", "encrypted_only"] as const) {
      const ports = createTaskOrdinaryFallbackPorts({ db: idle as DirectDatabase,
        restricted: idle as PostgresJsBridgeConnection, crypto,
        owner: bindEncryptionDataOperationOwner({ policy: {
          resolve: async () => ({ policy: { mode, shadowBehavior: "fallback" }, revalidationToken: 1 }),
          revalidate: async () => {},
        } }), observer: { kick() { throw new Error("No observer expected"); } } });
      const failure = await ports.publishCreate({ authority, prepared: prepared() })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("not supported");
    }
  });
});
