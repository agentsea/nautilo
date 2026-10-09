import { describe, expect, test } from "bun:test";
import type { Task } from "@nautilo/db";

import { callerTaskToolIntentMatches } from "../../src/tasks/task-run-executor";

function task(
  toolsMode: Task["toolsMode"],
  toolsWhitelist: string[] = [],
): Pick<Task, "toolsMode" | "toolsWhitelist"> {
  return { toolsMode, toolsWhitelist };
}

describe("caller-funded Task durable tool intent", () => {
  test("auto mode requires the durable job input to omit toolWhitelist", () => {
    expect(callerTaskToolIntentMatches(task("auto"), {})).toBe(true);
    expect(callerTaskToolIntentMatches(task("auto"), { toolWhitelist: [] })).toBe(false);
    expect(callerTaskToolIntentMatches(task("auto"), { toolWhitelist: undefined })).toBe(false);
    expect(callerTaskToolIntentMatches(task("auto"), { toolWhitelist: ["file"] })).toBe(false);
  });

  test("none mode requires an explicit empty whitelist", () => {
    expect(callerTaskToolIntentMatches(task("none"), { toolWhitelist: [] })).toBe(true);
    expect(callerTaskToolIntentMatches(task("none"), {})).toBe(false);
    expect(callerTaskToolIntentMatches(task("none"), { toolWhitelist: ["file"] })).toBe(false);
  });

  test("whitelist mode requires the exact canonical ordered list", () => {
    const canonical = task("whitelist", ["file", "run_web_search"]);
    expect(callerTaskToolIntentMatches(canonical, {
      toolWhitelist: ["file", "run_web_search"],
    })).toBe(true);
    expect(callerTaskToolIntentMatches(canonical, {
      toolWhitelist: ["run_web_search", "file"],
    })).toBe(false);
    expect(callerTaskToolIntentMatches(canonical, {
      toolWhitelist: ["file"],
    })).toBe(false);
    expect(callerTaskToolIntentMatches(canonical, {})).toBe(false);
  });

  test("legacy exec-only intent accepts only its canonical lifecycle companion", () => {
    const legacy = task("whitelist", ["exec_command"]);
    expect(callerTaskToolIntentMatches(legacy, {
      toolWhitelist: ["exec_command", "write_stdin"],
    })).toBe(true);
    expect(callerTaskToolIntentMatches(legacy, {
      toolWhitelist: ["exec_command", "write_stdin", "file"],
    })).toBe(false);
    expect(callerTaskToolIntentMatches(legacy, {
      toolWhitelist: ["write_stdin", "exec_command"],
    })).toBe(false);
  });
});
