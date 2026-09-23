import { describe, expect, test } from "bun:test";
import { NautiloApiClient, type NautiloApiFetch } from "../../src/client.ts";
import type {
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
} from "../../src/schemas/protected-task.ts";

const TASK_ID = "91000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "91000000-0000-4000-8000-000000000002";
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

function prepared(): ProtectedTaskPreparedCreateRequestV1 {
  return {
    requestVersion: 1,
    operation: "create",
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
    namespaceEnvelopes: [{ namespaceId: NAMESPACE_ID, envelopeBytesBase64url: "ZW52ZWxvcGU" }],
    signedPublicationRequestBytesBase64url: "c2lnbmVk",
    task: { scheduleKind: "cron", cron: "0 9 * * *", timezone: "UTC" },
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("opt-in Task content API methods", () => {
  test("uses only explicit v1 endpoints and accepts content-free protected projections", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      const url = typeof target === "string" ? target
        : target instanceof URL ? target.href : target.url;
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/definition?")) return response({
        readVersion: 1, status: "ready", taskId: TASK_ID,
        objectId: protectedSummary.content.objectId,
        contentRevision: 1, cryptoAccessRevision: 0,
        namespaceId: NAMESPACE_ID,
        encryptedPayloadBytesBase64url: "Y2lwaGVy",
        accessManifestBytesBase64url: "bWFuaWZlc3Q",
        accessManifestProofBytesBase64url: [],
        namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
        signerEvidence: [{ kind: "human_device", subjectHumanId: NAMESPACE_ID,
          committerDeviceId: "device:one", hostAuthorizationRevision: 1,
          signingPublicKeyBase64url: "A".repeat(43) }],
      });
      if (url.endsWith("/publication-plan")) return response({
        planVersion: 1, operation: url.includes(`/${TASK_ID}/`) ? "update" : "create",
        operationId: "task:plan:one", taskId: TASK_ID,
        expectedContentRevision: url.includes(`/${TASK_ID}/`) ? 1 : 0,
        nextContentRevision: url.includes(`/${TASK_ID}/`) ? 2 : 1,
        expectedCryptoAccessRevision: 0, planDigestBase64url: "A".repeat(43),
        authority: { requesterHumanId: NAMESPACE_ID, sourceRoomId: NAMESPACE_ID,
          namespaceId: NAMESPACE_ID, domainId: "domain:one", expectedAccessRevision: 0,
          expectedPolicyRevision: 1, bindingHashBase64url: "A".repeat(43), keyGeneration: 1 },
      });
      if (method === "POST") return response({ taskId: TASK_ID, status: "pending", nextFireAt: null });
      if (method === "PATCH") return response(protectedSummary);
      if (url.endsWith(`/${TASK_ID}/content-v1`)) {
        const { content: definition, ...task } = protectedSummary;
        return response({
          task: {
            ...task, cron: null, runAt: null, timezone: "UTC", targetChat: "orphan",
            resultDelivery: "wake", useScope: false, scopeId: null,
            toolsMode: "all", toolsWhitelist: [], selectionProfile: "balanced",
            selectionSpec: null, requestedModelId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          definition,
          runs: [],
        });
      }
      return response([protectedSummary]);
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("session-token");

    expect((await client.listTaskContentV1({ includeTerminal: true }))[0]?.content.status)
      .toBe("protected");
    expect((await client.getTaskContentV1(TASK_ID)).definition.status).toBe("protected");
    expect((await client.listProtectedTaskContentV1())[0]?.content.status).toBe("protected");
    expect((await client.planProtectedTaskCreateV1({ operationId: "task:plan:one", task: {} })).taskId)
      .toBe(TASK_ID);
    expect((await client.planProtectedTaskUpdateV1(TASK_ID,
      { operationId: "task:plan:one", task: {} })).nextContentRevision).toBe(2);
    const definition = await client.getProtectedTaskDefinitionEnvelopeV1(
      TASK_ID, protectedSummary.content,
    );
    expect(definition.status).toBe("ready");
    if (definition.status !== "ready") throw new Error("Expected a ready Task envelope");
    expect(definition.signerEvidence[0]).toMatchObject({ kind: "human_device" });
    expect((await client.createPreparedTaskV1(prepared())).taskId).toBe(TASK_ID);
    const update: ProtectedTaskPreparedUpdateRequestV1 = {
      ...prepared(), operation: "update", expectedContentRevision: 1,
      nextContentRevision: 2,
    };
    expect((await client.updatePreparedTaskV1(TASK_ID, update)).content.status)
      .toBe("protected");
    const dualCreate = {
      ...prepared(),
      representation: "dual" as const,
      ordinaryPayloadBytesBase64url: "cGF5bG9hZA",
    };
    expect((await client.createDualPreparedTaskV1(dualCreate)).taskId).toBe(TASK_ID);
    const dualUpdate = {
      ...update,
      representation: "dual" as const,
      ordinaryPayloadBytesBase64url: "cGF5bG9hZA",
    };
    expect((await client.updateDualPreparedTaskV1(TASK_ID, dualUpdate)).content.status)
      .toBe("protected");
    expect(calls).toEqual([
      { url: "https://nautilo.test/api/tasks/content-v1?includeTerminal=true", method: "GET" },
      { url: `https://nautilo.test/api/tasks/${TASK_ID}/content-v1`, method: "GET" },
      { url: "https://nautilo.test/api/protected/tasks", method: "GET" },
      { url: "https://nautilo.test/api/protected/tasks/publication-plan", method: "POST" },
      { url: `https://nautilo.test/api/protected/tasks/${TASK_ID}/publication-plan`, method: "POST" },
      { url: `https://nautilo.test/api/protected/tasks/${TASK_ID}/definition?objectId=${encodeURIComponent(protectedSummary.content.objectId)}&contentRevision=1&cryptoAccessRevision=0`, method: "GET" },
      { url: "https://nautilo.test/api/protected/tasks/publication", method: "POST" },
      { url: `https://nautilo.test/api/protected/tasks/${TASK_ID}/publication`, method: "PATCH" },
      { url: "https://nautilo.test/api/protected/tasks/publication", method: "POST" },
      { url: `https://nautilo.test/api/protected/tasks/${TASK_ID}/publication`, method: "PATCH" },
    ]);
  });

  test("ordinary fallback methods use the existing Task routes with exact content mapping", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async (target, init) => {
        const url = typeof target === "string" ? target
          : target instanceof URL ? target.href : target.url;
        const method = init?.method ?? "GET";
        const body: unknown = typeof init?.body === "string"
          ? JSON.parse(init.body) as unknown
          : undefined;
        calls.push({ url, method, body });
        if (method === "POST") {
          return response({ taskId: TASK_ID, status: "pending", nextFireAt: null });
        }
        return response({
          id: TASK_ID,
          prompt: "updated private prompt",
          lastError: null,
          status: "paused",
        });
      },
    });
    client.setToken("session-token");
    await client.createOrdinaryTaskV1({
      prompt: "private prompt",
      expectedOutput: null,
      scheduleKind: "now",
    });
    await client.updateOrdinaryTaskV1(TASK_ID, {
      prompt: "updated private prompt",
      expectedOutput: "answer",
      timezone: "UTC",
    });
    expect(calls).toEqual([
      {
        url: "https://nautilo.test/api/tasks",
        method: "POST",
        body: { prompt: "private prompt", expectedOutput: null, scheduleKind: "now" },
      },
      {
        url: `https://nautilo.test/api/tasks/${TASK_ID}`,
        method: "PATCH",
        body: { prompt: "updated private prompt", expectedOutput: "answer", timezone: "UTC" },
      },
    ]);
  });

  test("rejects plaintext request keys and protected responses before publication succeeds", async () => {
    let calls = 0;
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async () => {
        calls += 1;
        return response([{ ...protectedSummary, prompt: "leaked" }]);
      },
    });
    client.setToken("session-token");
    const rejectedPrepared = await client.createPreparedTaskV1({
      ...prepared(), task: { prompt: "leaked" },
    } as unknown as ProtectedTaskPreparedCreateRequestV1).then(
      () => false, () => true,
    );
    expect(rejectedPrepared).toBe(true);
    expect(calls).toBe(0);
    const rejectedResponse = await client.listTaskContentV1().then(
      () => false, () => true,
    );
    expect(rejectedResponse).toBe(true);
  });
});
