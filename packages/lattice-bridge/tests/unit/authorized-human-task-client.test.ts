import { describe, expect, test } from "bun:test";
import type {
  DualTaskPreparedCreateRequestV1,
  DualTaskPreparedUpdateRequestV1,
  NautiloApiClient,
  ProtectedTaskPreparedCreateRequestV1,
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
import { encodeTaskPayloadV1 } from "../../src/task/task-payload-v1.ts";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
} from "../../src/transition/encryption-data-operation-owner.ts";

const taskId = "11111111-1111-4111-8111-111111111111";
const objectId = "task-object";

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
    encryptedPayloadBytes: new Uint8Array([1, 2]),
    accessManifestBytes: new Uint8Array([3]),
    accessManifestProofBytes: [new Uint8Array([4])],
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

function client(input: {
  mode?: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  shadowBehavior?: "fallback" | "strict";
  api?: Partial<NautiloApiClient>;
  plans?: Partial<HumanTaskPublicationPlansV1>;
  content?: Partial<HumanTaskDeviceContentPortV1>;
  journal?: Partial<HumanTaskPreparedJournalV1>;
  ordinary?: HumanTaskOrdinaryPublicationPortV1;
}) {
  return createAuthorizedHumanTaskClientV1({
    owner: owner(input.mode, input.shadowBehavior),
    api: input.api as NautiloApiClient,
    plans: input.plans as HumanTaskPublicationPlansV1,
    content: input.content as HumanTaskDeviceContentPortV1,
    journal: input.journal as HumanTaskPreparedJournalV1,
    ...(input.ordinary === undefined ? {} : { ordinary: input.ordinary }),
    createOperationId: () => "operation",
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
        async openExact() {
          calls.push("device-open");
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
    });
    expect(calls).toEqual(["read-envelope", "device-open"]);
    expect(openedBytes.every((value) => value === 0)).toBe(true);
    expect(envelope.encryptedPayloadBytes.every((value) => value === 0)).toBe(true);
    expect(envelope.accessManifestBytes.every((value) => value === 0)).toBe(true);
    expect(envelope.accessManifestProofBytes[0]!.every((value) => value === 0)).toBe(true);
    expect(envelope.namespaceEnvelopeBytes.every((value) => value === 0)).toBe(true);
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
        "plan:update", "prepare:update", "journal:task_update", "unseal",
        "send:dual-update", "outcome:completed",
      ]);
    },
  );

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
      plans: { async update() { return publicationPlan("update"); } },
      content: { async prepareDualUpdate() { return dualUpdateRequest(); } },
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
