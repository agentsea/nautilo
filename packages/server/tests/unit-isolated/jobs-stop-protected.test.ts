import { beforeEach, expect, mock, test } from "bun:test";
import Fastify from "fastify";

const humanId = "40000000-0000-4000-8000-000000000004";
const otherHumanId = "40000000-0000-4000-8000-000000000099";
const taskId = "10000000-0000-4000-8000-000000000001";
const taskRunId = "20000000-0000-4000-8000-000000000002";
const jobId = "30000000-0000-4000-8000-000000000003";
const inputObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId = `task-run-result:v1:${"b".repeat(64)}`;

const protectedReference = {
  kind: "protected_task_run_v1" as const,
  taskId,
  taskRunId,
  inputObjectId,
  resultObjectId,
  authorizationRequestId: `task-run-authorization:${taskRunId}`,
  policyRevision: 7,
  executionSegment: 1,
};

function job(input: Record<string, unknown>, ownerId = humanId) {
  return {
    id: jobId,
    ownerId,
    requestorId: ownerId,
    laneKey: `task:${taskId}`,
    type: "foreground" as const,
    status: "running",
    input,
    result: null,
    message: null,
    createdAt: new Date("2026-10-08T09:00:00.000Z"),
    startedAt: new Date("2026-10-08T09:00:01.000Z"),
    completedAt: null,
  };
}

let durableJob: ReturnType<typeof job> | null = null;
let stopResult = { ok: true, status: "cancelled", message: "Task stopped." };
const reads: unknown[] = [];
const stops: unknown[] = [];
const aborts: unknown[] = [];

const realDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...realDb,
  getJobById: async (id: string, ownerId?: string) => {
    reads.push({ id, ownerId });
    return durableJob?.id === id && (ownerId === undefined || durableJob.ownerId === ownerId)
      ? durableJob
      : null;
  },
}));

const realRuntime = await import("@nautilo/runtime");
const routeJobManager = {
  abortJob: (id: string) => {
    aborts.push(id);
    return true;
  },
};
mock.module("@nautilo/runtime", () => ({
  ...realRuntime,
  getTaskRunDb: () => ({ kind: "task-db" }),
  jobManager: routeJobManager,
  stopTask: async (deps: unknown, id: string, expected: unknown) => {
    stops.push({ deps, id, expected });
    return stopResult;
  },
}));

const { jobRoutes } = await import("../../src/routes/jobs");

async function requestStop(sessionUserId = humanId) {
  const app = Fastify({ logger: false });
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", (request, _reply, done) => {
    (request as { sessionUserId: string }).sessionUserId = sessionUserId;
    done();
  });
  jobRoutes(app);
  await app.ready();
  try {
    return await app.inject({ method: "POST", url: `/api/jobs/${jobId}/stop` });
  } finally {
    await app.close();
  }
}

beforeEach(() => {
  durableJob = null;
  stopResult = { ok: true, status: "cancelled", message: "Task stopped." };
  reads.length = 0;
  stops.length = 0;
  aborts.length = 0;
});

test("protected Job stop uses owner-scoped durable authority without local tracking", async () => {
  durableJob = job(protectedReference);

  const response = await requestStop();

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ stopped: true });
  expect(reads).toEqual([{ id: jobId, ownerId: humanId }]);
  expect(stops).toHaveLength(1);
  expect(stops[0]).toMatchObject({
    id: taskId,
    expected: { humanUserId: humanId, taskRunId, jobId },
  });
  expect(aborts).toEqual([]);
});

test("stale protected Job authority stays closed", async () => {
  durableJob = job(protectedReference);
  stopResult = {
    ok: false,
    status: "authority_changed",
    message: "Task invocation changed.",
  };

  const response = await requestStop();

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ stopped: false });
  expect(stops).toHaveLength(1);
  expect(aborts).toEqual([]);
});

test("malformed protected marker never falls through to direct abort", async () => {
  durableJob = job({ ...protectedReference, taskRunId: "not-a-uuid" });

  const response = await requestStop();

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ stopped: false });
  expect(stops).toEqual([]);
  expect(aborts).toEqual([]);
});

test("owner-scoped lookup hides another Human's protected Job", async () => {
  durableJob = job(protectedReference, otherHumanId);

  const response = await requestStop();

  expect(response.statusCode).toBe(404);
  expect(stops).toEqual([]);
  expect(aborts).toEqual([]);
});

test("Plain Job stop preserves the direct process-local abort path", async () => {
  durableJob = job({ task: "ordinary background work" });

  const response = await requestStop();

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ stopped: true });
  expect(stops).toEqual([]);
  expect(aborts).toEqual([jobId]);
});
