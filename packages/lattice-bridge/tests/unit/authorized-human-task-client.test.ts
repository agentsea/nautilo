import { describe, expect, test } from "bun:test";
import type {
  DualTaskPreparedCreateRequestV1,
  DualTaskPreparedUpdateRequestV1,
  TaskOrdinaryFallbackCreatePlanV1,
  TaskOrdinaryFallbackPreparedCreateRequestV1,
  TaskOrdinaryFallbackPreparedUpdateRequestV1,
  TaskOrdinaryFallbackUpdatePlanV1,
  NautiloApiClient,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
} from "@nautilo/api-client/browser";
import type { TaskContentSummaryV1 } from "@nautilo/types";

import {
  createAuthorizedHumanTaskClientV1,
  type HumanTaskDeviceContentPortV1,
  type HumanTaskPreparedJournalV1,
  type HumanTaskPublicationPlansV1,
  type HumanTaskOrdinaryPublicationPortV1,
  type TaskDefinitionPublicationPlanV1,
  type TaskDefinitionReadEnvelopeV1,
} from "../../src/client/task/authorized-human-task-client.ts";
import {
  encodeTaskDefinitionContentV2,
  encodeTaskPayloadV1,
} from "../../src/task/task-payload-v1.ts";
import { deriveTaskHistoricalContentCryptoObjectIdV1 } from
  "../../src/task/task-historical-content-identity.ts";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
} from "../../src/transition/encryption-data-operation-owner.ts";

const taskId = "11111111-1111-4111-8111-111111111111";
const objectId = "task-object";
const agentId = "22222222-2222-4222-8222-222222222222";

function owner(
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only" = "encrypted_only",
  shadowBehavior: "fallback" | "strict" = "strict",
) {
  return bindEncryptionDataOperationOwner({
    policy: {
      async resolve() {
        return {
          policy: { mode, shadowBehavior },
          revalidationToken: 1,
        };
      },
      async revalidate(token) {
        expect(token).toBe(1);
      },
    },
  });
}

const summary = {
  id: taskId,
  agentId,
  status: "pending",
  content: {
    dtoVersion: 1,
    status: "protected",
    objectId,
    contentRevision: 1,
    cryptoAccessRevision: 0,
  },
} as TaskContentSummaryV1;

function readEnvelope(): TaskDefinitionReadEnvelopeV1 {
  return {
    readVersion: 1,
    taskId,
    objectId,
    contentRevision: 1,
    cryptoAccessRevision: 0,
    namespaceId: "namespace",
    readAuthority: {
      sourceRoomId: "33333333-3333-4333-8333-333333333333",
      namespaceId: "namespace",
      currentGeneration: 0,
      retainedGenerations: [{
        generation: 0,
        accessRevision: 0,
        headDigestBase64url: "AQ",
        publicationDigestBase64url: "Ag",
        publicationSetDigestBase64url: "Aw",
        audienceFingerprintBase64url: "BA",
      }],
    },
    encryptedPayloadBytes: new Uint8Array([1, 2]),
    accessManifestBytes: new Uint8Array([3]),
    accessManifestProofBytes: [],
    namespaceEnvelopeBytes: new Uint8Array([5]),
    signerEvidence: [],
  };
}

function publicationPlan(operation: "create" | "update"): TaskDefinitionPublicationPlanV1 {
  const update = operation === "update";
  return {
    planVersion: 1,
    operation,
    operationId: "operation",
    taskId,
    expectedContentRevision: update ? 1 : 0,
    nextContentRevision: update ? 2 : 1,
    expectedCryptoAccessRevision: update ? 1 : 0,
    planDigestBase64url: "digest",
    authority: {
      requesterHumanId: "human",
      sourceRoomId: "room",
      namespaceId: "namespace",
      domainId: "domain",
      expectedAccessRevision: 1,
      expectedPolicyRevision: 1,
      bindingHashBase64url: "binding",
      keyGeneration: 1,
    },
  };
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function dualCreateRequest(): DualTaskPreparedCreateRequestV1 {
  return {
    operation: "create",
    operationId: "operation",
    taskId,
    expectedContentRevision: 0,
    nextContentRevision: 1,
    expectedCryptoAccessRevision: 0,
    planDigestBase64url: "digest",
    requiredNamespaceIds: ["namespace"],
    namespaceEnvelopes: [{ namespaceId: "namespace" }],
    representation: "dual",
    ordinaryPayloadBytesBase64url: "payload",
  } as DualTaskPreparedCreateRequestV1;
}

function dualUpdateRequest(): DualTaskPreparedUpdateRequestV1 {
  return {
    ...dualCreateRequest(),
    operation: "update",
    expectedContentRevision: 1,
    nextContentRevision: 2,
    expectedCryptoAccessRevision: 1,
  } as DualTaskPreparedUpdateRequestV1;
}

function fallbackCreatePlan(): TaskOrdinaryFallbackCreatePlanV1 {
  return {
    formatVersion: 1,
    purpose: "task.ordinary_fallback.create",
    reason: "target_encryption_not_ready",
    operationId: "operation",
    taskId,
    sourceDigestBase64url: "A".repeat(43),
    operationalFieldsDigestBase64url: "B".repeat(43),
    expectedContentRevision: 0,
    expectedCryptoAccessRevision: 0,
    expectedUpdatedAt: null,
    policyRevision: 3,
    subjectHumanId: "human",
    committerDeviceId: "device",
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: 2,
    planIssuedAt: 1,
    planDeadlineAt: 30_001,
    planDigestBase64url: "C".repeat(43),
  };
}

function fallbackCreateRequest(): TaskOrdinaryFallbackPreparedCreateRequestV1 {
  return {
    requestVersion: 1,
    representation: "ordinary_fallback",
    operationId: "operation",
    taskId,
    authenticatedRequestDigestBase64url: "D".repeat(43),
    ordinaryPayloadBytesBase64url: "cGF5bG9hZA",
    signedOrdinaryFallbackRequestBytesBase64url: "c2lnbmVk",
    task: {},
  };
}

function fallbackUpdatePlan(): TaskOrdinaryFallbackUpdatePlanV1 {
  return {
    ...fallbackCreatePlan(),
    purpose: "task.ordinary_fallback.update",
    expectedUpdatedAt: "2026-10-19T10:11:12.345Z",
  };
}

function fallbackUpdateRequest(): TaskOrdinaryFallbackPreparedUpdateRequestV1 {
  return { ...fallbackCreateRequest(), task: {} };
}

function client(input: {
  mode?: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  shadowBehavior?: "fallback" | "strict";
  api?: Partial<NautiloApiClient>;
  plans?: Partial<HumanTaskPublicationPlansV1>;
  content?: Partial<HumanTaskDeviceContentPortV1>;
  journal?: Partial<HumanTaskPreparedJournalV1>;
  ordinary?: HumanTaskOrdinaryPublicationPortV1;
  createOperationId?: () => string;
}) {
  return createAuthorizedHumanTaskClientV1({
    owner: owner(input.mode, input.shadowBehavior),
    api: input.api as NautiloApiClient,
    plans: input.plans as HumanTaskPublicationPlansV1,
    content: input.content as HumanTaskDeviceContentPortV1,
    journal: input.journal as HumanTaskPreparedJournalV1,
    ...(input.ordinary === undefined ? {} : { ordinary: input.ordinary }),
    createOperationId: input.createOperationId ?? (() => "operation"),
  });
}

describe("authorized Human Task client boundary", () => {
  test("Full list selects the protected-only projection", async () => {
    const events: string[] = [];
    const result = await client({
      api: {
        async listTaskContentV1() {
          events.push("mixed-list");
          throw new Error("Full must not load a mixed Task list");
        },
      },
      plans: {
        async listProtected() {
          events.push("protected-list");
          return [summary];
        },
      },
    }).list();
    expect(result).toEqual([summary]);
    expect(events).toEqual(["protected-list"]);
  });

  test("Full open consumes exact ciphertext only and wipes borrowed byte buffers", async () => {
    const calls: string[] = [];
    const envelope = readEnvelope();
    const openedBytes = encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "private prompt",
      expectedOutput: null,
      protectedMetadata: {},
    });
    const result = await client({
      api: {
        async getTaskContentV1() {
          calls.push("ordinary-detail");
          throw new Error("Full must not load ordinary Task content");
        },
      },
      plans: {
        async readExact(input) {
          calls.push("read-envelope");
          expect(input.reference.objectId).toBe(objectId);
          return envelope;
        },
      },
      content: {
        async openExact(input) {
          calls.push("device-open");
          expect(input.expectedAgentId).toBe(agentId);
          return openedBytes;
        },
      },
    }).open(summary);

    expect(result.content).toEqual({
      status: "protected",
      payload: {
        formatVersion: 1,
        prompt: "private prompt",
        expectedOutput: null,
        protectedMetadata: {},
      },
      retainedHistoricalError: null,
    });
    expect(calls).toEqual(["read-envelope", "device-open"]);
    expect(openedBytes.every((value) => value === 0)).toBe(true);
    expect(envelope.encryptedPayloadBytes.every((value) => value === 0)).toBe(true);
    expect(envelope.accessManifestBytes.every((value) => value === 0)).toBe(true);
    expect(envelope.accessManifestProofBytes).toHaveLength(0);
    expect(envelope.namespaceEnvelopeBytes.every((value) => value === 0)).toBe(true);
  });

  test("historical definition binds the source-derived object before device open", async () => {
    const namespaceId = "22222222-2222-4222-8222-222222222222";
    const sourceDigest = new Uint8Array(32).fill(0x31);
    const historicalObjectId = deriveTaskHistoricalContentCryptoObjectIdV1({
      coordinate: { kind: "definition", taskId, contentRevision: 1 },
      namespaceId,
      sourceDigest,
    });
    const historicalRepair = {
      version: 2 as const,
      claimId: "33333333-3333-4333-8333-333333333333",
      publisherDeviceId: "historical-device.1",
      signedRequestDigest: "11".repeat(32),
      sourceDigest: Buffer.from(sourceDigest).toString("hex"),
      sourcePayloadHash: "22".repeat(32),
      sourceRevision: 0 as const,
      genesisManifestHash: "33".repeat(32),
    };
    const historicalSummary = {
      ...summary,
      content: { ...summary.content, objectId: historicalObjectId },
    } as TaskContentSummaryV1;
    let opens = 0;
    const makeEnvelope = (): TaskDefinitionReadEnvelopeV1 => ({
      ...readEnvelope(),
      objectId: historicalObjectId,
      namespaceId,
      historicalRepair,
      signerEvidence: [{
        kind: "human_device",
        subjectHumanId: "human",
        committerDeviceId: historicalRepair.publisherDeviceId,
      }],
    });
    const opened = encodeTaskDefinitionContentV2({
      formatVersion: 2, prompt: "historical", expectedOutput: null,
      protectedMetadata: {}, retainedHistoricalError: "provider unavailable",
    });
    expect(await client({
      plans: { readExact: () => Promise.resolve(makeEnvelope()) },
      content: { openExact: () => {
        opens += 1;
        return Promise.resolve(opened);
      } },
    }).open(historicalSummary)).toMatchObject({
      content: {
        status: "protected",
        payload: { prompt: "historical" },
        retainedHistoricalError: "provider unavailable",
      },
    });
    expect(opens).toBe(1);

    for (const patch of [
      { historicalRepair: { ...historicalRepair, sourceDigest: "44".repeat(32) } },
      { signerEvidence: [] },
    ]) {
      const attempted = client({
        plans: { readExact: () => Promise.resolve({ ...makeEnvelope(), ...patch }) },
        content: { openExact: () => {
          opens += 1;
          throw new Error("substitution reached device");
        } },
      });
      await attempted.open(historicalSummary).then(
        () => { throw new Error("historical definition substitution was accepted"); },
        error => expect(error).toBeInstanceOf(ClassifiedDataOperationError),
      );
    }
    expect(opens).toBe(1);
  });

  test("substituted read coordinates stop before device open and wipe the response", async () => {
    const envelope = { ...readEnvelope(), contentRevision: 2 };
    let opened = false;
    const error = await client({
      plans: { async readExact() { return envelope; } },
      content: { async openExact() { opened = true; throw new Error("unexpected"); } },
    }).open(summary).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect((error as ClassifiedDataOperationError).failureClass).toBe("integrity");
    expect(opened).toBe(false);
    expect(envelope.encryptedPayloadBytes.every((value) => value === 0)).toBe(true);
  });

  test("Shadow open repairs one stale Dual revision from the exact plan payload and opens the verified successor", async () => {
    const stale = {
      ...summary,
      content: {
        dtoVersion: 1,
        status: "ordinary",
        promptPreview: "stale preview",
        lastError: "stale error",
      },
    } as TaskContentSummaryV1;
    const repaired = {
      ...summary,
      content: {
        ...summary.content,
        objectId: "repaired-object",
        contentRevision: 2,
        cryptoAccessRevision: 0,
      },
    } as TaskContentSummaryV1;
    const definition = {
      formatVersion: 2 as const,
      prompt: "complete source prompt",
      expectedOutput: "complete source output",
      protectedMetadata: {
        instructions: "retain metadata",
        execution: { workingDirectory: "/workspace/task" },
      },
      retainedHistoricalError: "retained source error",
    };
    const repairBytes = encodeTaskDefinitionContentV2(definition);
    const repairPayload = base64url(repairBytes);
    repairBytes.fill(0);
    const events: string[] = [];
    let retained: Parameters<HumanTaskPreparedJournalV1["putBeforeSend"]>[0]
      | undefined;
    let operationIds = 0;
    const opened = await client({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      createOperationId: () => {
        operationIds += 1;
        return "operation";
      },
      plans: {
        async update(input) {
          events.push(`plan:${input.operationId}`);
          expect(input.current).toBe(stale);
          expect(input.task).toEqual({});
          return {
            ...publicationPlan("update"),
            ordinaryRepairPayloadBase64url: repairPayload,
          };
        },
        async readExact({ reference }) {
          events.push(`read:${reference.contentRevision}`);
          expect(reference).toEqual({
            dtoVersion: 1,
            status: "protected",
            objectId: "repaired-object",
            contentRevision: 2,
            cryptoAccessRevision: 0,
          });
          return {
            ...readEnvelope(),
            objectId: "repaired-object",
            contentRevision: 2,
          };
        },
      },
      content: {
        async prepareDualUpdate(input) {
          events.push("prepare");
          expect(input.task).toEqual({});
          expect(input.payload).toEqual(definition);
          return dualUpdateRequest();
        },
        async openExact() {
          events.push("open");
          return encodeTaskDefinitionContentV2(definition);
        },
      },
      journal: {
        async putBeforeSend(mutation) {
          events.push("journal");
          retained = mutation;
          return { status: "inserted", index: {
            operationId: "operation",
            authenticatedRequestDigestBase64url: "request-digest",
          } as never };
        },
        async withPrepared(operationId, use) {
          events.push(`unseal:${operationId}`);
          return use(retained!);
        },
        async recordOutcome({ outcome }) { events.push(`outcome:${outcome}`); },
      },
      api: {
        async getTaskContentV1() {
          throw new Error("Repair must not load the incomplete ordinary detail");
        },
        async updateDualPreparedTaskV1(sentTaskId, request) {
          events.push(`send:${request.operationId}`);
          expect(sentTaskId).toBe(taskId);
          return repaired;
        },
      },
    }).open(stale);
    expect(opened).toEqual({
      task: repaired,
      content: {
        status: "protected",
        payload: {
          formatVersion: 1,
          prompt: definition.prompt,
          expectedOutput: definition.expectedOutput,
          protectedMetadata: definition.protectedMetadata,
        },
        retainedHistoricalError: definition.retainedHistoricalError,
      },
    });
    expect(operationIds).toBe(1);
    expect(events).toEqual([
      "plan:operation", "prepare", "journal", "unseal:operation",
      "send:operation", "outcome:completed", "read:2", "open",
    ]);
  });

  test.each(["stale", "authority"] as const)(
    "Shadow repair propagates a %s plan denial before preparation or journaling",
    async failureClass => {
      const events: string[] = [];
      const stale = { ...summary, content: { dtoVersion: 1, status: "ordinary",
        promptPreview: "stale", lastError: null } } as TaskContentSummaryV1;
      const error = await client({
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        plans: { async update() {
          events.push("plan");
          throw new ClassifiedDataOperationError(failureClass, "repair denied");
        } },
        content: { async prepareDualUpdate() {
          events.push("prepare");
          throw new Error("unreachable");
        } },
        journal: { async putBeforeSend() {
          events.push("journal");
          throw new Error("unreachable");
        } },
        api: { async getTaskContentV1() {
          events.push("ordinary");
          throw new Error("unreachable");
        } },
      }).open(stale).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ClassifiedDataOperationError);
      expect((error as ClassifiedDataOperationError).failureClass)
        .toBe(failureClass);
      expect(events).toEqual(["plan"]);
    },
  );

  test.each([
    ["noncanonical base64url", "bm90LWpzb24="],
    ["invalid Task JSON", "bm90LWpzb24"],
  ])("Shadow repair rejects present %s as integrity before Device or fallback", async (_label, ordinaryRepairPayloadBase64url) => {
    const events: string[] = [];
    const stale = { ...summary, content: { dtoVersion: 1, status: "ordinary",
      promptPreview: "stale", lastError: null } } as TaskContentSummaryV1;
    const error = await client({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      plans: { async update() {
        events.push("plan");
        return { ...publicationPlan("update"), ordinaryRepairPayloadBase64url };
      } },
      content: { async prepareDualUpdate() {
        events.push("prepare");
        throw new Error("unreachable");
      } },
      journal: { async putBeforeSend() {
        events.push("journal");
        throw new Error("unreachable");
      } },
      api: { async getTaskContentV1() {
        events.push("ordinary");
        throw new Error("unreachable");
      }, async updateDualPreparedTaskV1() {
        events.push("send");
        throw new Error("unreachable");
      } },
    }).open(stale).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect((error as ClassifiedDataOperationError).failureClass)
      .toBe("integrity");
    expect(events).toEqual(["plan"]);
  });

  test("Plain opens one legacy detail without repair while Full neither repairs nor reads ordinary", async () => {
    const stale = { ...summary, content: { dtoVersion: 1, status: "ordinary",
      promptPreview: "stale", lastError: null } } as TaskContentSummaryV1;
    const plainEvents: string[] = [];
    const plain = await client({
      mode: "plaintext_only",
      api: { async getTaskContentV1() {
        plainEvents.push("ordinary");
        return { task: stale, definition: { dtoVersion: 1, status: "ordinary",
          prompt: "plain", expectedOutput: null, lastError: null }, runs: [] } as never;
      } },
      plans: { async update() { plainEvents.push("plan"); throw new Error("unreachable"); } },
      content: { async prepareDualUpdate() { plainEvents.push("crypto"); throw new Error("unreachable"); } },
    }).open(stale);
    expect(plain.content).toMatchObject({ status: "ordinary", prompt: "plain" });
    expect(plainEvents).toEqual(["ordinary"]);

    const fullEvents: string[] = [];
    const fullError = await client({
      mode: "encrypted_only",
      api: { async getTaskContentV1() { fullEvents.push("ordinary"); throw new Error("unreachable"); } },
      plans: { async update() { fullEvents.push("plan"); throw new Error("unreachable"); } },
      content: { async prepareDualUpdate() { fullEvents.push("crypto"); throw new Error("unreachable"); } },
    }).open(stale).catch((cause: unknown) => cause);
    expect(fullError).toBeInstanceOf(ClassifiedDataOperationError);
    expect((fullError as ClassifiedDataOperationError).failureClass)
      .toBe("recoverable_availability");
    expect(fullEvents).toEqual([]);
  });

  test("Fallback Shadow returns the ordinary definition when an eligible unavailable summary has no repair payload", async () => {
    const unavailable = { ...summary, content: { dtoVersion: 1,
      status: "unavailable", reason: "device_not_ready" } } as TaskContentSummaryV1;
    const events: string[] = [];
    const opened = await client({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      plans: { async update() {
        events.push("plan");
        return publicationPlan("update");
      } },
      api: { async getTaskContentV1() {
        events.push("ordinary");
        return { task: unavailable, definition: { dtoVersion: 1,
          status: "ordinary", prompt: "fallback source", expectedOutput: null,
          lastError: "waiting" }, runs: [] } as never;
      } },
      content: { async prepareDualUpdate() {
        events.push("crypto");
        throw new Error("unreachable");
      } },
      journal: { async putBeforeSend() {
        events.push("journal");
        throw new Error("unreachable");
      } },
    }).open(unavailable);
    expect(opened.content).toEqual({ status: "ordinary",
      prompt: "fallback source", expectedOutput: null, lastError: "waiting" });
    expect(events).toEqual(["plan", "ordinary"]);
  });

  test.each(["completed", "cancelled"] as const)(
    "Strict Shadow leaves a %s unavailable Task immutable",
    async status => {
      const terminal = {
        ...summary,
        status,
        content: {
          dtoVersion: 1,
          status: "unavailable",
          reason: "device_not_ready",
        },
      } as TaskContentSummaryV1;
      const events: string[] = [];
      const error = await client({
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        plans: { async update() {
          events.push("plan");
          throw new Error("Terminal Task must not request an update plan");
        } },
        api: { async getTaskContentV1() {
          events.push("ordinary");
          throw new Error("Strict Shadow must not read ordinary Task content");
        } },
        content: { async prepareDualUpdate() {
          events.push("prepare");
          throw new Error("Terminal Task must not prepare a mutation");
        } },
        journal: { async putBeforeSend() {
          events.push("journal");
          throw new Error("Terminal Task must not journal a mutation");
        } },
      }).open(terminal).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ClassifiedDataOperationError);
      expect((error as ClassifiedDataOperationError).failureClass)
        .toBe("key_waiting");
      expect(events).toEqual([]);
    },
  );

  test("Paused unavailable Tasks retain the authorized forward-repair path", async () => {
    const paused = {
      ...summary,
      status: "paused",
      content: {
        dtoVersion: 1,
        status: "unavailable",
        reason: "device_not_ready",
      },
    } as TaskContentSummaryV1;
    const events: string[] = [];
    const error = await client({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      plans: { async update() {
        events.push("plan");
        return publicationPlan("update");
      } },
    }).open(paused).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect((error as ClassifiedDataOperationError).failureClass)
      .toBe("recoverable_availability");
    expect(events).toEqual(["plan"]);
  });

  test.each(["fallback", "strict"] as const)(
    "%s Shadow create and update each journal one dual request and send once",
    async (shadowBehavior) => {
      const events: string[] = [];
      let retained: Parameters<HumanTaskPreparedJournalV1["putBeforeSend"]>[0] | undefined;
      const taskClient = client({
        mode: "shadow_encryption",
        shadowBehavior,
        plans: {
          async create() { events.push("plan:create"); return publicationPlan("create"); },
          async update() { events.push("plan:update"); return publicationPlan("update"); },
          async readExact() { events.push("read:update"); return readEnvelope(); },
        },
        content: {
          async prepareDualCreate() {
            events.push("prepare:create");
            return dualCreateRequest();
          },
          async prepareDualUpdate() {
            events.push("prepare:update");
            return dualUpdateRequest();
          },
          async openExact() {
            events.push("open:update");
            return encodeTaskPayloadV1({
              formatVersion: 1, prompt: "old", expectedOutput: null,
              protectedMetadata: {},
            });
          },
        },
        journal: {
          async putBeforeSend(mutation) {
            events.push(`journal:${mutation.kind}`);
            retained = mutation;
            return { status: "inserted", index: {
              operationId: "operation",
              authenticatedRequestDigestBase64url: "request-digest",
            } as never };
          },
          async withPrepared(_operationId, use) {
            events.push("unseal");
            return use(retained!);
          },
          async recordOutcome(input) { events.push(`outcome:${input.outcome}`); },
        },
        api: {
          async createDualPreparedTaskV1(request) {
            events.push("send:dual-create");
            expect(request.representation).toBe("dual");
            return { taskId, status: "pending", nextFireAt: null };
          },
          async updateDualPreparedTaskV1(_taskId, request) {
            events.push("send:dual-update");
            expect(request.representation).toBe("dual");
            return { ...summary, content: { ...summary.content, contentRevision: 2 } };
          },
          async createPreparedTaskV1() { throw new Error("split protected create"); },
          async updatePreparedTaskV1() { throw new Error("split protected update"); },
        },
        ordinary: {
          async create() { throw new Error("split ordinary create"); },
          async update() { throw new Error("split ordinary update"); },
        },
      });
      const payload = {
        formatVersion: 1 as const,
        prompt: "private prompt",
        expectedOutput: null,
        protectedMetadata: {},
      };
      expect((await taskClient.create({ payload, task: {} })).taskId).toBe(taskId);
      expect((await taskClient.update(summary, { payload, task: {} })).content)
        .toMatchObject({ status: "protected", contentRevision: 2 });
      expect(events).toEqual([
        "plan:create", "prepare:create", "journal:task_create", "unseal",
        "send:dual-create", "outcome:completed",
        "read:update", "open:update", "plan:update", "prepare:update", "journal:task_update", "unseal",
        "send:dual-update", "outcome:completed",
      ]);
    },
  );

  test.each([
    ["encrypted_only", "protected"],
    ["shadow_encryption", "dual"],
  ] as const)(
    "%s updates carry an authenticated V2 display snapshot through revisions 2 and 3",
    async (mode, representation) => {
      const carried: unknown[] = [];
      let retained: Parameters<HumanTaskPreparedJournalV1["putBeforeSend"]>[0] | undefined;
      let currentPrompt = "historical";
      const currentBytes = () => encodeTaskDefinitionContentV2({
        formatVersion: 2,
        prompt: currentPrompt,
        expectedOutput: null,
        protectedMetadata: {},
        retainedHistoricalError: "provider unavailable",
      });
      const taskClient = client({
        mode,
        plans: {
          async readExact({ reference }) {
            return {
              ...readEnvelope(),
              objectId: reference.objectId,
              contentRevision: reference.contentRevision,
              cryptoAccessRevision: reference.cryptoAccessRevision,
            };
          },
          async update({ current }) {
            const expected = current.content.status === "protected"
              ? current.content.contentRevision : 0;
            return {
              ...publicationPlan("update"),
              expectedContentRevision: expected,
              nextContentRevision: expected + 1,
              expectedCryptoAccessRevision: current.content.status === "protected"
                ? current.content.cryptoAccessRevision : 0,
            };
          },
        },
        content: {
          async openExact() { return currentBytes(); },
          async prepareUpdate(input) {
            carried.push(input.payload);
            const dual = dualUpdateRequest();
            const { representation: _representation,
              ordinaryPayloadBytesBase64url: _ordinary, ...request } = dual;
            return {
              ...request,
              expectedContentRevision: input.plan.expectedContentRevision,
              nextContentRevision: input.plan.nextContentRevision,
              expectedCryptoAccessRevision: input.plan.expectedCryptoAccessRevision,
            } as ProtectedTaskPreparedUpdateRequestV1;
          },
          async prepareDualUpdate(input) {
            carried.push(input.payload);
            return {
              ...dualUpdateRequest(),
              expectedContentRevision: input.plan.expectedContentRevision,
              nextContentRevision: input.plan.nextContentRevision,
              expectedCryptoAccessRevision: input.plan.expectedCryptoAccessRevision,
            };
          },
        },
        journal: {
          async putBeforeSend(mutation) {
            retained = mutation;
            return { status: "inserted", index: { operationId: "operation",
              authenticatedRequestDigestBase64url: "digest" } as never };
          },
          async withPrepared(_operationId, use) { return use(retained!); },
          async recordOutcome() {},
        },
        api: {
          async updatePreparedTaskV1(_taskId, request) {
            expect(representation).toBe("protected");
            return { ...summary, content: { ...summary.content,
              contentRevision: request.nextContentRevision } };
          },
          async updateDualPreparedTaskV1(_taskId, request) {
            expect(representation).toBe("dual");
            return { ...summary, content: { ...summary.content,
              contentRevision: request.nextContentRevision } };
          },
        },
      });
      const edit = (prompt: string) => ({
        payload: { formatVersion: 1 as const, prompt, expectedOutput: null,
          protectedMetadata: {} },
        task: {},
      });
      const revision2 = await taskClient.update(summary, edit("revision 2"));
      currentPrompt = "revision 2";
      const revision3 = await taskClient.update(revision2, edit("revision 3"));
      expect(revision3.content).toMatchObject({ contentRevision: 3 });
      expect(carried).toEqual([
        { formatVersion: 2, prompt: "revision 2", expectedOutput: null,
          protectedMetadata: {}, retainedHistoricalError: "provider unavailable" },
        { formatVersion: 2, prompt: "revision 3", expectedOutput: null,
          protectedMetadata: {}, retainedHistoricalError: "provider unavailable" },
      ]);
    },
  );

  test("protected update stops before planning or publication when current content cannot open", async () => {
    const events: string[] = [];
    const error = await client({
      mode: "encrypted_only",
      plans: {
        async readExact() {
          events.push("read-current");
          throw new ClassifiedDataOperationError(
            "key_waiting",
            "Current Task definition key is unavailable",
          );
        },
        async update() {
          events.push("plan-update");
          return publicationPlan("update");
        },
      },
      content: {
        async prepareUpdate() {
          events.push("prepare-update");
          throw new Error("prepare must remain unreachable");
        },
      },
      api: {
        async updatePreparedTaskV1() {
          events.push("publish-update");
          return summary;
        },
      },
    }).update(summary, {
      payload: {
        formatVersion: 1,
        prompt: "edited",
        expectedOutput: null,
        protectedMetadata: {},
      },
      task: {},
    }).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect((error as ClassifiedDataOperationError).failureClass).toBe("key_waiting");
    expect(events).toEqual(["read-current"]);
  });

  test("Fallback Shadow selects ordinary only after recoverable pre-send dual preparation failure", async () => {
    const events: string[] = [];
    const response = await client({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      plans: { async create() { events.push("plan"); return publicationPlan("create"); } },
      content: {
        async prepareDualCreate() {
          events.push("prepare:dual");
          throw new ClassifiedDataOperationError("key_waiting", "key unavailable");
        },
      },
      journal: { async putBeforeSend() { events.push("journal"); throw new Error("unexpected"); } },
      ordinary: {
        async create({ payload }) {
          events.push(`ordinary:${payload.prompt}`);
          return { taskId, status: "pending", nextFireAt: null };
        },
        async update() { throw new Error("unexpected"); },
      },
    }).create({
      payload: { formatVersion: 1, prompt: "private prompt", expectedOutput: null,
        protectedMetadata: {} },
      task: {},
    });
    expect(response.taskId).toBe(taskId);
    expect(events).toEqual(["plan", "prepare:dual", "ordinary:private prompt"]);
  });

  test("Fallback Shadow journals and publishes a signed Task fallback when available", async () => {
    const events: string[] = [];
    let retained: Parameters<HumanTaskPreparedJournalV1["putBeforeSend"]>[0]
      | undefined;
    const response = await client({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      plans: {
        async create() {
          events.push("plan:protected");
          return publicationPlan("create");
        },
        async ordinaryFallbackCreate({ operationId }) {
          events.push(`plan:fallback:${operationId}`);
          return fallbackCreatePlan();
        },
      },
      content: {
        async prepareDualCreate() {
          events.push("prepare:dual");
          throw new ClassifiedDataOperationError("key_waiting", "key unavailable");
        },
        async prepareOrdinaryFallbackCreate({ plan }) {
          events.push(`prepare:fallback:${plan.operationId}`);
          return fallbackCreateRequest();
        },
      },
      journal: {
        async putBeforeSend(mutation) {
          retained = mutation;
          events.push("journal");
          return { status: "inserted", index: {
            operationId: mutation.request.operationId,
            authenticatedRequestDigestBase64url: "D".repeat(43),
          } as never };
        },
        async withPrepared(_operationId, use) { return use(retained!); },
        async recordOutcome({ outcome }) { events.push(`outcome:${outcome}`); },
      },
      api: {
        async createTaskOrdinaryFallbackV1(request) {
          events.push(`publish:${request.operationId}`);
          return { taskId, status: "pending", nextFireAt: null };
        },
      },
    }).create({
      payload: {
        formatVersion: 1,
        prompt: "private prompt",
        expectedOutput: null,
        protectedMetadata: {},
      },
      task: {},
    });
    expect(response.taskId).toBe(taskId);
    expect(events).toEqual([
      "plan:protected",
      "prepare:dual",
      "plan:fallback:operation",
      "prepare:fallback:operation",
      "journal",
      "publish:operation",
      "outcome:completed",
    ]);
  });

  test("Fallback create rejects a plan for another operation before Device preparation", async () => {
    let prepared = false;
    const error = await client({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      plans: {
        async create() { return publicationPlan("create"); },
        async ordinaryFallbackCreate() {
          return { ...fallbackCreatePlan(), operationId: "substituted" };
        },
      },
      content: {
        async prepareDualCreate() {
          throw new ClassifiedDataOperationError("key_waiting", "key unavailable");
        },
        async prepareOrdinaryFallbackCreate() {
          prepared = true;
          throw new Error("substituted plan reached Device preparation");
        },
      },
    }).create({
      payload: { formatVersion: 1, prompt: "private prompt", expectedOutput: null,
        protectedMetadata: {} },
      task: {},
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect((error as ClassifiedDataOperationError).failureClass).toBe("integrity");
    expect(prepared).toBe(false);
  });

  test("a receipt-backed ordinary sibling can take the normal signed dual update path", async () => {
    const ordinary = { ...summary, content: { dtoVersion: 1, status: "ordinary", promptPreview: "old", lastError: "prior error" } } as TaskContentSummaryV1;
    let retained: Parameters<HumanTaskPreparedJournalV1["putBeforeSend"]>[0] | undefined;
    let actualPayload: unknown;
    const result = await client({ mode: "shadow_encryption", shadowBehavior: "fallback",
      api: {
        async getTaskContentV1() { return { task: ordinary, definition: {
          dtoVersion: 1, status: "ordinary", prompt: "old", expectedOutput: null, lastError: "prior error",
        }, runs: [] } as never; },
        async updateDualPreparedTaskV1() { return { ...summary,
          content: { ...summary.content, contentRevision: 2 } }; },
        async updateTaskOrdinaryFallbackV1() { throw new Error("Repair must not record another fallback"); },
      },
      plans: { async update() { return publicationPlan("update"); } },
      content: {
        async prepareDualUpdate({ payload }) { actualPayload = payload; return dualUpdateRequest(); },
        async openExact() { throw new Error("Stale encrypted content must not be used as the new definition"); },
      },
      journal: {
        async putBeforeSend(mutation) { retained = mutation; return { status: "inserted", index: {
          operationId: "operation", authenticatedRequestDigestBase64url: "request-digest",
        } as never }; },
        async withPrepared(_id, use) { return use(retained!); },
        async recordOutcome() {},
      },
    }).update(ordinary, { payload: { formatVersion: 1, prompt: "edited", expectedOutput: null,
      protectedMetadata: { instructions: "Retain this complete supplied metadata" } }, task: {} });
    expect(result.content).toMatchObject({ status: "protected", contentRevision: 2 });
    expect(actualPayload).toMatchObject({ formatVersion: 2, prompt: "edited", retainedHistoricalError: "prior error",
      protectedMetadata: { instructions: "Retain this complete supplied metadata" } });
  });

  test("Fallback update alone loads an ordinary rev0 source and retains its error", async () => {
    const ordinarySummary = {
      ...summary,
      content: {
        dtoVersion: 1,
        status: "ordinary",
        promptPreview: "old",
        lastError: "retained failure",
      },
    } as TaskContentSummaryV1;
    let retained: Parameters<HumanTaskPreparedJournalV1["putBeforeSend"]>[0]
      | undefined;
    let preparedPayload: unknown;
    const result = await client({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      api: {
        async getTaskContentV1() {
          return {
            task: ordinarySummary,
            definition: {
              dtoVersion: 1,
              status: "ordinary",
              prompt: "old",
              expectedOutput: null,
              lastError: "retained failure",
            },
            runs: [],
          } as never;
        },
        async updateTaskOrdinaryFallbackV1() { return ordinarySummary; },
      },
      plans: {
        async update() { throw new ClassifiedDataOperationError("key_waiting", "Task counterpart awaiting repair"); },
        async ordinaryFallbackUpdate() { return fallbackUpdatePlan(); },
      },
      content: {
        async prepareOrdinaryFallbackUpdate({ payload }) {
          preparedPayload = payload;
          return fallbackUpdateRequest();
        },
      },
      journal: {
        async putBeforeSend(mutation) {
          retained = mutation;
          return { status: "inserted", index: {
            operationId: mutation.request.operationId,
            authenticatedRequestDigestBase64url: "D".repeat(43),
          } as never };
        },
        async withPrepared(_operationId, use) { return use(retained!); },
        async recordOutcome() {},
      },
    }).update(ordinarySummary, {
      payload: {
        formatVersion: 1,
        prompt: "edited",
        expectedOutput: null,
        protectedMetadata: {},
      },
      task: {},
    });
    expect(result).toBe(ordinarySummary);
    expect(preparedPayload).toMatchObject({
      formatVersion: 2,
      prompt: "edited",
      retainedHistoricalError: "retained failure",
    });
  });

  test("Fallback update rejects substituted operation and Task coordinates before Device preparation", async () => {
    const ordinarySummary = {
      ...summary,
      content: { dtoVersion: 1, status: "ordinary", promptPreview: "old", lastError: null },
    } as TaskContentSummaryV1;
    for (const patch of [
      { operationId: "substituted" },
      { taskId: "44444444-4444-4444-8444-444444444444" },
    ]) {
      let prepared = false;
      const error = await client({
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        api: {
          async getTaskContentV1() {
            return { task: ordinarySummary, definition: {
              dtoVersion: 1, status: "ordinary", prompt: "old",
              expectedOutput: null, lastError: null,
            }, runs: [] } as never;
          },
        },
        plans: {
          async update() { throw new ClassifiedDataOperationError("key_waiting", "Task counterpart awaiting repair"); },
          async ordinaryFallbackUpdate() {
            return { ...fallbackUpdatePlan(), ...patch };
          },
        },
        content: {
          async prepareOrdinaryFallbackUpdate() {
            prepared = true;
            throw new Error("substituted plan reached Device preparation");
          },
        },
      }).update(ordinarySummary, {
        payload: { formatVersion: 1, prompt: "edited", expectedOutput: null,
          protectedMetadata: {} },
        task: {},
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ClassifiedDataOperationError);
      expect((error as ClassifiedDataOperationError).failureClass).toBe("integrity");
      expect(prepared).toBe(false);
    }
  });

  test("Strict Shadow rejects the same pre-send failure without ordinary publication", async () => {
    let ordinary = false;
    const error = await client({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      plans: { async create() { return publicationPlan("create"); } },
      content: { async prepareDualCreate() {
        throw new ClassifiedDataOperationError("key_waiting", "key unavailable");
      } },
      ordinary: {
        async create() { ordinary = true; throw new Error("unexpected"); },
        async update() { throw new Error("unexpected"); },
      },
    }).create({
      payload: { formatVersion: 1, prompt: "private prompt", expectedOutput: null,
        protectedMetadata: {} }, task: {},
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect(ordinary).toBe(false);
  });

  test("Fallback Shadow never calls ordinary publication after a dual send starts", async () => {
    let retained: Parameters<HumanTaskPreparedJournalV1["putBeforeSend"]>[0] | undefined;
    let ordinary = false;
    const error = await client({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      plans: { async create() { return publicationPlan("create"); } },
      content: { async prepareDualCreate() { return dualCreateRequest(); } },
      journal: {
        async putBeforeSend(mutation) {
          retained = mutation;
          return { status: "inserted", index: { operationId: "operation",
            authenticatedRequestDigestBase64url: "digest" } as never };
        },
        async withPrepared(_operationId, use) { return use(retained!); },
        async recordOutcome(input) { expect(input.outcome).toBe("retryable"); },
      },
      api: {
        async createDualPreparedTaskV1() {
          throw new ClassifiedDataOperationError(
            "recoverable_availability",
            "send outcome uncertain",
          );
        },
      },
      ordinary: {
        async create() { ordinary = true; throw new Error("unexpected"); },
        async update() { throw new Error("unexpected"); },
      },
    }).create({
      payload: { formatVersion: 1, prompt: "private prompt", expectedOutput: null,
        protectedMetadata: {} }, task: {},
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect(ordinary).toBe(false);
  });

  test("Fallback Shadow never calls ordinary update after a dual PATCH starts", async () => {
    let retained: Parameters<HumanTaskPreparedJournalV1["putBeforeSend"]>[0] | undefined;
    let ordinary = false;
    const error = await client({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      plans: {
        async update() { return publicationPlan("update"); },
        async readExact() { return readEnvelope(); },
      },
      content: {
        async openExact() {
          return encodeTaskPayloadV1({ formatVersion: 1, prompt: "old",
            expectedOutput: null, protectedMetadata: {} });
        },
        async prepareDualUpdate() { return dualUpdateRequest(); },
      },
      journal: {
        async putBeforeSend(mutation) {
          retained = mutation;
          return { status: "inserted", index: { operationId: "operation",
            authenticatedRequestDigestBase64url: "digest" } as never };
        },
        async withPrepared(_operationId, use) { return use(retained!); },
        async recordOutcome(input) { expect(input.outcome).toBe("retryable"); },
      },
      api: {
        async updateDualPreparedTaskV1() {
          throw new ClassifiedDataOperationError(
            "recoverable_availability",
            "PATCH outcome uncertain",
          );
        },
      },
      ordinary: {
        async create() { throw new Error("unexpected"); },
        async update() { ordinary = true; throw new Error("unexpected"); },
      },
    }).update(summary, {
      payload: { formatVersion: 1, prompt: "private prompt", expectedOutput: null,
        protectedMetadata: {} }, task: {},
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect(ordinary).toBe(false);
  });

  test("Full create journals prepared ciphertext before sending it", async () => {
    const events: string[] = [];
    const task = {} as never;
    const plan: TaskDefinitionPublicationPlanV1 = {
      planVersion: 1,
      operation: "create",
      operationId: "operation",
      taskId,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      expectedCryptoAccessRevision: 0,
      planDigestBase64url: "digest",
      authority: {
        requesterHumanId: "human",
        sourceRoomId: "room",
        namespaceId: "namespace",
        domainId: "domain",
        expectedAccessRevision: 1,
        expectedPolicyRevision: 1,
        bindingHashBase64url: "binding",
        keyGeneration: 1,
      },
    };
    const request = {
      operation: "create",
      operationId: "operation",
      taskId,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      expectedCryptoAccessRevision: 0,
      planDigestBase64url: "digest",
      requiredNamespaceIds: ["namespace"],
      namespaceEnvelopes: [{ namespaceId: "namespace" }],
    } as ProtectedTaskPreparedCreateRequestV1;
    const response = await client({
      plans: {
        async create() {
          events.push("plan");
          return plan;
        },
      },
      content: {
        async prepareCreate() {
          events.push("prepare");
          return request;
        },
      },
      journal: {
        async putBeforeSend() {
          events.push("journal");
          return {
            status: "inserted",
            index: {
              operationId: "operation",
              authenticatedRequestDigestBase64url: "request-digest",
            } as never,
          };
        },
        async withPrepared(_operationId, use) {
          events.push("unseal");
          return use({ kind: "task_create", taskId, request });
        },
        async recordOutcome(input) {
          events.push(`outcome:${input.outcome}`);
        },
      },
      api: {
        async createPreparedTaskV1() {
          events.push("send");
          return { taskId, status: "pending", nextFireAt: null };
        },
      },
    }).create({
      payload: {
        formatVersion: 1,
        prompt: "private prompt",
        expectedOutput: null,
        protectedMetadata: {},
      },
      task,
    });
    expect(response.taskId).toBe(taskId);
    expect(events).toEqual([
      "plan", "prepare", "journal", "unseal", "send", "outcome:completed",
    ]);
  });
});
