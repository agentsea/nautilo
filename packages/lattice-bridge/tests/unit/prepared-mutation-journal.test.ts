import { describe, expect, test } from "bun:test";
import type {
  ProtectedArtifactPreparedPublicationRequestV1,
  ProtectedMemoryPreparedCreateRequestV1,
  ProtectedMemoryPreparedAccessRequestV1,
  ProtectedMemoryPreparedUpdateRequestV1,
  ProtectedMemoryOrdinaryFallbackCreateRequestV1,
  LiveShadowMessagePreparedRequestV1,
  FullEncryptionMessagePreparedRequestV2,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
} from "@nautilo/api-client/browser";

import {
  PREPARED_MUTATION_JOURNAL_LIMITS,
  PreparedMutationJournalBackpressureError,
  PreparedMutationJournalCollisionError,
  createPreparedMutationJournal,
  decodePreparedMutationJournalIndex,
  type PreparedMutationJournalIndex,
  type PreparedMutationJournalVaultPort,
} from "../../src/client/memory/prepared-mutation-journal.ts";

const MEMORY_ID = "81000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "81000000-0000-4000-8000-000000000010";
const ARTIFACT_ID = "82000000-0000-4000-8000-000000000001";
const ARTIFACT_ROW_ID = "82000000-0000-4000-8000-000000000002";
const BLOB_ID = "82000000-0000-4000-8000-000000000003";
const ROOM_ID = "83000000-0000-4000-8000-000000000001";
const TASK_ID = "84000000-0000-4000-8000-000000000001";

function liveShadowRequest(): LiveShadowMessagePreparedRequestV1 {
  return {
    requestVersion: 1,
    status: "prepared",
    operationId: "live-shadow:m282:journal",
    planBytesBase64url: "cGxhbg",
    signedRequestBytesBase64url: "cmVxdWVzdA",
    ordinaryPayloadBytesBase64url: "b3JkaW5hcnk",
    encryptedPayloadBytesBase64url: "ZW5jcnlwdGVk",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
    grantBytesBase64url: "Z3JhbnQ",
  };
}

function fullLiveShadowRequest(): FullEncryptionMessagePreparedRequestV2 {
  const { ordinaryPayloadBytesBase64url: _ordinary, ...request } = liveShadowRequest();
  return {
    ...request,
    requestVersion: 2,
    representationMode: "full_encryption",
  };
}

function createRequest(
  operationId = "memory-create:1",
): ProtectedMemoryPreparedCreateRequestV1 {
  return {
    requestVersion: 1,
    memoryId: MEMORY_ID,
    operationId,
    expectedContentRevision: 0,
    nextContentRevision: 1,
    cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:1`,
    payloadVersion: 1,
    encryptedPayloadBytesBase64url: "Y2lwaGVydGV4dA",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    requiredNamespaceIds: [NAMESPACE_ID],
    namespaceEnvelopes: [{
      namespaceId: NAMESPACE_ID,
      envelopeBytesBase64url: "ZW52ZWxvcGU",
    }],
    signedContentEmbeddingRequestBytesBase64url: "c2lnbmVkLXJlcXVlc3Q",
  };
}

function updateRequest(): ProtectedMemoryPreparedUpdateRequestV1 {
  const { memoryId: _memoryId, ...source } = createRequest();
  return {
    ...source,
    operationId: "memory-update:1",
    expectedContentRevision: 1,
    nextContentRevision: 2,
    cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:2`,
  };
}

function fallbackCreateRequest(): ProtectedMemoryOrdinaryFallbackCreateRequestV1 {
  return { requestVersion: 1, publicationKind: "ordinary_fallback",
    reason: "target_encryption_not_ready", memoryId: MEMORY_ID,
    operationId: "memory-create:fallback", expectedContentRevision: 0,
    nextContentRevision: 1, expectedCryptoAccessRevision: 0,
    requiredNamespaceIds: [NAMESPACE_ID],
    signedOrdinaryFallbackRequestBytesBase64url: "c2lnbmVkLWZhbGxiYWNr" };
}

function accessRequest(): ProtectedMemoryPreparedAccessRequestV1 {
  return {
    requestVersion: 1,
    operationId: "memory-access:1",
    memoryId: MEMORY_ID,
    expectedContentRevision: 1,
    expectedCryptoAccessRevision: 0,
    nextCryptoAccessRevision: 1,
    cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:1`,
    currentNamespaceIds: [NAMESPACE_ID],
    targetNamespaceIds: [],
    accessManifestBytesBase64url: "YWNjZXNzLW1hbmlmZXN0",
    signedAccessRequestBytesBase64url: "c2lnbmVkLWFjY2Vzcy1yZXF1ZXN0",
    namespaceEnvelopes: [],
  };
}

function artifactRequest(
  operationId = "artifact-create:1",
): ProtectedArtifactPreparedPublicationRequestV1 {
  return {
    requestVersion: 1,
    operationId,
    planDigestBase64url: "F".repeat(43),
    operation: "create",
    lifecycleAction: "activate",
    artifactRowId: ARTIFACT_ROW_ID,
    artifactId: ARTIFACT_ID,
    anchorNamespaceId: NAMESPACE_ID,
    cryptoObjectId: `artifact:v1:${"a".repeat(64)}`,
    expectedArtifactRevision: 0,
    nextArtifactRevision: 1,
    expectedCryptoAccessRevision: 0,
    resultCryptoAccessRevision: 0,
    expectedBlobGeneration: 0,
    resultBlobGeneration: 1,
    expectedBlobId: null,
    resultBlobId: BLOB_ID,
    requiredNamespaceIds: [NAMESPACE_ID],
    encryptedControlPayloadBytesBase64url: "Y29udHJvbA",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    namespaceEnvelopes: [{
      namespaceId: NAMESPACE_ID,
      envelopeBytesBase64url: "ZW52ZWxvcGU",
    }],
    signedPublicationRequestBytesBase64url: "c2lnbmVk",
    ciphertextLength: 100,
    ciphertextSha256Base64url: "A".repeat(43),
    chunkPlaintextBytes: 1_048_576,
    chunkCount: 1,
    mimeClass: "document",
    sizeBucket: "le_64_kib",
  };
}

function taskCreateRequest(
  operationId = "task-create:1",
): ProtectedTaskPreparedCreateRequestV1 {
  return {
    requestVersion: 1,
    operationId,
    planDigestBase64url: "T".repeat(43),
    taskId: TASK_ID,
    expectedContentRevision: 0,
    nextContentRevision: 1,
    expectedCryptoAccessRevision: 0,
    resultCryptoAccessRevision: 0,
    cryptoObjectId: `task:v1:${TASK_ID}:1`,
    payloadVersion: 1,
    requiredNamespaceIds: [NAMESPACE_ID],
    encryptedPayloadBytesBase64url: "Y2lwaGVydGV4dA",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    namespaceEnvelopes: [{
      namespaceId: NAMESPACE_ID,
      envelopeBytesBase64url: "ZW52ZWxvcGU",
    }],
    signedPublicationRequestBytesBase64url: "c2lnbmVk",
    operation: "create",
  };
}

function taskUpdateRequest(): ProtectedTaskPreparedUpdateRequestV1 {
  return {
    ...taskCreateRequest("task-update:1"),
    operation: "update",
    expectedContentRevision: 1,
    nextContentRevision: 2,
    expectedCryptoAccessRevision: 2,
    cryptoObjectId: `task:v1:${TASK_ID}:2`,
  };
}

class FakeVault implements PreparedMutationJournalVaultPort {
  readonly records = new Map<string, Readonly<{
    index: PreparedMutationJournalIndex;
    sealed: Uint8Array;
  }>>();
  openedBufferWiped = false;
  unavailable = false;

  putSealed(input: Readonly<{
    index: PreparedMutationJournalIndex;
    canonicalBody: Uint8Array;
  }>): Promise<"inserted" | "exact_duplicate" | "collision"> {
    const existing = this.records.get(input.index.operationId);
    if (existing !== undefined) {
      return Promise.resolve(
        existing.index.authenticatedRequestDigestBase64url
          === input.index.authenticatedRequestDigestBase64url
          ? "exact_duplicate"
          : "collision",
      );
    }
    const sealed = input.canonicalBody.map((byte) => byte ^ 0xa5);
    this.records.set(input.index.operationId, Object.freeze({
      index: Object.freeze({ ...input.index, sealedBytes: sealed.length }),
      sealed,
    }));
    return Promise.resolve("inserted");
  }

  listIndexes(): Promise<readonly PreparedMutationJournalIndex[]> {
    return Promise.resolve([...this.records.values()].map((record) =>
      Object.freeze({ ...record.index })
    ));
  }

  async withOpenedBody<Result>(
    operationId: string,
    _expectedDigestBase64url: string,
    use: (canonicalBody: Uint8Array) => Promise<Result> | Result,
  ): Promise<Result> {
    if (this.unavailable) throw new Error("vault authority unavailable");
    const record = this.records.get(operationId);
    if (record === undefined) throw new Error("record missing");
    const opened = record.sealed.map((byte) => byte ^ 0xa5);
    try {
      return await use(opened);
    } finally {
      opened.fill(0);
      this.openedBufferWiped = opened.every((byte) => byte === 0);
    }
  }

  updateIndex(
    expected: PreparedMutationJournalIndex,
    replacement: PreparedMutationJournalIndex,
  ): Promise<boolean> {
    const current = this.records.get(expected.operationId);
    if (current === undefined || current.index.updatedAt !== expected.updatedAt) {
      return Promise.resolve(false);
    }
    this.records.set(expected.operationId, Object.freeze({
      index: Object.freeze({ ...replacement }),
      sealed: current.sealed,
    }));
    return Promise.resolve(true);
  }

  removeExact(operationId: string, expectedDigest: string): Promise<boolean> {
    const current = this.records.get(operationId);
    if (
      current === undefined
      || current.index.authenticatedRequestDigestBase64url !== expectedDigest
    ) return Promise.resolve(false);
    current.sealed.fill(0);
    this.records.delete(operationId);
    return Promise.resolve(true);
  }
}

function fixture() {
  const vault = new FakeVault();
  let now = 1_800_000_000_000;
  const audit: unknown[] = [];
  const journal = createPreparedMutationJournal({
    vault,
    now: () => now,
    auditDiscard: (fact) => { audit.push(fact); },
  });
  return { vault, journal, audit, advance(ms: number) { now += ms; } };
}

describe("vault-sealed prepared Human Memory mutation journal", () => {
  test("representation repair reuses sealed custody and survives a journal restart", async () => {
    const state = fixture();
    const request = { requestVersion: 1 as const, memoryId: MEMORY_ID, operationId: "repair:1",
      direction: "protected_to_ordinary" as const, signedRepairAttestationBytesBase64url: "c2lnbmVk",
      payload: { formatVersion: 1 as const, type: "authored type", content: "opened historical fact" } };
    const first = await state.journal.putBeforeSend({ kind: "repair", memoryId: MEMORY_ID, request });
    expect(first.status).toBe("inserted");
    const restarted = createPreparedMutationJournal({ vault: state.vault, now: () => 1_800_000_000_001,
      auditDiscard: () => {} });
    const due = await restarted.listDue();
    expect(due.map(({ kind }) => kind)).toEqual(["repair"]);
    await restarted.withPrepared("repair:1", (retained) => {
      expect(retained).toEqual({ kind: "repair", memoryId: MEMORY_ID, request });
    });
    await restarted.recordOutcome({ operationId: "repair:1",
      authenticatedRequestDigestBase64url: first.index.authenticatedRequestDigestBase64url,
      outcome: "completed" });
    expect(await restarted.listDue()).toEqual([]);
  });
  test("seals a prepared live Shadow turn before its single ordinary send", async () => {
    const state = fixture();
    const inserted = await state.journal.putBeforeSend({
      kind: "live_shadow_message",
      roomId: ROOM_ID,
      request: liveShadowRequest(),
    });
    expect(inserted).toMatchObject({
      status: "inserted",
      index: {
        kind: "live_shadow_message",
        roomId: ROOM_ID,
        operationId: "live-shadow:m282:journal",
      },
    });
    expect(JSON.stringify(inserted.index)).not.toContain("ordinaryPayload");

    let opened: unknown;
    await state.journal.withPrepared(
      "live-shadow:m282:journal",
      (mutation) => { opened = mutation; },
    );
    expect(opened).toEqual({
      kind: "live_shadow_message",
      roomId: ROOM_ID,
      request: liveShadowRequest(),
    });
    expect(state.vault.openedBufferWiped).toBeTrue();
  });

  test("seals and retires a Full prepared turn without ordinary bytes", async () => {
    const state = fixture();
    const inserted = await state.journal.putBeforeSend({
      kind: "live_shadow_message", roomId: ROOM_ID,
      request: fullLiveShadowRequest(),
    });
    expect(inserted.status).toBe("inserted");
    let opened: unknown;
    await state.journal.withPrepared("live-shadow:m282:journal", (mutation) => {
      opened = mutation;
    });
    expect(opened).toEqual({
      kind: "live_shadow_message", roomId: ROOM_ID,
      request: fullLiveShadowRequest(),
    });
    expect(JSON.stringify(opened)).not.toContain("ordinaryPayloadBytes");
    await state.journal.recordOutcome({
      operationId: "live-shadow:m282:journal",
      authenticatedRequestDigestBase64url:
        inserted.index.authenticatedRequestDigestBase64url,
      outcome: "completed",
    });
    expect(state.vault.records.size).toBe(0);
  });

  test("stores Artifact publication records under a distinct authenticated domain", async () => {
    const state = fixture();
    const inserted = await state.journal.putBeforeSend({
      kind: "artifact_create",
      artifactId: ARTIFACT_ID,
      request: artifactRequest(),
    });
    expect(inserted.status).toBe("inserted");
    expect(inserted.index).toMatchObject({
      kind: "artifact_create",
      artifactId: ARTIFACT_ID,
      operationId: "artifact-create:1",
    });
    expect("memoryId" in inserted.index).toBeFalse();

    let opened: unknown;
    await state.journal.withPrepared("artifact-create:1", (mutation) => {
      opened = mutation;
    });
    expect(opened).toEqual({
      kind: "artifact_create",
      artifactId: ARTIFACT_ID,
      request: artifactRequest(),
    });
    expect(state.vault.openedBufferWiped).toBeTrue();

    expect(state.journal.putBeforeSend({
      kind: "artifact_control",
      artifactId: ARTIFACT_ID,
      request: artifactRequest(),
    })).rejects.toThrow("coordinates disagree");
  });

  test("seals Task create and update under exact Task coordinates", async () => {
    const state = fixture();
    const created = await state.journal.putBeforeSend({
      kind: "task_create",
      taskId: TASK_ID,
      request: taskCreateRequest(),
    });
    const updated = await state.journal.putBeforeSend({
      kind: "task_update",
      taskId: TASK_ID,
      request: taskUpdateRequest(),
    });
    expect(created.index).toMatchObject({
      kind: "task_create",
      taskId: TASK_ID,
      operationId: "task-create:1",
    });
    expect(updated.index).toMatchObject({
      kind: "task_update",
      taskId: TASK_ID,
      operationId: "task-update:1",
    });
    expect(created.index.authenticatedRequestDigestBase64url)
      .not.toBe(updated.index.authenticatedRequestDigestBase64url);
    expect(JSON.stringify(created.index)).not.toContain("encryptedPayload");

    let opened: unknown;
    await state.journal.withPrepared("task-update:1", (mutation) => {
      opened = mutation;
    });
    expect(opened).toEqual({
      kind: "task_update",
      taskId: TASK_ID,
      request: taskUpdateRequest(),
    });
    expect(state.vault.openedBufferWiped).toBeTrue();
  });

  test("rejects Task wrapper disagreement and preserves authenticated index order", async () => {
    const state = fixture();
    expect(state.journal.putBeforeSend({
      kind: "task_create",
      taskId: "84000000-0000-4000-8000-000000000099",
      request: taskCreateRequest(),
    })).rejects.toThrow("coordinates disagree");
    expect(state.journal.putBeforeSend({
      kind: "task_update",
      taskId: TASK_ID,
      request: taskCreateRequest() as unknown as ProtectedTaskPreparedUpdateRequestV1,
    })).rejects.toThrow();

    const inserted = await state.journal.putBeforeSend({
      kind: "task_create",
      taskId: TASK_ID,
      request: taskCreateRequest(),
    });
    const serialized = JSON.stringify(inserted.index);
    expect(decodePreparedMutationJournalIndex(inserted.index)).toBe(inserted.index);
    expect(JSON.stringify(inserted.index)).toBe(serialized);
    expect(() => decodePreparedMutationJournalIndex({
      ...inserted.index,
      unexpected: true,
    })).toThrow("corrupt");
    const devicePlan = {
      formatVersion: 1,
      operationId: "device-plan:1",
      kind: "additional_device_target_plan",
      authenticatedRequestDigestBase64url: "D".repeat(43),
      canonicalBytes: 1,
      sealedBytes: 17,
      createdAt: 1,
      updatedAt: 1,
      attempts: 0,
      attemptWindowStartedAt: null,
      attemptsInWindow: 0,
      nextAttemptAt: 1,
      lastAttemptAt: null,
      state: "pending",
      targetDeviceId: "device:1",
      verificationCode: "123456",
      deliveryHighWatermark: 1,
      deliveryManifest: [{
        messageId: "message:1",
        recipientSequence: 1,
        payloadHashBase64url: "M".repeat(43),
        unexpected: true,
      }],
    };
    expect(() => decodePreparedMutationJournalIndex(devicePlan)).toThrow("corrupt");
  });

  test("atomically puts canonical create/update/access bodies before send", async () => {
    const state = fixture();
    for (const mutation of [
      { kind: "create" as const, memoryId: MEMORY_ID, request: createRequest() },
      { kind: "create" as const, memoryId: MEMORY_ID,
        request: fallbackCreateRequest() },
      { kind: "update" as const, memoryId: MEMORY_ID, request: updateRequest() },
      { kind: "access" as const, memoryId: MEMORY_ID, request: accessRequest() },
    ]) expect((await state.journal.putBeforeSend(mutation)).status).toBe("inserted");

    const status = await state.journal.listStatus();
    expect(status.map((entry) => ({
      operationId: entry.operationId,
      kind: entry.kind,
      memoryId: "memoryId" in entry ? entry.memoryId : undefined,
    }))).toEqual([
      { operationId: "memory-access:1", kind: "access", memoryId: MEMORY_ID },
      { operationId: "memory-create:1", kind: "create", memoryId: MEMORY_ID },
      { operationId: "memory-create:fallback", kind: "create", memoryId: MEMORY_ID },
      { operationId: "memory-update:1", kind: "update", memoryId: MEMORY_ID },
    ]);
    expect(JSON.stringify(status)).not.toContain("ciphertext");
    expect(JSON.stringify(status)).not.toContain("signedContent");
    let opened: unknown;
    await state.journal.withPrepared("memory-create:1", (mutation) => {
      opened = mutation;
    });
    expect(opened).toEqual({
      kind: "create", memoryId: MEMORY_ID, request: createRequest(),
    });
    expect(state.vault.openedBufferWiped).toBeTrue();
    await state.journal.withPrepared("memory-create:fallback", (mutation) => {
      opened = mutation;
    });
    expect(opened).toEqual({ kind: "create", memoryId: MEMORY_ID,
      request: fallbackCreateRequest() });
  });

  test("deduplicates exact authenticated bytes and rejects operation collisions", async () => {
    const state = fixture();
    expect((await state.journal.putBeforeSend({
      kind: "create", memoryId: MEMORY_ID, request: createRequest(),
    })).status).toBe("inserted");
    expect((await state.journal.putBeforeSend({
      kind: "create", memoryId: MEMORY_ID, request: createRequest(),
    })).status).toBe("duplicate");
    expect(state.journal.putBeforeSend({
      kind: "create",
      memoryId: MEMORY_ID,
      request: { ...createRequest(), cryptoObjectId: "different-object" },
    })).rejects.toBeInstanceOf(PreparedMutationJournalCollisionError);
    expect(state.vault.records).toHaveLength(1);

    const update = fixture();
    await update.journal.putBeforeSend({
      kind: "update", memoryId: MEMORY_ID, request: updateRequest(),
    });
    expect(update.journal.putBeforeSend({
      kind: "update",
      memoryId: "81000000-0000-4000-8000-000000000099",
      request: updateRequest(),
    })).rejects.toBeInstanceOf(PreparedMutationJournalCollisionError);
  });

  test("orders retries deterministically and enforces attempt, rate, and retention bounds", async () => {
    const state = fixture();
    await state.journal.putBeforeSend({ kind: "update", memoryId: MEMORY_ID, request: updateRequest() });
    await state.journal.putBeforeSend({ kind: "create", memoryId: MEMORY_ID, request: createRequest() });
    expect((await state.journal.listDue()).map((entry) => entry.operationId))
      .toEqual(["memory-create:1", "memory-update:1"]);
    const first = (await state.journal.listStatus())[0]!;
    await state.journal.recordOutcome({
      operationId: first.operationId,
      authenticatedRequestDigestBase64url:
        first.authenticatedRequestDigestBase64url,
      outcome: "retryable",
    });
    expect((await state.journal.listDue()).map((entry) => entry.operationId))
      .not.toContain(first.operationId);
    state.advance(PREPARED_MUTATION_JOURNAL_LIMITS.retryBaseMs);
    expect((await state.journal.listDue()).map((entry) => entry.operationId))
      .toContain(first.operationId);
    state.advance(PREPARED_MUTATION_JOURNAL_LIMITS.retentionMs);
    const retry = (await state.journal.listStatus()).find((entry) =>
      entry.operationId === first.operationId
    )!;
    await state.journal.recordOutcome({
      operationId: retry.operationId,
      authenticatedRequestDigestBase64url:
        retry.authenticatedRequestDigestBase64url,
      outcome: "retryable",
    });
    expect((await state.journal.listStatus()).find((entry) =>
      entry.operationId === first.operationId
    )?.state).toBe("terminal_expired");
    expect(state.vault.records.has(first.operationId)).toBeTrue();

    const rate = fixture();
    for (let index = 0; index < PREPARED_MUTATION_JOURNAL_LIMITS.maxAttemptsPerMinute; index += 1) {
      const inserted = await rate.journal.putBeforeSend({
        kind: "create",
        memoryId: MEMORY_ID,
        request: createRequest(`rate:${index}`),
      });
      await rate.journal.recordOutcome({
        operationId: inserted.index.operationId,
        authenticatedRequestDigestBase64url:
          inserted.index.authenticatedRequestDigestBase64url,
        outcome: "retryable",
      });
    }
    rate.advance(PREPARED_MUTATION_JOURNAL_LIMITS.retryBaseMs);
    expect(await rate.journal.listDue()).toEqual([]);
  });

  test("keeps terminal entries repairable and removes only exact completion", async () => {
    const state = fixture();
    await state.journal.putBeforeSend({ kind: "access", memoryId: MEMORY_ID, request: accessRequest() });
    const entry = (await state.journal.listStatus())[0]!;
    await state.journal.recordOutcome({
      operationId: entry.operationId,
      authenticatedRequestDigestBase64url:
        entry.authenticatedRequestDigestBase64url,
      outcome: "denied",
    });
    expect((await state.journal.listStatus())[0]?.state).toBe("terminal_denied");
    expect(state.journal.recordOutcome({
      operationId: entry.operationId,
      authenticatedRequestDigestBase64url: "wrong",
      outcome: "completed",
    })).rejects.toBeInstanceOf(PreparedMutationJournalCollisionError);
    const terminal = (await state.journal.listStatus())[0]!;
    await state.journal.recordOutcome({
      operationId: terminal.operationId,
      authenticatedRequestDigestBase64url:
        terminal.authenticatedRequestDigestBase64url,
      outcome: "completed",
    });
    expect(await state.journal.listStatus()).toEqual([]);
  });

  test("classifies corruption and missing vault authority without fallback", async () => {
    const corrupt = fixture();
    await corrupt.journal.putBeforeSend({ kind: "create", memoryId: MEMORY_ID, request: createRequest() });
    const corruptRecord = corrupt.vault.records.get("memory-create:1");
    if (corruptRecord === undefined) throw new Error("missing test record");
    corruptRecord.sealed[0] = corruptRecord.sealed[0]! ^ 1;
    expect(corrupt.journal.withPrepared("memory-create:1", () => undefined))
      .rejects.toThrow();
    expect((await corrupt.journal.listStatus())[0]?.state).toBe("corrupt");

    const missing = fixture();
    await missing.journal.putBeforeSend({ kind: "access", memoryId: MEMORY_ID, request: accessRequest() });
    missing.vault.unavailable = true;
    expect(missing.journal.withPrepared("memory-access:1", () => undefined))
      .rejects.toThrow("authority unavailable");
    expect((await missing.journal.listStatus())[0]?.state)
      .toBe("missing_authority");

    const callbackFailure = fixture();
    await callbackFailure.journal.putBeforeSend({
      kind: "update", memoryId: MEMORY_ID, request: updateRequest(),
    });
    expect(callbackFailure.journal.withPrepared("memory-update:1", () => {
      throw new Error("transport failed");
    })).rejects.toThrow("transport failed");
    expect((await callbackFailure.journal.listStatus())[0]?.state).toBe("pending");
  });

  test("requires reconciliation and explicit uncertainty confirmation before discard", async () => {
    const state = fixture();
    await state.journal.putBeforeSend({ kind: "update", memoryId: MEMORY_ID, request: updateRequest() });
    let reconciled = 0;
    expect(state.journal.discard({
      operationId: "memory-update:1",
      confirmUncertainCommit: false,
      reconcile: async () => { reconciled += 1; return "uncertain"; },
    })).rejects.toThrow("uncertain-commit confirmation");
    expect(reconciled).toBe(1);
    expect(state.vault.records.has("memory-update:1")).toBeTrue();
    await state.journal.discard({
      operationId: "memory-update:1",
      confirmUncertainCommit: true,
      reconcile: async () => { reconciled += 1; return "unavailable"; },
    });
    expect(reconciled).toBe(2);
    expect(state.vault.records.has("memory-update:1")).toBeFalse();
    expect(JSON.stringify(state.audit)).not.toContain("ciphertext");
    expect(JSON.stringify(state.audit)).not.toContain("digest");
  });

  test("applies conservative browser/electron storage bounds with warning, never eviction", async () => {
    expect(PREPARED_MUTATION_JOURNAL_LIMITS.maxCanonicalRecordBytes)
      .toBe(4 * 1_048_576);
    expect(PREPARED_MUTATION_JOURNAL_LIMITS.maxTotalSealedBytes)
      .toBe(132 * 1_048_576);
    expect(PREPARED_MUTATION_JOURNAL_LIMITS.warningTotalSealedBytes)
      .toBeLessThan(PREPARED_MUTATION_JOURNAL_LIMITS.maxTotalSealedBytes);
    const state = fixture();
    for (let index = 0; index < PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords; index += 1) {
      await state.journal.putBeforeSend({
        kind: "create",
        memoryId: MEMORY_ID,
        request: createRequest(`memory-create:${String(index).padStart(3, "0")}`),
      });
    }
    expect(await state.journal.capacity()).toMatchObject({
      records: PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords,
      warning: true,
      full: true,
    });
    expect(state.journal.putBeforeSend({
      kind: "create", memoryId: MEMORY_ID, request: createRequest("memory-create:overflow"),
    })).rejects.toBeInstanceOf(PreparedMutationJournalBackpressureError);
    expect(state.vault.records).toHaveLength(
      PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords,
    );
  });

  test("never accepts search/read/archive/tier entries", async () => {
    const state = fixture();
    expect(state.journal.putBeforeSend({
      kind: "archive",
      request: { operationId: "archive:1", memoryId: MEMORY_ID },
    } as never)).rejects.toThrow();
    expect(state.vault.records).toHaveLength(0);
  });
});
