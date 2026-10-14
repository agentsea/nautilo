import { beforeEach, afterEach, describe, expect, spyOn, test } from "bun:test";
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
import { createInScopeTool } from "../../src/tools/tasks/shortcuts/in-scope";
import { createInPrivateNamespaceTool } from "../../src/tools/tasks/shortcuts/in-private-namespace";
import { createAskPeerTool } from "../../src/tools/tasks/shortcuts/ask-peer";
import { createScheduleTool } from "../../src/tools/tasks/shortcuts/schedule";
import { createDiscoverModelsTool } from "../../src/tools/meta/discover-models";
import {
  runWithCapabilityFundingSession,
  type CapabilityFundingSession,
} from "../../src/runtime/capability-funding";
import * as shareArtifact from "../../src/tools/file/share-artifact";
import {
  setTaskToolRuntime,
  type TaskToolCreateInput,
  type TaskToolRuntime,
} from "../../src/tools/tasks/task-tool-runtime";
import { dispatchTaskCommand } from "../../src/tools/tasks/dispatch";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const ROOM_ID = "30000000-0000-4000-8000-000000000003";
const PEER_ID = "40000000-0000-4000-8000-000000000004";
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

  beforeEach(() => {
    const versioned = spyOn(db, "getTaskByIdWithMutationVersion").mockImplementation(async (database, id) => {
      const task = await db.getTaskById(database, id);
      return task ? { ...task, mutationVersion: "fixture-version", contentRevision: task.contentRevision ?? 0 } : undefined;
    });
    restores.push(() => versioned.mockRestore());
  });

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
      "task", "in_background", "in_scope", "in_private_namespace", "ask_peer",
      "schedule", "discover_models",
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
    })).toBeTrue();
    expect(isPersonalTaskControlCall({
      name: "in_background",
      args: { brief: "summarize", tools: ["run_shell"] },
    })).toBeTrue();
    expect(isPersonalTaskControlCall({
      name: "ask_peer",
      args: { peer_handle: "peer", message_to_peer: "Are you free?" },
    })).toBeTrue();
    expect(isPersonalTaskControlCall({
      name: "ask_peer",
      args: { peer_handle: "peer", message_to_peer: "Review this", artifact_ids: ["doc"] },
    })).toBeFalse();
    expect(isPersonalTaskControlCall({
      name: "discover_models",
      args: { command: "list", output: "video" },
    })).toBeFalse();
    expect(isPersonalTaskControlCall({
      name: "discover_models",
      args: {
        command: "list", workload: "decision",
        decision_operation: "noul", runnable_only: true,
      },
    })).toBeTrue();
    expect(isPersonalTaskControlCall({
      name: "discover_models",
      args: { command: "list", decision_operation: "noul" },
    })).toBeFalse();
    expect(isPersonalTaskControlCall({ name: "generate_image", args: {} })).toBeFalse();
  });

  test("personal task schema exposes native shapes but omits external harness controls", () => {
    const shape = createPersonalTaskToolSchema().shape;
    for (const key of ["harness", "collaboration_mode", "harness_model_id", "working_directory"]) {
      expect(key in shape).toBeFalse();
    }
    for (const key of ["target_users", "use_scope", "scope_id", "tools", "parent_task_id"]) {
      expect(key in shape).toBeTrue();
    }
    expect(shape.command.options).toEqual([
      "create", "read", "list", "update", "pause", "unpause", "stop",
    ]);
    expect(createPersonalTaskToolSchema().safeParse({
      command: "create", prompt: "x", target_chat: "new_in_namespace",
    }).success).toBeTrue();
  });

  test("a foreign Genie can create a multi-user tool Task for the causal Human", async () => {
    const query = {
      from() { return this; },
      where() { return this; },
      limit: async () => [{ id: PEER_ID }],
    };
    installRuntime({ db: { select: () => query } as never });
    await createTaskTool({
      ...CONTEXT,
      ownerId: "50000000-0000-4000-8000-000000000005",
      causalHumanUserId: OWNER_ID,
    }).invoke({
      command: "create",
      prompt: "Compare our notes",
      target_users: ["@peer"],
      tools: ["search_memory"],
      model_id: PERSONAL_ONLY_MODEL_ID,
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      ownerId: "50000000-0000-4000-8000-000000000005",
      requestorId: OWNER_ID,
      targetUserIds: [OWNER_ID, PEER_ID],
      toolsMode: "whitelist",
      toolsWhitelist: ["search_memory"],
      requestedModelId: PERSONAL_ONLY_MODEL_ID,
    });
  });

  test("personal capability controls reach scoped, private, and peer Task journeys", async () => {
    installRuntime();
    await createInScopeTool(CONTEXT).invoke({
      brief: "Check one fact", tools: ["search_memory"], model_id: PERSONAL_ONLY_MODEL_ID,
    });
    await createInPrivateNamespaceTool(CONTEXT).invoke({
      brief: "Review my notes", bring_back: false, model_id: PERSONAL_ONLY_MODEL_ID,
    });
    await createAskPeerTool(CONTEXT).invoke({
      peer_handle: "peer", message_to_peer: "Are you free?", model_id: PERSONAL_ONLY_MODEL_ID,
    });

    expect(created).toHaveLength(3);
    expect(created[0]).toMatchObject({ preset: "in_scope", useScope: true,
      toolsMode: "whitelist", toolsWhitelist: ["search_memory"] });
    expect(created[1]).toMatchObject({ preset: "in_private_namespace",
      metadata: { bringBack: false }, toolsMode: "auto" });
    expect(created[2]).toMatchObject({ preset: "ask_peer", targetChat: "last_dm",
      targetChatHandle: "@peer", awaitResponse: true, toolsMode: "none" });
    expect(created.every((input) => input.requestedModelId === PERSONAL_ONLY_MODEL_ID)).toBeTrue();
  });

  test("personal peer controls advertise and execute only plain peer Tasks", async () => {
    installRuntime();
    const tool = createAskPeerTool(CONTEXT);
    const schema = tool.schema as { shape?: Record<string, unknown> };
    expect(Object.keys(schema.shape ?? {}).sort()).toEqual([
      "message_to_peer", "model_id", "model_selection", "peer_handle",
      "return_instructions", "tools",
    ]);
    expect(tool.description).toContain("plain DM subagent");
    expect(tool.description).not.toContain("include_focused_artifacts");
    const share = spyOn(shareArtifact, "grantArtifactExactUserAccess");
    restores.push(() => share.mockRestore());
    let rejected = false;
    try {
      await tool.invoke({
        peer_handle: "peer", message_to_peer: "Review this", artifact_ids: ["doc"],
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBeTrue();
    expect(share).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  test("capability ALS keeps personal and exact personal-only peer children plain before sharing", async () => {
    installRuntime();
    const share = spyOn(shareArtifact, "grantArtifactExactUserAccess");
    restores.push(() => share.mockRestore());

    await runWithCapabilityFundingSession({
      humanUserId: OWNER_ID,
      parentFundingKind: "personal",
    } as never, async () => {
      const tool = createAskPeerTool({ ...SERVER_PARENT_CONTEXT,
        ownerId: "50000000-0000-4000-8000-000000000005" });
      const schema = tool.schema as { shape?: Record<string, unknown> };
      expect(Object.keys(schema.shape ?? {})).not.toContain("artifact_ids");
      let rejected = false;
      try {
        await tool.invoke({
          peer_handle: "peer", message_to_peer: "Review this", artifact_ids: ["doc"],
        });
      } catch {
        rejected = true;
      }
      expect(rejected).toBeTrue();
    });

    const serverParentContext = { ...SERVER_PARENT_CONTEXT,
      ownerId: "50000000-0000-4000-8000-000000000005" };
    const denied = await runWithCapabilityFundingSession({
      humanUserId: OWNER_ID,
      parentFundingKind: "server",
    } as never, () => createAskPeerTool(serverParentContext).invoke({
      peer_handle: "peer", message_to_peer: "Review this", artifact_ids: ["doc"],
      model_id: PERSONAL_ONLY_MODEL_ID,
    }));
    expect(denied).toContain("Cannot start caller-funded ask_peer with Artifacts");
    expect(share).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);

    await runWithCapabilityFundingSession({
      humanUserId: OWNER_ID,
      parentFundingKind: "server",
    } as never, () => createAskPeerTool(serverParentContext).invoke({
      peer_handle: "peer", message_to_peer: "Are you free?",
      model_id: PERSONAL_ONLY_MODEL_ID,
    }));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ ownerId: serverParentContext.ownerId,
      requestorId: OWNER_ID, requestedModelId: PERSONAL_ONLY_MODEL_ID });
  });

  test("direct personal factories preserve ordinary native immediate and scheduled semantics", async () => {
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
        toolsMode: "auto",
        targetUserIds: [OWNER_ID],
        depth: 0,
      });
      expect(input.parentTaskId).toBeUndefined();
    }
    expect(created[0]?.targetChat).toBe("orphan");
    expect(created[1]?.targetChat).toBe("last_in_namespace");
    expect(created[1]?.targetRoomId).toBe(ROOM_ID);
  });

  test("server-funded parent preserves native semantics for an exact personal-only model", async () => {
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
        toolsMode: "auto",
        targetUserIds: [OWNER_ID],
        depth: 0,
      });
      expect(input.parentTaskId).toBeUndefined();
    }
    expect(created[0]?.targetChat).toBe("orphan");
    expect(created[1]?.targetChat).toBe("orphan");
    expect(created[2]?.targetChat).toBe("last_in_namespace");
    expect(created[2]?.targetRoomId).toBe(ROOM_ID);
  });

  test("real capability ALS still defers exact personal-only children to live Task admission", async () => {
    installRuntime();
    await runWithCapabilityFundingSession({
      humanUserId: OWNER_ID,
      parentFundingKind: "server",
    } as never, async () => {
      await createTaskTool(SERVER_PARENT_CONTEXT).invoke({
        command: "create", prompt: "exact child", model_id: PERSONAL_ONLY_MODEL_ID,
      });
      await createInBackgroundTool(SERVER_PARENT_CONTEXT).invoke({
        brief: "exact background child", model_id: PERSONAL_ONLY_MODEL_ID,
      });
      await createScheduleTool(SERVER_PARENT_CONTEXT).invoke({
        message: "exact scheduled child",
        when: { kind: "recurring", cron: "0 9 * * *" },
        model_id: PERSONAL_ONLY_MODEL_ID,
      });
    });

    expect(created).toHaveLength(3);
    expect(created.map((input) => input.requestedModelId)).toEqual([
      PERSONAL_ONLY_MODEL_ID, PERSONAL_ONLY_MODEL_ID, PERSONAL_ONLY_MODEL_ID,
    ]);
    expect(created[2]).toMatchObject({
      preset: "schedule", targetChat: "last_in_namespace", targetRoomId: ROOM_ID,
    });
  });

  test("live capability ALS defers shortcut model validation to Task admission", async () => {
    installRuntime({ isPersonalOnlyTaskSelection: async () => false });
    const context = { ...SERVER_PARENT_CONTEXT, personalOnlyTaskModelIds: [] };
    await runWithCapabilityFundingSession({
      humanUserId: OWNER_ID,
      parentFundingKind: "server",
    } as never, async () => {
      await createInBackgroundTool(context).invoke({
        brief: "defer exact selection", model_id: "openrouter:admission-owned-model",
      });
      await createScheduleTool(context).invoke({
        message: "defer exact schedule selection",
        when: { kind: "recurring", cron: "0 9 * * *" },
        model_id: "openrouter:admission-owned-model",
      });
    });

    expect(created).toHaveLength(2);
    expect(created.map((input) => input.requestedModelId)).toEqual([
      "openrouter:admission-owned-model", "openrouter:admission-owned-model",
    ]);
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
        toolsMode: "auto",
        depth: 0,
      });
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

  test("personal-only conversion admits native shapes and rejects external harness selection", () => {
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
      { target_chat: "new_in_namespace" },
    ]) {
      expect(isPersonalOnlyNativeTaskCreate({ ...base, ...extra }, "parent", trusted)).toBeTrue();
    }
    expect(isPersonalOnlyNativeTaskCreate({ ...base, harness: "codex" }, "", trusted)).toBeFalse();
    expect(isPersonalOnlyNativeTaskCreate({ ...base, model_selection_profile: "cheapest" }, "", trusted)).toBeFalse();
    expect(isPersonalOnlyNativeTaskCreate(base, "parent", trusted)).toBeTrue();
    expect(isPersonalOnlyNativeShortcutCreate({
      brief: "x", model_id: PERSONAL_ONLY_MODEL_ID, tools: ["file"],
    }, "parent", trusted, { allowTools: true })).toBeTrue();

    expect(isBoundedPersonalNativeTaskCreate({
      command: "create", prompt: "x", model_selection_profile: "most_private",
    }, "")).toBeTrue();
    expect(isBoundedPersonalNativeShortcutCreate({
      brief: "x", model_selection: "most_private",
    }, "", { allowTools: true })).toBeTrue();
    for (const supported of [
      { command: "create", prompt: "x", tools: ["file"] },
      { command: "create", prompt: "x", target_users: ["@peer"] },
      { command: "create", prompt: "x", target_chat: "new_in_namespace" },
    ]) {
      expect(isBoundedPersonalNativeTaskCreate(supported, "parent")).toBeTrue();
    }
    expect(isBoundedPersonalNativeTaskCreate(
      { command: "create", prompt: "x", harness: "codex" }, "",
    )).toBeFalse();
  });

  test("personal factories preserve canonical nested lineage and native schema fields", async () => {
    installRuntime();
    const parent = spyOn(db, "getTaskById").mockResolvedValue({
      id: "parent", ownerId: OWNER_ID, depth: 2,
    } as never);
    restores.push(() => parent.mockRestore());
    const nested = createInBackgroundTool({ ...CONTEXT, currentTaskId: "parent" });
    expect(await nested.invoke({ brief: "nested", tools: ["search_memory"] })).toContain("taskId");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      parentTaskId: "parent", depth: 3,
      toolsMode: "whitelist", toolsWhitelist: ["search_memory"],
    });

    const schema = createInBackgroundTool(CONTEXT).schema as { shape?: Record<string, unknown> };
    expect(Object.keys(schema.shape ?? {}).sort()).toEqual([
      "brief", "harness", "model_id", "model_selection", "result_delivery", "tools", "working_directory",
    ]);
  });

  test("personal model discovery exposes only the trusted runnable text set", async () => {
    const runnableModelIds = ["anthropic:claude-sonnet-4-6"];
    const decisionModelId = "openrouter:typesafe/jev-1.13";
    const capability = {
      humanUserId: OWNER_ID,
      parentFundingKind: "personal",
      decisionModelId,
      async resolveModel(role, configuredId) {
        if (role !== "decision" || configuredId !== decisionModelId) {
          throw new Error("unavailable");
        }
        return { modelId: decisionModelId, preferenceRevision: 1 };
      },
      async openModel() { throw new Error("unused"); },
      async openService() { throw new Error("unused"); },
    } satisfies CapabilityFundingSession;
    const tool = createDiscoverModelsTool({
      personalTaskControls: true,
      personalTaskRunnableModelIds: runnableModelIds,
      env: {},
    });
    const schema = tool.schema as { shape?: Record<string, unknown> };
    expect(Object.keys(schema.shape ?? {}).sort()).toEqual([
      "command", "decision_operation", "limit", "model_id", "offset", "output",
      "provider", "query", "requires_reasoning", "runnable_only", "workload",
    ]);
    await runWithCapabilityFundingSession(capability, async () => {
      const result = JSON.parse(String(await tool.invoke({ command: "list" }))) as {
        items: Array<{ id: string; availability: string; workload: string; output: string[] }>;
      };
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe(runnableModelIds[0]);
      expect(result.items[0]?.availability).toBe("selectable");
      expect(result.items[0]?.workload).toBe("chat");
      expect(result.items[0]?.output).toContain("text");

      const decisions = JSON.parse(String(await tool.invoke({
        command: "list",
        workload: "decision",
        decision_operation: "noul",
        runnable_only: true,
      }))) as {
        items: Array<{ id: string; availability: string; workload: string }>;
      };
      expect(decisions.items).toHaveLength(1);
      expect(decisions.items[0]).toMatchObject({
        id: decisionModelId,
        availability: "selectable",
        workload: "decision",
      });
    });
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
    const updateTask = spyOn(db, "updateTaskIfCurrent").mockImplementation(async (_database, _id, patch) => ({
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
    const updateTask = spyOn(db, "updateTaskIfCurrent").mockImplementation(async (_database, _id, patch) => {
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
    const updateTask = spyOn(db, "updateTaskIfCurrent").mockResolvedValue(task as never);
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
    }, CONTEXT)).toContain("caller-funded Task identity or native authority changed");
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

  test("personal controls can update and unpause a memoized orphan only after trusted funding validation", async () => {
    const task = personalTask({ targetRoomId: "hidden-task-room" });
    const getTask = spyOn(db, "getTaskById").mockResolvedValue(task as never);
    const update = spyOn(db, "updateTaskIfCurrent").mockResolvedValue(task as never);
    restores.push(() => getTask.mockRestore(), () => update.mockRestore());
    const order: string[] = [];
    installRuntime({
      assertMutationFunding: async ({ operation }) => { order.push(`admit:${operation}`); },
      unpauseTask: async () => {
        order.push("unpause");
        return { ok: true, status: "pending", message: "" };
      },
    });
    await dispatchTaskCommand({ command: "update", taskId: task.id, prompt: "updated text" }, CONTEXT);
    expect(update).toHaveBeenCalledTimes(1);
    await dispatchTaskCommand({ command: "unpause", taskId: task.id }, CONTEXT);
    expect(order).toEqual(["admit:update", "admit:unpause", "unpause"]);

    installRuntime({ assertMutationFunding: async () => { throw new Error("hidden Room validation denied"); } });
    expect(await dispatchTaskCommand({ command: "unpause", taskId: task.id }, CONTEXT))
      .toContain("hidden Room validation denied");
    expect(order).toHaveLength(3);
  });
});
