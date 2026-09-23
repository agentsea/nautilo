import type { TaskReadPendingPage } from "./read-projection";
import type { BaseMessage } from "@langchain/core/messages";
import { readTaskSection } from "./read";
import { readTaskPreparation } from "@nautilo/types";
import {
  getTaskById,
  getTaskRuns,
  getLatestRunModelByTask,
  listTasksForOwner,
  updateTask,
  users,
  and,
  eq,
  isNull,
  type DirectDatabase,
  type NewTask,
} from "@nautilo/db";
import {
  ACP_RELAY_MAX_OPAQUE_ID_BYTES,
  OPENCODE_ACP_RELAY_PROTOCOL_VERSION,
} from "@nautilo/relay";
import { getRunAgentTranscript } from "../../store/session-store";
import type { TaskToolArgs } from "./schema";
import {
  getTaskToolRuntime,
  resolveTaskToolCreateLineage,
  type TaskToolClaudeCodeHarnessCreateInput,
  type TaskToolCreateInput,
  type TaskToolHarnessCreateInput,
  type TaskToolHermesAcpHarnessCreateInput,
} from "./task-tool-runtime";
import { rejectNotYetWiredTaskParams } from "./validate";
import { validateTaskModelSelectionForCreate } from "./selection-validation";
import { codexHarnessFailureGuidance } from "./codex-harness-guidance";
import {
  hermesAcpHarnessFailureGuidance,
  hermesAcpHarnessUnavailableGuidance,
} from "./hermes-acp-harness-guidance";
import { genieRecoveryResult } from "../genie-recovery";

export interface TaskDispatchContext {
  ownerId: string;
  causalHumanUserId: string;
  agentId: string;
  roomId: string;
  /** Server-authored durable Task currently executing this graph, if any. */
  currentTaskId?: string;
  taskReadMaxResponseBytes?: number | undefined;
  taskReadMessages?: readonly BaseMessage[] | undefined;
  taskReadPendingPages?: readonly TaskReadPendingPage[] | undefined;
}

const SCHEDULE_FIELDS = ["schedule_kind", "run_at", "cron", "timezone"] as const;

type ExternalHarnessId = "codex" | "hermes-acp" | "opencode-acp" | "claude-code";

/** Project only stable harness identity; keep relay/process metadata private. */
function taskExternalHarnessId(metadata: unknown): ExternalHarnessId | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const metadataRecord = metadata as Record<string, unknown>;
  const execution = metadataRecord["execution"];
  if (typeof execution !== "object" || execution === null || Array.isArray(execution)) return null;
  const record = execution as Record<string, unknown>;
  if (record["version"] !== 1 || record["source"] !== "genie") return null;
  if (record["harnessId"] === "codex" || record["harnessId"] === "hermes-acp") {
    return record["harnessId"];
  }
  if (isClaudeCodeExecutionDescriptor(metadataRecord, record)) return "claude-code";
  return isOpenCodeAcpExecutionDescriptor(record) ? "opencode-acp" : null;
}

/** Claude’s descriptor is sealed by the server creator; near matches stay opaque. */
function isClaudeCodeExecutionDescriptor(
  metadata: Record<string, unknown>,
  record: Record<string, unknown>,
): boolean {
  const metadataKeys = Object.keys(metadata).sort();
  const keys = Object.keys(record).sort();
  return metadataKeys.length === 1
    && metadataKeys[0] === "execution"
    && keys.length === 6
    && keys.join(",") === "catalogModelId,harnessId,profileRef,selectedModel,source,version"
    && record["version"] === 1
    && record["harnessId"] === "claude-code"
    && record["source"] === "genie"
    && isClaudeCodeDescriptorText(record["profileRef"])
    && isClaudeCodeDescriptorText(record["catalogModelId"])
    && isClaudeCodeDescriptorText(record["selectedModel"]);
}

function isClaudeCodeDescriptorText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 320
    && !value.includes("\0")
    && new TextEncoder().encode(value).byteLength <= 320;
}

/** OpenCode's descriptor has execution-specific facts. Do not project a loose
 * caller-shaped lookalike into generic Task read/list output. */
function isOpenCodeAcpExecutionDescriptor(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record).sort();
  if (keys.length !== 5 || keys.join(",") !== "executionProfile,harnessId,readiness,source,version") return false;
  if (
    record["version"] !== 1
    || record["harnessId"] !== "opencode-acp"
    || record["source"] !== "genie"
    || record["executionProfile"] !== "autonomous"
  ) return false;
  const readiness = record["readiness"];
  if (typeof readiness !== "object" || readiness === null || Array.isArray(readiness)) return false;
  const readinessRecord = readiness as Record<string, unknown>;
  const readinessKeys = Object.keys(readinessRecord).sort();
  return readinessKeys.length === 6
    && readinessKeys.join(",") === "capabilityRevision,desktopSessionId,pairingGenerationRef,relayId,relaySessionId,selectedProtocolVersion"
    && isOpenCodeAcpOpaqueId(readinessRecord["relayId"])
    && isOpenCodeAcpOpaqueId(readinessRecord["relaySessionId"])
    && isOpenCodeAcpOpaqueId(readinessRecord["pairingGenerationRef"])
    && isOpenCodeAcpOpaqueId(readinessRecord["desktopSessionId"])
    && typeof readinessRecord["selectedProtocolVersion"] === "number"
    && Number.isSafeInteger(readinessRecord["selectedProtocolVersion"])
    && readinessRecord["selectedProtocolVersion"] >= OPENCODE_ACP_RELAY_PROTOCOL_VERSION
    && typeof readinessRecord["capabilityRevision"] === "number"
    && Number.isSafeInteger(readinessRecord["capabilityRevision"])
    && readinessRecord["capabilityRevision"] >= 0;
}

function isOpenCodeAcpOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && new TextEncoder().encode(value).byteLength <= ACP_RELAY_MAX_OPAQUE_ID_BYTES;
}

function toolsFieldsFromArgs(
  tools: string[] | undefined,
): Pick<TaskToolCreateInput, "toolsMode" | "toolsWhitelist"> {
  if (tools === undefined) {
    return { toolsMode: "auto" };
  }
  if (tools.length === 0) {
    return { toolsMode: "none" };
  }
  return { toolsMode: "whitelist", toolsWhitelist: tools };
}

/**
 * M165 — resolve the `create` command's `target_users` (@handles) to local
 * `users.id`s, with the requester always auto-included (dedup, requester
 * first). Returns a friendly error string when a handle doesn't resolve to a
 * local human, so the namespace derivation never silently drops a named peer.
 * Local-only (`server IS NULL`), mirroring `findLocalUserByHandle`.
 */
async function resolveTargetUserIds(
  db: DirectDatabase,
  requesterUserId: string,
  handles: string[] | undefined,
): Promise<{ ok: true; userIds: string[] } | { ok: false; message: string }> {
  const resolved: string[] = [requesterUserId];
  for (const raw of handles ?? []) {
    const handle = raw.trim().replace(/^@/, "");
    if (!handle) continue;
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.handle, handle), isNull(users.server)))
      .limit(1);
    if (!row) {
      return {
        ok: false,
        message: `Cannot create task: no local user found for target_users handle "@${handle}".`,
      };
    }
    if (!resolved.includes(row.id)) resolved.push(row.id);
  }
  return { ok: true, userIds: resolved };
}

/** Parse an ISO `run_at` string into a Date, throwing a friendly error on junk. */
function parseRunAt(runAt: string | undefined): Date | undefined {
  if (runAt === undefined) return undefined;
  const d = new Date(runAt);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`run_at is not a valid ISO timestamp: "${runAt}"`);
  }
  return d;
}

function claudeCodeHarnessUnavailable(): string {
  return "Claude Code task execution is unavailable on this server. In Connections, enable Claude Code on a connected Desktop and select a model, then try again.";
}

export async function dispatchTaskCommand(
  args: TaskToolArgs,
  ctx: TaskDispatchContext,
): Promise<string> {
  try {
    const staleArgs = args as unknown as { harness?: string; execution_profile?: unknown };
    if (staleArgs.harness === "opencode-acp" || staleArgs.execution_profile !== undefined) {
      return "OpenCode Tasks are temporarily unavailable while Nautilo completes reliability work. Use Codex, Hermes, or Nautilo Native instead.";
    }
    if (
      args.command !== "create"
      && args.command !== "list_harness_models"
      && (args.harness !== undefined || args.collaboration_mode !== undefined || args.harness_model_id !== undefined || args.working_directory !== undefined)
    ) {
      return "Cannot use harness selection here: harness and collaboration_mode apply only when creating a task.";
    }
    switch (args.command) {
      case "list_harness_models": {
        if (!ctx.ownerId) return "Cannot list harness models: missing owner context.";
        if (args.harness !== "codex" && args.harness !== "claude-code") {
          return "Cannot list harness models: set harness to 'codex' or 'claude-code'.";
        }
        const rt = getTaskToolRuntime();
        if (args.harness === "claude-code" && rt.claudeCodeTasksEnabled !== true) {
          return claudeCodeHarnessUnavailable();
        }
        if (!rt.listHarnessModels) {
          return "Cannot list harness models: harness discovery is unavailable on this server.";
        }
        const models = await rt.listHarnessModels({ ownerId: ctx.ownerId, harness: args.harness });
        if (models.length === 0) {
          return args.harness === "claude-code"
            ? "Claude Code returned no picker-visible models for the selected account."
            : "Codex returned no picker-visible models for the selected account.";
        }
        if (args.harness === "claude-code") {
          return models.map((model) =>
            `${model.isPreferred ? "* " : "- "}${model.id} — ${model.displayName}${model.isPreferred ? " (selected)" : ""}${model.description ? `: ${model.description}` : ""}`
          ).join("\n");
        }
        return models.map((model) =>
          `${model.isPreferred ? "* " : "- "}${model.id} — ${model.displayName}${model.isPreferred ? " (Nautilo default)" : model.isDefault ? " (Codex default)" : ""}${model.description ? `: ${model.description}` : ""}`
        ).join("\n");
      }
      case "create": {
        if (!ctx.causalHumanUserId) return "Cannot create task: initiating Human is unavailable.";
        if (!ctx.ownerId || !ctx.agentId) {
          return "Cannot create task: missing owner or agent context.";
        }
        if (!args.prompt) {
          return "Cannot create task: 'prompt' is required for command 'create'.";
        }
        const rt = getTaskToolRuntime();
        if (
          args.collaboration_mode !== undefined
          && args.harness !== "codex"
        ) {
          return "Cannot create task: collaboration_mode requires harness 'codex'.";
        }
        if (
          args.harness_model_id !== undefined
          && args.harness !== "codex"
          && args.harness !== "claude-code"
        ) {
          return "Cannot create harness task: harness_model_id requires exact harness 'codex' or 'claude-code'.";
        }
        if (args.working_directory !== undefined && args.harness !== "codex") {
          return "Cannot create harness task: working_directory requires exact harness 'codex'.";
        }
        if (args.harness === "claude-code") {
          if (!ctx.roomId) {
            return "Cannot create Claude Code task: a current Room is required.";
          }
          if (ctx.currentTaskId || args.parent_task_id !== undefined) {
            return "Cannot create Claude Code task: it must be a root task.";
          }
          if (
            args.expected_output !== undefined
            || args.schedule_kind !== undefined
            || args.run_at !== undefined
            || args.cron !== undefined
            || args.timezone !== undefined
            || args.target_chat !== undefined
            || args.target_users !== undefined
            || args.use_scope !== undefined
            || args.scope_id !== undefined
            || args.tools !== undefined
            || args.result_delivery !== undefined
            || args.time_limit_seconds !== undefined
            || args.model_selection_profile !== undefined
            || args.model_selection_spec !== undefined
            || args.model_id !== undefined
          ) {
            return "Cannot create Claude Code task: scheduling, routing, scope, tools, delivery, and native model settings are server-owned.";
          }
          if (rt.claudeCodeTasksEnabled !== true || !rt.createHarnessTask) {
            return claudeCodeHarnessUnavailable();
          }
          const created = await rt.createHarnessTask({
            ownerId: ctx.ownerId,
            requestorId: ctx.causalHumanUserId,
            agentId: ctx.agentId,
            prompt: args.prompt,
            callingRoomId: ctx.roomId,
            harness: "claude-code",
            ...(args.harness_model_id === undefined ? {} : { harnessModelId: args.harness_model_id }),
          } satisfies TaskToolClaudeCodeHarnessCreateInput);
          if (created.execution !== "claude-code") return claudeCodeHarnessUnavailable();
          return JSON.stringify({
            taskId: created.taskId,
            status: created.status,
            execution: created.execution,
            model: created.model,
            message:
              "The task was accepted for Claude Code; it will report back to this chat when done.",
          });
        }
        if (args.harness === "codex" || args.harness === "hermes-acp") {
          // A harness run is an immediate, current-Room Task. Do not accept
          // generic task controls that would imply a second execution or tool
          // authority contract. The server seals those fields after admission.
          if (
            (args.schedule_kind !== undefined && args.schedule_kind !== "now")
            || args.run_at !== undefined
            || args.cron !== undefined
            || args.timezone !== undefined
          ) {
            return "Cannot create harness task: external harness tasks run immediately in the current Room; scheduled execution is not supported.";
          }
          if (
            args.harness === "hermes-acp"
            && (
              args.schedule_kind !== undefined
              || args.expected_output !== undefined
              || (args.parent_task_id !== undefined && !ctx.currentTaskId)
              || args.time_limit_seconds !== undefined
            )
          ) {
            return "Cannot create harness task: scheduling, output, parent, and time-limit settings are server-owned for a Hermes ACP task.";
          }
          if (
            args.target_chat !== undefined
            || args.target_users !== undefined
            || args.use_scope !== undefined
            || args.scope_id !== undefined
            || args.tools !== undefined
            || args.result_delivery !== undefined
            || args.model_selection_profile !== undefined
            || args.model_selection_spec !== undefined
            || args.model_id !== undefined
          ) {
            return "Cannot create harness task: routing, scope, tool, delivery, and model settings are server-owned for an external harness task.";
          }
        }
        const reject = rejectNotYetWiredTaskParams(args as Record<string, unknown>);
        if (reject) return reject;

        const toolsFields = toolsFieldsFromArgs(args.tools);

        // D429 Phase 3 / M152 — create-time model-selection guard (A8): the
        // combined validator owns BOTH the exact `model_id` pin (curated IDs,
        // capability truth, mutual-exclusion conflict) and the M152
        // profile/spec bias. Reject an unsatisfiable selection with the
        // actionable message; do NOT insert.
        const selectionError = validateTaskModelSelectionForCreate({
          requestedModelId: args.model_id,
          profile: args.model_selection_profile,
          spec: args.model_selection_spec,
          toolsMode: toolsFields.toolsMode,
          toolsWhitelist: toolsFields.toolsWhitelist,
        });
        if (selectionError) return selectionError;

        const scheduleKind = args.schedule_kind ?? "now";
        const runAt = parseRunAt(args.run_at);

        // M165 — derive the namespace target-users set from @handles (requester
        // auto-included). Drives `buildEnvelopeForTargetUsers` at the dispatch
        // seam; orthogonal to `target_chat` (where the result lands).
        const targets = await resolveTargetUserIds(
          rt.db,
          ctx.causalHumanUserId,
          args.target_users,
        );
        if (!targets.ok) return targets.message;

        const lineage = await resolveTaskToolCreateLineage({
          ownerId: ctx.ownerId,
          db: rt.db,
          ...(ctx.currentTaskId ? { currentTaskId: ctx.currentTaskId } : {}),
          ...(args.parent_task_id !== undefined
            ? { requestedParentTaskId: args.parent_task_id }
            : {}),
        });
        if (!lineage.ok) return lineage.message;

        const input: TaskToolCreateInput = {
          ownerId: ctx.ownerId,
          requestorId: ctx.causalHumanUserId,
          agentId: ctx.agentId,
          prompt: args.prompt,
          ...(args.expected_output !== undefined
            ? { expectedOutput: args.expected_output }
            : {}),
          scheduleKind,
          ...(runAt !== undefined ? { runAt } : {}),
          ...(args.cron !== undefined ? { cron: args.cron } : {}),
          ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
          targetChat: args.target_chat ?? "orphan",
          callingRoomId: ctx.roomId || null,
          resultDelivery: args.result_delivery ?? "wake",
          useScope: args.use_scope ?? false,
          ...(args.scope_id !== undefined ? { scopeId: args.scope_id } : {}),
          ...(lineage.parentTaskId !== undefined
            ? { parentTaskId: lineage.parentTaskId }
            : {}),
          awaitResponse: false,
          targetUserIds: targets.userIds,
          depth: lineage.depth,
          preset: "task",
          ...(args.time_limit_seconds !== undefined
            ? { timeLimitSeconds: args.time_limit_seconds }
            : {}),
          ...(args.model_selection_profile !== undefined
            ? { selectionProfile: args.model_selection_profile }
            : {}),
          ...(args.model_selection_spec !== undefined
            ? { selectionSpec: args.model_selection_spec }
            : {}),
          ...(args.model_id !== undefined ? { requestedModelId: args.model_id } : {}),
          ...toolsFields,
        };
        if (args.harness === "codex" || args.harness === "hermes-acp") {
          if (!rt.createHarnessTask) {
            return genieRecoveryResult("task", "Codex harness execution is unavailable on this server. Open Codex setup, connect Desktop, then try again.", { requirement: "desktop" });
          }
          if (args.harness === "hermes-acp") {
            const hermesInput: TaskToolHermesAcpHarnessCreateInput = {
              ownerId: input.ownerId,
              requestorId: input.requestorId,
              agentId: input.agentId,
              prompt: input.prompt,
              callingRoomId: input.callingRoomId ?? null,
              ...(lineage.parentTaskId !== undefined
                ? { parentTaskId: lineage.parentTaskId, depth: lineage.depth }
                : {}),
              harness: "hermes-acp",
            };
            const created = await rt.createHarnessTask(hermesInput);
            return JSON.stringify({
              taskId: created.taskId,
              status: created.status,
              execution: created.execution,
              message:
                "The task was accepted for the selected external harness; it will report back to this chat when done.",
            });
          }
          const {
            requestedModelId: _requestedModelId,
            selectionProfile: _selectionProfile,
            selectionSpec: _selectionSpec,
            ...sealedInput
          } = input;
          const created = await rt.createHarnessTask({
            ...sealedInput,
            harness: "codex",
            collaborationMode: args.collaboration_mode ?? "work",
            ...(args.harness_model_id !== undefined
              ? { harnessModelId: args.harness_model_id }
              : {}),
            ...(args.working_directory !== undefined
              ? { workingDirectory: args.working_directory }
              : {}),
          } satisfies TaskToolHarnessCreateInput);
          return JSON.stringify({
            taskId: created.taskId,
            status: created.status,
            execution: created.execution,
            message:
              "The task was accepted for the selected external harness; it will report back to this chat when done.",
          });
        }

        const { taskId, status } = await rt.createTask(input);
        return JSON.stringify({
          taskId,
          status,
          message:
            "The task is running in the background; it will report back to this chat when done.",
        });
      }
      case "steer": {
        if (!args.taskId || !args.prompt) {
          return "Cannot steer task: 'taskId' and 'prompt' are required.";
        }
        if (!ctx.ownerId || !ctx.agentId || !ctx.roomId) {
          return "Cannot steer task: missing owner, agent, or Room context.";
        }
        const rt = getTaskToolRuntime();
        const task = await getTaskById(rt.db, args.taskId);
        if (
          !task
          || task.ownerId !== ctx.ownerId
          || task.agentId !== ctx.agentId
          || task.callingRoomId !== ctx.roomId
        ) {
          return "Task not found.";
        }
        if (!rt.steerHarnessTask) {
          return "Cannot steer task: external harness steering is unavailable on this server.";
        }
        const result = await rt.steerHarnessTask({
          taskId: task.id,
          ownerId: ctx.ownerId,
          agentId: ctx.agentId,
          roomId: ctx.roomId,
          text: args.prompt,
        });
        return JSON.stringify({
          taskId: task.id,
          status: result.status,
          message: "The instruction was sent to the active harness turn.",
        });
      }
      case "read": {
        if (!args.taskId) {
          return "Cannot read task: 'taskId' is required for command 'read'.";
        }
        const rt = getTaskToolRuntime();
        const task = await getTaskById(rt.db, args.taskId);
        if (!task || task.ownerId !== ctx.ownerId) {
          return "Task not found.";
        }
        const readContext = { ownerId: ctx.ownerId, agentId: task.agentId,
          maxResponseBytes: ctx.taskReadMaxResponseBytes, messages: ctx.taskReadMessages, pendingPages: ctx.taskReadPendingPages };
        if (!Number.isSafeInteger(ctx.taskReadMaxResponseBytes) || !ctx.taskReadMaxResponseBytes || ctx.taskReadMaxResponseBytes < 1) {
          return readTaskSection(args, readContext, { task: { id: task.id, status: task.status }, runs: [] }, []);
        }
        const canResumeResearch = task.status === "errored" && task.lastError === "no_progress"
          && await rt.canResumeResearch?.(task) === true;
        const runs = await getTaskRuns(rt.db, args.taskId);
        const runsOut = await Promise.all(
          runs.map(async (run) => ({
            id: run.id,
            status: run.status,
            modelId: run.modelId,
            resultText: run.resultText,
            lastError: run.lastError,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            // Only the legacy default needs full materialization to measure
            // its complete response. Explicit sections load their one source
            // in readTaskSection; metadata/result never query transcripts.
            transcript: (
              args.readSection || args.readCursor || args.continueRead || args.readSearch || args.runId ? [] : await getRunAgentTranscript({
                ownerId: ctx.ownerId,
                graphThreadId: run.graphThreadId,
                agentId: task.agentId,
                startedAt: run.startedAt ?? null,
                completedAt: run.completedAt ?? null,
              })
            ).map((m) => ({
              role: m.role,
              content: m.content,
              toolName: m.toolName,
              toolCalls: m.toolCalls,
              createdAt:
                m.createdAt instanceof Date
                  ? m.createdAt.toISOString()
                  : String(m.createdAt),
            })),
          })),
        );
        // This is intentionally optional and server-composed. A generic Task
        // read gains live harness facts only for the same owner + Agent +
        // calling Room; every other owned Task retains its established shape.
        const harness = !args.continueRead && !args.readCursor && (!args.readSection || args.readSection === "metadata") && rt.inspectHarnessTask && task.agentId === ctx.agentId && task.callingRoomId === ctx.roomId
          ? await rt.inspectHarnessTask({
              taskId: task.id,
              ownerId: ctx.ownerId,
              agentId: ctx.agentId,
              roomId: ctx.roomId,
            })
          : null;
        return readTaskSection(args, readContext, {
          task: {
            id: task.id,
            status: task.status,
            lastError: task.lastError,
            ...(canResumeResearch ? { canResumeResearch: true } : {}),
            preparation: readTaskPreparation(task.metadata?.["preparation"]),
            prompt: task.prompt,
            scheduleKind: task.scheduleKind,
            targetChat: task.targetChat,
            callingRoomId: task.callingRoomId,
            resultDelivery: task.resultDelivery,
            selectionProfile: task.selectionProfile,
            selectionSpec: task.selectionSpec,
            // D429 Phase 3 — the requested exact pin (distinct from the
            // per-run actual model in `runs[].modelId`).
            requestedModelId: task.requestedModelId,
            harnessId: taskExternalHarnessId(task.metadata),
          },
          runs: runsOut,
          ...(harness ? { harness } : {}),
        }, runs);
      }
      case "list": {
        const rt = getTaskToolRuntime();
        // When a status is given, push it to the store (which filters by exact
        // status and takes precedence over includeTerminal). The previous shape
        // passed `{}` then JS-filtered, but `{}` makes the store EXCLUDE
        // terminal rows — so `status:"completed"` always returned [].
        const opts = args.status
          ? { status: args.status as NonNullable<NewTask["status"]> }
          : { includeTerminal: args.includeTerminal ?? false };
        const tasks = await listTasksForOwner(rt.db, ctx.ownerId, opts);
        const lastModels = await getLatestRunModelByTask(
          rt.db,
          tasks.map((t) => t.id),
        );
        return JSON.stringify(
          await Promise.all(tasks.map(async (task) => ({
            id: task.id,
            ...(task.status === "errored" && task.lastError === "no_progress" && await rt.canResumeResearch?.(task) === true
              ? { canResumeResearch: true } : {}),
            status: task.status,
            prompt: task.prompt.slice(0, 80),
            scheduleKind: task.scheduleKind,
            callingRoomId: task.callingRoomId,
            selectionProfile: task.selectionProfile,
            // D429 Phase 3 — requested exact pin (null when none). The actual
            // run model is surfaced separately as `lastModelId` below.
            requestedModelId: task.requestedModelId,
            lastModelId: lastModels.get(task.id) ?? null,
            harnessId: taskExternalHarnessId(task.metadata),
          }))),
        );
      }
      case "update": {
        if (!args.taskId) {
          return "Cannot update task: 'taskId' is required for command 'update'.";
        }
        const reject = rejectNotYetWiredTaskParams(args as Record<string, unknown>);
        if (reject) return reject;

        const rt = getTaskToolRuntime();
        const task = await getTaskById(rt.db, args.taskId);
        if (!task || task.ownerId !== ctx.ownerId) {
          return "Task not found.";
        }
        if (task.status !== "pending" && task.status !== "paused") {
          return `Cannot update task: only pending or paused tasks can be updated (this one is '${task.status}').`;
        }

        // D429 Phase 3 / M152 — validate a changed selection before patching
        // the row. The combined validator owns the exact `model_id` pin, the
        // M152 profile/spec bias, and their mutual-exclusion conflict. We
        // validate the EFFECTIVE selection (patch overlaid on the existing
        // row) so setting model_id on a row that still carries a non-default
        // profile/spec is caught as a conflict — the caller must clear the
        // profile/spec (e.g. `model_selection_profile: "balanced"`) to pin.
        if (
          args.tools !== undefined ||
          args.model_id !== undefined ||
          args.model_selection_profile !== undefined ||
          args.model_selection_spec !== undefined
        ) {
          const toolsFields = toolsFieldsFromArgs(args.tools);
          const effectiveToolsMode =
            args.tools !== undefined ? toolsFields.toolsMode : task.toolsMode;
          const effectiveToolsWhitelist =
            args.tools !== undefined
              ? (toolsFields.toolsWhitelist ?? [])
              : task.toolsWhitelist;
          const selectionError = validateTaskModelSelectionForCreate({
            requestedModelId:
              args.model_id !== undefined ? args.model_id : task.requestedModelId,
            profile:
              args.model_selection_profile !== undefined
                ? args.model_selection_profile
                : task.selectionProfile,
            spec:
              args.model_selection_spec !== undefined
                ? args.model_selection_spec
                : task.selectionSpec,
            toolsMode: effectiveToolsMode,
            toolsWhitelist: effectiveToolsWhitelist,
          });
          if (selectionError) return selectionError;
        }

        const patch: Partial<NewTask> = {};
        if (args.prompt !== undefined) patch.prompt = args.prompt;
        if (args.expected_output !== undefined) {
          patch.expectedOutput = args.expected_output;
        }
        if (args.schedule_kind !== undefined) patch.scheduleKind = args.schedule_kind;
        const parsedRunAt = parseRunAt(args.run_at);
        if (parsedRunAt !== undefined) patch.runAt = parsedRunAt;
        if (args.cron !== undefined) patch.cron = args.cron;
        if (args.timezone !== undefined) patch.timezone = args.timezone;
        if (args.target_chat !== undefined) patch.targetChat = args.target_chat;
        if (args.result_delivery !== undefined) {
          patch.resultDelivery = args.result_delivery;
        }
        if (args.tools !== undefined) {
          const tf = toolsFieldsFromArgs(args.tools);
          patch.toolsMode = tf.toolsMode;
          patch.toolsWhitelist = tf.toolsWhitelist ?? [];
        }
        if (args.time_limit_seconds !== undefined) {
          patch.timeLimitSeconds = args.time_limit_seconds;
        }
        if (args.model_selection_profile !== undefined) {
          patch.selectionProfile = args.model_selection_profile;
        }
        if (args.model_selection_spec !== undefined) {
          patch.selectionSpec = args.model_selection_spec;
        }
        // D429 Phase 3 — explicit clearing semantics: `model_id: null` clears
        // the pin; a string sets it; omission preserves the existing value
        // (omission is NOT treated as clear).
        if (args.model_id !== undefined) {
          patch.requestedModelId = args.model_id;
        }

        const scheduleChanged = SCHEDULE_FIELDS.some(
          (f) => (args as Record<string, unknown>)[f] !== undefined,
        );
        if (scheduleChanged) {
          const effectiveKind = args.schedule_kind ?? task.scheduleKind;
          const effectiveRunAt = parsedRunAt ?? task.runAt ?? undefined;
          const effectiveCron = args.cron ?? task.cron;
          const effectiveTz = args.timezone ?? task.timezone;
          patch.nextFireAt = rt.computeNextFireAt(
            effectiveKind,
            effectiveRunAt,
            effectiveCron,
            effectiveTz,
          );
        }

        const updated = await updateTask(rt.db, args.taskId, patch);
        if (!updated) return "Task not found.";
        return JSON.stringify({
          task: {
            id: updated.id,
            status: updated.status,
            prompt: updated.prompt,
            scheduleKind: updated.scheduleKind,
            targetChat: updated.targetChat,
            nextFireAt: updated.nextFireAt,
            resultDelivery: updated.resultDelivery,
          },
        });
      }
      case "pause":
      case "unpause":
      case "stop": {
        if (!args.taskId) {
          return `Cannot ${args.command} task: 'taskId' is required for command '${args.command}'.`;
        }
        const rt = getTaskToolRuntime();
        // Owner check (M146 pattern): don't leak existence of another owner's task.
        const task = await getTaskById(rt.db, args.taskId);
        if (!task || task.ownerId !== ctx.ownerId) {
          return "Task not found.";
        }
        const result =
          args.command === "pause"
            ? await rt.pauseTask(args.taskId)
            : args.command === "unpause"
              ? await rt.unpauseTask(args.taskId)
              : await rt.stopTask(args.taskId);
        return JSON.stringify({
          taskId: args.taskId,
          status: result.status,
          message: result.message,
        });
      }
      default: {
        return `Error: unknown task command '${String(args.command)}'`;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (args.command === "create" && args.harness === "hermes-acp") {
      return hermesAcpHarnessFailureGuidance(err)
        ?? hermesAcpHarnessUnavailableGuidance;
    }
    if (args.command === "create" && args.harness === "claude-code") {
      return claudeCodeHarnessUnavailable();
    }
    const codexGuidance = codexHarnessFailureGuidance(err);
    if (codexGuidance) return codexGuidance;
    return `Error in task:${args.command}: ${msg}`;
  }
}
