import { describe, expect, test } from "bun:test";
import {
  CodexCanonicalFactsRejected,
  CodexCanonicalFactsService,
  type CodexCanonicalFactsReader,
} from "../../src/codex/canonical-facts";

const OWNER = "owner";
const TASK = "task";
const RUN = "run";
const JOB = "job";
const ROOM = "room";
const AGENT = "agent";
const PROFILE = "profile";
const LANE = "task:task";

const request = {
  actorId: OWNER,
  agentId: AGENT,
  taskId: TASK,
  taskRunId: RUN,
  jobId: JOB,
  roomId: ROOM,
  profileId: PROFILE,
  laneKey: LANE,
};

function reader(overrides: Partial<{
  task: Partial<Awaited<ReturnType<CodexCanonicalFactsReader["getTask"]>>>;
  run: Partial<Awaited<ReturnType<CodexCanonicalFactsReader["getTaskRun"]>>>;
  job: Partial<Awaited<ReturnType<CodexCanonicalFactsReader["getJob"]>>>;
  profile: Partial<Awaited<ReturnType<CodexCanonicalFactsReader["getProfile"]>>>;
  roomExists: boolean;
  agentMember: boolean;
  agentOwner: string | null;
}> = {}): CodexCanonicalFactsReader {
  return {
    getTask: async () => ({
      id: TASK,
      ownerId: OWNER,
      requestorId: OWNER,
      agentId: AGENT,
      parentTaskId: null,
      targetRoomId: ROOM,
      ...overrides.task,
    }),
    getTaskRun: async () => ({
      id: RUN,
      taskId: TASK,
      jobId: JOB,
      graphThreadId: "room:room:agent",
      ...overrides.run,
    }),
    getJob: async () => ({
      id: JOB,
      ownerId: OWNER,
      requestorId: OWNER,
      laneKey: LANE,
      roomId: ROOM,
      input: {
        taskId: TASK,
        taskRunId: RUN,
        agentId: AGENT,
        roomId: ROOM,
        graphThreadId: "room:room:agent",
      },
      ...overrides.job,
    }),
    roomExists: async () => overrides.roomExists ?? true,
    isAgentMember: async () => overrides.agentMember ?? true,
    getAgentOwner: async () => overrides.agentOwner ?? OWNER,
    getProfile: async () => ({
      id: PROFILE,
      userId: OWNER,
      relayId: "relay",
      homeHandle: "profile-home",
      profileGeneration: 3,
      accountGeneration: 5,
      authState: "signed_in",
      removalState: "active",
      ...overrides.profile,
    }),
  };
}

async function rejected(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("expected Codex canonical-facts rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(CodexCanonicalFactsRejected);
  }
}

describe("CodexCanonicalFactsService", () => {
  test("returns only the DB-proven immutable binding facts", async () => {
    const facts = await new CodexCanonicalFactsService(reader()).resolve(request);

    expect(facts).toEqual({
      userId: OWNER,
      agentId: AGENT,
      taskId: TASK,
      taskRunId: RUN,
      jobId: JOB,
      parentTaskId: null,
      roomId: ROOM,
      laneKey: LANE,
      profileId: PROFILE,
      relayId: "relay",
      profileHandle: PROFILE,
      profileGeneration: 3,
      accountGeneration: 5,
    });
    expect(Object.isFrozen(facts)).toBe(true);
  });

  test("fails closed for mismatched Task ownership, Room, TaskRun, Job, lane, or job attribution", async () => {
    await rejected(new CodexCanonicalFactsService(reader({ task: { ownerId: "other" } })).resolve(request));
    await rejected(new CodexCanonicalFactsService(reader({ task: { targetRoomId: "other-room" } })).resolve(request));
    await rejected(new CodexCanonicalFactsService(reader({ run: { taskId: "other-task" } })).resolve(request));
    await rejected(new CodexCanonicalFactsService(reader({ run: { jobId: "other-job" } })).resolve(request));
    await rejected(new CodexCanonicalFactsService(reader({ job: { laneKey: "other-lane" } })).resolve(request));
    await rejected(new CodexCanonicalFactsService(reader({ job: { input: { taskId: TASK, taskRunId: RUN, agentId: AGENT, roomId: ROOM, graphThreadId: "other-thread" } } })).resolve(request));
  });

  test("fails closed for a foreign/non-member Agent or missing Room", async () => {
    await rejected(new CodexCanonicalFactsService(reader({ agentOwner: "other" })).resolve(request));
    await rejected(new CodexCanonicalFactsService(reader({ agentMember: false })).resolve(request));
    await rejected(new CodexCanonicalFactsService(reader({ roomExists: false })).resolve(request));
  });

  test("fails closed for an unowned, stale, unsigned, or removing profile", async () => {
    await rejected(new CodexCanonicalFactsService(reader({ profile: { userId: "other" } })).resolve(request));
    await rejected(new CodexCanonicalFactsService(reader({ profile: { authState: "expired" } })).resolve(request));
    await rejected(new CodexCanonicalFactsService(reader({ profile: { removalState: "removing" } })).resolve(request));
    await rejected(new CodexCanonicalFactsService(reader({ profile: { profileGeneration: -1 } })).resolve(request));
  });
});

const PROTECTED_TASK = "50000000-0000-4000-8000-000000000005";
const PROTECTED_RUN = "60000000-0000-4000-8000-000000000006";
const protectedReference = {
  kind: "protected_task_run_v1",
  taskId: PROTECTED_TASK,
  taskRunId: PROTECTED_RUN,
  inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
  resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
  authorizationRequestId: `task-run-authorization:${PROTECTED_RUN}`,
  policyRevision: 7,
  executionSegment: 1,
} as const;
const protectedRequest = { ...request, taskId: PROTECTED_TASK, taskRunId: PROTECTED_RUN };
function protectedReader(overrides: Parameters<typeof reader>[0] = {}): CodexCanonicalFactsReader {
  return reader({ ...overrides,
    task: { id: PROTECTED_TASK, ...overrides.task },
    run: { id: PROTECTED_RUN, taskId: PROTECTED_TASK, ...overrides.run },
    job: { input: { ...protectedReference }, ...overrides.job },
  });
}

describe("Codex protected canonical Job binding", () => {
  test("denies a valid protected reference by default", async () => {
    await rejected(new CodexCanonicalFactsService(protectedReader()).resolve(protectedRequest));
  });

  test("lends an immutable exact reference only after common canonical checks", async () => {
    let calls = 0;
    const facts = await new CodexCanonicalFactsService(protectedReader(), {
      assertProtectedJobBinding: async binding => {
        calls++;
        expect(binding.task.id).toBe(PROTECTED_TASK);
        expect(binding.run).toMatchObject({ id: PROTECTED_RUN, taskId: PROTECTED_TASK, jobId: JOB });
        expect(binding.job.input).toEqual(protectedReference);
        expect(binding.job.input).not.toBe(protectedReference);
        for (const value of [binding, binding.task, binding.run, binding.job, binding.job.input]) {
          expect(Object.isFrozen(value)).toBe(true);
        }
        return true;
      },
    }).resolve(protectedRequest);
    expect(calls).toBe(1);
    expect(facts).toMatchObject({ taskId: PROTECTED_TASK, taskRunId: PROTECTED_RUN, jobId: JOB });
  });

  test("never calls the protected hook for ordinary attribution, including ordinary failures", async () => {
    let calls = 0;
    const options = { assertProtectedJobBinding: async () => { calls++; return true; } };
    await new CodexCanonicalFactsService(reader(), options).resolve(request);
    await rejected(new CodexCanonicalFactsService(reader({ job: { input: {
      taskId: TASK, taskRunId: RUN, agentId: AGENT, roomId: ROOM, graphThreadId: "forged",
    } } }), options).resolve(request));
    expect(calls).toBe(0);
  });

  test("rejects malformed or substituted protected references before the hook", async () => {
    let calls = 0;
    const options = { assertProtectedJobBinding: async () => { calls++; return true; } };
    for (const change of [
      { kind: "protected_task_run_v2" }, { taskId: PROTECTED_RUN }, { taskRunId: PROTECTED_TASK },
      { extra: true }, { agentId: AGENT }, { inputObjectId: "fake" }, { resultObjectId: "fake" },
      { authorizationRequestId: "invalid request" }, { policyRevision: 0 }, { executionSegment: 2 },
    ]) {
      await rejected(new CodexCanonicalFactsService(protectedReader({
        job: { input: { ...protectedReference, ...change } },
      }), options).resolve(protectedRequest));
    }
    expect(calls).toBe(0);
  });

  test("does not let a permissive hook bypass owner, Room, Run, lane, membership or profile fences", async () => {
    let calls = 0;
    const options = { assertProtectedJobBinding: async () => { calls++; return true; } };
    const invalid: NonNullable<Parameters<typeof reader>[0]>[] = [
      { task: { ownerId: "other" } }, { task: { requestorId: "other" } },
      { task: { agentId: "other" } }, { task: { targetRoomId: "other" } },
      { run: { jobId: "other" } }, { run: { taskId: "other" } },
      { job: { ownerId: "other" } }, { job: { requestorId: "other" } },
      { job: { laneKey: "other" } }, { job: { roomId: "other" } },
      { agentMember: false }, { roomExists: false }, { agentOwner: "other" },
      { profile: { id: "other" } }, { profile: { userId: "other" } },
      { profile: { authState: "signed_out" } }, { profile: { removalState: "removing" } },
      { profile: { profileGeneration: -1 } }, { profile: { accountGeneration: -1 } },
    ];
    for (const override of invalid) {
      await rejected(new CodexCanonicalFactsService(protectedReader(override), options).resolve(protectedRequest));
    }
    expect(calls).toBe(0);
  });

  test("requires the private hook to match valid coordinates to its exact accepted grant", async () => {
    let checks = 0;
    const options = { assertProtectedJobBinding: async ({ job }: Parameters<
      NonNullable<import("../../src/codex/canonical-facts").CodexCanonicalFactsOptions["assertProtectedJobBinding"]>
    >[0]) => {
      checks++;
      return job.input.authorizationRequestId === protectedReference.authorizationRequestId
        && job.input.policyRevision === protectedReference.policyRevision
        && job.input.inputObjectId === protectedReference.inputObjectId
        && job.input.resultObjectId === protectedReference.resultObjectId;
    } };
    for (const change of [
      { authorizationRequestId: "different-request" }, { policyRevision: 8 },
      { inputObjectId: `task-definition:v1:${"c".repeat(64)}` },
      { resultObjectId: `task-run-result:v1:${"d".repeat(64)}` },
    ]) {
      await rejected(new CodexCanonicalFactsService(protectedReader({
        job: { input: { ...protectedReference, ...change } },
      }), options).resolve(protectedRequest));
    }
    expect(checks).toBe(4);
  });

  test("normalizes a stale or throwing current-grant hook to a closed rejection", async () => {
    for (const hook of [async () => false, async (): Promise<boolean> => { throw new Error("private grant details"); }]) {
      await rejected(new CodexCanonicalFactsService(protectedReader(), {
        assertProtectedJobBinding: hook,
      }).resolve(protectedRequest));
    }
  });
});
