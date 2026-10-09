import { beforeEach, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import type { Task, TaskRun } from "@nautilo/db";
import { bindEncryptionDataOperationOwner, deriveTaskContentCryptoObjectIdV1, type LiveShadowEncryptionTransitionPolicy } from "@nautilo/lattice-bridge";
import { taskContentDetailV1Schema } from "@nautilo/api-client";

const actualDb = await import("@nautilo/db");
const actualAgent = await import("@nautilo/agent");
const actualRuntime = await import("@nautilo/runtime");
const taskId = "71000000-0000-4000-8000-000000000001";
const runId = "71000000-0000-4000-8000-000000000002";
const ownerId = "71000000-0000-4000-8000-000000000003";
const agentId = "71000000-0000-4000-8000-000000000004";
const namespaceId = "71000000-0000-4000-8000-000000000005";
let task: Task;
let run: TaskRun;
let invalidate = false;
let validations = 0;
const transcript = mock(async () => [{ role: "assistant", content: "private transcript", toolName: null, toolCalls: null, createdAt: new Date(0) }]);
const findTask = mock(async () => task);
const findRuns = mock(async () => [run]);
const resume = mock(async () => false);
mock.module("@nautilo/db", () => ({ ...actualDb, getTaskById: findTask, getTaskRuns: findRuns,
  getOwnerAgentDisplayNamesByAgentId: async () => new Map([[agentId, "Genie"]]) }));
mock.module("@nautilo/agent", () => ({ ...actualAgent, getRunAgentTranscript: transcript }));
mock.module("@nautilo/runtime", () => ({ ...actualRuntime, canResumeSecurityResearchContextFailure: resume }));
mock.module("../../src/lib/server-direct-db", () => ({ getServerDirectDb: () => ({}) }));
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
    localExecutionDelegation: null, cancelledAt: null };
  run = { id: runId, status: "completed", modelId: null, startedAt: new Date(0), completedAt: new Date(1),
    graphThreadId: "thread", resultRepresentation: "ordinary", resultText: "private result", lastError: "private run error",
    taskId, jobId: null, fundingBinding: null, fundingPredecessorRunId: null,
    resultContentNamespaceId: null, resultRevision: 0, resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0, resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped" };
  invalidate = false; validations = 0;
  transcript.mockClear(); findTask.mockClear(); findRuns.mockClear(); resume.mockClear();
});
async function read(policy: LiveShadowEncryptionTransitionPolicy, user = ownerId) {
  const app = Fastify();
  app.addHook("preHandler", async request => { request.sessionUserId = user; });
  tasksRoutes(app, { observer: { kick() {} }, contentOwner: bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({ policy, revalidationToken: 1 }),
    revalidate: async () => { if (invalidate && ++validations > 1) throw new Error("policy changed"); },
  } }) });
  try { return await app.inject({ method: "GET", url: `/api/tasks/${taskId}/content-v1` }); }
  finally { await app.close(); }
}
const policies: LiveShadowEncryptionTransitionPolicy[] = [
  { mode: "plaintext_only", shadowBehavior: "fallback" },
  { mode: "shadow_encryption", shadowBehavior: "fallback" },
  { mode: "shadow_encryption", shadowBehavior: "strict" },
  { mode: "encrypted_only", shadowBehavior: "fallback" },
];
for (const policy of policies) {
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
    } else {
      expect(detail.definition).toMatchObject({ status: "unavailable", reason: "waiting_for_authorization" });
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
test("policy changes during projection discard the response", async () => {
  invalidate = true;
  const response = await read(policies[0]!);
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain("private ");
  expect(response.body).not.toContain(runId);
});
