import { describe, expect, test } from "bun:test";

import {
  parseProtectedTaskContentResponseV1,
  type ProtectedTaskDefinitionDtoV1,
  type ProtectedTaskRunResultDtoV1,
} from "../../src/task/protected-task-dto-v1.ts";

describe("protected Task content DTO v1", () => {
  test("admits opaque definition and result coordinates without plaintext", () => {
    const protectedContent = parseProtectedTaskContentResponseV1({
      dtoVersion: 1,
      status: "protected",
      objectId: "task.object.1",
      contentRevision: 1,
      cryptoAccessRevision: 0,
    });
    const definition = {
      taskId: "task.1",
      content: protectedContent,
    } satisfies ProtectedTaskDefinitionDtoV1;
    const result = {
      taskId: "task.1",
      taskRunId: "task-run.1",
      content: protectedContent,
    } satisfies ProtectedTaskRunResultDtoV1;

    expect(definition.content).toEqual(protectedContent);
    expect(result.content).toEqual(protectedContent);
    expect(Object.isFrozen(protectedContent)).toBe(true);
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
      dtoVersion: 1,
      status: "protected",
      objectId: "task.object.1",
      contentRevision: 1,
      cryptoAccessRevision: 0,
      prompt: "must stay encrypted",
    })).toThrow("invalid");
    expect(() => parseProtectedTaskContentResponseV1({
      dtoVersion: 1,
      status: "protected",
      objectId: "task.object.1",
      contentRevision: 0,
      cryptoAccessRevision: 0,
    })).toThrow("invalid");
  });
});
