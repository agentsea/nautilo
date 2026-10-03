import type { ToolCall } from "@langchain/core/messages/tool";

/** The complete tool surface available to an admitted personal-funded parent. */
export const PERSONAL_TASK_CONTROL_TOOL_NAMES = [
  "task",
  "in_background",
  "schedule",
  "discover_models",
] as const;

const PERSONAL_TASK_CONTROL_TOOL_NAME_SET = new Set<string>(
  PERSONAL_TASK_CONTROL_TOOL_NAMES,
);

function isPersonalTaskControlToolName(name: string): boolean {
  return PERSONAL_TASK_CONTROL_TOOL_NAME_SET.has(name);
}

function hasOnlyKeys(
  args: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(args).every((key) => keys.has(key));
}

function isTrustedPersonalOnlyModel(
  modelId: unknown,
  personalOnlyTaskModelIds: readonly string[] | undefined,
): modelId is string {
  return typeof modelId === "string"
    && personalOnlyTaskModelIds?.includes(modelId) === true;
}

/**
 * A server-funded foreground parent may select a caller-only model only for
 * the same bounded native root tool-free Task shape as personal controls.
 * The trusted model set comes from graph composition, never model arguments.
 */
export function isPersonalOnlyNativeTaskCreate(
  args: Readonly<Record<string, unknown>>,
  currentTaskId: string,
  personalOnlyTaskModelIds: readonly string[] | undefined,
): boolean {
  return args["command"] === "create"
    && currentTaskId.length === 0
    && isTrustedPersonalOnlyModel(args["model_id"], personalOnlyTaskModelIds)
    && (args["harness"] === undefined || args["harness"] === "native")
    && (args["tools"] === undefined
      || (Array.isArray(args["tools"]) && args["tools"].length === 0))
    && args["target_users"] === undefined
    && (args["use_scope"] === undefined || args["use_scope"] === false)
    && args["scope_id"] === undefined
    && args["parent_task_id"] === undefined
    && args["collaboration_mode"] === undefined
    && args["harness_model_id"] === undefined
    && args["working_directory"] === undefined
    && (args["target_chat"] === undefined
      || args["target_chat"] === "orphan"
      || args["target_chat"] === "last_in_namespace")
    && args["model_selection_profile"] === undefined
    && args["model_selection_spec"] === undefined;
}

export function isPersonalOnlyNativeShortcutCreate(
  args: Readonly<Record<string, unknown>>,
  currentTaskId: string,
  personalOnlyTaskModelIds: readonly string[] | undefined,
  options: Readonly<{ allowTools: boolean }>,
): boolean {
  return currentTaskId.length === 0
    && isTrustedPersonalOnlyModel(args["model_id"], personalOnlyTaskModelIds)
    && args["model_selection"] === undefined
    && args["harness"] === undefined
    && args["working_directory"] === undefined
    && (!options.allowTools
      ? args["tools"] === undefined
      : args["tools"] === undefined
        || (Array.isArray(args["tools"]) && args["tools"].length === 0));
}

function isTaskControlArgs(args: Readonly<Record<string, unknown>>): boolean {
  const command = args["command"];
  if (command === "create") {
    return hasOnlyKeys(args, [
      "command", "prompt", "expected_output", "schedule_kind", "run_at",
      "cron", "timezone", "target_chat", "result_delivery",
      "time_limit_seconds", "model_selection_profile", "model_selection_spec",
      "model_id",
    ]);
  }
  if (command === "update") {
    return hasOnlyKeys(args, [
      "command", "taskId", "prompt", "expected_output", "schedule_kind",
      "run_at", "cron", "timezone", "target_chat", "result_delivery",
      "time_limit_seconds", "model_selection_profile", "model_selection_spec",
      "model_id",
    ]);
  }
  if (command === "read") {
    return hasOnlyKeys(args, [
      "command", "taskId", "readSection", "runId", "readCursor",
      "continueRead", "readSearch",
    ]);
  }
  if (command === "list") {
    return hasOnlyKeys(args, ["command", "status", "includeTerminal"]);
  }
  if (command === "pause" || command === "unpause" || command === "stop") {
    return hasOnlyKeys(args, ["command", "taskId"]);
  }
  return false;
}

function isDiscoverModelsArgs(args: Readonly<Record<string, unknown>>): boolean {
  if (!hasOnlyKeys(args, [
    "command", "model_id", "query", "provider", "runnable_only",
    "requires_reasoning", "workload", "output", "limit", "offset",
  ])) return false;
  if (args["workload"] !== undefined && args["workload"] !== "chat") return false;
  if (args["output"] !== undefined && args["output"] !== "text") return false;
  return args["command"] === "list"
    || args["command"] === "search"
    || args["command"] === "get";
}

/**
 * Recheck raw model output before schema parsing. Zod strips unknown object
 * keys, so this predicate deliberately rejects them before they can smuggle a
 * peer, harness, resource, scope, nested parent, or worker-tool request.
 */
export function isPersonalTaskControlCall(
  call: Pick<ToolCall, "name" | "args">,
): boolean {
  if (!isPersonalTaskControlToolName(call.name)) return false;
  const args = call.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const record = args as Readonly<Record<string, unknown>>;
  if (call.name === "task") return isTaskControlArgs(record);
  if (call.name === "in_background") {
    return hasOnlyKeys(record, [
      "brief", "result_delivery", "model_selection", "model_id",
    ]);
  }
  if (call.name === "schedule") {
    return hasOnlyKeys(record, ["message", "when", "model_selection", "model_id"]);
  }
  return isDiscoverModelsArgs(record);
}

export function filterPersonalTaskControlTools<T extends { readonly name: string }>(
  tools: readonly T[],
): T[] {
  return tools.filter((tool) => isPersonalTaskControlToolName(tool.name));
}
