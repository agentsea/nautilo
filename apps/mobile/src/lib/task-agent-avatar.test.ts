import { describe, expect, test } from "bun:test";
import { taskAgentAvatarPath } from "./task-agent-avatar";

describe("taskAgentAvatarPath", () => {
  test("uses the canonical exact-Task avatar route", () => {
    expect(taskAgentAvatarPath("b487068d-9720-4f0f-a7a0-e84d9e4bff54")).toBe(
      "/api/tasks/b487068d-9720-4f0f-a7a0-e84d9e4bff54/agent/avatar",
    );
  });

  test("encodes a task ID as one path segment", () => {
    expect(taskAgentAvatarPath("task/id?with#reserved chars")).toBe(
      "/api/tasks/task%2Fid%3Fwith%23reserved%20chars/agent/avatar",
    );
  });
});
