import { describe, expect, test } from "bun:test";
import type { TaskContentDetailV1, TaskContentSummaryV1, TaskDetail, TaskSummary } from "@nautilo/types";
import {
  MOBILE_PROTECTED_TASK_DETAIL,
  MOBILE_PROTECTED_TASK_LABEL,
  isMissingTaskContentProjection,
  mobileTaskDefinitionContent,
  mobileTaskRunContent,
  mobileTaskSummaryContent,
  mobileTaskTranscript,
} from "./task-content-mobile";

const ordinaryLegacy = {
  id: "task-1", parentTaskId: null, depth: 0, status: "pending", preset: "task",
  prompt: "Legacy preview", scheduleKind: "one_shot", nextFireAt: null,
  callingRoomId: null, lastError: null,
} as TaskSummary;

const protectedSummary = {
  id: "task-2", parentTaskId: null, depth: 0, status: "pending", preset: "task",
  scheduleKind: "cron", nextFireAt: null, callingRoomId: null,
  content: { dtoVersion: 1, status: "protected", objectId: "task:task-2", contentRevision: 1, cryptoAccessRevision: 1 },
} as TaskContentSummaryV1;

const protectedDetail = {
  task: protectedSummary,
  definition: protectedSummary.content,
  runs: [{
    id: "run-1", status: "completed", modelId: null, startedAt: null, completedAt: null,
    content: { dtoVersion: 1, status: "unavailable", reason: "unsupported_client" },
  }],
} as unknown as TaskContentDetailV1;

describe("Mobile Task content projection", () => {
  test("preserves ordinary previews and definitions exactly", () => {
    expect(mobileTaskSummaryContent(ordinaryLegacy)).toEqual({ status: "ordinary", prompt: "Legacy preview" });
    expect(mobileTaskSummaryContent({
      ...protectedSummary,
      content: { dtoVersion: 1, status: "ordinary", promptPreview: "New preview", lastError: null },
    })).toEqual({ status: "ordinary", prompt: "New preview" });
    expect(mobileTaskDefinitionContent({
      task: ordinaryLegacy,
      runs: [],
    } as unknown as TaskDetail)).toMatchObject({ status: "ordinary", prompt: "Legacy preview" });

    const ordinaryDetail = {
      ...protectedDetail,
      definition: { dtoVersion: 1, status: "ordinary", prompt: "Full ordinary task", expectedOutput: "A report", lastError: null },
      runs: [{
        ...protectedDetail.runs[0],
        content: { dtoVersion: 1, status: "ordinary", resultText: "Done", lastError: null, transcript: [{
          role: "assistant", content: "Ordinary transcript", toolName: null, toolCalls: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }] },
      }],
    } as TaskContentDetailV1;
    expect(mobileTaskDefinitionContent(ordinaryDetail)).toEqual({
      status: "ordinary", prompt: "Full ordinary task", expectedOutput: "A report",
    });
    expect(mobileTaskRunContent(ordinaryDetail.runs[0]).resultText).toBe("Done");
    expect(mobileTaskTranscript(ordinaryDetail)[0]?.content).toBe("Ordinary transcript");
  });

  test("shows lifecycle but no fabricated prompt or result for protected content", () => {
    expect("prompt" in protectedSummary).toBe(false);
    expect(mobileTaskSummaryContent(protectedSummary)).toEqual({
      status: "unsupported_client", prompt: MOBILE_PROTECTED_TASK_LABEL,
    });
    expect(mobileTaskDefinitionContent(protectedDetail)).toEqual({
      status: "unsupported_client", prompt: MOBILE_PROTECTED_TASK_LABEL, expectedOutput: null,
    });
    expect(mobileTaskRunContent(protectedDetail.runs[0])).toEqual({
      status: "unsupported_client", resultText: null, lastError: null,
    });
    expect(mobileTaskTranscript(protectedDetail)).toEqual([]);
    expect(MOBILE_PROTECTED_TASK_DETAIL).toContain("unavailable on this device");
  });

  test("does not show an ordinary run transcript beneath a protected definition", () => {
    const mixedDetail = {
      ...protectedDetail,
      runs: [{
        ...protectedDetail.runs[0],
        content: { dtoVersion: 1, status: "ordinary", resultText: "Old result", lastError: null, transcript: [{
          role: "assistant", content: "Old transcript", toolName: null, toolCalls: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }] },
      }],
    } as TaskContentDetailV1;
    expect(mobileTaskTranscript(mixedDetail)).toEqual([]);
  });

  test("only missing projection endpoints permit an older-server fallback", () => {
    expect(isMissingTaskContentProjection({ status: 404 })).toBe(true);
    expect(isMissingTaskContentProjection({ status: 405 })).toBe(true);
    expect(isMissingTaskContentProjection({ status: 501 })).toBe(true);
    expect(isMissingTaskContentProjection({ status: 409 })).toBe(false);
    expect(isMissingTaskContentProjection({ status: 403 })).toBe(false);
  });

  test("keeps the Plain detail presentation identical across legacy and content-v1 shapes", () => {
    const transcript = [{
      role: "assistant",
      content: "  preserve exact Plain response text  ",
      toolName: null,
      toolCalls: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    }];
    const legacy = {
      task: {
        ...ordinaryLegacy,
        prompt: "  preserve exact Plain prompt  ",
        expectedOutput: "Plain expected output",
      },
      runs: [{
        id: "run-plain",
        status: "completed",
        modelId: "model",
        resultText: "Plain result",
        lastError: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        transcript,
      }],
    } as unknown as TaskDetail;
    const current = {
      task: {
        ...ordinaryLegacy,
        prompt: undefined,
        cron: null,
        runAt: null,
        timezone: "UTC",
        targetChat: "orphan",
        resultDelivery: "wake",
        useScope: false,
        scopeId: null,
        toolsMode: "auto",
        toolsWhitelist: [],
        selectionProfile: "balanced",
        selectionSpec: null,
        requestedModelId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
      },
      definition: {
        dtoVersion: 1,
        status: "ordinary",
        prompt: "  preserve exact Plain prompt  ",
        expectedOutput: "Plain expected output",
        lastError: null,
      },
      runs: [{
        id: "run-plain",
        status: "completed",
        modelId: "model",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        content: {
          dtoVersion: 1,
          status: "ordinary",
          resultText: "Plain result",
          lastError: null,
          transcript,
        },
      }],
    } as unknown as TaskContentDetailV1;

    expect(mobileTaskDefinitionContent(current)).toEqual(mobileTaskDefinitionContent(legacy));
    expect(mobileTaskRunContent(current.runs[0])).toEqual(mobileTaskRunContent(legacy.runs[0]));
    expect(mobileTaskTranscript(current)).toEqual(mobileTaskTranscript(legacy));
    expect(mobileTaskTranscript(current)[0]?.content).toBe("  preserve exact Plain response text  ");
  });

  test("does not treat auth, policy, or schema failures as an old-server fallback", () => {
    for (const status of [400, 401, 403, 409, 422, 500, null]) {
      expect(isMissingTaskContentProjection(status === null ? new Error("schema") : { status }))
        .toBe(false);
    }
  });
});
