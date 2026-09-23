import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import * as db from "@nautilo/db";
import { createTaskTool } from "../../src/tools/tasks/task-tool";
import { dispatchTaskCommand } from "../../src/tools/tasks/dispatch";
import {
  setTaskToolRuntime,
  type TaskToolCreateInput,
  type TaskToolRuntime,
} from "../../src/tools/tasks/task-tool-runtime";
import {
  createTaskToolSchema,
  listTaskToolCommandNames,
  taskToolSchema,
} from "../../src/tools/tasks/schema";
import * as sessionStore from "../../src/store/session-store";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const ROOM_ID = "30000000-0000-4000-8000-000000000003";
const OTHER_OWNER_ID = "40000000-0000-4000-8000-000000000004";

const CTX = { ownerId: OWNER_ID, causalHumanUserId: OWNER_ID, agentId: AGENT_ID, roomId: ROOM_ID, taskReadMaxResponseBytes: 100_000 };

describe("task tool (M143)", () => {
  let capturedCreate: TaskToolCreateInput | null = null;
  const restores: Array<() => void> = [];

  afterEach(() => {
    setTaskToolRuntime(null);
    capturedCreate = null;
    while (restores.length) restores.pop()!();
  });

  function stubRuntime(overrides: Partial<TaskToolRuntime> = {}) {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async (input) => {
        capturedCreate = input;
        return { taskId: "t1", status: "pending" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
      ...overrides,
    });
  }

  test("createTaskTool().name === 'task'", () => {
    expect(createTaskTool().name).toBe("task");
  });

  test("describes connected harness delegation as task-owned rather than shell-owned", () => {
    const description = createTaskTool().description;
    expect(description).toContain("If the user explicitly asks for Codex");
    expect(description).toContain("harness: 'codex'");
    expect(description).toContain("never another executor");
  });

  test("distinguishes Native running acknowledgement from external admission receipts", () => {
    const description = createTaskTool().description;
    expect(description).toContain(
      "A Nautilo Native create receipt may deterministically report that its task is running in the background",
    );
    expect(description).toContain(
      "For an external harness create receipt, say only that the task was accepted",
    );
    expect(description).toContain(
      "authoritative task card and report-back determine whether it started and how it ended",
    );
    expect(description).toContain(
      "Do not describe an external harness task as pending or running",
    );
  });

  test("schema accepts valid create args", () => {
    const parsed = taskToolSchema.parse({
      command: "create",
      prompt: "Summarize the inbox",
    });
    expect(parsed).toEqual({
      command: "create",
      prompt: "Summarize the inbox",
    });
  });

  test("schema keeps harness selection compact and opt-in", () => {
    expect(taskToolSchema.parse({ command: "create", prompt: "Use Codex", harness: "codex", collaboration_mode: "plan" })).toMatchObject({
      harness: "codex",
      collaboration_mode: "plan",
    });
    expect(taskToolSchema.parse({ command: "create", prompt: "Native by default" }).harness).toBeUndefined();
  });

  test("schema does not advertise deferred OpenCode execution", () => {
    expect(() => taskToolSchema.parse({ command: "create", prompt: "Use OpenCode", harness: "opencode-acp" })).toThrow();
    expect("execution_profile" in taskToolSchema.shape).toBeFalse();
  });

  test("keeps Claude Code out of the legacy tool while the enabled factory advertises it", () => {
    setTaskToolRuntime(null);
    expect(taskToolSchema.shape.harness.unwrap().options).not.toContain("claude-code");
    expect(taskToolSchema.safeParse({ command: "create", prompt: "x", harness: "claude-code" }).success).toBe(false);
    expect(createTaskTool().description).not.toContain("CLAUDE CODE");

    setTaskToolRuntime({
      db: {} as never,
      claudeCodeTasksEnabled: true,
      createTask: async () => ({ taskId: "native", status: "pending" }),
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    expect(createTaskToolSchema({ claudeCode: true }).shape.harness.unwrap().options).toContain("claude-code");
    expect(createTaskTool().description).toContain("first call `list_harness_models` with `harness: 'claude-code'`");
  });

  test("Claude Code list and create recheck the runtime opt-in and return only the sealed model receipt", async () => {
    let nativeCalls = 0;
    let capturedHarness: unknown;
    setTaskToolRuntime({
      db: {} as never,
      claudeCodeTasksEnabled: true,
      createTask: async () => { nativeCalls += 1; return { taskId: "native", status: "pending" }; },
      listHarnessModels: async (input) => {
        expect(input).toEqual({ ownerId: OWNER_ID, harness: "claude-code" });
        return [{ id: "catalog-id", displayName: "Claude Model", description: "Ready", isDefault: false, isPreferred: true }];
      },
      createHarnessTask: async (input) => {
        capturedHarness = input;
        return {
          taskId: "claude-task",
          status: "pending",
          execution: "claude-code",
          model: { catalogModelId: "catalog-id", selectedModel: "claude-model" },
        };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    expect(await dispatchTaskCommand({ command: "list_harness_models", harness: "claude-code" }, CTX))
      .toBe("* catalog-id — Claude Model (selected): Ready");
    const created = JSON.parse(await dispatchTaskCommand({
      command: "create", prompt: "Inspect the current Room", harness: "claude-code", harness_model_id: "catalog-id",
    }, CTX)) as unknown;
    expect(created).toMatchObject({
      taskId: "claude-task",
      status: "pending",
      execution: "claude-code",
      model: { catalogModelId: "catalog-id", selectedModel: "claude-model" },
    });
    expect(capturedHarness).toEqual({
      ownerId: OWNER_ID,
      requestorId: OWNER_ID,
      agentId: AGENT_ID,
      prompt: "Inspect the current Room",
      callingRoomId: ROOM_ID,
      harness: "claude-code",
      harnessModelId: "catalog-id",
    });
    expect(nativeCalls).toBe(0);
  });

  test("rejects forged or malformed Claude Code creation without native fallback", async () => {
    let calls = 0;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => { calls += 1; return { taskId: "native", status: "pending" }; },
      createHarnessTask: async () => { calls += 1; return { taskId: "wrong", status: "pending", execution: "codex" }; },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const unavailable = await dispatchTaskCommand({
      command: "create", prompt: "x", harness: "claude-code",
    }, CTX);
    expect(unavailable).toContain("Connections");
    expect(calls).toBe(0);

    setTaskToolRuntime({
      db: {} as never,
      claudeCodeTasksEnabled: true,
      createTask: async () => { calls += 1; return { taskId: "native", status: "pending" }; },
      createHarnessTask: async () => { calls += 1; return { taskId: "wrong", status: "pending", execution: "codex" }; },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const denied = [
      [{ ...CTX, currentTaskId: "parent" }, { command: "create", prompt: "x", harness: "claude-code" }],
      [CTX, { command: "create", prompt: "x", harness: "claude-code", parent_task_id: "parent" }],
      [{ ...CTX, roomId: "" }, { command: "create", prompt: "x", harness: "claude-code" }],
      [CTX, { command: "create", prompt: "x", harness: "claude-code", schedule_kind: "now" }],
      [CTX, { command: "create", prompt: "x", harness: "claude-code", target_chat: "orphan" }],
      [CTX, { command: "create", prompt: "x", harness: "claude-code", tools: [] as string[] }],
      [CTX, { command: "create", prompt: "x", harness: "claude-code", model_id: "anthropic:claude-sonnet-4-6" }],
      [CTX, { command: "create", prompt: "x", harness: "claude-code", collaboration_mode: "work" }],
      [CTX, { command: "create", prompt: "x", harness: "claude-code", working_directory: "/tmp" }],
    ] as const;
    for (const [context, args] of denied) {
      expect(await dispatchTaskCommand(args, context)).toContain("Cannot create");
    }
    expect(calls).toBe(0);

    setTaskToolRuntime({
      db: {} as never,
      claudeCodeTasksEnabled: true,
      createTask: async () => { calls += 1; return { taskId: "native", status: "pending" }; },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    expect(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "claude-code" }, CTX)).toContain("Connections");

    setTaskToolRuntime({
      db: {} as never,
      claudeCodeTasksEnabled: true,
      createTask: async () => { calls += 1; return { taskId: "native", status: "pending" }; },
      createHarnessTask: async () => { throw new Error("private provider detail"); },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const thrown = await dispatchTaskCommand({ command: "create", prompt: "x", harness: "claude-code" }, CTX);
    expect(thrown).toContain("Connections");
    expect(thrown).not.toContain("private provider detail");
    expect(calls).toBe(0);
  });

  test("wire schema is a FLAT object (OpenAI/Anthropic require top-level type:object — NOT a discriminatedUnion)", () => {
    // Regression guard: a z.discriminatedUnion serialises to `{ anyOf: [...] }`
    // with no top-level `type`, which OpenAI rejects ("got type: None") on EVERY
    // turn since `task` is ungated. Keep it a flat z.object like the file tool.
    expect(taskToolSchema instanceof z.ZodObject).toBe(true);
  });

  test("schema rejects unknown command", () => {
    expect(() =>
      taskToolSchema.parse({ command: "delete", taskId: "x" }),
    ).toThrow();
  });

  test("create returns taskId and background message", async () => {
    stubRuntime();
    const raw = await dispatchTaskCommand(
      { command: "create", prompt: "Do the thing" },
      CTX,
    );
    const body = JSON.parse(raw) as {
      taskId: string;
      status: string;
      message: string;
    };
    expect(body.taskId).toBe("t1");
    expect(body.status).toBe("pending");
    expect(body.message).toContain("background");
  });

  test("create sets scheduleKind now, targetChat orphan, callingRoomId from ctx", async () => {
    stubRuntime();
    await dispatchTaskCommand({ command: "create", prompt: "x" }, CTX);
    expect(capturedCreate).toMatchObject({
      ownerId: OWNER_ID,
      requestorId: OWNER_ID,
      agentId: AGENT_ID,
      scheduleKind: "now",
      targetChat: "orphan",
      callingRoomId: ROOM_ID,
      useScope: false,
      awaitResponse: false,
      depth: 0,
      resultDelivery: "wake",
    });
    expect(capturedCreate?.parentTaskId).toBeUndefined();
  });

  test("a foreign Genie's task records the initiating Human and includes that Human in its target set", async () => {
    stubRuntime();
    await dispatchTaskCommand({ command: "create", prompt: "x" },
      { ...CTX, causalHumanUserId: OTHER_OWNER_ID });
    expect(capturedCreate).toMatchObject({
      ownerId: OWNER_ID,
      requestorId: OTHER_OWNER_ID,
      targetUserIds: [OTHER_OWNER_ID],
    });
  });

  test("create maps undefined tools → auto", async () => {
    stubRuntime();
    await dispatchTaskCommand({ command: "create", prompt: "x" }, CTX);
    expect(capturedCreate?.toolsMode).toBe("auto");
    expect(capturedCreate?.toolsWhitelist).toBeUndefined();
  });

  test("omitted harness preserves the existing Native create path", async () => {
    stubRuntime();
    await dispatchTaskCommand({ command: "create", prompt: "x" }, CTX);
    expect(capturedCreate).not.toBeNull();
  });

  test("missing Codex harness seam returns typed Desktop recovery", async () => {
    stubRuntime();
    expect(JSON.parse(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "codex" }, CTX))).toMatchObject({
      recovery: { target: "connections.codex", requirement: "desktop", domainTool: "task" },
    });
  });

  test("explicit Codex harness reaches the server-owned admission seam", async () => {
    let capturedHarness: unknown;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "native", status: "pending" }),
      createHarnessTask: async (input) => {
        capturedHarness = input;
        return { taskId: "codex", status: "pending", execution: "codex" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const raw = await dispatchTaskCommand({
      command: "create",
      prompt: "x",
      harness: "codex",
      collaboration_mode: "work",
      working_directory: "/projects/nautilo",
    }, CTX);
    expect(JSON.parse(raw)).toMatchObject({ taskId: "codex", execution: "codex" });
    expect(capturedHarness).toMatchObject({
      harness: "codex",
      collaborationMode: "work",
      workingDirectory: "/projects/nautilo",
    });
  });

  test("explicit Hermes ACP harness reaches the sealed admission seam with no Codex-only fields", async () => {
    let capturedHarness: unknown;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "native", status: "pending" }),
      createHarnessTask: async (input) => {
        capturedHarness = input;
        return { taskId: "hermes", status: "pending", execution: "hermes-acp" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const raw = await dispatchTaskCommand({ command: "create", prompt: "x", harness: "hermes-acp" }, CTX);
    expect(JSON.parse(raw)).toMatchObject({ taskId: "hermes", execution: "hermes-acp" });
    expect(capturedHarness).toEqual({
      ownerId: OWNER_ID,
      requestorId: OWNER_ID,
      agentId: AGENT_ID,
      prompt: "x",
      callingRoomId: ROOM_ID,
      harness: "hermes-acp",
    });
  });

  test("rejects stale OpenCode create shapes before either runtime seam", async () => {
    let calls = 0;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => { calls++; return { taskId: "native", status: "pending" }; },
      createHarnessTask: async () => { calls++; return { taskId: "opencode", status: "pending", execution: "opencode-acp" }; },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const staleHarness = await dispatchTaskCommand({
      command: "create",
      prompt: "x",
      harness: "opencode-acp",
      execution_profile: "autonomous",
    } as never, CTX);
    const staleProfile = await dispatchTaskCommand({ command: "create", prompt: "x", execution_profile: "autonomous" } as never, CTX);
    expect(staleHarness).toBe("OpenCode Tasks are temporarily unavailable while Nautilo completes reliability work. Use Codex, Hermes, or Nautilo Native instead.");
    expect(staleProfile).toBe(staleHarness);
    expect(calls).toBe(0);
  });

  test("turns bounded Hermes admission failures into safe setup guidance", async () => {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "native", status: "pending" }),
      createHarnessTask: async () => { throw new Error("ACP_HARNESS_UNAVAILABLE"); },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    expect(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "hermes-acp" }, CTX)).toContain(
      "Hermes is unavailable",
    );
  });

  test("collapses an unknown Hermes failure without leaking private details", async () => {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "native", status: "pending" }),
      createHarnessTask: async () => {
        throw new Error("database write failed for /private/owner-token");
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const result = await dispatchTaskCommand({ command: "create", prompt: "x", harness: "hermes-acp" }, CTX);
    expect(result).toBe(
      "Hermes is unavailable on a paired Nautilo desktop. Open Nautilo Desktop, finish Hermes setup, then try again.",
    );
    expect(result).not.toContain("/private/owner-token");
  });

  test("preserves existing Native and Codex generic error behavior", async () => {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => { throw new Error("native-private-detail"); },
      createHarnessTask: async () => { throw new Error("codex-private-detail"); },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    expect(await dispatchTaskCommand({ command: "create", prompt: "x" }, CTX)).toBe(
      "Error in task:create: native-private-detail",
    );
    expect(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "codex" }, CTX)).toBe(
      "Error in task:create: codex-private-detail",
    );
  });

  test("scopes harness failure guidance to the selected harness", async () => {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => { throw new Error("ACP_HARNESS_UNAVAILABLE"); },
      createHarnessTask: async (input) => {
        throw new Error(
          input.harness === "hermes-acp"
            ? "CODEX_PROFILE_UNAVAILABLE"
            : "ACP_HARNESS_UNAVAILABLE",
        );
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    expect(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "hermes-acp" }, CTX)).toBe(
      "Hermes is unavailable on a paired Nautilo desktop. Open Nautilo Desktop, finish Hermes setup, then try again.",
    );
    expect(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "codex" }, CTX)).toBe(
      "Error in task:create: ACP_HARNESS_UNAVAILABLE",
    );
    expect(await dispatchTaskCommand({ command: "create", prompt: "x" }, CTX)).toBe(
      "Error in task:create: ACP_HARNESS_UNAVAILABLE",
    );
  });

  test("preserves typed Codex recovery for model-list and steer failures", async () => {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "unused", status: "pending" }),
      listHarnessModels: async () => { throw new Error("CODEX_PROFILE_UNAVAILABLE"); },
      steerHarnessTask: async () => { throw new Error("CODEX_HOST_UNAVAILABLE"); },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    expect(JSON.parse(
      await dispatchTaskCommand({ command: "list_harness_models", harness: "codex" }, CTX),
    )).toMatchObject({
      recovery: { target: "connections.codex", requirement: "login", domainTool: "task" },
    });

    const taskSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-1",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      callingRoomId: ROOM_ID,
    } as never);
    restores.push(() => taskSp.mockRestore());
    expect(await dispatchTaskCommand({ command: "steer", taskId: "task-1", prompt: "continue" }, CTX)).toContain(
      "Codex cannot reach the selected Desktop",
    );
  });

  test.each([
    ["CLAUDE_TASK_FORBIDDEN", "cannot be controlled"],
    ["CLAUDE_TURN_UNAVAILABLE", "no active turn"],
    ["CLAUDE_STEER_UNAVAILABLE", "could not deliver"],
  ])("turns %s into readable Claude steer guidance", async (code, text) => {
    setTaskToolRuntime({
      db: {} as never, createTask: async () => ({ taskId: "unused", status: "pending" }),
      steerHarnessTask: async () => { throw new Error(code); }, computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const taskSp = spyOn(db, "getTaskById").mockResolvedValue({ id: "task-1", ownerId: OWNER_ID, agentId: AGENT_ID, callingRoomId: ROOM_ID } as never);
    restores.push(() => taskSp.mockRestore());
    expect(await dispatchTaskCommand({ command: "steer", taskId: "task-1", prompt: "continue" }, CTX)).toContain(text);
  });

  test("keeps list_harness_models Codex-only", async () => {
    stubRuntime();
    expect(await dispatchTaskCommand({ command: "list_harness_models", harness: "hermes-acp" }, CTX)).toContain(
      "set harness to 'codex'",
    );
  });

  test.each([
    [{ collaboration_mode: "work" as const }, "collaboration_mode"],
    [{ harness_model_id: "gpt-5.6-sol" }, "harness_model_id"],
    [{ working_directory: "/projects/nautilo" }, "working_directory"],
    [{ model_selection_profile: "smartest" as const }, "model settings"],
    [{ model_selection_spec: { objective: "smart" as const } }, "model settings"],
    [{ model_id: "anthropic/claude-sonnet-4.5" }, "model settings"],
    [{ tools: [] }, "server-owned"],
    [{ result_delivery: "raw" as const }, "server-owned"],
    [{ target_chat: "orphan" as const }, "server-owned"],
    [{ target_users: ["someone"] }, "server-owned"],
    [{ use_scope: true }, "server-owned"],
    [{ scope_id: "scope" }, "server-owned"],
    [{ expected_output: "caller-controlled" }, "server-owned"],
    [{ parent_task_id: "44444444-4444-4444-8444-444444444444" }, "server-owned"],
    [{ time_limit_seconds: 60 }, "server-owned"],
    [{ schedule_kind: "now" as const }, "server-owned"],
    [{ schedule_kind: "cron" as const }, "run immediately"],
    [{ run_at: "2027-01-01T00:00:00Z" }, "run immediately"],
    [{ cron: "0 9 * * *" }, "run immediately"],
    [{ timezone: "UTC" }, "run immediately"],
  ])("rejects Hermes ACP caller-controlled %s without invoking an executor", async (extra, expected) => {
    let calls = 0;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => { calls++; return { taskId: "native", status: "pending" }; },
      createHarnessTask: async () => { calls++; return { taskId: "hermes", status: "pending", execution: "hermes-acp" }; },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const result = await dispatchTaskCommand({ command: "create", prompt: "x", harness: "hermes-acp", ...extra }, CTX);
    expect(result).toContain(expected);
    expect(calls).toBe(0);
  });

  test("lists live harness models and forwards only an exact returned picker id", async () => {
    let capturedHarness: unknown;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "native", status: "pending" }),
      listHarnessModels: async () => [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Frontier coding model",
        isDefault: true,
        isPreferred: true,
      }],
      createHarnessTask: async (input) => {
        capturedHarness = input;
        return { taskId: "codex", status: "pending", execution: "codex" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const catalog = await dispatchTaskCommand({
      command: "list_harness_models",
      harness: "codex",
    }, CTX);
    expect(catalog).toContain("* gpt-5.6-sol — GPT-5.6 Sol (Nautilo default)");
    await dispatchTaskCommand({
      command: "create",
      prompt: "x",
      harness: "codex",
      harness_model_id: "gpt-5.6-sol",
    }, CTX);
    expect(capturedHarness).toMatchObject({ harnessModelId: "gpt-5.6-sol" });
  });

  test("turns bounded Codex admission failures into actionable user guidance", async () => {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "native", status: "pending" }),
      createHarnessTask: async () => {
        throw new Error("CODEX_PROFILE_UNAVAILABLE");
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    expect(JSON.parse(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "codex" }, CTX))).toMatchObject({
      recovery: { target: "connections.codex", requirement: "login", domainTool: "task" },
    });
  });

  test("rejects harness fields outside create and unsupported exact-Codex controls", async () => {
    stubRuntime();
    expect(taskToolSchema.safeParse({
      command: "create",
      prompt: "x",
      harness: "auto",
    }).success).toBe(false);
    expect(await dispatchTaskCommand({ command: "read", taskId: "t", harness: "codex" }, CTX)).toContain("apply only when creating");
    expect(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "codex", schedule_kind: "cron" }, CTX)).toContain("run immediately");
    expect(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "codex", cron: "0 9 * * *" }, CTX)).toContain("run immediately");
    expect(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "codex", target_chat: "orphan" }, CTX)).toContain("server-owned");
    expect(await dispatchTaskCommand({ command: "create", prompt: "x", harness: "codex", model_selection_profile: "smartest" }, CTX)).toContain("model settings");
    expect(await dispatchTaskCommand({ command: "create", prompt: "x", working_directory: "/tmp" }, CTX)).toContain("requires exact harness 'codex'");
  });

  test("create maps [] tools → none", async () => {
    stubRuntime();
    await dispatchTaskCommand(
      { command: "create", prompt: "x", tools: [] },
      CTX,
    );
    expect(capturedCreate?.toolsMode).toBe("none");
  });

  test("create maps ['x'] tools → whitelist", async () => {
    stubRuntime();
    await dispatchTaskCommand(
      { command: "create", prompt: "x", tools: ["search_memory"] },
      CTX,
    );
    expect(capturedCreate?.toolsMode).toBe("whitelist");
    expect(capturedCreate?.toolsWhitelist).toEqual(["search_memory"]);
  });

  test("create without owner/agent context returns error string", async () => {
    stubRuntime();
    const raw = await dispatchTaskCommand(
      { command: "create", prompt: "x" },
      { ownerId: "", causalHumanUserId: "", agentId: "", roomId: "" },
    );
    expect(raw).toBe("Cannot create task: initiating Human is unavailable.");
  });

  test("read and list expose only the runtime-confirmed research resume affordance", async () => {
    const task = { id: "task-recovery", ownerId: OWNER_ID, agentId: AGENT_ID, status: "errored",
      lastError: "no_progress", prompt: "audit", scheduleKind: "now", callingRoomId: ROOM_ID };
    let eligibilityCalls = 0;
    let eligible = true;
    stubRuntime({ canResumeResearch: async (candidate) => {
      expect(candidate).toMatchObject(task);
      eligibilityCalls += 1;
      return eligible;
    } });
    const get = spyOn(db, "getTaskById").mockResolvedValue(task as never);
    const runs = spyOn(db, "getTaskRuns").mockResolvedValue([] as never);
    const list = spyOn(db, "listTasksForOwner").mockResolvedValue([task] as never);
    const models = spyOn(db, "getLatestRunModelByTask").mockResolvedValue(new Map());
    restores.push(() => { get.mockRestore(); runs.mockRestore(); list.mockRestore(); models.mockRestore(); });
    const read = async () => JSON.parse(await dispatchTaskCommand({ command: "read", taskId: task.id }, CTX)) as { task: { canResumeResearch?: boolean } };
    expect((await read()).task.canResumeResearch).toBe(true);
    const rows = JSON.parse(await dispatchTaskCommand({ command: "list", status: "errored" }, CTX)) as Array<{ canResumeResearch?: boolean }>;
    expect(rows[0]?.canResumeResearch).toBe(true);
    eligible = false;
    expect((await read()).task.canResumeResearch).toBeUndefined();
    expect(eligibilityCalls).toBe(3);
    get.mockResolvedValue({ ...task, ownerId: OTHER_OWNER_ID } as never);
    expect(await dispatchTaskCommand({ command: "read", taskId: task.id }, CTX)).toBe("Task not found.");
    expect(eligibilityCalls).toBe(3);
    get.mockResolvedValue({ ...task, lastError: "provider_error", metadata: { canResumeResearch: true } } as never);
    expect((await read()).task.canResumeResearch).toBeUndefined();
    expect(eligibilityCalls).toBe(3);
    get.mockResolvedValue({ ...task, status: "running" } as never);
    expect((await read()).task.canResumeResearch).toBeUndefined();
    expect(eligibilityCalls).toBe(3);
    stubRuntime();
    get.mockResolvedValue(task as never);
    expect((await read()).task.canResumeResearch).toBeUndefined();
  });

  test("read with non-matching owner returns Task not found.", async () => {
    stubRuntime();
    const sp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-1",
      ownerId: OTHER_OWNER_ID,
      status: "pending",
      prompt: "secret",
      scheduleKind: "now",
      callingRoomId: null,
      resultDelivery: "wake",
    } as never);
    restores.push(() => sp.mockRestore());
    // M163 — the transcript helper must NOT run for another owner's task.
    const transcriptSp = spyOn(sessionStore, "getRunAgentTranscript");
    restores.push(() => transcriptSp.mockRestore());

    const raw = await dispatchTaskCommand(
      { command: "read", taskId: "task-1" },
      CTX,
    );
    expect(raw).toBe("Task not found.");
    expect(sp).toHaveBeenCalled();
    expect(transcriptSp).not.toHaveBeenCalled();
  });

  test("read recognizes only the exact autonomous OpenCode execution descriptor", async () => {
    stubRuntime();
    const getSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-opencode",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      callingRoomId: ROOM_ID,
      status: "pending",
      prompt: "do it",
      scheduleKind: "now",
      targetChat: "orphan",
      resultDelivery: "raw",
      selectionProfile: "balanced",
      selectionSpec: null,
      requestedModelId: null,
      metadata: {
        execution: {
          version: 1,
          harnessId: "opencode-acp",
          source: "genie",
          executionProfile: "autonomous",
          readiness: {
            relayId: "relay",
            relaySessionId: "session",
            pairingGenerationRef: "pairing",
            desktopSessionId: "desktop",
            selectedProtocolVersion: 15,
            capabilityRevision: 1,
          },
        },
      },
    } as never);
    const runsSp = spyOn(db, "getTaskRuns").mockResolvedValue([] as never);
    const transcriptSp = spyOn(sessionStore, "getRunAgentTranscript").mockResolvedValue([] as never);
    restores.push(() => { getSp.mockRestore(); runsSp.mockRestore(); transcriptSp.mockRestore(); });
    const body = JSON.parse(await dispatchTaskCommand({ command: "read", taskId: "task-opencode" }, CTX)) as {
      task: { harnessId: string | null };
    };
    expect(body.task.harnessId).toBe("opencode-acp");
  });

  test.each([
    ["empty opaque id", { relayId: "" }],
    ["NUL opaque id", { relaySessionId: "session\0id" }],
    ["oversize opaque id", { desktopSessionId: "x".repeat(513) }],
    ["pre-OpenCode protocol", { selectedProtocolVersion: 14 }],
    ["negative capability revision", { capabilityRevision: -1 }],
  ])("read excludes malformed OpenCode descriptor: %s", async (_name, invalidReadiness) => {
    stubRuntime();
    const getSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-opencode-malformed",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      callingRoomId: ROOM_ID,
      status: "pending",
      prompt: "do it",
      scheduleKind: "now",
      targetChat: "orphan",
      resultDelivery: "raw",
      selectionProfile: "balanced",
      selectionSpec: null,
      requestedModelId: null,
      metadata: {
        execution: {
          version: 1,
          harnessId: "opencode-acp",
          source: "genie",
          executionProfile: "autonomous",
          readiness: {
            relayId: "relay",
            relaySessionId: "session",
            pairingGenerationRef: "pairing",
            desktopSessionId: "desktop",
            selectedProtocolVersion: 15,
            capabilityRevision: 1,
            ...invalidReadiness,
          },
        },
      },
    } as never);
    const runsSp = spyOn(db, "getTaskRuns").mockResolvedValue([] as never);
    const transcriptSp = spyOn(sessionStore, "getRunAgentTranscript").mockResolvedValue([] as never);
    restores.push(() => { getSp.mockRestore(); runsSp.mockRestore(); transcriptSp.mockRestore(); });
    const body = JSON.parse(await dispatchTaskCommand({ command: "read", taskId: "task-opencode-malformed" }, CTX)) as {
      task: { harnessId: string | null };
    };
    expect(body.task.harnessId).toBeNull();
  });

  test("tool invoke wires context from factory closure", async () => {
    stubRuntime();
    const tool = createTaskTool({
      ownerId: OWNER_ID,
      causalHumanUserId: OWNER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
    });
    const raw = await tool.invoke({ command: "create", prompt: "via tool" });
    const body = JSON.parse(String(raw)) as { taskId: string };
    expect(body.taskId).toBe("t1");
    expect(capturedCreate?.callingRoomId).toBe(ROOM_ID);
  });

  test("orphan Task tool inherits its exact originating Room for a nested Codex Task", async () => {
    let capturedHarness: unknown;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "native", status: "pending" }),
      createHarnessTask: async (input) => {
        capturedHarness = input;
        return { taskId: "codex", status: "pending", execution: "codex" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const tool = createTaskTool({
      ownerId: OWNER_ID,
      causalHumanUserId: OWNER_ID,
      agentId: AGENT_ID,
      roomId: "",
      callingRoomId: ROOM_ID,
    });

    await tool.invoke({
      command: "create",
      prompt: "verify the disposable checkout",
      harness: "codex",
      collaboration_mode: "work",
    });

    expect(capturedHarness).toMatchObject({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      callingRoomId: ROOM_ID,
      harness: "codex",
    });
  });

  test("a nested Native create inherits the exact current Task, its depth, and owner", async () => {
    stubRuntime();
    const parentSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "parent-task",
      ownerId: OWNER_ID,
      depth: 2,
    } as never);
    restores.push(() => parentSp.mockRestore());

    await dispatchTaskCommand(
      { command: "create", prompt: "do the nested work" },
      { ...CTX, currentTaskId: "parent-task" },
    );

    expect(parentSp).toHaveBeenCalledWith(expect.anything(), "parent-task");
    expect(capturedCreate).toMatchObject({
      ownerId: OWNER_ID,
      requestorId: OWNER_ID,
      parentTaskId: "parent-task",
      depth: 3,
    });
  });

  test("a nested Codex create preserves canonical parent/depth and sealed harness routing", async () => {
    let capturedHarness: unknown;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "native", status: "pending" }),
      createHarnessTask: async (input) => {
        capturedHarness = input;
        return { taskId: "codex", status: "pending", execution: "codex" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const parentSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "parent-task",
      ownerId: OWNER_ID,
      depth: 1,
    } as never);
    restores.push(() => parentSp.mockRestore());

    await createTaskTool({
      ownerId: OWNER_ID,
      causalHumanUserId: OWNER_ID,
      agentId: AGENT_ID,
      roomId: "",
      callingRoomId: ROOM_ID,
      currentTaskId: "parent-task",
    }).invoke({
      command: "create",
      prompt: "verify the checkout",
      harness: "codex",
      collaboration_mode: "work",
    });

    expect(capturedHarness).toMatchObject({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      callingRoomId: ROOM_ID,
      parentTaskId: "parent-task",
      depth: 2,
      harness: "codex",
      collaborationMode: "work",
    });
  });

  test("identical explicit nested parent is accepted while a conflict creates nothing", async () => {
    let creates = 0;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async (input) => {
        creates++;
        capturedCreate = input;
        return { taskId: "native", status: "pending" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const parentSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "parent-task",
      ownerId: OWNER_ID,
      depth: 0,
    } as never);
    restores.push(() => parentSp.mockRestore());
    const nestedCtx = { ...CTX, currentTaskId: "parent-task" };

    await dispatchTaskCommand(
      { command: "create", prompt: "same parent", parent_task_id: "parent-task" },
      nestedCtx,
    );
    expect(capturedCreate).toMatchObject({ parentTaskId: "parent-task", depth: 1 });
    expect(creates).toBe(1);

    const conflict = await dispatchTaskCommand(
      { command: "create", prompt: "other parent", parent_task_id: "other-task" },
      nestedCtx,
    );
    expect(conflict).toBe("Cannot create task: parent task conflicts with the current task.");
    expect(creates).toBe(1);
  });

  test.each([
    ["missing", undefined],
    ["foreign", { id: "parent-task", ownerId: OTHER_OWNER_ID, depth: 0 }],
  ] as const)("a %s current Task fails closed before Native or harness creation", async (_name, parent) => {
    let creates = 0;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => {
        creates++;
        return { taskId: "native", status: "pending" };
      },
      createHarnessTask: async () => {
        creates++;
        return { taskId: "codex", status: "pending", execution: "codex" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const parentSp = spyOn(db, "getTaskById").mockResolvedValue(parent as never);
    restores.push(() => parentSp.mockRestore());

    expect(await dispatchTaskCommand(
      { command: "create", prompt: "native child" },
      { ...CTX, currentTaskId: "parent-task" },
    )).toBe("Cannot create task: current task not found.");
    expect(await dispatchTaskCommand(
      { command: "create", prompt: "harness child", harness: "codex" },
      { ...CTX, currentTaskId: "parent-task" },
    )).toBe("Cannot create task: current task not found.");
    expect(creates).toBe(0);
  });

  test("listTaskToolCommandNames includes lifecycle commands (schema drift guard)", () => {
    expect(listTaskToolCommandNames()).toEqual([
      "create",
      "read",
      "list",
      "update",
      "pause",
      "unpause",
      "stop",
      "steer",
      "list_harness_models",
    ]);
  });

  test("explicit steer sends a concise instruction through the existing task Tool", async () => {
    let steered: unknown;
    const taskSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-1",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      callingRoomId: ROOM_ID,
    } as never);
    restores.push(() => taskSp.mockRestore());
    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "unused", status: "pending" }),
      steerHarnessTask: async (input) => {
        steered = input;
        return { ok: true, status: "steered" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });

    const raw = await dispatchTaskCommand({
      command: "steer",
      taskId: "task-1",
      prompt: "Focus on the failing test",
    }, CTX);
    expect(JSON.parse(raw)).toMatchObject({
      taskId: "task-1",
      status: "steered",
    });
    expect(steered).toEqual({
      taskId: "task-1",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      text: "Focus on the failing test",
    });
  });
});

describe("task tool dispatcher (M146 Phase 5)", () => {
  let capturedCreate: TaskToolCreateInput | null = null;
  const restores: Array<() => void> = [];

  afterEach(() => {
    setTaskToolRuntime(null);
    capturedCreate = null;
    while (restores.length) restores.pop()!();
  });

  function stubRuntime() {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async (input) => {
        capturedCreate = input;
        return { taskId: "t1", status: "pending" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
  }

  test("full create shaping", async () => {
    stubRuntime();
    await dispatchTaskCommand(
      {
        command: "create",
        prompt: "p",
        schedule_kind: "cron",
        cron: "0 9 * * *",
        timezone: "America/New_York",
        use_scope: true,
        scope_id: "55555555-0000-4000-8000-000000000055",
        tools: ["run_shell"],
        target_chat: "new_in_namespace",
        expected_output: "a summary",
        result_delivery: "raw",
      },
      CTX,
    );
    expect(capturedCreate).toMatchObject({
      scheduleKind: "cron",
      cron: "0 9 * * *",
      timezone: "America/New_York",
      useScope: true,
      scopeId: "55555555-0000-4000-8000-000000000055",
      toolsMode: "whitelist",
      toolsWhitelist: ["run_shell"],
      targetChat: "new_in_namespace",
      expectedOutput: "a summary",
      resultDelivery: "raw",
      preset: "task",
      depth: 0,
    });
  });

  test("advanced task accepts explicit raw_and_wake delivery", async () => {
    stubRuntime();
    await dispatchTaskCommand(
      {
        command: "create",
        prompt: "p",
        result_delivery: "raw_and_wake",
      },
      CTX,
    );
    expect(capturedCreate?.resultDelivery).toBe("raw_and_wake");
  });

  test("create one_shot parses run_at ISO → Date", async () => {
    stubRuntime();
    await dispatchTaskCommand(
      {
        command: "create",
        prompt: "p",
        schedule_kind: "one_shot",
        run_at: "2030-01-01T00:00:00Z",
      },
      CTX,
    );
    expect(capturedCreate?.runAt).toBeInstanceOf(Date);
    expect(capturedCreate?.runAt?.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  test("create with invalid run_at returns friendly error and does not call createTask", async () => {
    stubRuntime();
    const raw = await dispatchTaskCommand(
      {
        command: "create",
        prompt: "p",
        schedule_kind: "one_shot",
        run_at: "not-a-date",
      },
      CTX,
    );
    expect(raw).toContain("not a valid ISO");
    expect(capturedCreate).toBeNull();
  });

  test("create derives depth from parent_task_id", async () => {
    stubRuntime();
    const sp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "parent",
      ownerId: OWNER_ID,
      depth: 2,
    } as never);
    restores.push(() => sp.mockRestore());

    await dispatchTaskCommand(
      { command: "create", prompt: "p", parent_task_id: "parent" },
      CTX,
    );
    expect(capturedCreate?.depth).toBe(3);
    expect(capturedCreate?.parentTaskId).toBe("parent");
  });

  test("create parent owned by other owner returns parent task not found", async () => {
    stubRuntime();
    const sp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "parent",
      ownerId: OTHER_OWNER_ID,
      depth: 2,
    } as never);
    restores.push(() => sp.mockRestore());

    const raw = await dispatchTaskCommand(
      { command: "create", prompt: "p", parent_task_id: "parent" },
      CTX,
    );
    expect(raw).toContain("parent task not found");
    expect(capturedCreate).toBeNull();
  });

  test("R3 rejects for create — not-yet-wired params", async () => {
    stubRuntime();
    const cases: Array<Record<string, unknown>> = [
      { await_response: true },
      { target_chat: "new_dm" },
      { target_user_ids: ["u1"] },
    ];
    for (const extra of cases) {
      capturedCreate = null;
      const raw = await dispatchTaskCommand(
        { command: "create", prompt: "x", ...extra } as never,
        CTX,
      );
      expect(raw).toMatch(/not available yet \(lands in Phase \d\)/);
      expect(capturedCreate).toBeNull();
    }
  });

  test("M147 — create maps time_limit_seconds → timeLimitSeconds (no longer rejected)", async () => {
    stubRuntime();
    await dispatchTaskCommand(
      { command: "create", prompt: "p", time_limit_seconds: 90 },
      CTX,
    );
    expect(capturedCreate?.timeLimitSeconds).toBe(90);
  });

  test("M147 — lifecycle commands owner-check then call the seam", async () => {
    let paused = "";
    let unpaused = "";
    let stopped = "";
    setTaskToolRuntime({
      db: {} as never,
      createTask: async (input) => {
        capturedCreate = input;
        return { taskId: "t1", status: "pending" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async (taskId) => {
        paused = taskId;
        return { ok: true, status: "paused", message: "Task paused." };
      },
      unpauseTask: async (taskId) => {
        unpaused = taskId;
        return { ok: true, status: "pending", message: "Task resumed." };
      },
      stopTask: async (taskId) => {
        stopped = taskId;
        return { ok: true, status: "cancelled", message: "Task stopped." };
      },
    });
    const sp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "t1",
      ownerId: OWNER_ID,
    } as never);
    restores.push(() => sp.mockRestore());

    const pRaw = await dispatchTaskCommand({ command: "pause", taskId: "t1" }, CTX);
    expect(paused).toBe("t1");
    expect(pRaw).toContain("paused");

    const uRaw = await dispatchTaskCommand({ command: "unpause", taskId: "t1" }, CTX);
    expect(unpaused).toBe("t1");
    expect(uRaw).toContain("pending");

    const sRaw = await dispatchTaskCommand({ command: "stop", taskId: "t1" }, CTX);
    expect(stopped).toBe("t1");
    expect(sRaw).toContain("cancelled");
  });

  test("M147 — lifecycle command on another owner's task returns 'Task not found.' and does not call the seam", async () => {
    let called = false;
    setTaskToolRuntime({
      db: {} as never,
      createTask: async (input) => {
        capturedCreate = input;
        return { taskId: "t1", status: "pending" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => {
        called = true;
        return { ok: true, status: "paused", message: "" };
      },
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
    const sp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "t1",
      ownerId: OTHER_OWNER_ID,
    } as never);
    restores.push(() => sp.mockRestore());

    const raw = await dispatchTaskCommand({ command: "pause", taskId: "t1" }, CTX);
    expect(raw).toBe("Task not found.");
    expect(called).toBe(false);
  });

  test("M147 — lifecycle command without taskId returns a friendly error", async () => {
    stubRuntime();
    const raw = await dispatchTaskCommand({ command: "stop" }, CTX);
    expect(raw).toContain("'taskId' is required");
  });

  test("update happy path recomputes next_fire_at", async () => {
    const fixedNext = new Date("2031-05-05T09:00:00Z");
    let computeArgs: unknown[] | null = null;
    let capturedPatch: Record<string, unknown> | null = null;

    setTaskToolRuntime({
      db: {} as never,
      createTask: async (input) => {
        capturedCreate = input;
        return { taskId: "t1", status: "pending" };
      },
      computeNextFireAt: (...args) => {
        computeArgs = args;
        return fixedNext;
      },
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });

    const getSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-1",
      ownerId: OWNER_ID,
      status: "pending",
      prompt: "old",
      scheduleKind: "now",
      cron: null,
      runAt: null,
      timezone: "UTC",
      targetChat: "orphan",
      resultDelivery: "wake",
      depth: 0,
    } as never);
    restores.push(() => getSp.mockRestore());

    const updateSp = spyOn(db, "updateTask").mockImplementation(
      async (_db, _id, patch) => {
        capturedPatch = patch as Record<string, unknown>;
        return {
          id: "task-1",
          ownerId: OWNER_ID,
          status: "pending",
          prompt: "new",
          scheduleKind: "cron",
          cron: "0 9 * * *",
          nextFireAt: fixedNext,
          targetChat: "orphan",
          resultDelivery: "wake",
        } as never;
      },
    );
    restores.push(() => updateSp.mockRestore());

    await dispatchTaskCommand(
      {
        command: "update",
        taskId: "task-1",
        prompt: "new",
        cron: "0 9 * * *",
        schedule_kind: "cron",
      },
      CTX,
    );

    expect(updateSp).toHaveBeenCalled();
    expect(capturedPatch).toMatchObject({
      prompt: "new",
      scheduleKind: "cron",
      cron: "0 9 * * *",
      nextFireAt: fixedNext,
    });
    expect(computeArgs as unknown as unknown[]).toEqual([
      "cron",
      undefined,
      "0 9 * * *",
      "UTC",
    ]);
  });

  test("update without schedule change does NOT recompute next_fire_at", async () => {
    let computeCalled = false;
    let capturedPatch: Record<string, unknown> | null = null;

    setTaskToolRuntime({
      db: {} as never,
      createTask: async () => ({ taskId: "t1", status: "pending" }),
      computeNextFireAt: () => {
        computeCalled = true;
        return new Date();
      },
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });

    const getSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-1",
      ownerId: OWNER_ID,
      status: "pending",
      prompt: "old",
      scheduleKind: "now",
      cron: null,
      runAt: null,
      timezone: "UTC",
      targetChat: "orphan",
      resultDelivery: "wake",
      depth: 0,
    } as never);
    restores.push(() => getSp.mockRestore());

    const updateSp = spyOn(db, "updateTask").mockImplementation(
      async (_db, _id, patch) => {
        capturedPatch = patch as Record<string, unknown>;
        return {
          id: "task-1",
          ownerId: OWNER_ID,
          status: "pending",
          prompt: "new",
          scheduleKind: "now",
          targetChat: "orphan",
          resultDelivery: "wake",
        } as never;
      },
    );
    restores.push(() => updateSp.mockRestore());

    await dispatchTaskCommand(
      { command: "update", taskId: "task-1", prompt: "new" },
      CTX,
    );

    expect(capturedPatch).toMatchObject({ prompt: "new" });
    expect(capturedPatch).not.toHaveProperty("nextFireAt");
    expect(computeCalled).toBe(false);
  });

  test("update status guard — running and completed", async () => {
    stubRuntime();
    const updateSp = spyOn(db, "updateTask");
    restores.push(() => updateSp.mockRestore());

    for (const status of ["running", "completed"] as const) {
      const getSp = spyOn(db, "getTaskById").mockResolvedValue({
        id: "task-1",
        ownerId: OWNER_ID,
        status,
        prompt: "old",
        scheduleKind: "now",
        targetChat: "orphan",
        resultDelivery: "wake",
      } as never);
      restores.push(() => getSp.mockRestore());

      const raw = await dispatchTaskCommand(
        { command: "update", taskId: "task-1", prompt: "new" },
        CTX,
      );
      expect(raw).toMatch(/only pending or paused/);
    }
    expect(updateSp).not.toHaveBeenCalled();
  });

  test("update owner guard", async () => {
    stubRuntime();
    const getSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-1",
      ownerId: OTHER_OWNER_ID,
      status: "pending",
      prompt: "old",
      scheduleKind: "now",
      targetChat: "orphan",
      resultDelivery: "wake",
    } as never);
    restores.push(() => getSp.mockRestore());

    const updateSp = spyOn(db, "updateTask");
    restores.push(() => updateSp.mockRestore());

    const raw = await dispatchTaskCommand(
      { command: "update", taskId: "task-1", prompt: "new" },
      CTX,
    );
    expect(raw).toBe("Task not found.");
    expect(updateSp).not.toHaveBeenCalled();
  });

  test("M152 — create persists selectionProfile", async () => {
    stubRuntime();
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "x";
    restores.push(() => {
      if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prev;
    });

    await dispatchTaskCommand(
      { command: "create", prompt: "p", model_selection_profile: "cheapest" },
      CTX,
    );
    expect(capturedCreate?.selectionProfile).toBe("cheapest");
  });

  // D429 Phase 3 — exact model_id pin threading + mutual-exclusion guard.
  describe("D429 Phase 3 — exact model_id", () => {
    test("create persists requestedModelId when a valid curated id is supplied", async () => {
      stubRuntime();
      const prev = process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_API_KEY"] = "x";
      restores.push(() => {
        if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
        else process.env["ANTHROPIC_API_KEY"] = prev;
      });

      await dispatchTaskCommand(
        { command: "create", prompt: "p", model_id: "anthropic:claude-sonnet-4-6" },
        CTX,
      );
      expect(capturedCreate?.requestedModelId).toBe("anthropic:claude-sonnet-4-6");
      // An exact pin must NOT also set a selection profile/spec.
      expect(capturedCreate?.selectionProfile).toBeUndefined();
      expect(capturedCreate?.selectionSpec).toBeUndefined();
    });

    test("create rejects model_id + model_selection_profile together (conflict) and does NOT insert", async () => {
      stubRuntime();
      const prev = process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_API_KEY"] = "x";
      restores.push(() => {
        if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
        else process.env["ANTHROPIC_API_KEY"] = prev;
      });

      capturedCreate = null;
      const raw = await dispatchTaskCommand(
        {
          command: "create",
          prompt: "p",
          model_id: "anthropic:claude-sonnet-4-6",
          model_selection_profile: "cheapest",
        },
        CTX,
      );
      expect(raw).toContain("combine");
      expect(capturedCreate).toBeNull();
    });

    test("create rejects a dynamic openrouter: model_id (v1: curated ids only) and does NOT insert", async () => {
      stubRuntime();
      const prev = process.env["OPENROUTER_API_KEY"];
      process.env["OPENROUTER_API_KEY"] = "x";
      restores.push(() => {
        if (prev === undefined) delete process.env["OPENROUTER_API_KEY"];
        else process.env["OPENROUTER_API_KEY"] = prev;
      });

      capturedCreate = null;
      const raw = await dispatchTaskCommand(
        {
          command: "create",
          prompt: "p",
          model_id: "openrouter:somevendor/unknown-model-v1",
        },
        CTX,
      );
      expect(raw).toContain("curated");
      expect(capturedCreate).toBeNull();
    });

    test("create rejects a tool-using task on a null-tools model (capability mismatch)", async () => {
      stubRuntime();
      const prev = process.env["GOOGLE_API_KEY"];
      process.env["GOOGLE_API_KEY"] = "x";
      restores.push(() => {
        if (prev === undefined) delete process.env["GOOGLE_API_KEY"];
        else process.env["GOOGLE_API_KEY"] = prev;
      });

      capturedCreate = null;
      const raw = await dispatchTaskCommand(
        {
          command: "create",
          prompt: "p",
          model_id: "google:gemini-2.5-pro",
          // tools omitted → auto → tool-using → requires confirmed tools.
        },
        CTX,
      );
      expect(raw).toContain("tool");
      expect(capturedCreate).toBeNull();
    });

    test("create ALLOWS a tool-free task (tools: []) on a null-tools model", async () => {
      stubRuntime();
      const prev = process.env["GOOGLE_API_KEY"];
      process.env["GOOGLE_API_KEY"] = "x";
      restores.push(() => {
        if (prev === undefined) delete process.env["GOOGLE_API_KEY"];
        else process.env["GOOGLE_API_KEY"] = prev;
      });

      await dispatchTaskCommand(
        {
          command: "create",
          prompt: "p",
          model_id: "google:gemini-2.5-pro",
          tools: [],
        },
        CTX,
      );
      expect(capturedCreate?.requestedModelId).toBe("google:gemini-2.5-pro");
      expect(capturedCreate?.toolsMode).toBe("none");
    });

    test("update sets requestedModelId on the patch", async () => {
      stubRuntime();
      const prev = process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_API_KEY"] = "x";
      const getSp = spyOn(db, "getTaskById").mockResolvedValue({
        id: "task-1",
        ownerId: OWNER_ID,
        status: "pending",
        prompt: "old",
        scheduleKind: "now",
        targetChat: "orphan",
        resultDelivery: "wake",
        // Row has NO existing pin/profile.
        requestedModelId: null,
        selectionProfile: "balanced",
        selectionSpec: null,
        toolsMode: "auto",
        toolsWhitelist: [],
      } as never);
      let patched: Record<string, unknown> | null = null;
      const updateSp = spyOn(db, "updateTask").mockImplementation(async (_db, _id, patch) => {
        patched = patch as Record<string, unknown>;
        return { id: "task-1", ownerId: OWNER_ID, status: "pending", prompt: "old", scheduleKind: "now", targetChat: "orphan", resultDelivery: "wake" } as never;
      });
      restores.push(() => {
        getSp.mockRestore();
        updateSp.mockRestore();
        if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
        else process.env["ANTHROPIC_API_KEY"] = prev;
      });

      await dispatchTaskCommand(
        { command: "update", taskId: "task-1", model_id: "anthropic:claude-sonnet-4-6" },
        CTX,
      );
      expect(patched).not.toBeNull();
      expect(patched!["requestedModelId"]).toBe("anthropic:claude-sonnet-4-6");
    });

    test("tools-only update revalidates an existing exact pin and rejects newly enabled tools", async () => {
      stubRuntime();
      const prev = process.env["GOOGLE_API_KEY"];
      process.env["GOOGLE_API_KEY"] = "x";
      const getSp = spyOn(db, "getTaskById").mockResolvedValue({
        id: "task-1",
        ownerId: OWNER_ID,
        status: "pending",
        prompt: "old",
        scheduleKind: "now",
        targetChat: "orphan",
        resultDelivery: "wake",
        // This null-tools model was valid while the task was tool-free.
        requestedModelId: "google:gemini-2.5-pro",
        selectionProfile: "balanced",
        selectionSpec: null,
        toolsMode: "none",
        toolsWhitelist: [],
      } as never);
      const updateSp = spyOn(db, "updateTask");
      restores.push(() => {
        getSp.mockRestore();
        updateSp.mockRestore();
        if (prev === undefined) delete process.env["GOOGLE_API_KEY"];
        else process.env["GOOGLE_API_KEY"] = prev;
      });

      const raw = await dispatchTaskCommand(
        {
          command: "update",
          taskId: "task-1",
          // Only tools change: none → non-empty whitelist.
          tools: ["search_memory"],
        },
        CTX,
      );
      expect(raw).toContain("tool");
      expect(updateSp).not.toHaveBeenCalled();
    });

    test("update clears requestedModelId when model_id: null is supplied (explicit clear)", async () => {
      stubRuntime();
      const prev = process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_API_KEY"] = "x";
      const getSp = spyOn(db, "getTaskById").mockResolvedValue({
        id: "task-1",
        ownerId: OWNER_ID,
        status: "pending",
        prompt: "old",
        scheduleKind: "now",
        targetChat: "orphan",
        resultDelivery: "wake",
        requestedModelId: "anthropic:claude-sonnet-4-6",
        selectionProfile: "balanced",
        selectionSpec: null,
        toolsMode: "auto",
        toolsWhitelist: [],
      } as never);
      let patched: Record<string, unknown> | null = null;
      const updateSp = spyOn(db, "updateTask").mockImplementation(async (_db, _id, patch) => {
        patched = patch as Record<string, unknown>;
        return { id: "task-1", ownerId: OWNER_ID, status: "pending", prompt: "old", scheduleKind: "now", targetChat: "orphan", resultDelivery: "wake" } as never;
      });
      restores.push(() => {
        getSp.mockRestore();
        updateSp.mockRestore();
        if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
        else process.env["ANTHROPIC_API_KEY"] = prev;
      });

      await dispatchTaskCommand(
        { command: "update", taskId: "task-1", model_id: null },
        CTX,
      );
      expect(patched).not.toBeNull();
      expect(patched!["requestedModelId"]).toBeNull();
    });

    test("update preserves requestedModelId when model_id is omitted (omission ≠ clear)", async () => {
      stubRuntime();
      const getSp = spyOn(db, "getTaskById").mockResolvedValue({
        id: "task-1",
        ownerId: OWNER_ID,
        status: "pending",
        prompt: "old",
        scheduleKind: "now",
        targetChat: "orphan",
        resultDelivery: "wake",
        requestedModelId: "anthropic:claude-sonnet-4-6",
        selectionProfile: "balanced",
        selectionSpec: null,
        toolsMode: "auto",
        toolsWhitelist: [],
      } as never);
      let patched: Record<string, unknown> | null = null;
      const updateSp = spyOn(db, "updateTask").mockImplementation(async (_db, _id, patch) => {
        patched = patch as Record<string, unknown>;
        return { id: "task-1", ownerId: OWNER_ID, status: "pending", prompt: "old", scheduleKind: "now", targetChat: "orphan", resultDelivery: "wake" } as never;
      });
      restores.push(() => {
        getSp.mockRestore();
        updateSp.mockRestore();
      });

      await dispatchTaskCommand(
        { command: "update", taskId: "task-1", prompt: "new" },
        CTX,
      );
      expect(patched).not.toBeNull();
      expect(patched).not.toHaveProperty("requestedModelId");
    });

    test("update rejects setting model_id on a row that still carries a non-default profile (conflict)", async () => {
      stubRuntime();
      const prev = process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_API_KEY"] = "x";
      const getSp = spyOn(db, "getTaskById").mockResolvedValue({
        id: "task-1",
        ownerId: OWNER_ID,
        status: "pending",
        prompt: "old",
        scheduleKind: "now",
        targetChat: "orphan",
        resultDelivery: "wake",
        requestedModelId: null,
        selectionProfile: "cheapest",
        selectionSpec: null,
        toolsMode: "auto",
        toolsWhitelist: [],
      } as never);
      const updateSp = spyOn(db, "updateTask");
      restores.push(() => {
        getSp.mockRestore();
        updateSp.mockRestore();
        if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
        else process.env["ANTHROPIC_API_KEY"] = prev;
      });

      const raw = await dispatchTaskCommand(
        { command: "update", taskId: "task-1", model_id: "anthropic:claude-sonnet-4-6" },
        CTX,
      );
      expect(raw).toContain("combine");
      expect(updateSp).not.toHaveBeenCalled();
    });

    test("read surfaces requestedModelId separately from the run model", async () => {
      stubRuntime();
      const transcriptSp = spyOn(sessionStore, "getRunAgentTranscript").mockResolvedValue([] as never);
      restores.push(() => transcriptSp.mockRestore());
      const getSp = spyOn(db, "getTaskById").mockResolvedValue({
        id: "task-1",
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        status: "completed",
        prompt: "do it",
        scheduleKind: "now",
        targetChat: "orphan",
        callingRoomId: null,
        resultDelivery: "wake",
        selectionProfile: "balanced",
        selectionSpec: null,
        requestedModelId: "anthropic:claude-sonnet-4-6",
      } as never);
      restores.push(() => getSp.mockRestore());
      const runsSp = spyOn(db, "getTaskRuns").mockResolvedValue([
        {
          id: "run1",
          status: "completed",
          modelId: "anthropic:claude-sonnet-4-6",
          resultText: "ok",
          lastError: null,
          startedAt: new Date("2024-01-01T00:00:00.000Z"),
          completedAt: new Date("2024-01-01T00:05:00.000Z"),
          graphThreadId: "subagent:room:x:abc",
        },
      ] as never);
      restores.push(() => runsSp.mockRestore());

      const raw = await dispatchTaskCommand(
        { command: "read", taskId: "task-1" },
        CTX,
      );
      const body = JSON.parse(raw) as {
        task: { requestedModelId: string | null };
        runs: Array<{ modelId: string | null; resultText: string | null }>;
      };
      expect(body.task.requestedModelId).toBe("anthropic:claude-sonnet-4-6");
      expect(body.runs[0]?.modelId).toBe("anthropic:claude-sonnet-4-6");
      expect(body.runs[0]?.resultText).toBe("ok");
    });

    test("read includes live harness inspection only for the exact Agent and calling Room", async () => {
      let inspectionCalls = 0;
      setTaskToolRuntime({
        db: {} as never,
        createTask: async () => ({ taskId: "unused", status: "pending" }),
        inspectHarnessTask: async (input) => {
          inspectionCalls += 1;
          expect(input).toEqual({ taskId: "task-1", ownerId: OWNER_ID, agentId: AGENT_ID, roomId: ROOM_ID });
          return {
            taskRunId: "run-1",
            jobId: "job-1",
            jobStatus: "running",
            jobCreatedAt: "2026-08-07T10:00:00.000Z",
            jobStartedAt: "2026-08-07T10:00:01.000Z",
            jobCompletedAt: null,
            lastActivityAt: "2026-08-07T10:00:02.000Z",
            activity: [],
          };
        },
        computeNextFireAt: () => new Date(),
        pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
        unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
        stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
      });
      const transcriptSp = spyOn(sessionStore, "getRunAgentTranscript").mockResolvedValue([] as never);
      const getSp = spyOn(db, "getTaskById").mockResolvedValue({
        id: "task-1", ownerId: OWNER_ID, agentId: AGENT_ID, callingRoomId: ROOM_ID,
        status: "running", prompt: "do it", scheduleKind: "now", targetChat: "orphan",
        resultDelivery: "raw", selectionProfile: "balanced", selectionSpec: null, requestedModelId: null,
        metadata: { execution: { version: 1, harnessId: "hermes-acp", source: "genie", readiness: { private: "hidden" } } },
      } as never);
      const runsSp = spyOn(db, "getTaskRuns").mockResolvedValue([] as never);
      restores.push(() => { transcriptSp.mockRestore(); getSp.mockRestore(); runsSp.mockRestore(); });
      const body = JSON.parse(await dispatchTaskCommand({ command: "read", taskId: "task-1" }, CTX)) as {
        task: { harnessId: string | null };
        harness?: { taskRunId: string; jobId: string; jobStartedAt: string | null };
      };
      expect(body.task.harnessId).toBe("hermes-acp");
      expect(JSON.stringify(body)).not.toContain("hidden");
      expect(body.harness).toMatchObject({ taskRunId: "run-1", jobId: "job-1", jobStartedAt: "2026-08-07T10:00:01.000Z" });
      expect(inspectionCalls).toBe(1);

      getSp.mockResolvedValueOnce({
        id: "task-1", ownerId: OWNER_ID, agentId: AGENT_ID, callingRoomId: ROOM_ID,
        status: "running", prompt: "do it", scheduleKind: "now", targetChat: "orphan",
        resultDelivery: "raw", selectionProfile: "balanced", selectionSpec: null, requestedModelId: null,
      } as never);
      const otherRoom = JSON.parse(await dispatchTaskCommand(
        { command: "read", taskId: "task-1" },
        { ...CTX, roomId: "other-room" },
      )) as { harness?: unknown };
      expect(otherRoom.harness).toBeUndefined();
      expect(inspectionCalls).toBe(1);
    });

    test("list surfaces requestedModelId on each summary row", async () => {
      stubRuntime();
      const listSp = spyOn(db, "listTasksForOwner").mockResolvedValue([
        {
          id: "t1",
          status: "pending",
          prompt: "do work",
          scheduleKind: "now",
          callingRoomId: null,
          selectionProfile: "balanced",
          requestedModelId: "anthropic:claude-sonnet-4-6",
          metadata: {
            execution: {
              version: 1,
              harnessId: "hermes-acp",
              source: "genie",
              readiness: { private: "not projected" },
            },
          },
        },
        {
          id: "t2",
          status: "pending",
          prompt: "other work",
          scheduleKind: "now",
          callingRoomId: null,
          selectionProfile: "cheapest",
          requestedModelId: null,
        },
        {
          id: "t3",
          status: "pending",
          prompt: "codex work",
          scheduleKind: "now",
          callingRoomId: null,
          selectionProfile: "balanced",
          requestedModelId: null,
          metadata: { execution: { version: 1, harnessId: "codex", source: "genie" } },
        },
        {
          id: "t4",
          status: "pending",
          prompt: "near match",
          scheduleKind: "now",
          callingRoomId: null,
          selectionProfile: "balanced",
          requestedModelId: null,
          metadata: { execution: { version: 1, harnessId: "hermes-acp", source: "caller" } },
        },
        {
          id: "t5",
          status: "pending",
          prompt: "opencode work",
          scheduleKind: "now",
          callingRoomId: null,
          selectionProfile: "balanced",
          requestedModelId: null,
          metadata: {
            execution: {
              version: 1,
              harnessId: "opencode-acp",
              source: "genie",
              executionProfile: "autonomous",
              readiness: {
                relayId: "relay",
                relaySessionId: "session",
                pairingGenerationRef: "pairing",
                desktopSessionId: "desktop",
                selectedProtocolVersion: 15,
                capabilityRevision: 1,
              },
            },
          },
        },
        {
          id: "t6",
          status: "pending",
          prompt: "loose OpenCode lookalike",
          scheduleKind: "now",
          callingRoomId: null,
          selectionProfile: "balanced",
          requestedModelId: null,
          metadata: {
            execution: {
              version: 1,
              harnessId: "opencode-acp",
              source: "genie",
              executionProfile: "interactive",
              readiness: { private: "not projected" },
            },
          },
        },
        {
          id: "t7",
          status: "pending",
          prompt: "claude work",
          scheduleKind: "now",
          callingRoomId: null,
          selectionProfile: "balanced",
          requestedModelId: null,
          metadata: {
            execution: {
              version: 1,
              harnessId: "claude-code",
              source: "genie",
              profileRef: "profile-1",
              catalogModelId: "catalog-1",
              selectedModel: "claude-model",
            },
          },
        },
        {
          id: "t8",
          status: "pending",
          prompt: "near claude",
          scheduleKind: "now",
          callingRoomId: null,
          selectionProfile: "balanced",
          requestedModelId: null,
          metadata: {
            execution: {
              version: 1,
              harnessId: "claude-code",
              source: "genie",
              profileRef: "profile-1",
              catalogModelId: "catalog-1",
              selectedModel: "claude-model",
            },
            extra: true,
          },
        },
        {
          id: "t9",
          status: "pending",
          prompt: "oversize claude",
          scheduleKind: "now",
          callingRoomId: null,
          selectionProfile: "balanced",
          requestedModelId: null,
          metadata: {
            execution: {
              version: 1,
              harnessId: "claude-code",
              source: "genie",
              profileRef: "🙂".repeat(81),
              catalogModelId: "catalog-1",
              selectedModel: "claude-model",
            },
          },
        },
      ] as never);
      restores.push(() => listSp.mockRestore());
      const modelSp = spyOn(db, "getLatestRunModelByTask").mockResolvedValue(new Map());
      restores.push(() => modelSp.mockRestore());

      const raw = await dispatchTaskCommand({ command: "list" }, CTX);
      const body = JSON.parse(raw) as Array<{
        id: string;
        requestedModelId: string | null;
        harnessId: string | null;
      }>;
      expect(body.find((t) => t.id === "t1")?.requestedModelId).toBe(
        "anthropic:claude-sonnet-4-6",
      );
      expect(body.find((t) => t.id === "t2")?.requestedModelId).toBeNull();
      expect(body.find((t) => t.id === "t1")?.harnessId).toBe("hermes-acp");
      expect(body.find((t) => t.id === "t2")?.harnessId).toBeNull();
      expect(body.find((t) => t.id === "t3")?.harnessId).toBe("codex");
      expect(body.find((t) => t.id === "t4")?.harnessId).toBeNull();
      expect(body.find((t) => t.id === "t5")?.harnessId).toBe("opencode-acp");
      expect(body.find((t) => t.id === "t6")?.harnessId).toBeNull();
      expect(body.find((t) => t.id === "t7")?.harnessId).toBe("claude-code");
      expect(body.find((t) => t.id === "t8")?.harnessId).toBeNull();
      expect(body.find((t) => t.id === "t9")?.harnessId).toBeNull();
      expect(raw).not.toContain("not projected");
    });

    test("list excludes OpenCode descriptors with malformed relay readiness facts", async () => {
      stubRuntime();
      const opencodeTask = (id: string, invalidReadiness: Record<string, unknown>) => ({
        id,
        status: "pending",
        prompt: "opencode work",
        scheduleKind: "now",
        callingRoomId: null,
        selectionProfile: "balanced",
        requestedModelId: null,
        metadata: {
          execution: {
            version: 1,
            harnessId: "opencode-acp",
            source: "genie",
            executionProfile: "autonomous",
            readiness: {
              relayId: "relay",
              relaySessionId: "session",
              pairingGenerationRef: "pairing",
              desktopSessionId: "desktop",
              selectedProtocolVersion: 15,
              capabilityRevision: 1,
              ...invalidReadiness,
            },
          },
        },
      });
      const listSp = spyOn(db, "listTasksForOwner").mockResolvedValue([
        opencodeTask("empty", { relayId: "" }),
        opencodeTask("nul", { relaySessionId: "session\0id" }),
        opencodeTask("oversize", { pairingGenerationRef: "x".repeat(513) }),
        opencodeTask("protocol", { selectedProtocolVersion: 14 }),
        opencodeTask("revision", { capabilityRevision: -1 }),
      ] as never);
      const modelSp = spyOn(db, "getLatestRunModelByTask").mockResolvedValue(new Map());
      restores.push(() => { listSp.mockRestore(); modelSp.mockRestore(); });
      const body = JSON.parse(await dispatchTaskCommand({ command: "list" }, CTX)) as Array<{
        id: string;
        harnessId: string | null;
      }>;
      expect(body.map((task) => task.harnessId)).toEqual([null, null, null, null, null]);
    });

    test("read labels only an exact Claude Code descriptor", async () => {
      stubRuntime();
      const execution = {
        version: 1,
        harnessId: "claude-code",
        source: "genie",
        profileRef: "profile-1",
        catalogModelId: "catalog-1",
        selectedModel: "claude-model",
      };
      const getSp = spyOn(db, "getTaskById")
        .mockResolvedValueOnce({
          id: "claude-task", ownerId: OWNER_ID, agentId: AGENT_ID, status: "pending",
          prompt: "work", scheduleKind: "now", targetChat: "orphan", callingRoomId: ROOM_ID,
          resultDelivery: "wake", metadata: { execution },
        } as never)
        .mockResolvedValueOnce({
          id: "claude-task", ownerId: OWNER_ID, agentId: AGENT_ID, status: "pending",
          prompt: "work", scheduleKind: "now", targetChat: "orphan", callingRoomId: ROOM_ID,
          resultDelivery: "wake", metadata: { execution, extra: true },
        } as never);
      const runsSp = spyOn(db, "getTaskRuns").mockResolvedValue([] as never);
      restores.push(() => { getSp.mockRestore(); runsSp.mockRestore(); });
      const exact = JSON.parse(await dispatchTaskCommand({ command: "read", taskId: "claude-task" }, CTX)) as unknown as {
        task: { harnessId: string | null };
      };
      const near = JSON.parse(await dispatchTaskCommand({ command: "read", taskId: "claude-task" }, CTX)) as unknown as {
        task: { harnessId: string | null };
      };
      expect(exact.task.harnessId).toBe("claude-code");
      expect(near.task.harnessId).toBeNull();
    });
  });

  test("M152 — unsatisfiable privacy profile returns the error and does NOT insert", async () => {
    stubRuntime();
    const savedKeys: Record<string, string | undefined> = {};
    for (const k of ["ANTHROPIC_API_KEY", "FIREWORKS_API_KEY", "OPENROUTER_API_KEY", "VENICE_API_KEY"]) {
      savedKeys[k] = process.env[k];
      if (k === "ANTHROPIC_API_KEY") process.env[k] = "x";
      else delete process.env[k];
    }
    restores.push(() => {
      for (const [k, v] of Object.entries(savedKeys)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    capturedCreate = null;
    const raw = await dispatchTaskCommand(
      { command: "create", prompt: "p", model_selection_profile: "private_cheap" },
      CTX,
    );
    expect(raw).toContain("privacy grade");
    expect(capturedCreate).toBeNull();
  });

  test("M152 — update persists selectionProfile on the patch", async () => {
    stubRuntime();
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "x";
    const getSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-1",
      ownerId: OWNER_ID,
      status: "pending",
      prompt: "old",
      scheduleKind: "now",
      targetChat: "orphan",
      resultDelivery: "wake",
    } as never);
    let patched: Record<string, unknown> | null = null;
    const updateSp = spyOn(db, "updateTask").mockImplementation(async (_db, _id, patch) => {
      patched = patch as Record<string, unknown>;
      return { id: "task-1", ownerId: OWNER_ID, status: "pending", prompt: "old", scheduleKind: "now", targetChat: "orphan", resultDelivery: "wake" } as never;
    });
    restores.push(() => {
      getSp.mockRestore();
      updateSp.mockRestore();
      if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prev;
    });

    await dispatchTaskCommand(
      { command: "update", taskId: "task-1", model_selection_profile: "smartest" },
      CTX,
    );
    expect(patched).not.toBeNull();
    expect(patched!["selectionProfile"]).toBe("smartest");
  });

  test("M163 — read attaches agent-authored transcript for orphan (assistant w/ toolCalls + tool w/ null)", async () => {
    stubRuntime();
    const startedAt = new Date("2024-01-01T00:00:00.000Z");
    const completedAt = new Date("2024-01-01T00:05:00.000Z");
    const tA = new Date("2024-01-01T00:01:00.000Z");
    const tT = new Date("2024-01-01T00:02:00.000Z");

    // The helper already does the role/window/agent filtering in SQL, so the
    // unit test mocks its OUTPUT (already assistant/tool only). It asserts the
    // dispatch wiring: toolCalls passthrough + ISO createdAt + helper call args.
    const transcriptSp = spyOn(
      sessionStore,
      "getRunAgentTranscript",
    ).mockResolvedValue([
      {
        role: "assistant",
        content: "calling search",
        toolName: null,
        toolCalls: [{ name: "search", args: { q: "x" }, id: "call_1" }],
        createdAt: tA,
      },
      {
        role: "tool",
        content: "search results",
        toolName: "search",
        toolCalls: null,
        createdAt: tT,
      },
    ] as never);
    restores.push(() => transcriptSp.mockRestore());

    const getSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-1",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      status: "completed",
      prompt: "do it",
      scheduleKind: "now",
      targetChat: "orphan",
      callingRoomId: null,
      resultDelivery: "wake",
    } as never);
    restores.push(() => getSp.mockRestore());

    const runsSp = spyOn(db, "getTaskRuns").mockResolvedValue([
      {
        id: "run1",
        status: "completed",
        modelId: "fireworks:accounts/fireworks/models/kimi-k2p6",
        resultText: "ok",
        lastError: null,
        startedAt,
        completedAt,
        graphThreadId: "subagent:room:x:abc",
      },
    ] as never);
    restores.push(() => runsSp.mockRestore());

    const raw = await dispatchTaskCommand(
      { command: "read", taskId: "task-1" },
      CTX,
    );
    const body = JSON.parse(raw) as {
      runs: Array<{
        modelId: string | null;
        transcript?: Array<{
          role: string;
          content: string;
          toolName: string | null;
          toolCalls: Array<{ name: string; args: unknown; id: string | null }> | null;
          createdAt: string;
        }>;
      }>;
    };
    expect(body.runs[0]?.transcript).toEqual([
      {
        role: "assistant",
        content: "calling search",
        toolName: null,
        toolCalls: [{ name: "search", args: { q: "x" }, id: "call_1" }],
        createdAt: tA.toISOString(),
      },
      {
        role: "tool",
        content: "search results",
        toolName: "search",
        toolCalls: null,
        createdAt: tT.toISOString(),
      },
    ]);
    // The helper is keyed by the run's thread + the task's agent + run window.
    expect(transcriptSp).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      graphThreadId: "subagent:room:x:abc",
      agentId: AGENT_ID,
      startedAt,
      completedAt,
    });
    // M152 — read surfaces the model each run actually used.
    expect(body.runs[0]?.modelId).toBe(
      "fireworks:accounts/fireworks/models/kimi-k2p6",
    );
  });

  test("M163 — read attaches transcript for a named-target task too (was orphan-only)", async () => {
    stubRuntime();
    const transcriptSp = spyOn(
      sessionStore,
      "getRunAgentTranscript",
    ).mockResolvedValue([
      {
        role: "assistant",
        content: "did the thing",
        toolName: null,
        toolCalls: null,
        createdAt: new Date("2024-02-02T00:00:00.000Z"),
      },
    ] as never);
    restores.push(() => transcriptSp.mockRestore());

    const getSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "task-1",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      status: "completed",
      prompt: "do it",
      scheduleKind: "now",
      targetChat: "new_in_namespace",
      callingRoomId: null,
      resultDelivery: "wake",
    } as never);
    restores.push(() => getSp.mockRestore());

    const runsSp = spyOn(db, "getTaskRuns").mockResolvedValue([
      {
        id: "run1",
        status: "completed",
        modelId: null,
        resultText: "ok",
        lastError: null,
        startedAt: new Date("2024-02-02T00:00:00.000Z"),
        completedAt: new Date("2024-02-02T00:01:00.000Z"),
        graphThreadId: "room:roomA:bot:agentA",
      },
    ] as never);
    restores.push(() => runsSp.mockRestore());

    const raw = await dispatchTaskCommand(
      { command: "read", taskId: "task-1" },
      CTX,
    );
    const body = JSON.parse(raw) as {
      runs: Array<{ transcript?: Array<{ role: string; content: string }> }>;
    };
    // Previously this was `undefined` for named targets; now it is present.
    expect(body.runs[0]?.transcript).toEqual([
      expect.objectContaining({ role: "assistant", content: "did the thing" }),
    ]);
    expect(transcriptSp).toHaveBeenCalled();
  });

  test("list with status pushes { status } to the store (not {} + JS filter)", async () => {
    stubRuntime();
    const listSp = spyOn(db, "listTasksForOwner").mockResolvedValue([
      {
        id: "done-1",
        status: "completed",
        prompt: "finished work",
        scheduleKind: "now",
        callingRoomId: null,
        selectionProfile: "cheapest",
      },
    ] as never);
    restores.push(() => listSp.mockRestore());
    const modelSp = spyOn(db, "getLatestRunModelByTask").mockResolvedValue(
      new Map([["done-1", "fireworks:accounts/fireworks/models/kimi-k2p6"]]),
    );
    restores.push(() => modelSp.mockRestore());

    const raw = await dispatchTaskCommand(
      { command: "list", status: "completed", includeTerminal: true },
      CTX,
    );
    // Regression: the store must receive { status }, NOT {} (which excludes
    // terminal rows and made status:"completed" return []).
    expect(listSp).toHaveBeenCalledWith(expect.anything(), OWNER_ID, {
      status: "completed",
    });
    const body = JSON.parse(raw) as Array<{
      id: string;
      status: string;
      lastModelId: string | null;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.status).toBe("completed");
    // M152 — list surfaces the most-recent run's model id.
    expect(body[0]?.lastModelId).toBe(
      "fireworks:accounts/fireworks/models/kimi-k2p6",
    );
  });

  test("list without status passes { includeTerminal } to the store", async () => {
    stubRuntime();
    const listSp = spyOn(db, "listTasksForOwner").mockResolvedValue([] as never);
    restores.push(() => listSp.mockRestore());

    await dispatchTaskCommand({ command: "list", includeTerminal: true }, CTX);
    expect(listSp).toHaveBeenCalledWith(expect.anything(), OWNER_ID, {
      includeTerminal: true,
    });
  });
});

describe("task tool target_users (M165)", () => {
  const PEER_ID = "50000000-0000-4000-8000-000000000005";
  let capturedCreate: TaskToolCreateInput | null = null;

  afterEach(() => {
    setTaskToolRuntime(null);
    capturedCreate = null;
  });

  /** Stub runtime whose `db.select(...).from(...).where(...).limit(1)` returns
   *  the queued rows in order — one per resolved handle. */
  function runtimeWithLookup(results: Array<Array<{ id: string }>>) {
    let i = 0;
    setTaskToolRuntime({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => results[i++] ?? [] }),
          }),
        }),
      } as never,
      createTask: async (input) => {
        capturedCreate = input;
        return { taskId: "t1", status: "pending" };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
  }

  test("create with no target_users → requester-only targetUserIds (no db lookup)", async () => {
    // `db: {} as never` would throw if select() were called; it must not be.
    runtimeWithLookup([]);
    await dispatchTaskCommand({ command: "create", prompt: "x" }, CTX);
    expect(capturedCreate?.targetUserIds).toEqual([OWNER_ID]);
  });

  test("create with a resolvable peer handle → [requester, peer] (requester first)", async () => {
    runtimeWithLookup([[{ id: PEER_ID }]]);
    await dispatchTaskCommand(
      { command: "create", prompt: "x", target_users: ["@bob"] },
      CTX,
    );
    expect(capturedCreate?.targetUserIds).toEqual([OWNER_ID, PEER_ID]);
  });

  test("create dedups a handle that resolves to the requester", async () => {
    runtimeWithLookup([[{ id: OWNER_ID }]]);
    await dispatchTaskCommand(
      { command: "create", prompt: "x", target_users: ["@me"] },
      CTX,
    );
    expect(capturedCreate?.targetUserIds).toEqual([OWNER_ID]);
  });

  test("create with an unknown handle returns a friendly error and does NOT insert", async () => {
    runtimeWithLookup([[]]);
    const raw = await dispatchTaskCommand(
      { command: "create", prompt: "x", target_users: ["@ghost"] },
      CTX,
    );
    expect(raw).toContain('no local user found for target_users handle "@ghost"');
    expect(capturedCreate).toBeNull();
  });
});
