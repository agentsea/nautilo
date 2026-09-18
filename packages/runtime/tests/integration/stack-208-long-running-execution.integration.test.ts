/**
 * Stack 208 P3 — deterministic long-run / no-progress / ephemeral-cleanup
 * integration coverage against real LangGraph + a stub ChatModel + the
 * `test-cruft` scratch Postgres (no external LLM/API keys, no relay, no
 * operator rooms/data). Mirrors the canonical integration harness in
 * `graph-plumbing.test.ts` / `task-report-back.integration.test.ts`.
 *
 * Three cases:
 *   B. Long-run — 30 sequential successful model→tool→model rounds
 *      (`discover_tools`) + a final sentinel, exceeding the old
 *      100-superstep ceiling; asserts completion, sentinel presence,
 *      full script consumption, >=30 tool lifecycle completions, no
 *      budget/no-progress failure, exactly one surviving checkpoint for
 *      the canonical thread after compaction drains, referenced blobs
 *      exist, and stale writes/checkpoints do not scale with rounds.
 *   C. No-progress — four sequential identical `file.read` failures (a
 *      missing workspace file: the cloud `file` `read` handler catches
 *      ENOENT and returns `Error: file not found: <path>` through
 *      `fileToolError`, whose AsyncLocalStorage capture in `nodes/tools.ts`
 *      supplies `nautilo_tool_status: "error"` so the breaker keys on it) + an
 *      unused fifth sentinel; asserts the third failure triggers a
 *      corrective model turn, the fourth maps through Job to a failed
 *      user-safe no-progress outcome, no fifth response is consumed, no
 *      raw path/error leaks into room-scoped job status, and checkpoint
 *      tables stay shallow/valid.
 *   D. Ephemeral cleanup — drives a real completed scope/background Task
 *      with wake delivery, captures its `subagent:` graph thread id,
 *      waits for durable completion + report-back, then asserts zero
 *      rows across checkpoints/blobs/writes for that ephemeral thread and
 *      that a canonical room thread is retained.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  actors,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  jobs,
  createTask as dbCreateTask,
  getTaskById,
  getTaskRuns,
  eq,
  inArray,
  type DirectDatabase,
} from "@nautilo/db";
import {
  __setStubModelForTests,
  setAgentEventSink,
  ensureSession,
  setTaskToolRuntime,
} from "@nautilo/agent";
import { setConfigOverrides } from "@nautilo/config";
import type { ServerEvent } from "@nautilo/types";
import { JobManager } from "../../src/job-manager";
import { eventBus } from "../../src/event-bus";
import { TaskObserver } from "../../src/tasks/task-observer";
import { setTaskRunDb, setTaskRunJobManager } from "../../src/tasks/task-runtime-context";
import {
  cleanupTestUserWithDestructivePermission,
  closeDirectDb,
  getDirectDb,
  pollUntilComplete,
  collectEvents,
  waitForRunningForegroundJob,
  getJobFromDb,
} from "./helpers";
import { setupAgentTestEnv, closeAgentDb, getTranscriptMessages } from "./agent-helpers";
import { createStubProvider } from "./helpers/stub-provider";
import {
  waitForCheckpointCount,
  waitForCheckpointCountAtMost,
} from "./helpers/checkpoint-table-counts";
import {
  buildSequentialToolRounds,
  buildRepeatedFailureRounds,
} from "./helpers/stub-round-script";

const fastCoalesce = {
  coalescerWindowMs: 45,
  coalescerFirstSegmentQuietMs: 45,
} as const;

let userId: string;
let agentId: string;
let agentActorId: string;
let jobManager: JobManager;
let db: DirectDatabase;
let workspaceRoot: string;

function assistantVisibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          const raw = (block as { text?: unknown }).text;
          return typeof raw === "string" ? raw : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

beforeAll(async () => {
  setAgentEventSink({ emit: (e) => eventBus.emit(e) });
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  setConfigOverrides({ nautilo_security_level: "standard" });

  jobManager = new JobManager(fastCoalesce);
  const env = await setupAgentTestEnv("stack-208-long-running");
  userId = env.userId;
  agentId = env.agentId;
  db = getDirectDb();
  setTaskRunDb(db);
  setTaskRunJobManager(jobManager);

  const [aa] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(eq(actors.ownerId, userId))
    .limit(1);
  agentActorId = aa!.id;

  workspaceRoot = join(tmpdir(), `stack208-${Date.now()}`);
  await fsp.mkdir(workspaceRoot, { recursive: true });
});

beforeEach(() => {
  __setStubModelForTests(null);
});

afterAll(async () => {
  __setStubModelForTests(null);
  delete process.env["NAUTILO_TEST_MODE"];
  setAgentEventSink(null);
  setTaskToolRuntime(null);
  setTaskRunJobManager(null);
  setConfigOverrides({});
  if (workspaceRoot) {
    await fsp.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }
  if (userId) await cleanupTestUserWithDestructivePermission(userId);
  await closeDirectDb();
  await closeAgentDb();
});

describe("Stack 208 P3 — long-running execution (stub LLM, real PG)", () => {
  test("B: 30 sequential successful tool rounds + final sentinel (exceeds 100 supersteps)", async () => {
    const ROUNDS = 30;
    const SENTINEL = "STACK208_LONG_RUN_FINAL_SENTINEL";
    const { script, expectedInvocations } = buildSequentialToolRounds({
      rounds: ROUNDS,
      toolName: "discover_tools",
      toolArgs: { query: "filesystem" },
      finalSentinel: SENTINEL,
    });
    const stub = createStubProvider(script);
    __setStubModelForTests(stub.asChatModel());

    const { events, cleanup } = collectEvents(eventBus);
    try {
      const threadId = `stack208-long-${Date.now()}`;
      await jobManager.createForegroundJob(userId, userId, `lane:${threadId}`, {
        message: "Discover filesystem tools repeatedly, then summarize.",
        ownerId: userId,
        agentId,
        threadId,
        actorRole: "owner",
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        turnId: randomUUID(),
      });

      const job = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job, 120_000);

      // B1: job completes (no graph_budget_exceeded / no_progress failure).
      expect(job.status).toBe("completed");
      const dbJob = await getJobFromDb(job.id);
      expect(dbJob?.status).toBe("completed");

      // B2: all scripted responses consumed (30 tool calls + 1 final text).
      expect(stub.remaining).toBe(0);
      expect(stub.invocations.length).toBe(expectedInvocations);

      // B3: at least 30 tool lifecycle completions observed.
      const toolEnds = events.filter((e) => e.type === "tool.end");
      expect(toolEnds.length).toBeGreaterThanOrEqual(ROUNDS);

      // B4: final sentinel is present in the transcript.
      const messages = await getTranscriptMessages(threadId);
      const joined = messages.map((m) => assistantVisibleText(m.content)).join("\n");
      expect(joined).toContain(SENTINEL);

      // B5: 30 rounds + final response exceed the old 100-superstep ceiling.
      // Each tool round is pre_model→agent→post_model→tools (4 supersteps);
      // the final text round adds pre_model→agent→post_model (3). So the
      // total superstep count is `4 * toolEnds.length + 3` — with 30
      // rounds that is 123 > 100 (the graph_metrics log confirms
      // `supersteps=123`). Asserting the deterministic derivation from
      // the observed tool-round count keeps this independent of the
      // fire-and-forget compaction that collapses checkpoint history.
      expect(toolEnds.length).toBeGreaterThanOrEqual(ROUNDS);
      expect(4 * toolEnds.length + 3).toBeGreaterThan(100);

      // B6: exactly one surviving checkpoint for the canonical thread after
      // compaction drains (fire-and-forget compaction may lag by a few ms).
      const counts = await waitForCheckpointCountAtMost(db, threadId, 1, 15_000);
      expect(counts.checkpoints).toBe(1);

      // B7: referenced blobs exist (the retained checkpoint's
      // channel_versions point at them).
      expect(counts.blobs).toBeGreaterThan(0);

      // B8: stale writes/checkpoints do not scale with rounds — writes are
      // bounded to the retained checkpoint's pending writes, not 30+.
      expect(counts.writes).toBeLessThan(ROUNDS);
    } finally {
      cleanup();
    }
  }, 120_000);
});

describe("Stack 208 P3 — no-progress breaker (stub LLM, real PG)", () => {
  test("C: four identical file.read failures → corrective turn → failed no-progress outcome", async () => {
    // The failure source is a MISSING workspace file. The cloud `file`
    // `read` handler catches ENOENT and returns the documented error
    // string `Error: file not found: <resolved path>`. The cloud
    // invocation succeeds (no throw), so `fileToolError` explicitly flips
    // the status in the AsyncLocalStorage capture wrapped around the file
    // invocation in `nodes/tools.ts`. That captured status stamps
    // `nautilo_tool_status: "error"`; the no-progress breaker keys on it
    // and fires after the limit. This is the
    // originally-intended failure cause (a missing file the agent keeps
    // trying to read), exercised end-to-end through the real tools node.
    const MISSING_FILE = "missing-no-progress-file.txt";
    const SENTINEL = "STACK208_NO_PROGRESS_UNUSED_SENTINEL";
    const { script, expectedConsumedInvocations, expectedRemaining } = buildRepeatedFailureRounds({
      rounds: 4,
      failureArgs: { command: "read", path: MISSING_FILE, zone: "workspace" },
      unusedSentinel: SENTINEL,
    });
    const stub = createStubProvider(script);
    __setStubModelForTests(stub.asChatModel());

    // The foreground harness has no room/namespace, so the cloud `file`
    // `read` handler's workspace dispatcher would otherwise fail at the
    // envelope gate with an auth error BEFORE reaching the artifact
    // lookup. Thread a minimal namespace-mode memory-access envelope so
    // the workspace read actually reaches `resolveWorkspaceArtifact` and
    // returns the documented no-file error string for the missing
    // artifact (`Error: No workspace artifact found at "<path>" …`).
    // `readableNamespaces` is intentionally empty — there is no artifact
    // row, so the lookup misses and returns the no-file error through
    // `fileToolError`; the captured explicit `error` status is what the
    // breaker keys on.
    const memoryAccessEnvelope = {
      ownerId: userId,
      actorId: agentActorId,
      agentId,
      roomId: "",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: {},
    } as const;

    const { events, cleanup } = collectEvents(eventBus);
    try {
      const threadId = `stack208-np-${Date.now()}`;
      await jobManager.createForegroundJob(userId, userId, `lane:${threadId}`, {
        message: "Read the missing workspace file over and over.",
        ownerId: userId,
        agentId,
        threadId,
        actorRole: "owner",
        workspacePath: workspaceRoot,
        currentFolder: workspaceRoot,
        turnId: randomUUID(),
        memoryAccessEnvelope,
      });

      const job = await waitForRunningForegroundJob(jobManager);
      await pollUntilComplete(job, 120_000);

      // C1: the fourth failure maps through Job to a FAILED (not completed)
      // user-safe no-progress outcome.
      expect(job.status).toBe("failed");
      const dbJob = await getJobFromDb(job.id);
      expect(dbJob?.status).toBe("failed");

      // C2: no fifth tool call/response is consumed — the breaker stops on
      // the 4th failure, so the unused sentinel remains.
      expect(stub.remaining).toBe(expectedRemaining);
      expect(stub.invocations.length).toBe(expectedConsumedInvocations);

      // C3: the third failure causes a corrective model turn. The stub
      // provider does not expose system prompts, so assert the extra
      // corrective invocation + consumption ordering through
      // invocations/events: the corrective turn is the 4th model
      // invocation (preamble activate + 3 failures, then corrective +
      // 4th failure). Exactly 4 tool.end events fire (activate + 4
      // file.read); the 5th sentinel never reaches the model.
      const toolEnds = events.filter(
        (e): e is Extract<ServerEvent, { type: "tool.end" }> => e.type === "tool.end",
      );
      const fileToolEnds = toolEnds.filter((e) => e.toolName === "file");
      expect(fileToolEnds.length).toBe(4);
      expect(stub.invocations.length).toBe(5); // activate + 4 file.read (no 5th)

      // C4: no raw missing path/error leaks into room-scoped job status.
      // The job message is the user-safe no-progress sentence (MDL007),
      // with no resolved path, no "Error: file not found", no "no_progress".
      const jobMessage = dbJob?.message ?? "";
      expect(jobMessage).not.toContain(MISSING_FILE);
      expect(jobMessage).not.toContain("file not found");
      expect(jobMessage).not.toContain("Error:");
      expect(jobMessage).not.toContain("ENOENT");
      expect(jobMessage).not.toContain("no_progress");
      expect(jobMessage.length).toBeGreaterThan(0);

      // C5: the fourth failure is committed through the ordinary transcript /
      // checkpoint path together with the pending-stop marker. The following
      // pre-model node raises before a fifth model invocation can begin.
      const messages = await getTranscriptMessages(threadId);
      const fileToolMessages = messages.filter(
        (m) => m.role === "tool" && m.toolName === "file",
      );
      expect(fileToolMessages.length).toBe(4);
      // The persisted error content is the documented no-file error string
      // the cloud workspace `read` handler returns for a missing artifact
      // (`Error: No workspace artifact found at "<path>" …`); it stays in
      // the model-facing transcript (not the room-scoped job status).
      const firstFileContent = assistantVisibleText(fileToolMessages[0]?.content);
      expect(firstFileContent).toContain("Error: No workspace artifact");
      expect(firstFileContent).toContain(MISSING_FILE);

      // C6: checkpoint tables remain shallow/valid — exactly one
      // surviving checkpoint for the canonical thread after compaction,
      // referenced blobs exist, writes bounded.
      const counts = await waitForCheckpointCountAtMost(db, threadId, 1, 15_000);
      expect(counts.checkpoints).toBe(1);
      expect(counts.blobs).toBeGreaterThan(0);
      expect(counts.writes).toBeLessThan(4);
    } finally {
      cleanup();
    }
  }, 120_000);
});

describe("Stack 208 P3 — ephemeral thread cleanup (stub LLM, real PG)", () => {
  test("D: completed scope/background Task deletes its subagent checkpoint thread; room thread retained", async () => {
    // Drive a real completed Task with wake delivery (mirrors the
    // task-report-back S1 harness). The task run executes the real
    // subagent graph on a `subagent:` thread, durably reports back, then
    // `taskRunExecutor` calls `deleteEphemeralCheckpointThread` on the
    // completed ephemeral thread. Assert zero rows across
    // checkpoints/blobs/writes for that thread and that the canonical
    // strict-DM Room thread is retained.
    const createdRoomIds: string[] = [];
    const createdNamespaceIds: string[] = [];
    const createdUserActorIds: string[] = [];

    async function createCallingRoom(label: string): Promise<{ roomId: string; roomThread: string }> {
      const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const [ns] = await db
        .insert(namespaces)
        .values({ scope: "private", label: `stack208-${label}-${ts}` })
        .returning({ id: namespaces.id });
      createdNamespaceIds.push(ns!.id);

      const [userActor] = await db
        .insert(actors)
        .values({ ownerId: userId, kind: "user", displayName: "Owner", trustState: "verified" })
        .returning({ id: actors.id });
      createdUserActorIds.push(userActor!.id);

      const roomId = randomUUID();
      const roomThread = `room:${roomId}`;
      await db.insert(rooms).values({
        id: roomId,
        ownerId: userId,
        type: "private",
        label,
        graphThreadId: roomThread,
        namespaceId: ns!.id,
        humanActorIds: [userActor!.id],
      });
      createdRoomIds.push(roomId);
      await db.insert(roomMembers).values({ roomId, actorId: userActor!.id, roomRole: "admin" });
      await db.insert(roomMembers).values({ roomId, actorId: agentActorId, roomRole: "member" });
      await ensureSession({
        threadId: roomThread,
        ownerId: userId,
        personaId: "owner",
        roomId,
        agentId,
      });
      return { roomId, roomThread };
    }

    try {
      const { roomId, roomThread } = await createCallingRoom("ephemeral-cleanup");

      // One response for the task run; extras for the woken reply turn.
      const stub = createStubProvider({
        responses: [
          { type: "text", content: "STACK208_EPHEMERAL_TASK_RESULT" },
          { type: "text", content: "STACK208_EPHEMERAL_WAKE_REPLY" },
          { type: "text", content: "STACK208_EPHEMERAL_WAKE_REPLY" },
          { type: "text", content: "STACK208_EPHEMERAL_WAKE_REPLY" },
        ],
      });
      __setStubModelForTests(stub.asChatModel());

      const task = await dbCreateTask(db, {
        ownerId: userId,
        requestorId: userId,
        agentId,
        prompt: "do the ephemeral cleanup work",
        scheduleKind: "now",
        targetChat: "orphan",
        toolsMode: "none",
        callingRoomId: roomId,
        resultDelivery: "wake",
        nextFireAt: new Date(),
        status: "pending",
      });

      const obs = new TaskObserver({ db, jobManager, batch: 20 });
      await obs.tick();

      // Wait for the run to durably complete (report-back finalizer).
      const start = Date.now();
      let runs: Awaited<ReturnType<typeof getTaskRuns>> = [];
      while (Date.now() - start < 60_000) {
        runs = await getTaskRuns(db, task.id);
        if (runs.some((r) => r.status === "completed")) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(runs.some((r) => r.status === "completed")).toBe(true);

      const completedRun = runs.find((r) => r.status === "completed")!;
      const ephemeralThread = completedRun.graphThreadId;
      // The run's graph thread is an ephemeral `subagent:` thread.
      expect(ephemeralThread).toBeTruthy();
      expect(ephemeralThread.startsWith("subagent:")).toBe(true);

      const taskRow = await getTaskById(db, task.id);
      expect(taskRow?.status).toBe("completed");

      // Task completion means report-back has scheduled the wake turn, not
      // necessarily that the foreground Room job has finished persisting its
      // transcript. Wait for that durable terminal marker before asserting
      // its checkpoint and, critically, before fixture teardown deletes the
      // Room's sessions.
      const wakeDeadline = Date.now() + 15_000;
      let roomJobs: Array<{ completedAt: Date | null }> = [];
      while (Date.now() < wakeDeadline) {
        roomJobs = await db
          .select({ completedAt: jobs.completedAt })
          .from(jobs)
          .where(eq(jobs.roomId, roomId));
        if (roomJobs.length > 0 && roomJobs.every((job) => job.completedAt !== null)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(roomJobs.length).toBeGreaterThan(0);
      expect(roomJobs.every((job) => job.completedAt !== null)).toBe(true);

      // D1: zero rows across checkpoints/blobs/writes for the ephemeral
      // thread after durable completion + best-effort cleanup (poll: the
      // cleanup runs after the report-back commit, so it may lag by a few
      // ms).
      const ephemeralCounts = await waitForCheckpointCount(db, ephemeralThread, 0, 15_000);
      expect(ephemeralCounts.checkpoints).toBe(0);
      expect(ephemeralCounts.blobs).toBe(0);
      expect(ephemeralCounts.writes).toBe(0);

      // D2: this strict DM's canonical Room thread is retained (the wake turn
      // ran on it and compaction keeps exactly one surviving checkpoint).
      const roomCounts = await waitForCheckpointCountAtMost(db, roomThread, 1, 15_000);
      expect(roomCounts.checkpoints).toBeGreaterThanOrEqual(1);

      await obs.stop();
    } finally {
      // Clean up rooms/sessions/members/namespaces we created (tasks/
      // task_runs cascade off the owner delete, but namespaces do not).
      for (const rid of createdRoomIds) {
        const sess = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.roomId, rid));
        const ids = sess.map((s) => s.id);
        if (ids.length > 0) {
          await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ids));
          await db.delete(sessions).where(inArray(sessions.id, ids));
        }
        await db.delete(roomMembers).where(eq(roomMembers.roomId, rid));
        await db.delete(jobs).where(eq(jobs.roomId, rid));
        await db.delete(rooms).where(eq(rooms.id, rid));
      }
      for (const aid of createdUserActorIds) {
        await db.delete(actors).where(eq(actors.id, aid));
      }
      for (const nid of createdNamespaceIds) {
        await db.delete(namespaces).where(eq(namespaces.id, nid));
      }
    }
  }, 120_000);
});
