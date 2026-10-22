import { beforeEach, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import type { Task, TaskLifecycleState } from "@nautilo/db";
import type { TaskLifecycleResponse } from "@nautilo/types";
import { bindEncryptionDataOperationOwner, type LiveShadowEncryptionTransitionPolicy } from "@nautilo/lattice-bridge";

const database = await import("@nautilo/db");
const runtime = await import("@nautilo/runtime");
const TASK_ID = "71000000-0000-4000-8000-000000000001";
const HUMAN_ID = "71000000-0000-4000-8000-000000000002";
let state: TaskLifecycleState;
let contentReads: number;
let fundingChecks: number;
let priorRunReads: number;
let resumeCalls: number;
let invocationAllowed: boolean;
let legacyFundingChecks: number;
let ordinaryFundingMode: Task["fundingMode"];
const ordinaryTask = () => ({ ...state, fundingMode: ordinaryFundingMode, metadata: {}, prompt: "private task content" }) as unknown as Task;

mock.module("@nautilo/db", () => ({
  ...database,
  getTaskLifecycleState: async () => state,
  getTaskById: async (_db: unknown, _id: string, options?: { ordinaryOnly?: boolean }) => {
    contentReads += 1;
    expect(options).toEqual({ ordinaryOnly: true });
    if (state.contentRepresentation !== "ordinary") throw new Error("Protected content read");
    return ordinaryTask();
  },
  getLatestResumableTaskRun: async () => { priorRunReads += 1; return undefined; },
}));
mock.module("@nautilo/runtime", () => ({
  ...runtime,
  assertTaskFundingAdmission: async () => {
    fundingChecks += 1;
    if (state.contentRepresentation !== "ordinary") throw new Error("Protected funding without grant");
    if (ordinaryFundingMode === "legacy_server") return null;
    return { modelId: "provider:model", binding: { kind: "server", providerRoute: "provider" } };
  },
  unpauseTask: async () => { resumeCalls += 1; return { ok: true, status: "awaiting", message: "Task resumed." }; },
}));
mock.module("../../src/lib/server-direct-db", () => ({ getServerDirectDb: () => ({}) }));
mock.module("../../src/lib/agent-invocation-admission", () => ({
  requireAgentInvocation: async (_input: unknown, reply: FastifyReply) => {
    if (!invocationAllowed) reply.status(403).send({ error: "agent_invocation_denied" });
    return invocationAllowed;
  },
  requireServerFunding: async () => { legacyFundingChecks += 1; return true; },
}));
const { tasksRoutes } = await import("../../src/routes/tasks");

beforeEach(() => {
  state = { id: TASK_ID, ownerId: HUMAN_ID, requestorId: HUMAN_ID,
    agentId: "71000000-0000-4000-8000-000000000003", targetRoomId: null,
    status: "paused", contentRepresentation: "protected", scheduleKind: "now",
    pauseRequestId: "71000000-0000-4000-8000-000000000004", pauseRequestedAt: new Date(0),
    pauseReason: "manual_pause", localExecutionRecaptureRequired: false,
    fundingOutcomeUncertain: false, latestRunPaused: false };
  contentReads = 0; fundingChecks = 0; priorRunReads = 0; resumeCalls = 0;
  invocationAllowed = true;
  ordinaryFundingMode = "caller"; legacyFundingChecks = 0;
});

async function resume(policy: LiveShadowEncryptionTransitionPolicy, human = HUMAN_ID) {
  const app = Fastify();
  app.addHook("preHandler", async request => { request.sessionUserId = human; });
  tasksRoutes(app, { observer: { kick() {} }, contentOwner: bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({ policy, revalidationToken: 1 }), revalidate: async () => {},
  } }) });
  try { return await app.inject({ method: "POST", url: `/api/tasks/${TASK_ID}/unpause` }); }
  finally { await app.close(); }
}

const policies: LiveShadowEncryptionTransitionPolicy[] = [
  { mode: "plaintext_only", shadowBehavior: "fallback" },
  { mode: "shadow_encryption", shadowBehavior: "fallback" },
  { mode: "shadow_encryption", shadowBehavior: "strict" },
  { mode: "encrypted_only", shadowBehavior: "fallback" },
];
for (const policy of policies) {
  test(`${policy.mode}/${policy.shadowBehavior} protected Resume requests fresh admission without content or funding access`, async () => {
    const response = await resume(policy);
    expect(response.statusCode).toBe(200);
    expect(response.json<TaskLifecycleResponse>()).toEqual({ taskId: TASK_ID, status: "awaiting", message: "Task resumed." });
    expect(contentReads).toBe(0); expect(priorRunReads).toBe(0); expect(fundingChecks).toBe(0);
    expect(resumeCalls).toBe(1);
  });
  test(`${policy.mode}/${policy.shadowBehavior} ordinary Resume retains only the allowed ordinary funding path`, async () => {
    state = { ...state, contentRepresentation: "ordinary" };
    const response = await resume(policy);
    const allowed = policy.mode === "plaintext_only"
      || policy.mode === "shadow_encryption" && policy.shadowBehavior === "fallback";
    expect(response.statusCode).toBe(allowed ? 200 : 409);
    expect(contentReads).toBe(allowed ? 1 : 0);
    expect(priorRunReads).toBe(allowed ? 1 : 0);
    expect(fundingChecks).toBe(allowed ? 1 : 0);
    expect(resumeCalls).toBe(allowed ? 1 : 0);
    expect(response.body).not.toContain("private task content");
  });
}
test("a foreign owner cannot resume or trigger content/funding reads", async () => {
  expect((await resume(policies[3]!, "other-human")).statusCode).toBe(404);
  expect(contentReads).toBe(0); expect(fundingChecks).toBe(0); expect(resumeCalls).toBe(0);
});
test("Plain legacy Resume retains its server funding gate", async () => {
  state = { ...state, contentRepresentation: "ordinary" };
  ordinaryFundingMode = "legacy_server";
  expect((await resume(policies[0]!)).statusCode).toBe(200);
  expect(fundingChecks).toBe(1); expect(legacyFundingChecks).toBe(1);
  expect(priorRunReads).toBe(1); expect(resumeCalls).toBe(1);
});
test("protected Resume cannot bypass current Agent invocation permission", async () => {
  invocationAllowed = false;
  expect((await resume(policies[3]!)).statusCode).toBe(403);
  expect(contentReads).toBe(0); expect(fundingChecks).toBe(0); expect(resumeCalls).toBe(0);
});
