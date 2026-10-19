import { describe, expect, test } from "bun:test";
import {
  LATTICE_LIMITS,
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
  MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
} from "@nautilo/lattice-crypto/wire-limits";
import { TASK_FUNDING_FAILURE_CODES } from "@nautilo/types";

import {
  dualTaskPreparedCreateRequestV1Schema,
  dualTaskPreparedUpdateRequestV1Schema,
  protectedTaskPreparedCreateRequestV1Schema,
  protectedTaskPreparedPublicationRequestV1Schema,
  protectedTaskPreparedUpdateRequestV1Schema,
  protectedTaskPublicationPlanRequestV1Schema,
  protectedTaskPublicationPlanV1Schema,
  protectedTaskDefinitionReadEnvelopeV1Schema,
  protectedTaskRunResultReadEnvelopeV1Schema,
  protectedTaskContentListV1Schema,
  type ProtectedTaskPreparedCreateRequestV1,
} from "../../src/browser.ts";
import {
  taskContentDetailV1Schema,
  taskContentListV1Schema,
  taskContentSummaryV1Schema,
} from "../../src/schemas/protected-task.ts";

const TASK_ID = "91000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "91000000-0000-4000-8000-000000000002";
const TASK_RUN_ID = "91000000-0000-4000-8000-000000000003";
const readAuthority = {
  sourceRoomId: "91000000-0000-4000-8000-000000000005",
  namespaceId: NAMESPACE_ID,
  currentGeneration: 2,
  retainedGenerations: [1, 2].map(generation => ({
    generation,
    accessRevision: generation,
    headDigestBase64url: "A".repeat(43),
    publicationDigestBase64url: "A".repeat(43),
    publicationSetDigestBase64url: "A".repeat(43),
    audienceFingerprintBase64url: "A".repeat(43),
  })),
};
const historicalRepair = Object.freeze({
  version: 2 as const,
  claimId: "91000000-0000-4000-8000-000000000004",
  publisherDeviceId: "historical-device.1",
  signedRequestDigest: "11".repeat(32),
  sourceDigest: "22".repeat(32),
  sourcePayloadHash: "33".repeat(32),
  sourceRevision: 0 as const,
  genesisManifestHash: "44".repeat(32),
});

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
  test("admits bounded repair source bytes only for an existing update plan", () => {
    const plan = {
      planVersion: 1, operation: "update", operationId: "task:repair:source",
      taskId: TASK_ID, expectedContentRevision: 1, nextContentRevision: 2,
      expectedCryptoAccessRevision: 0, planDigestBase64url: "A".repeat(43),
      authority: {
        requesterHumanId: TASK_ID, sourceRoomId: TASK_RUN_ID, namespaceId: NAMESPACE_ID,
        domainId: "domain:private", expectedAccessRevision: 1, expectedPolicyRevision: 1,
        bindingHashBase64url: "A".repeat(43), keyGeneration: 1,
      },
    } as const;
    expect(protectedTaskPublicationPlanV1Schema.parse(plan)).toEqual(plan);
    const repair = { ...plan, ordinaryRepairPayloadBase64url: "c291cmNl" };
    expect(protectedTaskPublicationPlanV1Schema.parse(repair)).toEqual(repair);
    for (const invalid of [
      { ...repair, operation: "create", expectedContentRevision: 0, nextContentRevision: 1 },
      { ...repair, expectedContentRevision: 0, nextContentRevision: 1 },
      { ...repair, ordinaryRepairPayloadBase64url: "c291cmNl=" },
      { ...repair, ordinaryRepairPayloadBase64url: "A".repeat(Math.ceil(LATTICE_LIMITS.plaintextBytes * 4 / 3) + 4) },
    ]) expect(() => protectedTaskPublicationPlanV1Schema.parse(invalid)).toThrow();
  });
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

  test("uses the exact encrypted-payload and Namespace-envelope codec bounds", () => {
    const maximumEncodedLength = Math.ceil(
      MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2 * 4 / 3,
    );
    const create = createRequest();
    for (const length of [maximumEncodedLength - 2, maximumEncodedLength]) {
      expect(protectedTaskPreparedCreateRequestV1Schema.parse({
        ...create,
        encryptedPayloadBytesBase64url: "A".repeat(length),
      }).encryptedPayloadBytesBase64url).toHaveLength(length);
    }
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      encryptedPayloadBytesBase64url: "A".repeat(maximumEncodedLength + 1),
    })).toThrow();

    const maximumEnvelopeEncodedLength = Math.ceil(
      MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2 * 4 / 3,
    );
    expect(protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      namespaceEnvelopes: [{
        ...create.namespaceEnvelopes[0],
        envelopeBytesBase64url: "A".repeat(maximumEnvelopeEncodedLength),
      }],
    }).namespaceEnvelopes[0].envelopeBytesBase64url)
      .toHaveLength(maximumEnvelopeEncodedLength);
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      namespaceEnvelopes: [{
        ...create.namespaceEnvelopes[0],
        envelopeBytesBase64url: "A".repeat(maximumEnvelopeEncodedLength + 1),
      }],
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

  test("accepts only opaque Agent-signed TaskRun result envelopes", () => {
    const ready = {
      readVersion: 1 as const,
      status: "ready" as const,
      taskId: TASK_ID,
      taskRunId: "91000000-0000-4000-8000-000000000003",
      objectId: `task-run-result:v1:${"a".repeat(64)}`,
      resultRevision: 1 as const,
      cryptoAccessRevision: 0 as const,
      namespaceId: NAMESPACE_ID,
      readAuthority,
      encryptedPayloadBytesBase64url: "Y2lwaGVy",
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      accessManifestProofBytesBase64url: [] as [],
      namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
      signerEvidence: [{
        kind: "agent_runtime_publication" as const,
        evidenceBytesBase64url: "ZXZpZGVuY2U",
      }],
    };
    expect(protectedTaskRunResultReadEnvelopeV1Schema.parse(ready)).toEqual(ready);
    const maximumEncodedPayloadLength = Math.ceil(
      MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2 * 4 / 3,
    );
    const maximumReady = protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...ready,
      encryptedPayloadBytesBase64url: "A".repeat(maximumEncodedPayloadLength),
    });
    if (maximumReady.status !== "ready") throw new Error("Expected ready Task result");
    expect(maximumReady.encryptedPayloadBytesBase64url).toHaveLength(maximumEncodedPayloadLength);
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...ready,
      encryptedPayloadBytesBase64url: "A".repeat(maximumEncodedPayloadLength + 1),
    })).toThrow();
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...ready, readAuthority: undefined,
    })).toThrow();
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...ready, readAuthority: { ...readAuthority, namespaceId: TASK_ID },
    })).toThrow();
    const foreground = {
      ...ready,
      signerEvidence: [{
        kind: "foreground_agent_accepted_execution" as const,
        planBytesBase64url: "cGxhbg",
        planDigestBase64url: "A".repeat(43),
      }],
    };
    expect(protectedTaskRunResultReadEnvelopeV1Schema.parse(foreground))
      .toEqual(foreground);
    const certified = {
      ...ready,
      signerEvidence: [{
        kind: "task_runtime_signer_certificate" as const,
        evidenceBytesBase64url: "Y2VydGlmaWNhdGU",
      }],
    };
    expect(protectedTaskRunResultReadEnvelopeV1Schema.parse(certified))
      .toEqual(certified);
    const historical = {
      ...ready,
      accessManifestProofBytesBase64url: [] as [],
      historicalRepair,
      signerEvidence: [{
        kind: "human_device" as const,
        subjectHumanId: TASK_ID,
        committerDeviceId: historicalRepair.publisherDeviceId,
        hostAuthorizationRevision: 3,
        signingPublicKeyBase64url: "A".repeat(43),
      }],
    };
    expect(protectedTaskRunResultReadEnvelopeV1Schema.parse(historical))
      .toEqual(historical);
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...historical,
      signerEvidence: ready.signerEvidence,
    })).toThrow();
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...historical,
      signerEvidence: foreground.signerEvidence,
    })).toThrow();
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...historical,
      signerEvidence: certified.signerEvidence,
    })).toThrow();
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...historical,
      historicalRepair: { ...historicalRepair, sourceRevision: 1 },
    })).toThrow();
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      readVersion: 1, status: "waiting", taskId: TASK_ID,
      taskRunId: TASK_RUN_ID, objectId: historical.objectId,
      resultRevision: 1, cryptoAccessRevision: 0,
      reason: "result_not_mapped", historicalRepair,
    })).toThrow();
    const cancelled = { ...ready, resultRevision: 2 as const };
    expect(protectedTaskRunResultReadEnvelopeV1Schema.parse(cancelled))
      .toEqual(cancelled);
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...ready,
      resultRevision: 3,
    })).toThrow();
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...ready,
      resultText: "plaintext must not cross",
    })).toThrow();
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...ready,
      signerEvidence: [],
    })).toThrow();
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      ...ready,
      signerEvidence: [{
        kind: "human_device",
        subjectHumanId: TASK_ID,
        committerDeviceId: "device:one",
        hostAuthorizationRevision: 1,
        signingPublicKeyBase64url: "A".repeat(43),
      }],
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
  test("parses classified funding failures in Task lists without widening the strict wire shape", () => {
    const fundingFailedSummary = {
      ...protectedSummary,
      status: "paused",
      fundingFailure: "personal_credential_stale" as const,
      content: {
        dtoVersion: 1 as const,
        status: "ordinary" as const,
        promptPreview: "Personal-key Task",
        lastError: "personal_credential_stale",
      },
    };

    const [parsed] = taskContentListV1Schema.parse([fundingFailedSummary]);
    if (!parsed) throw new Error("funding-failed Task list row missing");
    expect(parsed.fundingFailure).toBe("personal_credential_stale");
    for (const fundingFailure of TASK_FUNDING_FAILURE_CODES) {
      expect(taskContentListV1Schema.parse([{
        ...fundingFailedSummary,
        fundingFailure,
      }])[0]?.fundingFailure).toBe(fundingFailure);
    }
    expect(taskContentListV1Schema.parse([{
      ...fundingFailedSummary,
      fundingFailure: null,
    }])[0]?.fundingFailure).toBeNull();

    expect(() => taskContentListV1Schema.parse([{
      ...fundingFailedSummary,
      fundingFailure: "provider_api_key_exposed",
    }])).toThrow();
    expect(() => taskContentListV1Schema.parse([{
      ...fundingFailedSummary,
      apiKey: "must-not-cross",
    }])).toThrow();
  });

  test("parses Task detail run funding sources and classified failure reasons", () => {
    const detail = {
      task: {
        id: TASK_ID,
        parentTaskId: null,
        depth: 0,
        status: "paused",
        preset: "task",
        scheduleKind: "now",
        nextFireAt: null,
        callingRoomId: null,
        fundingFailure: "personal_provider_unavailable" as const,
        cron: null,
        runAt: null,
        timezone: "UTC",
        targetChat: "orphan",
        resultDelivery: "raw",
        useScope: false,
        scopeId: null,
        toolsMode: "none",
        toolsWhitelist: [],
        selectionProfile: "balanced" as const,
        selectionSpec: null,
        requestedModelId: "openrouter:moonshotai/kimi-k3",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
      },
      definition: {
        dtoVersion: 1 as const,
        status: "ordinary" as const,
        prompt: "Use my provider key.",
        expectedOutput: null,
        lastError: "personal_provider_unavailable",
      },
      runs: [{
        id: TASK_RUN_ID,
        status: "paused",
        modelId: "openrouter:moonshotai/kimi-k3",
        fundingSource: "personal" as const,
        fundingFailure: "personal_provider_unavailable" as const,
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: null,
        content: {
          dtoVersion: 1 as const,
          status: "ordinary" as const,
          resultText: null,
          lastError: "personal_provider_unavailable",
          transcript: [],
        },
      }, {
        id: "91000000-0000-4000-8000-000000000004",
        status: "paused",
        modelId: "anthropic:claude-sonnet-4-6",
        fundingSource: "server" as const,
        fundingFailure: "funding_interrupted_uncertain" as const,
        startedAt: "2026-01-01T00:02:00.000Z",
        completedAt: null,
        content: {
          dtoVersion: 1 as const,
          status: "ordinary" as const,
          resultText: null,
          lastError: "funding_interrupted_uncertain",
          transcript: [],
        },
      }],
    };

    const parsed = taskContentDetailV1Schema.parse(detail);
    expect(parsed.task.fundingFailure).toBe("personal_provider_unavailable");
    expect(parsed.runs.map((run) => ({
      source: run.fundingSource,
      failure: run.fundingFailure,
    }))).toEqual([
      { source: "personal", failure: "personal_provider_unavailable" },
      { source: "server", failure: "funding_interrupted_uncertain" },
    ]);
    const nullable = taskContentDetailV1Schema.parse({
      ...detail,
      runs: [{
        ...detail.runs[0],
        fundingSource: null,
        fundingFailure: null,
      }],
    });
    expect(nullable.runs[0]?.fundingSource).toBeNull();
    expect(nullable.runs[0]?.fundingFailure).toBeNull();

    expect(() => taskContentDetailV1Schema.parse({
      ...detail,
      runs: [{ ...detail.runs[0], apiKey: "must-not-cross" }],
    })).toThrow();
  });

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

  test("keeps protected lists and definition access histories ciphertext-only", () => {
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
      readAuthority,
      encryptedPayloadBytesBase64url: "Y2lwaGVy",
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      accessManifestProofBytesBase64url: [],
      namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
      signerEvidence: [{
        kind: "human_device",
        subjectHumanId: TASK_ID,
        committerDeviceId: historicalRepair.publisherDeviceId,
        hostAuthorizationRevision: 3,
        signingPublicKeyBase64url: "A".repeat(43),
      }],
    } as const;
    expect(protectedTaskDefinitionReadEnvelopeV1Schema.parse(ready).status).toBe("ready");
    const maximumEncodedPayloadLength = Math.ceil(
      MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2 * 4 / 3,
    );
    const maximumReady = protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      ...ready,
      encryptedPayloadBytesBase64url: "A".repeat(maximumEncodedPayloadLength),
    });
    if (maximumReady.status !== "ready") throw new Error("Expected ready Task definition");
    expect(maximumReady.encryptedPayloadBytesBase64url).toHaveLength(maximumEncodedPayloadLength);
    expect(() => protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      ...ready,
      encryptedPayloadBytesBase64url: "A".repeat(maximumEncodedPayloadLength + 1),
    })).toThrow();
    expect(() => protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      ...ready,
      signerEvidence: [{ kind: "task_runtime_signer_certificate",
        evidenceBytesBase64url: "Y2VydGlmaWNhdGU" }],
    })).toThrow();
    const taskAuthorizationEvidence = {
      kind: "task_definition_foreground_authorization" as const,
      evidenceBytesBase64url: "YXV0aG9yaXphdGlvbg",
    };
    const foregroundParentEvidence = {
      kind: "foreground_agent_accepted_execution" as const,
      planBytesBase64url: "cGFyZW50",
      planDigestBase64url: "A".repeat(43),
    };
    expect(protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      ...ready,
      signerEvidence: [foregroundParentEvidence, taskAuthorizationEvidence],
    }).status).toBe("ready");
    expect(() => protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      ...ready,
      signerEvidence: [taskAuthorizationEvidence],
    })).toThrow();
    expect(() => protectedTaskRunResultReadEnvelopeV1Schema.parse({
      readVersion: 1,
      status: "ready",
      taskId: TASK_ID,
      taskRunId: TASK_RUN_ID,
      objectId: protectedSummary.content.objectId,
      resultRevision: 1,
      cryptoAccessRevision: 0,
      namespaceId: NAMESPACE_ID,
      readAuthority,
      encryptedPayloadBytesBase64url: "Y2lwaGVy",
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      accessManifestProofBytesBase64url: [],
      namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
      signerEvidence: [foregroundParentEvidence, taskAuthorizationEvidence],
    })).toThrow();
    for (const authority of [
      undefined,
      { ...readAuthority, namespaceId: TASK_ID },
      { ...readAuthority, currentGeneration: 3 },
      { ...readAuthority, retainedGenerations: [...readAuthority.retainedGenerations].reverse() },
      { ...readAuthority, retainedGenerations: [...readAuthority.retainedGenerations, readAuthority.retainedGenerations[1]] },
    ]) {
      expect(() => protectedTaskDefinitionReadEnvelopeV1Schema.parse({
        ...ready, readAuthority: authority,
      })).toThrow();
    }
    const historical = {
      ...ready,
      accessManifestProofBytesBase64url: [] as [],
      historicalRepair,
      signerEvidence: [{
        kind: "human_device" as const,
        subjectHumanId: TASK_ID,
        committerDeviceId: historicalRepair.publisherDeviceId,
        hostAuthorizationRevision: 3,
        signingPublicKeyBase64url: "A".repeat(43),
      }],
    };
    expect(protectedTaskDefinitionReadEnvelopeV1Schema.parse(historical))
      .toEqual(historical);
    expect(() => protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      ...historical,
      historicalRepair: { ...historicalRepair, genesisManifestHash: "g".repeat(64) },
    })).toThrow();
    expect(protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      ...ready,
      cryptoAccessRevision: 1,
      accessManifestProofBytesBase64url: ["YQ"],
    }).cryptoAccessRevision).toBe(1);
    expect(protectedTaskDefinitionReadEnvelopeV1Schema.parse({
      ...ready,
      cryptoAccessRevision: 257,
      accessManifestProofBytesBase64url: Array.from(
        { length: 257 },
        () => "YQ",
      ),
    }).cryptoAccessRevision).toBe(257);
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
