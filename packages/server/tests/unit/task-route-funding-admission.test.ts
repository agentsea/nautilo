import { describe, expect, mock, test } from "bun:test";
import type { FastifyReply } from "fastify";
import type { Task, TaskRun } from "@nautilo/db";
import { TaskFundingError } from "@nautilo/runtime";
import {
  callerTargetChatChangeConflictsWithResume,
  requireTaskFundingForMutation,
  taskTargetChatPatch,
} from "../../src/routes/tasks";

function task(): Task {
  return { id: "task-1", requestorId: "human-1" } as Task;
}

function replyFixture() {
  const send = mock((_body: unknown) => undefined);
  const status = mock((_status: number) => ({ send }));
  return { reply: { status } as unknown as FastifyReply, status, send };
}

describe("Task route funding admission", () => {
  test("clears a memoized target Room only when the target mode changes", () => {
    const existing = { targetChat: "last_in_namespace" as const };
    expect(taskTargetChatPatch(existing, undefined)).toEqual({});
    expect(taskTargetChatPatch(existing, "last_in_namespace")).toEqual({
      targetChat: "last_in_namespace",
    });
    expect(taskTargetChatPatch(existing, "orphan")).toEqual({
      targetChat: "orphan",
      targetRoomId: null,
    });
  });

  test("rejects only caller-funded target changes with a resumable run", () => {
    const priorRun = { id: "run-1" } as TaskRun;
    expect(callerTargetChatChangeConflictsWithResume(
      { fundingMode: "caller", targetChat: "last_in_namespace" },
      "orphan",
      priorRun,
    )).toBe(true);
    expect(callerTargetChatChangeConflictsWithResume(
      { fundingMode: "caller", targetChat: "last_in_namespace" },
      "last_in_namespace",
      priorRun,
    )).toBe(false);
    expect(callerTargetChatChangeConflictsWithResume(
      { fundingMode: "caller", targetChat: "last_in_namespace" },
      "orphan",
      undefined,
    )).toBe(false);
    expect(callerTargetChatChangeConflictsWithResume(
      { fundingMode: "legacy_server", targetChat: "last_in_namespace" },
      "orphan",
      priorRun,
    )).toBe(false);
  });

  test("accepts a caller-funded update without consulting the legacy server gate", async () => {
    const legacy = mock(async () => false);
    const priorRun = { id: "run-1" } as TaskRun;
    const allowed = await requireTaskFundingForMutation({
      task: task(), priorRun, origin: "task_update", reply: replyFixture().reply,
      assertAdmission: mock(async (candidate: Task, prior?: TaskRun) => {
        expect(candidate.requestorId).toBe("human-1");
        expect(prior).toBe(priorRun);
        return {
          modelId: "provider:model",
          binding: { kind: "server" as const, providerRoute: "provider" },
        };
      }),
      requireLegacyServerFunding: legacy,
    });
    expect(allowed).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
  });

  test("keeps the existing server funding gate for legacy Tasks", async () => {
    const legacy = mock(async () => true);
    const fixture = replyFixture();
    expect(await requireTaskFundingForMutation({
      task: task(), origin: "task_unpause", reply: fixture.reply,
      assertAdmission: mock(async () => null),
      requireLegacyServerFunding: legacy,
    })).toBe(true);
    expect(legacy).toHaveBeenCalledWith("human-1", "task_unpause", fixture.reply);
  });

  test("returns only a safe funding code when live admission rejects resume", async () => {
    const fixture = replyFixture();
    expect(await requireTaskFundingForMutation({
      task: task(), origin: "task_unpause", reply: fixture.reply,
      assertAdmission: mock(async () => {
        throw new TaskFundingError("personal_credential_stale");
      }),
    })).toBe(false);
    expect(fixture.status).toHaveBeenCalledWith(409);
    expect(fixture.send).toHaveBeenCalledWith({ error: "personal_credential_stale" });
  });
});
