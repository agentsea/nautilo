import { beforeEach, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import type { Task, TaskRun } from "@nautilo/db";
import { TASK_FUNDING_FAILURE_CODES } from "@nautilo/types";
import { bindEncryptionDataOperationOwner, deriveTaskContentCryptoObjectIdV1, taskContentRevisionObjectIdV1, type LiveShadowEncryptionTransitionPolicy } from "@nautilo/lattice-bridge";
import { taskContentDetailV1Schema, taskContentSummaryV1Schema } from "@nautilo/api-client";

const actualDb = await import("@nautilo/db");
const actualAgent = await import("@nautilo/agent");
const actualRuntime = await import("@nautilo/runtime");
const taskId = "71000000-0000-4000-8000-000000000001";
const protectedTaskV8Id = "836a18fb-2373-8420-a6c3-69213687b35e";
const runId = "71000000-0000-4000-8000-000000000002";
const ownerId = "71000000-0000-4000-8000-000000000003";
const agentId = "71000000-0000-4000-8000-000000000004";
const namespaceId = "71000000-0000-4000-8000-000000000005";
let task: Task;
let run: TaskRun;
let invalidate = false;
let validations = 0;
let historicalRows: readonly unknown[] = [];
const transcript = mock(async () => [{ role: "assistant", content: "private transcript", toolName: null, toolCalls: null, createdAt: new Date(0) }]);
const findTask = mock(async (_db: unknown, _id: string, options?: Parameters<typeof actualDb.getTaskById>[2]) => {
  if (!options?.lifecycleOnly) return task;
  if (task.ownerId !== options.ownerId) return undefined;
  return { ...task, prompt: "", expectedOutput: null,
    lastError: TASK_FUNDING_FAILURE_CODES.some(code => code === task.lastError) ? task.lastError : null, metadata: {} };
});
const findRuns = mock(async (_db: unknown, _id: string, projection?: Parameters<typeof actualDb.getTaskRuns>[2]) =>
  projection?.lifecycleOnly ? [{ ...run, resultText: null,
    lastError: TASK_FUNDING_FAILURE_CODES.some(code => code === run.lastError) ? run.lastError : null }] : [run]);
const listTasks = mock(async (_db: unknown, _owner: string, _opts: unknown, _projection?: unknown) => [task]);
const resume = mock(async () => false);
mock.module("@nautilo/db", () => ({ ...actualDb, getTaskById: findTask, getTaskRuns: findRuns,
  listTasksForOwner: listTasks, getLatestRunModelByTask: async () => new Map(),
  getOwnerAgentDisplayNamesByAgentId: async () => new Map([[agentId, "Genie"]]) }));
mock.module("@nautilo/agent", () => ({ ...actualAgent, getRunAgentTranscript: transcript }));
mock.module("@nautilo/runtime", () => ({ ...actualRuntime, canResumeSecurityResearchContextFailure: resume }));
mock.module("../../src/lib/server-direct-db", () => ({ getServerDirectDb: () => ({ select: (selection?: Record<string, unknown>) => {
  if (selection && Object.hasOwn(selection, "avatarRef")) {
    const chain = { from: () => chain, where: () => chain, limit: async () => [] };
    return chain;
  }
  const chain = { from: () => chain, innerJoin: () => chain, where: async () => historicalRows };
  return chain;
} }) }));
const { tasksRoutes } = await import("../../src/routes/tasks");

beforeEach(() => {
  task = { id: taskId, ownerId, agentId, parentTaskId: null, depth: 0, status: "completed", preset: "task",
    metadata: {}, contentRepresentation: "ordinary", contentRevision: 0, cryptoObjectId: null,
    contentNamespaceId: null, cryptoMappingState: "unmapped", cryptoAccessRevision: 0,
    prompt: "private prompt", expectedOutput: "private expectation", lastError: "private task error",
    scheduleKind: "now", cron: null, runAt: null, timezone: "UTC", nextFireAt: null, callingRoomId: null,
    targetRoomId: null, targetChat: "orphan", resultDelivery: "wake", useScope: false, scopeId: null,
    toolsMode: "auto", toolsWhitelist: [], selectionProfile: "balanced", selectionSpec: null,
    requestedModelId: null, createdAt: new Date(0), updatedAt: new Date(0),
    requestorId: ownerId, timeLimitSeconds: null, cryptoRequiredNamespaceFingerprint: null,
    catchup: "skip", targetChatHandle: null, targetUserIds: [], awaitResponse: false,
    fundingMode: "legacy_server", lastFiredAt: null, fireLockId: null, fireLockedAt: null,
    pauseRequestId: null, pauseRequestedAt: null, pauseReason: null,
    localExecutionDelegation: null, cancelledAt: null,
    ordinaryFallbackOperationId: null, ordinaryFallbackRequestDigest: null,
    ordinaryFallbackReason: null, ordinaryFallbackPolicyRevision: null,
    ordinaryFallbackCompletedAt: null };
  run = { id: runId, status: "completed", modelId: null, startedAt: new Date(0), completedAt: new Date(1),
    graphThreadId: "thread", resultRepresentation: "ordinary", resultText: "private result", lastError: "private run error",
    taskId, jobId: null, fundingBinding: null, fundingPredecessorRunId: null,
    resultContentNamespaceId: null, resultRevision: 0, resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0, resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped" };
  invalidate = false; validations = 0; historicalRows = [];
  transcript.mockClear(); findTask.mockClear(); findRuns.mockClear(); resume.mockClear(); listTasks.mockClear();
});
async function request(
  policy: LiveShadowEncryptionTransitionPolicy,
  url: string,
  user = ownerId,
) {
  const app = Fastify();
  app.addHook("preHandler", async request => { request.sessionUserId = user; });
  tasksRoutes(app, { observer: { kick() {} }, contentOwner: bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({ policy, revalidationToken: 1 }),
    revalidate: async () => { if (invalidate && ++validations > 1) throw new Error("policy changed"); },
  } }) });
  try { return await app.inject({ method: "GET", url }); }
  finally { await app.close(); }
}
async function read(
  policy: LiveShadowEncryptionTransitionPolicy,
  user = ownerId,
  list = false,
  funding = false,
  requestedTaskId = taskId,
) {
  return request(
    policy,
    list
      ? "/api/tasks/content-v1"
      : `/api/tasks/${requestedTaskId}/content-v1${funding ? "?includeFunding=true" : ""}`,
    user,
  );
}
const policies: LiveShadowEncryptionTransitionPolicy[] = [
  { mode: "plaintext_only", shadowBehavior: "fallback" },
  { mode: "shadow_encryption", shadowBehavior: "fallback" },
  { mode: "shadow_encryption", shadowBehavior: "strict" },
  { mode: "encrypted_only", shadowBehavior: "fallback" },
];
for (const policy of policies) {
  test(`${policy.mode}/${policy.shadowBehavior} projects a receipt-bound stale Task only through ordinary reads`, async () => {
    Object.assign(task, { contentRepresentation: "dual", contentRevision: 2,
      contentNamespaceId: namespaceId, cryptoMappingState: "stale",
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1({ kind: "definition", taskId, contentRevision: 2 }),
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32),
      ordinaryFallbackOperationId: "task:fallback:edit", ordinaryFallbackRequestDigest: new Uint8Array(32),
      ordinaryFallbackReason: "target_encryption_not_ready", ordinaryFallbackPolicyRevision: 25,
      ordinaryFallbackCompletedAt: new Date(1) });
    const response = await read(policy);
    expect(response.statusCode).toBe(200);
    const detail = taskContentDetailV1Schema.parse(response.json());
    const allowed = policy.mode === "plaintext_only"
      || policy.mode === "shadow_encryption" && policy.shadowBehavior === "fallback";
    if (allowed) {
      expect(detail.definition).toMatchObject({ status: "ordinary", prompt: task.prompt });
    } else {
      expect(detail.definition.status).toBe("unavailable");
      expect(response.body).not.toContain("private ");
    }
    task.ordinaryFallbackRequestDigest = null;
    const withoutReceipt = await read(policy);
    expect(taskContentDetailV1Schema.parse(withoutReceipt.json()).definition.status).toBe("unavailable");
  });
}
for (const policy of policies) {
  test(`${policy.mode}/${policy.shadowBehavior} retains mixed lifecycle rows without a whole-list denial`, async () => {
    task.metadata = { execution: { harnessId: "private harness marker" } };
    const protectedId = "71000000-0000-4000-8000-000000000006";
    const mapped = { ...task, id: protectedId, contentRepresentation: "dual" as const,
      contentRevision: 1, contentNamespaceId: namespaceId, cryptoMappingState: "verified" as const,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1({ kind: "definition", taskId: protectedId, contentRevision: 1 }) };
    listTasks.mockImplementation(async () => [task, mapped]);
    const response = await read(policy, ownerId, true);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const rows = taskContentSummaryV1Schema.array().parse(response.json());
    expect(rows.map((row: { id: string }) => row.id)).toEqual([taskId, protectedId]);
    expect(rows[1]!.content).toMatchObject({ status: "protected", objectId: mapped.cryptoObjectId });
    const ordinaryAllowed = policy.mode === "plaintext_only" || policy.mode === "shadow_encryption" && policy.shadowBehavior === "fallback";
    if (ordinaryAllowed) {
      expect(rows[0]!.content).toMatchObject({ status: "ordinary", promptPreview: task.prompt });
      expect(listTasks.mock.calls[0]?.[3]).toBeUndefined();
      expect(resume).toHaveBeenCalledTimes(1);
    } else {
      expect(rows[0]!.content).toEqual({ dtoVersion: 1, status: "unavailable", reason: "waiting_for_authorization" });
      expect(response.body).not.toContain("private ");
      expect(listTasks.mock.calls[0]?.[3]).toEqual({ lifecycleOnly: true });
      expect(resume).not.toHaveBeenCalled();
      expect(rows[0]!.harnessId).toBeNull();
      expect(response.body).not.toContain("private harness marker");
    }
    expect(transcript).not.toHaveBeenCalled();
    listTasks.mockImplementation(async () => [task]);
  });
  test(`${policy.mode}/${policy.shadowBehavior} preserves owner run coordinates and selects allowed content`, async () => {
    const response = await read(policy);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const detail = taskContentDetailV1Schema.parse(response.json());
    expect(detail.task.agentId).toBe(agentId);
    expect(detail.runs.map(value => value.id)).toEqual([runId]);
    if (policy.mode === "plaintext_only" || policy.mode === "shadow_encryption" && policy.shadowBehavior === "fallback") {
      expect(detail.definition).toMatchObject({ status: "ordinary", prompt: "private prompt" });
      expect(detail.runs[0]?.content).toMatchObject({ status: "ordinary", resultText: "private result" });
      expect(transcript).toHaveBeenCalledTimes(1);
      expect(findTask.mock.calls[0]).toHaveLength(2);
      expect(findRuns.mock.calls[0]).toHaveLength(2);
    } else {
      expect(detail.definition).toMatchObject({ status: "unavailable", reason: "waiting_for_authorization" });
      expect(findTask.mock.calls[0]?.[2]).toEqual({ lifecycleOnly: true, ownerId });
      expect(findRuns.mock.calls[0]?.[2]).toEqual({ lifecycleOnly: true });
      expect(response.body).not.toContain("private ");
      expect(transcript).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    }
  });
  test(`${policy.mode}/${policy.shadowBehavior} never projects protected plaintext siblings`, async () => {
    task.contentRepresentation = "dual";
    task.contentRevision = 1;
    task.contentNamespaceId = namespaceId;
    task.cryptoMappingState = "verified";
    task.cryptoObjectId = deriveTaskContentCryptoObjectIdV1({ kind: "definition", taskId, contentRevision: 1 });
    run.resultRepresentation = "dual";
    const response = await read(policy);
    expect(response.statusCode).toBe(200);
    expect(taskContentDetailV1Schema.parse(response.json()).definition.status).toBe("protected");
    expect(response.body).not.toContain("private ");
    expect(transcript).not.toHaveBeenCalled();
  });
}
test("foreign owner cannot discover run coordinates", async () => {
  expect((await read(policies[3]!, "other")).statusCode).toBe(404);
  expect(findRuns).not.toHaveBeenCalled();
});
test("protected content detail accepts generated UUIDv8 Task IDs without weakening owner isolation", async () => {
  task.id = protectedTaskV8Id;
  task.contentRepresentation = "dual";
  task.contentRevision = 1;
  task.contentNamespaceId = namespaceId;
  task.cryptoMappingState = "verified";
  task.cryptoObjectId = deriveTaskContentCryptoObjectIdV1({
    kind: "definition",
    taskId: protectedTaskV8Id,
    contentRevision: 1,
  });
  run.taskId = protectedTaskV8Id;
  run.resultRepresentation = "dual";

  const ownerResponse = await read(policies[3]!, ownerId, false, false, protectedTaskV8Id);
  expect(ownerResponse.statusCode).toBe(200);
  expect(taskContentDetailV1Schema.parse(ownerResponse.json()).task.id).toBe(protectedTaskV8Id);

  findRuns.mockClear();
  const foreignResponse = await read(policies[3]!, "other", false, false, protectedTaskV8Id);
  expect(foreignResponse.statusCode).toBe(404);
  expect(findRuns).not.toHaveBeenCalled();
});
test("protected content detail rejects malformed Task IDs before reading storage", async () => {
  const response = await request(policies[3]!, "/api/tasks/not-a-task-id/content-v1");
  expect(response.statusCode).toBe(404);
  expect(findTask).not.toHaveBeenCalled();
});
test("content detail retains uppercase UUID acceptance", async () => {
  const uppercaseTaskId = "71ABCDEF-ABCD-4DEF-8ABC-ABCDEFABCDEF";
  const response = await read(policies[0]!, ownerId, false, false, uppercaseTaskId);
  expect(response.statusCode).toBe(200);
  expect(findTask.mock.calls[0]?.[1]).toBe(uppercaseTaskId);
});
test("Task avatar accepts generated UUIDv8 Task IDs", async () => {
  task.id = protectedTaskV8Id;
  const response = await request(
    policies[3]!,
    `/api/tasks/${protectedTaskV8Id}/agent/avatar`,
  );
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("image/svg+xml");
  expect(findTask.mock.calls[0]?.[1]).toBe(protectedTaskV8Id);
  expect(findTask.mock.calls[0]?.[2]).toEqual({ lifecycleOnly: true, ownerId });
});
test("Task avatar uses a content-free owner projection and preserves foreign-owner 404", async () => {
  const foreignResponse = await request(
    policies[3]!,
    `/api/tasks/${taskId}/agent/avatar`,
    "other",
  );
  expect(foreignResponse.statusCode).toBe(404);
  expect(findTask).toHaveBeenCalledTimes(1);
  expect(findTask.mock.calls[0]?.[2]).toEqual({ lifecycleOnly: true, ownerId: "other" });
});
test("ordinary Task detail retains valid v4 and uppercase UUID behavior", async () => {
  const ordinaryResponse = await request(policies[0]!, `/api/tasks/${taskId}`);
  expect(ordinaryResponse.statusCode).toBe(200);
  expect(ordinaryResponse.json()).toMatchObject({ task: { id: taskId } });

  findTask.mockClear();
  const uppercaseTaskId = "71ABCDEF-ABCD-4DEF-8ABC-ABCDEFABCDEF";
  const uppercaseResponse = await request(policies[0]!, `/api/tasks/${uppercaseTaskId}`);
  expect(uppercaseResponse.statusCode).toBe(200);
  expect(findTask.mock.calls[0]?.[1]).toBe(uppercaseTaskId);
});
test("ordinary Task detail reads a retained-dual UUIDv8 Task after Plain restoration", async () => {
  task.id = protectedTaskV8Id;
  task.contentRepresentation = "dual";
  task.contentRevision = 1;
  task.contentNamespaceId = namespaceId;
  task.cryptoMappingState = "verified";
  task.cryptoObjectId = deriveTaskContentCryptoObjectIdV1({
    kind: "definition",
    taskId: protectedTaskV8Id,
    contentRevision: 1,
  });
  run.taskId = protectedTaskV8Id;
  run.resultRepresentation = "dual";

  const ownerResponse = await request(policies[0]!, `/api/tasks/${protectedTaskV8Id}`);
  expect(ownerResponse.statusCode).toBe(200);
  expect(ownerResponse.json()).toMatchObject({ task: { id: protectedTaskV8Id } });

  findRuns.mockClear();
  const foreignResponse = await request(
    policies[0]!,
    `/api/tasks/${protectedTaskV8Id}`,
    "other",
  );
  expect(foreignResponse.statusCode).toBe(404);
  expect(findRuns).not.toHaveBeenCalled();
});
test("ordinary Task detail rejects malformed IDs before reading storage", async () => {
  const response = await request(policies[0]!, "/api/tasks/not-a-task-id");
  expect(response.statusCode).toBe(404);
  expect(findTask).not.toHaveBeenCalled();
});
for (const policy of [policies[2]!, policies[3]!]) {
  test(`${policy.mode} keeps ordinary Task detail closed for UUIDv8 Tasks`, async () => {
    const response = await request(policy, `/api/tasks/${protectedTaskV8Id}`);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>())
      .toEqual({ error: "task_content_unavailable" });
    expect(findTask).not.toHaveBeenCalled();
  });
}
test("policy changes during projection discard the response", async () => {
  invalidate = true;
  const response = await read(policies[0]!);
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain("private ");
  expect(response.body).not.toContain(runId);
});

for (const policy of [policies[2]!, policies[3]!]) {
  test(`${policy.mode} lists and reads genuinely source-versioned historical mappings`, async () => {
    const provenance = { version: 2 as const, claimId: "71000000-0000-4000-8000-000000000007",
      publisherDeviceId: "device", signedRequestDigest: "11".repeat(32), sourceDigest: "22".repeat(32),
      sourcePayloadHash: "33".repeat(32), genesisManifestHash: "44".repeat(32), sourceRevision: 0 as const };
    task.contentRepresentation = "dual";
    task.contentRevision = 1;
    task.contentNamespaceId = namespaceId;
    task.cryptoMappingState = "verified";
    task.cryptoAccessRevision = 2;
    task.cryptoRequiredNamespaceFingerprint = new Uint8Array(32).fill(5);
    task.cryptoObjectId = taskContentRevisionObjectIdV1({
      coordinate: { kind: "definition", taskId, contentRevision: 1 }, namespaceId, historicalRepair: provenance,
    });
    const ledger = { taskId, ownerId, requestorId: ownerId, representation: "dual", namespaceId, revision: 1,
      objectId: task.cryptoObjectId, accessRevision: 2, fingerprint: task.cryptoRequiredNamespaceFingerprint,
      mappingState: "verified", ledgerRepresentation: "dual", anchorNamespaceId: namespaceId,
      genesisAccessRevision: 0, payloadVersion: 1, completion: "complete", disposition: "mapped",
      failureCode: null, completedAt: new Date(1), requestDigest: new Uint8Array(32).fill(0x11),
      historicalRepair: provenance };
    for (const list of [true, false]) {
      historicalRows = [ledger];
      const response = await read(policy, ownerId, list);
      expect(response.statusCode).toBe(200);
      const definition = list ? taskContentSummaryV1Schema.array().parse(response.json())[0]!.content
        : taskContentDetailV1Schema.parse(response.json()).definition;
      expect(definition).toMatchObject({ status: "protected", objectId: task.cryptoObjectId, cryptoAccessRevision: 2 });
      expect(response.body).not.toContain("private ");
      for (const invalid of [[], [{ ...ledger, historicalRepair: { ...provenance, sourceDigest: "55".repeat(32) } }]]) {
        historicalRows = invalid;
        const denied = await read(policy, ownerId, list);
        const content = list ? taskContentSummaryV1Schema.array().parse(denied.json())[0]!.content
          : taskContentDetailV1Schema.parse(denied.json()).definition;
        expect(content).toEqual({ dtoVersion: 1, status: "unavailable", reason: "integrity_failure" });
      }
    }
    expect(transcript).not.toHaveBeenCalled();
  });
}


for (const policy of [policies[2]!, policies[3]!]) {
  test(`${policy.mode} detail preserves closed funding failure without exposing result siblings`, async () => {
    run.lastError = "funding_source_changed";
    task.lastError = "funding_source_changed";
    const response = await read(policy, ownerId, false, true);
    expect(response.statusCode).toBe(200);
    const detail = taskContentDetailV1Schema.parse(response.json());
    expect(detail.task).toMatchObject({ fundingFailure: "funding_source_changed" });
    expect(detail.runs[0]).toMatchObject({ fundingSource: "server", fundingFailure: "funding_source_changed" });
    expect(response.body).not.toContain("private ");
    expect(findRuns.mock.calls[0]?.[2]).toEqual({ lifecycleOnly: true });
    expect(transcript).not.toHaveBeenCalled();
  });
}
