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
