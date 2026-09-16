import type {
  CodexCanonicalBindingFacts,
  CodexCanonicalFactsPort,
  CodexSemanticAuthorityRequest,
} from "./authority";
import {
  and,
  actors,
  eq,
  getCodexProfileWith,
  jobs,
  roomMembers,
  rooms,
  taskRuns,
  tasks,
  type DirectDatabase,
} from "@nautilo/db";

/**
 * Stable, deliberately detail-free rejection used by the persisted-facts
 * adapter.  Callers must not turn a failed comparison into an oracle for
 * another user's Task, Room, profile, or Job.
 */
export class CodexCanonicalFactsRejected extends Error {
  readonly code = "CODEX_CANONICAL_FACTS_REJECTED";

  constructor() {
    super("CODEX_CANONICAL_FACTS_REJECTED");
    this.name = "CodexCanonicalFactsRejected";
  }
}

export interface CanonicalCodexTaskRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly parentTaskId: string | null;
  /** The server-authored Room this Task is allowed to execute in. */
  readonly targetRoomId: string | null;
}

export interface CanonicalCodexTaskRunRecord {
  readonly id: string;
  readonly taskId: string;
  readonly jobId: string | null;
  readonly graphThreadId: string;
}

export interface CanonicalCodexJobRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly requestorId: string;
  readonly laneKey: string | null;
  readonly roomId: string | null;
  readonly input: Readonly<Record<string, unknown>> | null;
}

export interface CanonicalCodexProfileRecord {
  readonly id: string;
  readonly userId: string;
  readonly relayId: string;
  readonly homeHandle: string;
  readonly profileGeneration: number;
  readonly accountGeneration: number;
  readonly authState: string;
  readonly removalState: string;
}

/**
 * DB/trust reader boundary for {@link CodexCanonicalFactsService}.
 *
 * Every field is persisted or derived from the existing Room membership graph;
 * there is intentionally no browser request object in this interface.
 */
export interface CodexCanonicalFactsReader {
  getTask(taskId: string): Promise<CanonicalCodexTaskRecord | null>;
  getTaskRun(taskRunId: string): Promise<CanonicalCodexTaskRunRecord | null>;
  getJob(jobId: string): Promise<CanonicalCodexJobRecord | null>;
  roomExists(roomId: string): Promise<boolean>;
  isAgentMember(roomId: string, agentId: string): Promise<boolean>;
  getAgentOwner(agentId: string): Promise<string | null>;
  getProfile(userId: string, profileId: string): Promise<CanonicalCodexProfileRecord | null>;
}

/**
 * Concrete read adapter for server composition. Every lookup uses the injected
 * DB handle; profile lookup retains the owner-scoped RLS helper rather than
 * reading an account profile by guessed UUID.
 */
export function createCodexCanonicalFactsReader(
  db: DirectDatabase,
): CodexCanonicalFactsReader {
  return {
    async getTask(taskId) {
      const [row] = await db
        .select({
          id: tasks.id,
          ownerId: tasks.ownerId,
          requestorId: tasks.requestorId,
          agentId: tasks.agentId,
          parentTaskId: tasks.parentTaskId,
          targetRoomId: tasks.targetRoomId,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1);
      return row ?? null;
    },
    async getTaskRun(taskRunId) {
      const [row] = await db
        .select({
          id: taskRuns.id,
          taskId: taskRuns.taskId,
          jobId: taskRuns.jobId,
          graphThreadId: taskRuns.graphThreadId,
        })
        .from(taskRuns)
        .where(eq(taskRuns.id, taskRunId))
        .limit(1);
      return row ?? null;
    },
    async getJob(jobId) {
      const [row] = await db
        .select({
          id: jobs.id,
          ownerId: jobs.ownerId,
          requestorId: jobs.requestorId,
          laneKey: jobs.laneKey,
          roomId: jobs.roomId,
          input: jobs.input,
        })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1);
      return row ?? null;
    },
    async roomExists(roomId) {
      const [row] = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.id, roomId))
        .limit(1);
      return Boolean(row);
    },
    async isAgentMember(roomId, agentId) {
      const [row] = await db
        .select({ actorId: actors.id })
        .from(roomMembers)
        .innerJoin(actors, eq(actors.id, roomMembers.actorId))
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(actors.agentId, agentId),
            eq(actors.kind, "agent"),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async getAgentOwner(agentId) {
      const [row] = await db
        .select({ ownerId: actors.ownerId })
        .from(actors)
        .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
        .limit(1);
      return row?.ownerId ?? null;
    },
    async getProfile(userId, profileId) {
      // Keep this owner-scoped because `codex_account_profiles` has forced
      // RLS. The structural cast is the repo's existing direct/server DB
      // compatibility seam; both clients expose the same Drizzle operations.
      const row = await getCodexProfileWith(
        db as Parameters<typeof getCodexProfileWith>[0],
        { userId },
        profileId,
      );
      if (!row) return null;
      return {
        id: row.id,
        userId: row.userId,
        relayId: row.relayId,
        homeHandle: row.homeHandle,
        profileGeneration: row.profileGeneration,
        accountGeneration: row.accountGeneration,
        authState: row.authState,
        removalState: row.removalState,
      };
    },
  };
}

function safeGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmpty(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

function inputString(input: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = input?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Turns a semantic authority request into DB-proven binding facts.
 *
 * This is intentionally stricter than a relation-only lookup: the TaskRun's
 * persisted Job, the Job's persisted Room/lane/input attribution, the Room
 * membership, the Agent owner, and the owner-scoped profile must all agree.
 * A later caller cannot swap one UUID after a turn has been accepted.
 */
export class CodexCanonicalFactsService implements CodexCanonicalFactsPort {
  constructor(private readonly reader: CodexCanonicalFactsReader) {}

  async resolve(
    request: Omit<CodexSemanticAuthorityRequest, "posture" | "collaborationMode">,
  ): Promise<CodexCanonicalBindingFacts> {
    const [task, run, job, roomExists, agentOwner, profile] = await Promise.all([
      this.reader.getTask(request.taskId),
      this.reader.getTaskRun(request.taskRunId),
      this.reader.getJob(request.jobId),
      this.reader.roomExists(request.roomId),
      this.reader.getAgentOwner(request.agentId),
      this.reader.getProfile(request.actorId, request.profileId),
    ]);

    if (
      !task ||
      !run ||
      !job ||
      !roomExists ||
      !profile ||
      task.id !== request.taskId ||
      run.id !== request.taskRunId ||
      job.id !== request.jobId ||
      task.ownerId !== request.actorId ||
      task.requestorId !== request.actorId ||
      task.agentId !== request.agentId ||
      task.targetRoomId !== request.roomId ||
      run.taskId !== task.id ||
      run.jobId !== job.id ||
      job.ownerId !== task.ownerId ||
      job.requestorId !== task.requestorId ||
      job.laneKey !== request.laneKey ||
      job.roomId !== request.roomId ||
      inputString(job.input, "taskId") !== task.id ||
      inputString(job.input, "taskRunId") !== run.id ||
      inputString(job.input, "agentId") !== task.agentId ||
      inputString(job.input, "roomId") !== request.roomId ||
      inputString(job.input, "graphThreadId") !== run.graphThreadId ||
      agentOwner !== task.ownerId ||
      !nonEmpty(profile.relayId) ||
      !nonEmpty(profile.homeHandle) ||
      profile.id !== request.profileId ||
      profile.userId !== task.ownerId ||
      profile.authState !== "signed_in" ||
      profile.removalState !== "active" ||
      !safeGeneration(profile.profileGeneration) ||
      !safeGeneration(profile.accountGeneration)
    ) {
      throw new CodexCanonicalFactsRejected();
    }

    const member = await this.reader.isAgentMember(request.roomId, request.agentId);
    if (!member) throw new CodexCanonicalFactsRejected();

    return Object.freeze({
      userId: task.ownerId,
      agentId: task.agentId,
      taskId: task.id,
      taskRunId: run.id,
      jobId: job.id,
      parentTaskId: task.parentTaskId,
      roomId: request.roomId,
      laneKey: request.laneKey,
      profileId: profile.id,
      relayId: profile.relayId,
      // `codex_account_profiles.id` is the host-visible profile handle. The
      // separate homeHandle identifies its private CODEX_HOME and must never
      // be substituted into relay status/profile matching.
      profileHandle: profile.id,
      profileGeneration: profile.profileGeneration,
      accountGeneration: profile.accountGeneration,
    });
  }
}
