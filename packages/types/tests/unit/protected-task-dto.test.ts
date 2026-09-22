import { describe, expect, test } from "bun:test";

import {
  PROTECTED_TASK_PORTABLE_ID_MAX_UTF8_BYTES_V1,
  parseProtectedTaskContentResponseV1,
  parseProtectedTaskDefinitionDtoV1,
  parseProtectedTaskRunResultDtoV1,
} from "../../src/protected-task-dto";

const protectedContent = {
  dtoVersion: 1,
  status: "protected",
  objectId: "task.object.1",
  contentRevision: 1,
  cryptoAccessRevision: 0,
} as const;

describe("protected Task DTO v1", () => {
  test("strictly parses bounded definition and run-result coordinates", () => {
    const definition = parseProtectedTaskDefinitionDtoV1({
      taskId: "task.1",
      content: protectedContent,
    });
    const result = parseProtectedTaskRunResultDtoV1({
      taskId: "task.1",
      taskRunId: "task-run.1",
      content: protectedContent,
    });

    expect(definition).toEqual({ taskId: "task.1", content: protectedContent });
    expect(result).toEqual({
      taskId: "task.1",
      taskRunId: "task-run.1",
      content: protectedContent,
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.content)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("admits only the closed unavailable vocabulary", () => {
    for (const reason of [
      "waiting_for_authorization",
      "device_not_ready",
      "authority_changed",
      "unsupported_client",
      "integrity_failure",
    ] as const) {
      expect(parseProtectedTaskContentResponseV1({
        dtoVersion: 1,
        status: "unavailable",
        reason,
      })).toEqual({ dtoVersion: 1, status: "unavailable", reason });
    }
    expect(() => parseProtectedTaskContentResponseV1({
      dtoVersion: 1,
      status: "unavailable",
      reason: "plaintext_fallback",
    })).toThrow("invalid");
  });

  test("rejects plaintext, unknown fields, and invalid revisions", () => {
    expect(() => parseProtectedTaskContentResponseV1({
      ...protectedContent,
      prompt: "must stay encrypted",
    })).toThrow("invalid");
    expect(() => parseProtectedTaskContentResponseV1({
      ...protectedContent,
      contentRevision: 0,
    })).toThrow("invalid");
    expect(() => parseProtectedTaskDefinitionDtoV1({
      taskId: "task.1",
      content: protectedContent,
      extra: true,
    })).toThrow("invalid");
  });

  test("enforces the canonical portable identifier grammar and byte bound", () => {
    const maximumId = "a".repeat(PROTECTED_TASK_PORTABLE_ID_MAX_UTF8_BYTES_V1);
    expect(parseProtectedTaskDefinitionDtoV1({
      taskId: maximumId,
      content: protectedContent,
    }).taskId).toBe(maximumId);

    for (const invalidId of [
      "",
      "contains space",
      "é",
      "a".repeat(PROTECTED_TASK_PORTABLE_ID_MAX_UTF8_BYTES_V1 + 1),
    ]) {
      expect(() => parseProtectedTaskDefinitionDtoV1({
        taskId: invalidId,
        content: protectedContent,
      })).toThrow("invalid");
      expect(() => parseProtectedTaskRunResultDtoV1({
        taskId: "task.1",
        taskRunId: invalidId,
        content: protectedContent,
      })).toThrow("invalid");
    }
  });
});
