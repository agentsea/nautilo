import { ToolMessage } from "@langchain/core/messages";
import { appendTranscriptMessages } from "@nautilo/agent";
import type { CodexUserInputQuestion } from "@nautilo/db";
import type { CodexRequest, ServerEvent, TaskHarnessActivity } from "@nautilo/types";
import {
  type HarnessExecutionOutput,
  type TaskExecutionRouteFacts,
} from "@nautilo/runtime";

/**
 * Codex requests and activity project onto existing Nautilo event/transcript
 * surfaces. The authoritative assistant result deliberately bypasses this
 * projector and terminalizes through canonical Task report-back.
 */
export interface CodexRoomOutputContext {
  readonly jobId: string;
  readonly laneKey: string;
  readonly facts: TaskExecutionRouteFacts;
}

/**
 * Server-process-only, non-canonical live activity. It is deliberately
 * derived from the same semantic `task.progress` projection the Human sees:
 * a restart loses it rather than pretending this is a durable execution log.
 */
export interface CodexTaskActivitySnapshot {
  readonly taskRunId: string;
  readonly jobId: string;
  readonly lastActivityAt: string;
  readonly activity: readonly TaskHarnessActivity[];
}

type SnapshotEntry = CodexTaskActivitySnapshot & {
  readonly ownerId: string;
  readonly agentId: string;
  readonly roomId: string;
};

const LIVE_ACTIVITY_CAP = 20;
const LIVE_ACTIVITY_MAX_BYTES = 64 * 1024;
const LIVE_TASK_SNAPSHOT_CAP = 100;

type UserInputOutput = Extract<HarnessExecutionOutput, { readonly kind: "user_input_required" }>;

/**
 * The Room projection owns the exact mapping from an admitted harness request
 * to durable, answer-free facts.  The database adapter owns its binding CAS;
 * the projector never receives a database handle or browser identity.
 */
export type CodexUserInputRequestFacts = {
  readonly requestRef: string;
  readonly userId: string;
  readonly sourceAgentId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly roomId: string;
  readonly taskId: string;
  readonly taskRunId: string;
  readonly jobId: string;
  readonly codexThreadId: string;
  readonly codexTurnId: string;
  readonly codexItemId: string;
  readonly questions: readonly CodexUserInputQuestion[];
  readonly autoResolutionMs: number | null;
  readonly expiresAt: Date;
};

export type CodexUserInputRequestPersistenceResult =
  | {
      readonly status: "created" | "existing";
      /** Duplicate relay delivery is actionable only while the original row is. */
      readonly state: "awaiting_human" | "dispatching" | "submitted" | "expired" | "cancelled" | "unavailable" | "terminal";
    }
  | { readonly status: "stale_binding" | "conflict" | "expired" };

export interface CodexRoomOutputProjectorDeps {
  readonly append?: typeof appendTranscriptMessages;
  /** Claude's live-only requests intentionally bypass Codex durable input facts. */
  readonly requestMode?: "durable" | "ephemeral";
  /** Persists only semantic questions and exact binding attribution. */
  readonly persistUserInputRequest?: (
    facts: CodexUserInputRequestFacts,
  ) => Promise<CodexUserInputRequestPersistenceResult>;
}

/**
 * Request/activity output seam for the Codex execution route.
 */
export class CodexRoomOutputProjector {
  private readonly append: typeof appendTranscriptMessages;
  private readonly persistUserInputRequest: CodexRoomOutputProjectorDeps["persistUserInputRequest"];
  private readonly requestMode: "durable" | "ephemeral";
  private readonly liveActivityByTask = new Map<string, SnapshotEntry>();

  constructor(deps: CodexRoomOutputProjectorDeps = {}) {
    this.append = deps.append ?? appendTranscriptMessages;
    this.persistUserInputRequest = deps.persistUserInputRequest;
    this.requestMode = deps.requestMode ?? "durable";
  }

  async project(
    output: HarnessExecutionOutput,
    context: CodexRoomOutputContext,
  ): Promise<ServerEvent | null> {
    if (isHarnessRequest(output)) {
      return this.projectRequest(output, context);
    }
    const progress = projectHarnessProgress(output, context);
    if (progress) {
      this.captureLiveActivity(progress, context);
      await this.persistCompletedActivity(progress, context);
      return progress;
    }
    // Assistant completion and terminal markers remain lifecycle facts. The
    // executor retains the one authoritative result and hands it to canonical
    // Task report-back only after the exact Task/Run/Job assertion.
    return null;
  }

  /**
   * An optional server-composed inspection seam for generic Task `read`.
   * Exact owner/Agent/Room matching prevents a same-owner task in another
   * conversation from learning this process-local harness activity.
   */
  inspectLiveActivity(input: {
    readonly taskId: string;
    readonly ownerId: string;
    readonly agentId: string;
    readonly roomId: string;
  }): CodexTaskActivitySnapshot | null {
    const entry = this.liveActivityByTask.get(input.taskId);
    if (
      !entry ||
      entry.ownerId !== input.ownerId ||
      entry.agentId !== input.agentId ||
      entry.roomId !== input.roomId
    ) return null;
    return {
      taskRunId: entry.taskRunId,
      jobId: entry.jobId,
      lastActivityAt: entry.lastActivityAt,
      // Task read is Genie context, not the Human's live activity feed. Keep
      // only operational facts here: command/file output can contain secrets
      // even when the desktop bounds it for the owner-private UI.
      activity: entry.activity.map(safeInspectionActivity),
    };
  }

  private captureLiveActivity(
    event: Extract<ServerEvent, { readonly type: "task.progress" }>,
    context: CodexRoomOutputContext,
  ): void {
    if (!event.activity) return;
    const prior = this.liveActivityByTask.get(context.facts.taskId);
    // A retry or replacement must never merge another TaskRun's activity
    // under the new run/job attribution.
    const sameRun = prior?.taskRunId === context.facts.taskRunId && prior.jobId === context.jobId;
    const merged = mergeLiveActivity(sameRun ? prior.activity : [], event.activity);
    // Map insertion order is the LRU-ish recency order. A progress update is
    // the only access that refreshes it; inspection is read-only and cannot
    // keep a forgotten Task alive forever.
    this.liveActivityByTask.delete(context.facts.taskId);
    this.liveActivityByTask.set(context.facts.taskId, {
      taskRunId: context.facts.taskRunId,
      jobId: context.jobId,
      ownerId: context.facts.ownerId,
      agentId: context.facts.agentId,
      roomId: context.facts.roomId,
      lastActivityAt: new Date().toISOString(),
      activity: merged,
    });
    while (this.liveActivityByTask.size > LIVE_TASK_SNAPSHOT_CAP) {
      const oldestTaskId = this.liveActivityByTask.keys().next().value;
      if (typeof oldestTaskId !== "string") break;
      this.liveActivityByTask.delete(oldestTaskId);
    }
  }

  private async projectRequest(
    output: Extract<HarnessExecutionOutput, { readonly requestId: string }>,
    context: CodexRoomOutputContext,
  ): Promise<ServerEvent | null> {
    if (output.kind === "user_input_required" && this.requestMode === "durable") {
      // A durable fact commits before the interactive event can be emitted.
      // If this process cannot prove the exact active binding/expiry tuple, it
      // fails closed rather than presenting a prompt that cannot be answered.
      if (!this.persistUserInputRequest) return null;
      const input = userInputFacts(output, context);
      if (!input) return null;
      const persisted = await this.persistUserInputRequest(input);
      if (
        (persisted.status !== "created" && persisted.status !== "existing") ||
        persisted.state !== "awaiting_human"
      ) return null;
    }
    return projectCodexRequest(output, context, this.requestMode);
  }

  private async persistCompletedActivity(
    event: Extract<ServerEvent, { readonly type: "task.progress" }>,
    context: CodexRoomOutputContext,
  ): Promise<void> {
    const activity = event.activity;
    if (
      !activity ||
      (activity.status !== "completed" && activity.status !== "failed")
    ) {
      return;
    }
    await this.append(
      context.facts.graphThreadId,
      context.facts.ownerId,
      "owner",
      [new ToolMessage({
        // Completed activity is useful as a durable lifecycle fact, but never
        // persist provider-derived args/results/output into the agent graph.
        content: `Harness ${activity.name} ${activity.status}.`,
        tool_call_id: `harness:${context.facts.taskRunId}:${activity.id}`,
        name: activity.name,
      })],
      {
        agentId: context.facts.agentId,
        roomId: context.facts.roomId,
        transcriptOrigin: "subagent",
      },
    );
  }
}

function safeInspectionActivity(activity: TaskHarnessActivity): TaskHarnessActivity {
  return {
    id: activity.id,
    kind: activity.kind,
    name: activity.name,
    status: activity.status,
    args: {},
    startedAt: activity.startedAt,
    ...(activity.endedAt === undefined ? {} : { endedAt: activity.endedAt }),
  };
}

function mergeLiveActivity(
  prior: readonly TaskHarnessActivity[],
  incoming: TaskHarnessActivity,
): readonly TaskHarnessActivity[] {
  const index = prior.findIndex((activity) => activity.id === incoming.id);
  const current = index < 0 ? undefined : prior[index];
  const result = incoming.appendResult && incoming.result
    ? `${current?.result ?? ""}${current?.result ? (incoming.appendResultSeparator ?? "\n") : ""}${incoming.result}`
    : incoming.result;
  const merged: TaskHarnessActivity = {
    ...current,
    ...incoming,
    args: Object.keys(incoming.args).length === 0 ? (current?.args ?? {}) : incoming.args,
    startedAt: current?.startedAt ?? incoming.startedAt,
    ...(result !== undefined ? { result } : {}),
  };
  const next = index < 0
    ? [...prior, merged]
    : [...prior.slice(0, index), merged, ...prior.slice(index + 1)];
  // A live snapshot represents at most one current operation. If the
  // provider advances to another item without a terminal frame for the old
  // one, omit the superseded in-flight item rather than invent completion.
  const newestCurrent = [...next].reverse().find(isInFlight);
  const bounded = next.filter((activity) => !isInFlight(activity) || activity.id === newestCurrent?.id)
    .slice(-LIVE_ACTIVITY_CAP)
    .map(cloneActivity);
  return trimActivityBytes(bounded);
}

function isInFlight(activity: TaskHarnessActivity): boolean {
  return activity.status === "running" || activity.status === "waiting";
}

function cloneActivity(activity: TaskHarnessActivity): TaskHarnessActivity {
  return { ...activity, args: { ...activity.args } };
}

function trimActivityBytes(activity: readonly TaskHarnessActivity[]): readonly TaskHarnessActivity[] {
  const next = [...activity];
  while (next.length > 1 && activityBytes(next) > LIVE_ACTIVITY_MAX_BYTES) {
    const removable = next.findIndex((item) => !isInFlight(item));
    next.splice(removable < 0 ? 0 : removable, 1);
  }
  if (next.length === 1 && activityBytes(next) > LIVE_ACTIVITY_MAX_BYTES) {
    const [only] = next;
    if (only) next[0] = fitSingleActivity(only);
  }
  return next;
}

function fitSingleActivity(activity: TaskHarnessActivity): TaskHarnessActivity {
  const withSmallOutput: TaskHarnessActivity = {
    ...activity,
    args: {},
    ...(activity.result ? { result: boundedUtf8(activity.result, 16 * 1024) } : {}),
  };
  if (activityBytes([withSmallOutput]) <= LIVE_ACTIVITY_MAX_BYTES) return withSmallOutput;
  // The semantic contracts ordinarily bound id/name before this boundary, but
  // this final form makes the aggregate cap true even for malformed or future
  // producer data with a pathological args/result/id payload.
  return {
    id: boundedUtf8(activity.id, 1024),
    kind: activity.kind,
    name: boundedUtf8(activity.name, 1024),
    status: activity.status,
    args: {},
    startedAt: activity.startedAt,
    ...(activity.endedAt !== undefined ? { endedAt: activity.endedAt } : {}),
  };
}

function activityBytes(activity: readonly TaskHarnessActivity[]): number {
  return new TextEncoder().encode(JSON.stringify(activity)).byteLength;
}

function boundedUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = "...";
  const limit = maxBytes - encoder.encode(suffix).byteLength;
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes + size > limit) break;
    bytes += size;
    end += codePoint.length;
  }
  return `${value.slice(0, end)}${suffix}`;
}

/**
 * Convert the provider-neutral harness activity contract into the ordinary
 * owner-private Task progress lane. Raw app-server notifications never cross
 * this boundary; the Workbench receives only bounded semantic activity and
 * ephemeral response previews.
 */
function projectHarnessProgress(
  output: HarnessExecutionOutput,
  context: CodexRoomOutputContext,
): Extract<ServerEvent, { readonly type: "task.progress" }> | null {
  if (
    output.attribution.taskId !== context.facts.taskId ||
    output.attribution.roomId !== context.facts.roomId
  ) {
    return null;
  }
  let detail: string | null = null;
  let activity: TaskHarnessActivity | undefined;
  switch (output.kind) {
    case "progress":
      detail = output.message;
      activity = {
        id: output.attribution.vendorItemId ??
          `${output.attribution.vendorTurnId ?? "turn"}:status`,
        kind: "status",
        name: "harness_status",
        status: output.message.toLowerCase().includes("waiting") ? "waiting" : "running",
        args: { detail: output.message },
        startedAt: Date.now(),
      };
      break;
    case "output_delta":
      if (output.text.length === 0) return null;
      detail = "Writing response";
      activity = {
        id: output.attribution.vendorItemId ?? responseActivityId(output.attribution),
        kind: "status",
        name: "assistant_response",
        status: "running",
        args: {},
        result: output.text,
        appendResult: true,
        appendResultSeparator: "",
        startedAt: Date.now(),
      };
      break;
    case "command_summary":
      detail = output.commands.at(-1)?.summary ?? null;
      if (detail) activity = commandActivity(output.attribution.vendorItemId, detail);
      break;
    case "patch_summary":
      detail = output.summary;
      activity = fileActivity(output.attribution.vendorItemId, detail);
      break;
    default:
      return null;
  }
  if (!detail?.trim()) return null;
  return {
    type: "task.progress",
    taskId: context.facts.taskId,
    taskRunId: context.facts.taskRunId,
    detail,
    ...(activity ? { activity } : {}),
    ownerId: context.facts.ownerId,
  };
}

function responseActivityId(attribution: HarnessExecutionOutput["attribution"]): string {
  return `${attribution.vendorSessionId ?? "session"}:${attribution.vendorTurnId ?? "turn"}:response`;
}

function commandActivity(
  itemId: string | null,
  detail: string,
): TaskHarnessActivity {
  const lines = detail.split("\n");
  const heading = lines[0]?.trim() ?? "";
  const isTool = heading.startsWith("Tool ");
  const status = activityStatus(heading);
  const name = isTool
    ? (lines[1]?.trim() || "external_tool")
    : "run_command";
  return {
    id: itemId ?? `${isTool ? "tool" : "command"}:${name}`,
    kind: isTool ? "tool" : "command",
    name,
    status,
    args: isTool || heading === "Command output" || heading.startsWith("Terminal input")
      ? {}
      : {
          ...(lines[1]?.trim() ? { command: lines[1].trim() } : {}),
          ...(lines[2]?.trim() ? { cwd: lines[2].replace(/^cwd:\s*/, "").trim() } : {}),
        },
    result: detail,
    appendResult: heading === "Command output",
    startedAt: Date.now(),
    ...(status === "completed" || status === "failed" ? { endedAt: Date.now() } : {}),
  };
}

function fileActivity(
  itemId: string | null,
  detail: string,
): TaskHarnessActivity {
  const heading = detail.split("\n", 1)[0]?.trim() ?? "";
  const status = activityStatus(heading);
  return {
    id: itemId ?? "file_change",
    kind: "file_change",
    name: "apply_patch",
    status,
    args: {},
    result: detail,
    appendResult: heading === "File change output",
    startedAt: Date.now(),
    ...(status === "completed" || status === "failed" ? { endedAt: Date.now() } : {}),
  };
}

function activityStatus(heading: string): TaskHarnessActivity["status"] {
  const normalized = heading.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("error")) return "failed";
  if (
    normalized.includes("completed") ||
    normalized.includes("success") ||
    normalized.includes("finished")
  ) return "completed";
  if (normalized.includes("waiting")) return "waiting";
  return "running";
}

function isHarnessRequest(
  output: HarnessExecutionOutput,
): output is Extract<HarnessExecutionOutput, { readonly requestId: string }> {
  return "requestId" in output;
}

/**
 * Keep the native-request event deliberately semantic. This is a second
 * projection boundary after the driver: never spread a HarnessRequest here,
 * because that would make future server-private attributes browser-visible.
 */
function projectCodexRequest(
  output: Extract<HarnessExecutionOutput, { readonly requestId: string }>,
  context: CodexRoomOutputContext,
  requestMode: "durable" | "ephemeral",
): ServerEvent | null {
  const { facts } = context;
  if (
    output.ownerId !== facts.ownerId ||
    output.attribution.taskId !== facts.taskId ||
    output.attribution.roomId !== facts.roomId
  ) {
    return null;
  }
  const request = semanticRequest(output, requestMode);
  if (!request) return null;
  return {
    type: "codex.request",
    ownerId: facts.ownerId,
    requestId: output.requestId,
    taskId: facts.taskId,
    jobId: context.jobId,
    roomId: facts.roomId,
    expiresAt: output.expiresAt,
    request,
  };
}

function semanticRequest(
  output: Extract<HarnessExecutionOutput, { readonly requestId: string }>,
  requestMode: "durable" | "ephemeral",
): CodexRequest | null {
  if (output.kind === "command_approval_required") {
    return {
      kind: output.kind,
      options: [...output.options],
      reason: output.reason,
      command: { detail: output.command.detail, actionKinds: [...output.command.actionKinds] },
    };
  }
  if (output.kind === "network_approval_required") {
    return {
      kind: output.kind,
      options: [...output.options],
      reason: output.reason,
      network: { host: output.network.host, protocol: output.network.protocol },
    };
  }
  if (output.kind === "file_change_approval_required") {
    return {
      kind: output.kind,
      options: [...output.options],
      reason: output.reason,
      grantRoot: output.grantRoot,
    };
  }
  if (output.kind === "permissions_approval_required") {
    return {
      kind: output.kind,
      reason: output.reason,
      permissions: {
        network: output.permissions.network === null
          ? null
          : { enabled: output.permissions.network.enabled },
        fileSystem: output.permissions.fileSystem === null
          ? null
          : {
              readPathCount: output.permissions.fileSystem.readPathCount,
              writePathCount: output.permissions.fileSystem.writePathCount,
              entryCount: output.permissions.fileSystem.entryCount,
              pathDetail: output.permissions.fileSystem.pathDetail,
            },
      },
    };
  }
  if (output.kind === "user_input_required") {
    return {
      kind: output.kind,
      questions: output.questions.map((question) => ({
        id: question.id,
        header: question.header,
        prompt: question.prompt,
        secret: question.secret,
        ...(requestMode === "ephemeral" ? { multiSelect: question.multiSelect } : {}),
        allowOther: question.allowOther,
        options: question.options?.map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description,
        })) ?? null,
      })),
      autoResolutionMs: output.autoResolutionMs,
    };
  }
  if (output.kind === "permission_selection_required") {
    if (requestMode !== "ephemeral") return null;
    return {
      kind: output.kind,
      options: output.options.map((option) => ({
        id: option.id,
        label: option.label,
        semanticHint: option.semanticHint,
      })),
      tool: { title: output.tool.title, kind: output.tool.kind },
      ...(output.detail === undefined ? {} : { detail: output.detail }),
    };
  }
  return null;
}

function userInputFacts(
  output: UserInputOutput,
  context: CodexRoomOutputContext,
): CodexUserInputRequestFacts | null {
  const { facts } = context;
  const attribution = output.attribution;
  const bindingGeneration = parseGeneration(attribution.bindingGeneration);
  const expiresAt = output.expiresAt === null ? null : new Date(output.expiresAt);
  if (
    output.ownerId !== facts.ownerId ||
    attribution.taskId !== facts.taskId ||
    attribution.roomId !== facts.roomId ||
    bindingGeneration === null ||
    !expiresAt ||
    !Number.isFinite(expiresAt.getTime()) ||
    attribution.vendorSessionId === null ||
    attribution.vendorTurnId === null ||
    attribution.vendorItemId === null
  ) {
    return null;
  }
  return {
    requestRef: output.requestId,
    userId: facts.ownerId,
    sourceAgentId: facts.agentId,
    bindingId: attribution.bindingId,
    bindingGeneration,
    roomId: facts.roomId,
    taskId: facts.taskId,
    taskRunId: facts.taskRunId,
    jobId: context.jobId,
    codexThreadId: attribution.vendorSessionId,
    codexTurnId: attribution.vendorTurnId,
    codexItemId: attribution.vendorItemId,
    questions: output.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.prompt,
      isSecret: question.secret,
      isOther: question.allowOther,
      options: question.options?.map((option) => ({
        id: option.id,
        label: option.label,
        // The provider-neutral event contract permits a missing description;
        // this durable safe projection uses the DB's canonical empty string.
        description: option.description ?? "",
      })) ?? null,
    })),
    autoResolutionMs: output.autoResolutionMs,
    expiresAt,
  };
}

function parseGeneration(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
