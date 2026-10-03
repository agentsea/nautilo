import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as db from "@nautilo/db";
import {
  isBoundedPersonalNativeShortcutCreate,
  isBoundedPersonalNativeTaskCreate,
  isPersonalTaskControlCall,
  isPersonalOnlyNativeShortcutCreate,
  isPersonalOnlyNativeTaskCreate,
  PERSONAL_TASK_CONTROL_TOOL_NAMES,
} from "../../src/runtime/personal-task-controls";
import { createPersonalTaskToolSchema } from "../../src/tools/tasks/schema";
import { createTaskTool } from "../../src/tools/tasks/task-tool";
import { createInBackgroundTool } from "../../src/tools/tasks/shortcuts/in-background";
import { createScheduleTool } from "../../src/tools/tasks/shortcuts/schedule";
import { createDiscoverModelsTool } from "../../src/tools/meta/discover-models";
import {
  setTaskToolRuntime,
  type TaskToolCreateInput,
  type TaskToolRuntime,
} from "../../src/tools/tasks/task-tool-runtime";
import { dispatchTaskCommand } from "../../src/tools/tasks/dispatch";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const ROOM_ID = "30000000-0000-4000-8000-000000000003";
const CONTEXT = {
  ownerId: OWNER_ID,
  causalHumanUserId: OWNER_ID,
  agentId: AGENT_ID,
  roomId: ROOM_ID,
  userTimezone: "UTC",
  personalTaskControls: true,
};
const PERSONAL_ONLY_MODEL_ID = "anthropic:claude-sonnet-4-6";
const SERVER_PARENT_CONTEXT = {
  ownerId: OWNER_ID,
  causalHumanUserId: OWNER_ID,
  agentId: AGENT_ID,
  roomId: ROOM_ID,
  userTimezone: "UTC",
  personalTaskRunnableModelIds: [PERSONAL_ONLY_MODEL_ID],
  personalOnlyTaskModelIds: [PERSONAL_ONLY_MODEL_ID],
};

describe("personal-funded Task controls", () => {
  let created: TaskToolCreateInput[] = [];
  const restores: Array<() => void> = [];

  afterEach(() => {
    setTaskToolRuntime(null);
    created = [];
    while (restores.length > 0) restores.pop()!();
  });

  function installRuntime(overrides: Partial<TaskToolRuntime> = {}): void {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async (input) => {
        created.push(input);
        return { taskId: `task-${created.length}`, status: "pending", nextFireAt: new Date() };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
      ...overrides,
    });
  }

  function personalTask(overrides: Record<string, unknown> = {}) {
    return {
      id: "task-1",
      ownerId: OWNER_ID,
      requestorId: OWNER_ID,
      agentId: AGENT_ID,
      prompt: "summarize",
      expectedOutput: null,
      preset: "task",
      scheduleKind: "now",
      runAt: null,
      cron: null,
      timezone: "UTC",
      catchup: "run_once",
      callingRoomId: ROOM_ID,
      targetChat: "orphan",
      targetChatHandle: null,
      targetRoomId: null,
      resultDelivery: "raw",
      targetUserIds: [OWNER_ID],
      useScope: false,
      scopeId: null,
      toolsMode: "none",
      toolsWhitelist: [],
      awaitResponse: false,
      selectionProfile: "balanced",
      selectionSpec: null,
      requestedModelId: "anthropic:claude-sonnet-4-6",
      fundingMode: "caller",
      timeLimitSeconds: null,
      parentTaskId: null,
      depth: 0,
      status: "paused",
      nextFireAt: null,
      lastFiredAt: null,
      fireLockId: null,
      fireLockedAt: null,
      lastError: null,
      metadata: {},
      contentRepresentation: "ordinary",
      contentNamespaceId: null,
      contentRevision: 0,
      cryptoObjectId: null,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: null,
      cryptoMappingState: "unmapped",
      createdAt: new Date(),
      updatedAt: new Date(),
      cancelledAt: null,
      ...overrides,
    };
  }

  test("raw-call predicate admits only the bounded names and arguments", () => {
    expect(PERSONAL_TASK_CONTROL_TOOL_NAMES).toEqual([
      "task", "in_background", "schedule", "discover_models",
    ]);
    expect(isPersonalTaskControlCall({
      name: "task",
      args: { command: "create", prompt: "summarize", model_id: "model" },
    })).toBeTrue();
    expect(isPersonalTaskControlCall({
      name: "task",
      args: { command: "create", prompt: "summarize", harness: "codex" },
    })).toBeFalse();
    expect(isPersonalTaskControlCall({
      name: "task",
      args: { command: "create", prompt: "summarize", parent_task_id: "parent" },
    })).toBeFalse();
    expect(isPersonalTaskControlCall({
      name: "in_background",
      args: { brief: "summarize", tools: ["run_shell"] },
    })).toBeFalse();
    expect(isPersonalTaskControlCall({
      name: "discover_models",
      args: { command: "list", output: "video" },
    })).toBeFalse();
    expect(isPersonalTaskControlCall({ name: "generate_image", args: {} })).toBeFalse();
  });

  test("personal task schema omits peer, scope, harness, nested, resource, and worker-tool controls", () => {
    const shape = createPersonalTaskToolSchema().shape;
    for (const key of [
      "target_users", "use_scope", "scope_id", "tools", "parent_task_id",
      "harness", "collaboration_mode", "harness_model_id", "working_directory",
    ]) {
      expect(key in shape).toBeFalse();
    }
    expect(shape.command.options).toEqual([
      "create", "read", "list", "update", "pause", "unpause", "stop",
    ]);
    expect(createPersonalTaskToolSchema().safeParse({
      command: "create", prompt: "x", target_chat: "new_in_namespace",
    }).success).toBeFalse();
  });

  test("direct personal factories author native root tool-free immediate and scheduled Tasks", async () => {
    installRuntime();
    await createInBackgroundTool(CONTEXT).invoke({
      brief: "summarize this text",
      model_id: "personal:text-model",
    });
    await createScheduleTool(CONTEXT).invoke({
      message: "write a haiku",
      when: { kind: "recurring", cron: "0 9 * * *" },
      model_id: "personal:text-model",
    });
    await createTaskTool(CONTEXT).invoke({
      command: "create",
      prompt: "explain the note",
      schedule_kind: "now",
      model_id: "personal:text-model",
    });

    expect(created).toHaveLength(3);
    for (const input of created) {
      expect(input).toMatchObject({
        ownerId: OWNER_ID,
        requestorId: OWNER_ID,
        agentId: AGENT_ID,
        useScope: false,
        toolsMode: "none",
        targetUserIds: [OWNER_ID],
        depth: 0,
      });
      expect(input.toolsWhitelist ?? []).toEqual([]);
      expect(input.parentTaskId).toBeUndefined();
    }
    expect(created[0]?.targetChat).toBe("orphan");
    expect(created[1]?.targetChat).toBe("orphan");
  });

  test("server-funded parent creates exact personal-only models as native root tool-free Tasks", async () => {
    installRuntime();
    await createTaskTool(SERVER_PARENT_CONTEXT).invoke({
      command: "create",
      prompt: "explain the note",
      model_id: PERSONAL_ONLY_MODEL_ID,
    });
    await createInBackgroundTool(SERVER_PARENT_CONTEXT).invoke({
      brief: "summarize this text",
      model_id: PERSONAL_ONLY_MODEL_ID,
    });
    await createScheduleTool(SERVER_PARENT_CONTEXT).invoke({
      message: "write a haiku",
      when: { kind: "recurring", cron: "0 9 * * *" },
      model_id: PERSONAL_ONLY_MODEL_ID,
    });

    expect(created).toHaveLength(3);
    for (const input of created) {
      expect(input).toMatchObject({
        ownerId: OWNER_ID,
        requestorId: OWNER_ID,
        agentId: AGENT_ID,
        requestedModelId: PERSONAL_ONLY_MODEL_ID,
        useScope: false,
        toolsMode: "none",
        targetUserIds: [OWNER_ID],
        depth: 0,
      });
      expect(input.toolsWhitelist ?? []).toEqual([]);
      expect(input.parentTaskId).toBeUndefined();
    }
    expect(created[0]?.targetChat).toBe("orphan");
    expect(created[1]?.targetChat).toBe("orphan");
    expect(created[2]?.targetChat).toBe("orphan");
  });

  test("server-funded parent resolves default and profile personal-only selections before shaping Tasks", async () => {
    const selections: Array<Record<string, unknown>> = [];
    installRuntime({
      isPersonalOnlyTaskSelection: async (input) => {
        selections.push(input as Record<string, unknown>);
        return true;
      },
    });

    await createTaskTool(SERVER_PARENT_CONTEXT).invoke({
      command: "create",
      prompt: "use the Agent default",
    });
    await createInBackgroundTool(SERVER_PARENT_CONTEXT).invoke({
      brief: "choose privately",
      model_selection: "most_private",
    });
    await createScheduleTool(SERVER_PARENT_CONTEXT).invoke({
      message: "use the Agent default later",
      when: { kind: "recurring", cron: "0 9 * * *" },
    });
    await createTaskTool(SERVER_PARENT_CONTEXT).invoke({
      command: "create",
      prompt: "use the exact live selection",
      model_id: PERSONAL_ONLY_MODEL_ID,
    });

    expect(created).toHaveLength(4);
    for (const input of created) {
      expect(input).toMatchObject({
        ownerId: OWNER_ID,
        requestorId: OWNER_ID,
        agentId: AGENT_ID,
        toolsMode: "none",
        depth: 0,
      });
      expect(input.toolsWhitelist ?? []).toEqual([]);
    }
    expect(selections).toEqual([
      { requestorId: OWNER_ID, agentId: AGENT_ID, callingRoomId: ROOM_ID },
      {
        requestorId: OWNER_ID,
        agentId: AGENT_ID,
        callingRoomId: ROOM_ID,
        selectionProfile: "most_private",
      },
      { requestorId: OWNER_ID, agentId: AGENT_ID, callingRoomId: ROOM_ID },
      {
        requestorId: OWNER_ID,
        agentId: AGENT_ID,
        callingRoomId: ROOM_ID,
        requestedModelId: PERSONAL_ONLY_MODEL_ID,
      },
    ]);
  });

  test("personal-only conversion rejects paid, scoped, peer, nested, and biased shapes", () => {
    const trusted = [PERSONAL_ONLY_MODEL_ID];
    const base = {
      command: "create",
      prompt: "x",
      model_id: PERSONAL_ONLY_MODEL_ID,
    };
    expect(isPersonalOnlyNativeTaskCreate(base, "", trusted)).toBeTrue();
    for (const extra of [
      { tools: ["run_shell"] },
      { use_scope: true },
      { target_users: ["@peer"] },
      { parent_task_id: "parent" },
      { harness: "codex" },
      { target_chat: "new_in_namespace" },
      { model_selection_profile: "cheapest" },
    ]) {
      expect(isPersonalOnlyNativeTaskCreate({ ...base, ...extra }, "", trusted)).toBeFalse();
    }
    expect(isPersonalOnlyNativeTaskCreate(base, "parent", trusted)).toBeFalse();
    expect(isPersonalOnlyNativeShortcutCreate({
      brief: "x", model_id: PERSONAL_ONLY_MODEL_ID, tools: ["file"],
    }, "", trusted, { allowTools: true })).toBeFalse();

    expect(isBoundedPersonalNativeTaskCreate({
      command: "create", prompt: "x", model_selection_profile: "most_private",
    }, "")).toBeTrue();
    expect(isBoundedPersonalNativeShortcutCreate({
      brief: "x", model_selection: "most_private",
    }, "", { allowTools: true })).toBeTrue();
    for (const unsafe of [
      { command: "create", prompt: "x", tools: ["file"] },
      { command: "create", prompt: "x", target_users: ["@peer"] },
      { command: "create", prompt: "x", target_chat: "new_in_namespace" },
      { command: "create", prompt: "x", harness: "codex" },
    ]) {
      expect(isBoundedPersonalNativeTaskCreate(unsafe, "")).toBeFalse();
    }
  });

  test("personal factories reject nested construction and omit unsafe schema fields", async () => {
    installRuntime();
    const nested = createInBackgroundTool({ ...CONTEXT, currentTaskId: "parent" });
    expect(await nested.invoke({ brief: "nested" })).toContain("foreground parent chat");
    expect(created).toHaveLength(0);

    const schema = createInBackgroundTool(CONTEXT).schema as { shape?: Record<string, unknown> };
    expect(Object.keys(schema.shape ?? {}).sort()).toEqual([
      "brief", "model_id", "model_selection", "result_delivery",
    ]);
  });

  test("personal model discovery exposes only the trusted runnable text set", async () => {
    const runnableModelIds = ["anthropic:claude-sonnet-4-6"];
    const tool = createDiscoverModelsTool({
      personalTaskControls: true,
      personalTaskRunnableModelIds: runnableModelIds,
      env: {},
    });
    const schema = tool.schema as { shape?: Record<string, unknown> };
    expect(Object.keys(schema.shape ?? {}).sort()).toEqual([
      "command", "limit", "model_id", "offset", "output", "provider", "query",
      "requires_reasoning", "runnable_only", "workload",
    ]);
    const result = JSON.parse(String(await tool.invoke({ command: "list" }))) as {
      items: Array<{ id: string; availability: string; workload: string; output: string[] }>;
    };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(runnableModelIds[0]);
    expect(result.items[0]?.availability).toBe("selectable");
    expect(result.items[0]?.workload).toBe("chat");
    expect(result.items[0]?.output).toContain("text");
  });

  test("ordinary server parent discovery marks the trusted caller union selectable", async () => {
    const tool = createDiscoverModelsTool({
      personalTaskRunnableModelIds: [PERSONAL_ONLY_MODEL_ID],
      env: {},
    });
    const schema = tool.schema as { shape?: Record<string, unknown> };
    expect("requires_tools" in (schema.shape ?? {})).toBeTrue();
    const result = JSON.parse(String(await tool.invoke({
      command: "get",
      model_id: PERSONAL_ONLY_MODEL_ID,
    }))) as { found: boolean; model?: { id: string; availability: string } };
    expect(result).toMatchObject({
      found: true,
      model: { id: PERSONAL_ONLY_MODEL_ID, availability: "selectable" },
    });
  });

  test("personal update rechecks the prospective Task funding before persistence", async () => {
    const task = personalTask();
    const getTask = spyOn(db, "getTaskById").mockResolvedValue(task as never);
    const updateTask = spyOn(db, "updateTask").mockImplementation(async (_database, _id, patch) => ({
      ...task,
      ...patch,
    }) as never);
    restores.push(() => { getTask.mockRestore(); updateTask.mockRestore(); });
    const admissions: Array<{ operation: string; prompt?: string }> = [];
    installRuntime({
      assertMutationFunding: async ({ operation, patch }) => {
        admissions.push({
          operation,
          ...(patch?.prompt === undefined ? {} : { prompt: patch.prompt }),
        });
      },
    });

    const result = await dispatchTaskCommand({
      command: "update",
      taskId: "task-1",
      prompt: "new prompt",
      tools: [],
    }, CONTEXT);

    expect(result).toContain('"prompt":"new prompt"');
    expect(admissions).toEqual([{ operation: "update", prompt: "new prompt" }]);
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  test("server-funded parent updates a caller Task model through live canonical admission", async () => {
    const task = personalTask();
    const getTask = spyOn(db, "getTaskById").mockResolvedValue(task as never);
    const order: string[] = [];
    const updateTask = spyOn(db, "updateTask").mockImplementation(async (_database, _id, patch) => {
      order.push("write");
      return { ...task, ...patch } as never;
    });
    restores.push(() => { getTask.mockRestore(); updateTask.mockRestore(); });
    installRuntime({
      assertMutationFunding: async ({ patch }) => {
        order.push(`admit:${String(patch?.requestedModelId)}`);
      },
    });

    const result = await dispatchTaskCommand({
      command: "update",
      taskId: task.id,
      model_id: PERSONAL_ONLY_MODEL_ID,
    }, {
      ownerId: OWNER_ID,
      causalHumanUserId: OWNER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
    });

    expect(result).toContain(`"id":"${task.id}"`);
    expect(order).toEqual([`admit:${PERSONAL_ONLY_MODEL_ID}`, "write"]);
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  test("caller Task update fails closed before writes when canonical admission is absent or denied", async () => {
    const task = personalTask();
    const getTask = spyOn(db, "getTaskById").mockResolvedValue(task as never);
    const updateTask = spyOn(db, "updateTask").mockResolvedValue(task as never);
    restores.push(() => { getTask.mockRestore(); updateTask.mockRestore(); });
    const serverContext = {
      ownerId: OWNER_ID,
      causalHumanUserId: OWNER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
    };

    installRuntime();
    expect(await dispatchTaskCommand({
      command: "update", taskId: task.id, model_id: PERSONAL_ONLY_MODEL_ID,
    }, serverContext)).toBe("Cannot update task: live funding validation is unavailable.");
    expect(updateTask).not.toHaveBeenCalled();

    installRuntime({
      assertMutationFunding: async () => { throw new Error("funding denied"); },
    });
    expect(await dispatchTaskCommand({
      command: "update", taskId: task.id, model_id: PERSONAL_ONLY_MODEL_ID,
    }, serverContext)).toContain("funding denied");
    expect(updateTask).not.toHaveBeenCalled();
  });

  test("personal update and unpause fail closed for unsafe shape or unavailable funding admission", async () => {
    const paidLegacy = personalTask({ fundingMode: "legacy_server", toolsMode: "auto" });
    const getTask = spyOn(db, "getTaskById").mockResolvedValue(paidLegacy as never);
    restores.push(() => getTask.mockRestore());
    let unpauseCalls = 0;
    installRuntime({
      unpauseTask: async () => {
        unpauseCalls += 1;
        return { ok: true, status: "pending", message: "" };
      },
    });

    expect(await dispatchTaskCommand({
      command: "unpause", taskId: "task-1",
    }, CONTEXT)).toContain("only support caller-funded native root tool-free Tasks");
    expect(unpauseCalls).toBe(0);

    getTask.mockResolvedValue(personalTask() as never);
    expect(await dispatchTaskCommand({
      command: "unpause", taskId: "task-1",
    }, CONTEXT)).toBe("Cannot unpause task: live funding validation is unavailable.");
    expect(unpauseCalls).toBe(0);
  });

  test("personal unpause admits live funding first while stop remains available for any owned Task", async () => {
    const paidLegacy = personalTask({ fundingMode: "legacy_server", toolsMode: "auto" });
    const getTask = spyOn(db, "getTaskById").mockResolvedValue(personalTask() as never);
    restores.push(() => getTask.mockRestore());
    const order: string[] = [];
    installRuntime({
      assertMutationFunding: async ({ operation }) => { order.push(`admit:${operation}`); },
      unpauseTask: async () => {
        order.push("unpause");
        return { ok: true, status: "pending", message: "" };
      },
      stopTask: async () => {
        order.push("stop");
        return { ok: true, status: "cancelled", message: "" };
      },
    });

    await dispatchTaskCommand({ command: "unpause", taskId: "task-1" }, CONTEXT);
    expect(order).toEqual(["admit:unpause", "unpause"]);

    getTask.mockResolvedValue(paidLegacy as never);
    await dispatchTaskCommand({ command: "stop", taskId: "task-1" }, CONTEXT);
    expect(order).toEqual(["admit:unpause", "unpause", "stop"]);
  });
});
