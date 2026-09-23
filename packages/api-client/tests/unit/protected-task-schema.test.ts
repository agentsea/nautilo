import { describe, expect, test } from "bun:test";
import { LATTICE_LIMITS } from "@nautilo/lattice-crypto/wire-limits";

import {
  dualTaskPreparedCreateRequestV1Schema,
  dualTaskPreparedUpdateRequestV1Schema,
  protectedTaskPreparedCreateRequestV1Schema,
  protectedTaskPreparedPublicationRequestV1Schema,
  protectedTaskPreparedUpdateRequestV1Schema,
  protectedTaskPublicationPlanRequestV1Schema,
  protectedTaskDefinitionReadEnvelopeV1Schema,
  protectedTaskContentListV1Schema,
  type ProtectedTaskPreparedCreateRequestV1,
} from "../../src/browser.ts";
import {
  taskContentDetailV1Schema,
  taskContentSummaryV1Schema,
} from "../../src/schemas/protected-task.ts";

const TASK_ID = "91000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "91000000-0000-4000-8000-000000000002";

function createRequest(): ProtectedTaskPreparedCreateRequestV1 {
  return {
    requestVersion: 1,
    operationId: "task:create:1",
    planDigestBase64url: "A".repeat(43),
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
    task: {},
    operation: "create",
  };
}

describe("protected Task prepared publication schema", () => {
  test("accepts exact create and adjacent update coordinates", () => {
    const create = createRequest();
    expect(protectedTaskPreparedPublicationRequestV1Schema.parse(create)).toEqual(create);

    const update = {
      ...create,
      operation: "update" as const,
      operationId: "task:update:1",
      expectedContentRevision: 7,
      nextContentRevision: 8,
      expectedCryptoAccessRevision: 3,
      cryptoObjectId: `task:v1:${TASK_ID}:8`,
    };
    expect(protectedTaskPreparedUpdateRequestV1Schema.parse(update)).toEqual(update);
  });

  test("rejects unknown fields, mismatched authority, and invalid revisions", () => {
    const create = createRequest();
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      prompt: "must never enter the prepared transport",
    })).toThrow();
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      namespaceEnvelopes: [{
        ...create.namespaceEnvelopes[0],
        namespaceId: "91000000-0000-4000-8000-000000000003",
      }],
    })).toThrow();
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      expectedCryptoAccessRevision: 1,
    })).toThrow();
    expect(() => protectedTaskPreparedUpdateRequestV1Schema.parse({
      ...create,
      operation: "update",
      expectedContentRevision: 4,
      nextContentRevision: 6,
    })).toThrow();
  });

  test("uses the lattice ciphertext bound without truncation", () => {
    const maximumEncodedLength = Math.ceil(
      LATTICE_LIMITS.ciphertextBytes * 4 / 3,
    );
    const create = createRequest();
    for (const length of [maximumEncodedLength - 1, maximumEncodedLength]) {
      expect(protectedTaskPreparedCreateRequestV1Schema.parse({
        ...create,
        encryptedPayloadBytesBase64url: "A".repeat(length),
      }).encryptedPayloadBytesBase64url).toHaveLength(length);
    }
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      encryptedPayloadBytesBase64url: "A".repeat(maximumEncodedLength + 1),
    })).toThrow();
  });

  test("keeps operational fields closed and excludes plaintext content", () => {
    const request = createRequest();
    expect(protectedTaskPreparedCreateRequestV1Schema.parse({
      ...request,
      task: { scheduleKind: "cron", cron: "0 9 * * *", timezone: "UTC" },
    }).task).toEqual({ scheduleKind: "cron", cron: "0 9 * * *", timezone: "UTC" });
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...request,
      task: { prompt: "plaintext must not cross" },
    })).toThrow();
    expect(() => protectedTaskPreparedUpdateRequestV1Schema.parse({
      ...request,
      operation: "update",
      expectedContentRevision: 1,
      nextContentRevision: 2,
      task: { expectedOutput: "plaintext must not cross" },
    })).toThrow();
  });

  test("accepts bounded dual siblings while protected schemas reject dual fields", () => {
    const create = createRequest();
    const dualCreate = {
      ...create,
      representation: "dual" as const,
      ordinaryPayloadBytesBase64url: "eyJmb3JtYXRWZXJzaW9uIjoxfQ",
    };
    expect(dualTaskPreparedCreateRequestV1Schema.parse(dualCreate)).toEqual(dualCreate);
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse(dualCreate)).toThrow();

    const dualUpdate = {
      ...dualCreate,
      operation: "update" as const,
      expectedContentRevision: 1,
      nextContentRevision: 2,
    };
    expect(dualTaskPreparedUpdateRequestV1Schema.parse(dualUpdate)).toEqual(dualUpdate);
    expect(() => protectedTaskPreparedUpdateRequestV1Schema.parse(dualUpdate)).toThrow();
    expect(() => dualTaskPreparedCreateRequestV1Schema.parse({
      ...dualCreate,
      representation: "protected",
    })).toThrow();

    const maximumEncodedLength = Math.ceil(LATTICE_LIMITS.plaintextBytes * 4 / 3);
    expect(dualTaskPreparedCreateRequestV1Schema.parse({
      ...dualCreate,
      ordinaryPayloadBytesBase64url: "A".repeat(maximumEncodedLength),
    }).ordinaryPayloadBytesBase64url).toHaveLength(maximumEncodedLength);
    expect(() => dualTaskPreparedCreateRequestV1Schema.parse({
      ...dualCreate,
      ordinaryPayloadBytesBase64url: "A".repeat(maximumEncodedLength + 1),
    })).toThrow();
    expect(() => dualTaskPreparedCreateRequestV1Schema.parse({
      ...dualCreate,
      ordinaryPayloadBytesBase64url: "A===",
    })).toThrow();
  });

  test("derives operational string, tools, and aggregate bounds from lattice limits", () => {
    const plan = {
      requestVersion: 1 as const,
      operation: "create" as const,
      operationId: "task:create:bounded",
    };
    expect(protectedTaskPublicationPlanRequestV1Schema.parse({
      ...plan,
      task: {
        requestedModelId: "m".repeat(LATTICE_LIMITS.idBytes),
        tools: Array.from({ length: LATTICE_LIMITS.batchItems }, () => "tool"),
      },
    }).task.tools).toHaveLength(LATTICE_LIMITS.batchItems);
    expect(() => protectedTaskPublicationPlanRequestV1Schema.parse({
      ...plan,
      task: { requestedModelId: "m".repeat(LATTICE_LIMITS.idBytes + 1) },
    })).toThrow();
    expect(() => protectedTaskPublicationPlanRequestV1Schema.parse({
      ...plan,
      task: { tools: Array.from({ length: LATTICE_LIMITS.batchItems + 1 }, () => "tool") },
    })).toThrow();

    const emptyCronBytes = new TextEncoder().encode(JSON.stringify({ cron: "" })).length;
    const boundaryCron = "x".repeat(LATTICE_LIMITS.plaintextBytes - emptyCronBytes);
    expect(protectedTaskPublicationPlanRequestV1Schema.parse({
      ...plan, task: { cron: boundaryCron },
    }).task.cron).toHaveLength(boundaryCron.length);
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...createRequest(), task: { cron: `${boundaryCron}x` },
    })).toThrow();
  });
});

const protectedSummary = {
  id: TASK_ID,
  parentTaskId: null,
  depth: 0,
  status: "pending",
  preset: "task",
  scheduleKind: "cron",
  nextFireAt: null,
  callingRoomId: null,
  content: {
    dtoVersion: 1,
    status: "protected",
    objectId: `task:v1:${TASK_ID}:1`,
    contentRevision: 1,
    cryptoAccessRevision: 0,
  },
};

describe("Task content v1 response schemas", () => {
  test("rejects plaintext fields at every protected projection boundary", () => {
    expect(taskContentSummaryV1Schema.parse(protectedSummary).content.status)
      .toBe("protected");
    expect(() => taskContentSummaryV1Schema.parse({
      ...protectedSummary, prompt: "leaked",
    })).toThrow();
    expect(() => taskContentSummaryV1Schema.parse({
      ...protectedSummary,
      content: { ...protectedSummary.content, promptPreview: "leaked" },
    })).toThrow();
    expect(() => taskContentDetailV1Schema.parse({
      task: {
        id: TASK_ID,
        parentTaskId: null,
        depth: 0,
        status: "pending",
        preset: "task",
        scheduleKind: "cron",
        nextFireAt: null,
        callingRoomId: null,
        cron: null,
        runAt: null,
        timezone: "UTC",
        targetChat: "orphan",
        resultDelivery: "wake",
        useScope: false,
        scopeId: null,
        toolsMode: "all",
        toolsWhitelist: [],
        selectionProfile: "balanced",
        selectionSpec: null,
        requestedModelId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      definition: { ...protectedSummary.content, prompt: "leaked" },
      runs: [],
    })).toThrow();
  });

  test("keeps protected lists and definition reads ciphertext-only and genesis-only", () => {
    expect(protectedTaskContentListV1Schema.parse([protectedSummary])).toHaveLength(1);
    expect(() => protectedTaskContentListV1Schema.parse([{
      ...protectedSummary,
      content: { dtoVersion: 1, status: "ordinary",
        promptPreview: "must not cross", lastError: null },
    }])).toThrow();

    const ready = {
      readVersion: 1,
      status: "ready",
      taskId: TASK_ID,
      objectId: protectedSummary.content.objectId,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      namespaceId: NAMESPACE_ID,
      encryptedPayloadBytesBase64url: "Y2lwaGVy",
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      accessManifestProofBytesBase64url: [],
      namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
      signerEvidence: [],
    } as const;
    expect(protectedTaskDefinitionReadEnvelopeV1Schema.parse(ready).status).toBe("ready");
    expect(() => protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      ...ready, cryptoAccessRevision: 1,
    })).toThrow();
    expect(() => protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      ...ready, accessManifestProofBytesBase64url: ["YQ"],
    })).toThrow();
    expect(protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      readVersion: 1,
      status: "unavailable",
      taskId: TASK_ID,
      objectId: protectedSummary.content.objectId,
      contentRevision: 1,
      cryptoAccessRevision: 2,
      reason: "unsupported_crypto_access_revision",
    }).status).toBe("unavailable");
  });
});
