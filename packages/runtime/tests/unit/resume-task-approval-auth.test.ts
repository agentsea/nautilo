import { describe, test, expect } from "bun:test";
import type { DirectDatabase, Task, TaskRun } from "@nautilo/db";
import { authorizeTaskApprovalResume } from "../../src/tasks/resume-task-approval";
import { AgentInvocationDeniedError, ServerProviderCredentialsDeniedError } from "@nautilo/trust";

/**
 * M164 (MV3) — owner-only authorization for a Task approval resume. DB-free:
 * a fake `db` returns the parked task+run row (or nothing) so we can assert the
 * fail-closed posture (404 for not-found AND for another user's attempt) without
 * Postgres. The resume + finalization itself is graph-bound and lives in the
 * integration suite.
 */

function fakeDb(row: { task: Task; run: TaskRun } | undefined): DirectDatabase {
  const result = row ? [{ task: row.task, run: row.run }] : [];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => result,
  };
  return {
    select: () => chain,
    end: async () => undefined,
  } as unknown as DirectDatabase;
}

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: "task-1",
    ownerId: "owner-1",
    agentId: "agent-1",
    status: "awaiting",
    targetChat: "orphan",
    targetRoomId: null,
    scheduleKind: "now",
    ...over,
  }) as unknown as Task;

const run = (over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: "run-1",
    taskId: "task-1",
    graphThreadId: "subagent:thread-1",
    status: "awaiting",
    ...over,
  }) as unknown as TaskRun;

describe("M164 authorizeTaskApprovalResume", () => {
  test("owner of an awaiting task+run is authorized", async () => {
    const res = await authorizeTaskApprovalResume(
      { taskId: "task-1", threadId: "subagent:thread-1", sessionUserId: "owner-1" },
      {
        db: fakeDb({ task: task({ requestorId: "owner-1" }), run: run() }),
        assertInvocation: async () => {},
        assertServerFunding: async () => {},
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.task.id).toBe("task-1");
      expect(res.run.id).toBe("run-1");
    }
  });

  test("no awaiting task/run for (taskId, threadId) → 404 fail-closed", async () => {
    const res = await authorizeTaskApprovalResume(
      { taskId: "task-1", threadId: "subagent:thread-1", sessionUserId: "owner-1" },
      { db: fakeDb(undefined) },
    );
    expect(res).toEqual({ ok: false, status: 404, error: "task_approval_not_found" });
  });

  test("another user cannot resume the task approval → 404 fail-closed (not 403)", async () => {
    const res = await authorizeTaskApprovalResume(
      { taskId: "task-1", threadId: "subagent:thread-1", sessionUserId: "intruder-9" },
      { db: fakeDb({ task: task({ ownerId: "owner-1" }), run: run() }) },
    );
    expect(res).toEqual({ ok: false, status: 404, error: "task_approval_not_found" });
  });

  test("an incapable initiating Human gets the stable denial and pauses the parked work", async () => {
    const res = await authorizeTaskApprovalResume(
      { taskId: "task-1", threadId: "subagent:thread-1", sessionUserId: "owner-1" },
      {
        db: fakeDb({
          task: task({ requestorId: "requestor-2" }),
          run: run(),
        }),
        assertInvocation: async (input) => {
          if (input.humanUserId === "requestor-2") {
            throw new AgentInvocationDeniedError(input);
          }
        },
        assertServerFunding: async () => {},
        pauseForAuthorizationDenial: async () => ({ task: task({ status: "paused" }), run: run({ status: "paused" }), transitioned: true }),
      },
    );
    expect(res).toEqual({
      ok: false,
      status: 403,
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });
  });

  test("an initiating Human without server funding cannot resume paid work", async () => {
    const res = await authorizeTaskApprovalResume(
      { taskId: "task-1", threadId: "subagent:thread-1", sessionUserId: "owner-1" },
      {
        db: fakeDb({ task: task({ requestorId: "requestor-2" }), run: run() }),
        assertInvocation: async () => {},
        assertServerFunding: async (humanUserId) => {
          if (humanUserId === "requestor-2") {
            throw new ServerProviderCredentialsDeniedError(humanUserId);
          }
        },
        pauseForAuthorizationDenial: async () => ({ task: task({ status: "paused" }), run: run({ status: "paused" }), transitioned: true }),
      },
    );
    expect(res).toEqual({
      ok: false,
      status: 403,
      error: "server_provider_credentials_required",
      code: "server_provider_credentials_required",
      capability: "use_server_provider_credentials",
    });
  });
});


test("a withdrawn responder gets the access denial without mislabeling its retained grant", async () => {
  const result = await authorizeTaskApprovalResume(
    { taskId: "task-1", threadId: "subagent:thread-1", sessionUserId: "owner-1" },
    { db: fakeDb({ task: task({ requestorId: "other-human" }), run: run() }),
      assertInvocation: async input => {
        if (input.humanUserId === "owner-1") throw new AgentInvocationDeniedError(input, "invocation_access_withdrawn");
      }, assertServerFunding: async () => {} },
  );
  expect(result).toMatchObject({ ok: false, status: 403,
    error: "invocation_access_withdrawn", code: "invocation_access_withdrawn" });
});
