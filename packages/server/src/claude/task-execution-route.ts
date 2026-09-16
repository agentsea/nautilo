import type {
  ForegroundExecutionRoute,
  HarnessExecutionOutput,
  TaskExecutionRouteFacts,
  TaskExecutionRouteSelector,
} from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import { CLAUDE_EXECUTION_MAX_PROMPT_BYTES, CLAUDE_EXECUTION_MAX_TEXT_BYTES } from "@nautilo/relay";
import type { CodexRoomOutputContext } from "../codex/room-output";
import type { TaskHarnessExecutionRouteRegistration } from "../harness/task-execution-route";
import { TaskHarnessExecutionRouteProviderFailure } from "../harness/task-execution-route";
import type { HarnessTaskRunLifecyclePort } from "../messaging/harness-admission";
import type { ClaudeExecutionAdmission } from "./connection-controller";
import {
  type ClaudeHarnessExecution,
  type ClaudeHarnessExecutionAdmission,
} from "./harness-execution";
import { CLAUDE_CODE_HARNESS_ID } from "./harness-task";

export const CLAUDE_EXECUTION_FAILED = "CLAUDE_EXECUTION_FAILED" as const;

export class ClaudeTaskExecutionRouteFailure extends Error {
  readonly code = CLAUDE_EXECUTION_FAILED;

  constructor() {
    super(CLAUDE_EXECUTION_FAILED);
    this.name = "ClaudeTaskExecutionRouteFailure";
  }
}

export type ClaudeTaskExecutionMetadata = Readonly<{
  execution: Readonly<{
    version: 1;
    harnessId: typeof CLAUDE_CODE_HARNESS_ID;
    source: "genie";
    profileRef: string;
    catalogModelId: string;
    selectedModel: string;
  }>;
}>;

export interface ClaudeTaskExecutionRouteTask {
  readonly id: string;
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly parentTaskId: string | null;
  readonly callingRoomId: string | null;
  readonly targetRoomId: string | null;
  readonly prompt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

type ClaudeEphemeralOutput = Extract<
  HarnessExecutionOutput,
  { readonly kind: "progress" | "output_delta" | "permission_selection_required" | "user_input_required" }
>;

export interface ClaudeTaskExecutionRouteDeps {
  readonly tasks: Readonly<{
    getTask(taskId: string): Promise<ClaudeTaskExecutionRouteTask | null>;
  }>;
  readonly controller: Readonly<{
    admitExecution(
      ownerId: string,
      input: Readonly<{ profileRef: string; catalogModelId: string; selectedModel: string }>,
    ): Promise<ClaudeExecutionAdmission | null>;
  }>;
  readonly execution: Pick<ClaudeHarnessExecution, "start">;
  readonly taskRuns: HarnessTaskRunLifecyclePort;
  /** Project only live semantic/request output; completion remains lifecycle-owned. */
  readonly outputProjection: Readonly<{
    project(
      output: ClaudeEphemeralOutput,
      context: CodexRoomOutputContext,
    ): ServerEvent | null | Promise<ServerEvent | null>;
  }>;
}

type ClaudeRouteSnapshot = Readonly<{
  facts: TaskExecutionRouteFacts;
  task: ClaudeTaskExecutionRouteTask;
  admission: ClaudeExecutionAdmission;
}>;

const METADATA_KEYS = ["execution"] as const;
const EXECUTION_KEYS = [
  "version", "harnessId", "source", "profileRef", "catalogModelId", "selectedModel",
] as const;

/** The creator-owned metadata is the only persisted Claude routing authority. */
export function parseClaudeTaskExecutionMetadata(
  value: Readonly<Record<string, unknown>>,
): ClaudeTaskExecutionMetadata | null {
  if (!hasExactKeys(value, METADATA_KEYS)) return null;
  const raw = value["execution"];
  if (!hasExactKeys(raw, EXECUTION_KEYS)) return null;
  if (
    raw["version"] !== 1 || raw["harnessId"] !== CLAUDE_CODE_HARNESS_ID || raw["source"] !== "genie" ||
    !bounded(raw["profileRef"], CLAUDE_EXECUTION_MAX_TEXT_BYTES) ||
    !bounded(raw["catalogModelId"], CLAUDE_EXECUTION_MAX_TEXT_BYTES) ||
    !bounded(raw["selectedModel"], CLAUDE_EXECUTION_MAX_TEXT_BYTES)
  ) return null;
  return Object.freeze({ execution: Object.freeze({
    version: 1,
    harnessId: CLAUDE_CODE_HARNESS_ID,
    source: "genie",
    profileRef: raw["profileRef"],
    catalogModelId: raw["catalogModelId"],
    selectedModel: raw["selectedModel"],
  }) });
}

export class ClaudeTaskExecutionRouteSelector {
  constructor(private readonly deps: ClaudeTaskExecutionRouteDeps) {}

  readonly select: TaskExecutionRouteSelector = async (facts) => {
    try {
      const task = await this.deps.tasks.getTask(facts.taskId);
      const metadata = task ? parseClaudeTaskExecutionMetadata(task.metadata) : null;
      if (!task || !metadata || !matchesTaskFacts(task, facts)) throw new ClaudeTaskExecutionRouteFailure();

      const requested = Object.freeze({
        profileRef: metadata.execution.profileRef,
        catalogModelId: metadata.execution.catalogModelId,
        selectedModel: metadata.execution.selectedModel,
      });
      const admission = await this.deps.controller.admitExecution(facts.ownerId, requested);
      if (!admissionMatches(admission, requested)) throw new ClaudeTaskExecutionRouteFailure();

      const snapshot: ClaudeRouteSnapshot = Object.freeze({
        facts: Object.freeze({ ...facts }),
        task: Object.freeze({ ...task }),
        admission,
      });
      return Object.freeze({
        coalescing: "separate",
        contention: "serialize",
        modelAttribution: "external",
        executor: this.createExecutor(snapshot),
      } satisfies ForegroundExecutionRoute);
    } catch (error) {
      if (error instanceof ClaudeTaskExecutionRouteFailure) throw error;
      throw new ClaudeTaskExecutionRouteFailure();
    }
  };

  private createExecutor(snapshot: ClaudeRouteSnapshot): ForegroundExecutionRoute["executor"] {
    const deps = this.deps;
    return async function* claudeTaskExecutor(
      _persistedJobInput,
      jobId,
      _laneKey,
      signal,
    ): AsyncGenerator<ServerEvent> {
      const lifecycleFacts = Object.freeze({
        taskId: snapshot.facts.taskId,
        taskRunId: snapshot.facts.taskRunId,
        parentTaskId: snapshot.facts.parentTaskId,
        source: "room" as const,
      });
      let linked = false;
      let terminalized = false;
      let failureAttempted = false;
      let candidate: Extract<HarnessExecutionOutput, { readonly kind: "assistant_completed" }> | null = null;
      const fail = async (): Promise<void> => {
        if (!linked || terminalized || failureAttempted || signal.aborted) return;
        failureAttempted = true;
        await deps.taskRuns.fail({ ...lifecycleFacts, jobId, code: CLAUDE_EXECUTION_FAILED });
        terminalized = true;
      };

      try {
        await deps.taskRuns.linkJob({ ...lifecycleFacts, jobId });
        linked = true;
        if (signal.aborted) return;

        const admission: ClaudeHarnessExecutionAdmission = Object.freeze({
          jobId,
          taskId: snapshot.facts.taskId,
          taskRunId: snapshot.facts.taskRunId,
          ownerId: snapshot.facts.ownerId,
          requesterId: snapshot.facts.requestorId,
          roomId: snapshot.facts.roomId,
          laneKey: snapshot.facts.laneKey,
          source: "room",
          parentTaskId: snapshot.facts.parentTaskId,
          prompt: snapshot.task.prompt,
          abortSignal: signal,
          claude: Object.freeze({
            profileRef: snapshot.admission.profileRef,
            catalogModelId: snapshot.admission.catalogModelId,
            selectedModel: snapshot.admission.selectedModel,
            scope: snapshot.admission.scope,
          }),
        });

        for await (const output of deps.execution.start(admission)) {
          if (signal.aborted) return;
          if (output.kind === "assistant_completed") {
            if (candidate !== null || !isCandidate(output, snapshot.facts, jobId)) throw new ClaudeTaskExecutionRouteFailure();
            candidate = output;
            continue;
          }
          if (output.kind === "terminal") {
            if (output.status === "completed") {
              if (candidate === null) throw new ClaudeTaskExecutionRouteFailure();
              await deps.taskRuns.complete({ ...lifecycleFacts, jobId, resultText: candidate.text });
              terminalized = true;
              return;
            }
            if (output.status === "interrupted" && signal.aborted) return;
            throw new ClaudeTaskExecutionRouteFailure();
          }
          if (!isEphemeralOutput(output)) throw new ClaudeTaskExecutionRouteFailure();
          const projected = await deps.outputProjection.project(output, Object.freeze({
            jobId,
            laneKey: snapshot.facts.laneKey,
            facts: snapshot.facts,
          }));
          if (signal.aborted) return;
          if (projected) {
            yield projected;
          }
        }
        if (signal.aborted) return;
        throw new ClaudeTaskExecutionRouteFailure();
      } catch (error) {
        if (!signal.aborted) await fail().catch(() => undefined);
        if (signal.aborted) return;
        throw error instanceof ClaudeTaskExecutionRouteFailure
          ? error
          : new ClaudeTaskExecutionRouteFailure();
      }
    };
  }
}

export function createClaudeTaskExecutionRouteSelector(
  deps: ClaudeTaskExecutionRouteDeps,
): TaskExecutionRouteSelector {
  return new ClaudeTaskExecutionRouteSelector(deps).select;
}

export function createClaudeTaskHarnessExecutionRouteRegistration(
  createSelector: () => TaskExecutionRouteSelector,
): TaskHarnessExecutionRouteRegistration {
  return {
    harnessId: CLAUDE_CODE_HARNESS_ID,
    publicFailureCodes: [CLAUDE_EXECUTION_FAILED],
    createSelector: () => {
      const selector = createSelector();
      return {
        select: async ({ facts }) => {
        try {
          return await selector(facts);
        } catch (error) {
          if (error instanceof ClaudeTaskExecutionRouteFailure) {
            throw new TaskHarnessExecutionRouteProviderFailure(error.code);
          }
          throw error;
        }
      },
      };
    },
  };
}

function matchesTaskFacts(task: ClaudeTaskExecutionRouteTask, facts: TaskExecutionRouteFacts): boolean {
  return task.id === facts.taskId && task.ownerId === facts.ownerId && task.requestorId === facts.requestorId &&
    task.requestorId === task.ownerId && task.agentId === facts.agentId && task.parentTaskId === null &&
    facts.parentTaskId === null && task.callingRoomId === facts.roomId && task.targetRoomId === facts.roomId &&
    bounded(task.prompt, CLAUDE_EXECUTION_MAX_PROMPT_BYTES);
}

function admissionMatches(
  admission: ClaudeExecutionAdmission | null,
  metadata: Readonly<{ profileRef: string; catalogModelId: string; selectedModel: string }>,
): admission is ClaudeExecutionAdmission {
  return admission !== null && admission.profileRef === metadata.profileRef &&
    admission.catalogModelId === metadata.catalogModelId && admission.selectedModel === metadata.selectedModel;
}

function isCandidate(
  output: Extract<HarnessExecutionOutput, { readonly kind: "assistant_completed" }>,
  facts: TaskExecutionRouteFacts,
  jobId: string,
): boolean {
  return completeText(output.text) && output.attribution.bindingId === facts.taskRunId &&
    output.attribution.bindingGeneration === jobId && output.attribution.taskId === facts.taskId &&
    output.attribution.roomId === facts.roomId;
}

function isEphemeralOutput(output: HarnessExecutionOutput): output is ClaudeEphemeralOutput {
  return output.kind === "progress" || output.kind === "output_delta" || output.kind === "permission_selection_required" || output.kind === "user_input_required";
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function bounded(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxBytes && !value.includes("\0") &&
    new TextEncoder().encode(value).byteLength <= maxBytes;
}

function completeText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
