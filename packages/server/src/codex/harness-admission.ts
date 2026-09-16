import type { CodexPosture, ServerEvent } from "@nautilo/types";
import { error as logError } from "@nautilo/logger";
import {
  getCodexProfileWith,
  getCodexUserPreferenceWith,
  eq,
  tasks,
  type DirectDatabase,
} from "@nautilo/db";
import type {
  ForegroundExecutionRoute,
  HarnessControlPlane,
  HarnessExecutionOutput,
  TaskExecutionRouteFacts,
  TaskExecutionRouteSelector,
} from "@nautilo/runtime";
import type { CodexDerivedBindingScope, CodexSemanticAuthorityRequest } from "./authority";
import type { CodexHarnessReadinessReceipt } from "./harness-task";
import { CODEX_HARNESS_ID } from "./harness-driver";
import {
  assertCodexExecutionAdmission,
  type CodexExecutionAdmission,
} from "./execution-admission";
import type {
  CodexExecutionPreflightPort,
  CodexExecutionProfileFacts,
} from "./execution-preflight";
import type { HarnessTaskRunLifecyclePort } from "../messaging/harness-admission";
import {
  codexCapabilityModelId,
  createCodexModelOutputContract,
  parseCodexModelOutputContract,
  type CodexModelExecutionLimits,
  type CodexModelOutputContract,
} from "./model-output-contract";

type CodexPreference = {
  readonly enabled: boolean;
  readonly accountProfileId: string | null;
  readonly defaultPosture: CodexPosture;
};

type CodexProfile = CodexExecutionProfileFacts & {
  readonly id: string;
  readonly authState: string;
  readonly removalState: string;
};

export interface CodexHarnessPreferencePort {
  getOwnerPreference(userId: string): Promise<CodexPreference>;
  getProfile(userId: string, profileId: string): Promise<CodexProfile | undefined>;
}

type CodexPreferenceDb = Parameters<typeof getCodexUserPreferenceWith>[0];

/** Exact user-global Codex preference/profile store used by Room execution. */
export class CodexHarnessPreferenceStore implements CodexHarnessPreferencePort {
  constructor(private readonly db: CodexPreferenceDb) {}

  async getOwnerPreference(userId: string): Promise<CodexPreference> {
    const row = await getCodexUserPreferenceWith(this.db, { userId });
    return {
      enabled: row.enabled,
      accountProfileId: row.accountProfileId,
      defaultPosture: decodePosture(row.defaultPosture),
    };
  }

  async getProfile(userId: string, profileId: string): Promise<CodexProfile | undefined> {
    const row = await getCodexProfileWith(this.db, { userId }, profileId);
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.userId,
      relayId: row.relayId,
      profileHandle: row.id,
      profileGeneration: row.profileGeneration,
      accountGeneration: row.accountGeneration,
      authState: row.authState,
      removalState: row.removalState,
    };
  }
}

function decodePosture(value: string): CodexPosture {
  if (value === "codex_default" || value === "prompted_workspace" || value === "full_access_headless") {
    return value;
  }
  throw new CodexHarnessAdmissionFailure("CODEX_PROFILE_UNAVAILABLE");
}

export type CodexHarnessAdmissionFailureCode =
  | "CODEX_NOT_ENABLED"
  | "CODEX_SOURCE_FORBIDDEN"
  | "CODEX_PROFILE_UNAVAILABLE"
  | "CODEX_WORKSPACE_UNAVAILABLE"
  | "CODEX_EXECUTION_FAILED";

/** Bounded error vocabulary: upstream protocol text never crosses this seam. */
export class CodexHarnessAdmissionFailure extends Error {
  constructor(readonly code: CodexHarnessAdmissionFailureCode) {
    super(code);
    this.name = "CodexHarnessAdmissionFailure";
  }
}

export interface CodexHarnessAuthorityPort {
  deriveScope(request: CodexSemanticAuthorityRequest): Promise<CodexDerivedBindingScope>;
}

export interface CodexPersistedRouteTask {
  readonly id: string;
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly parentTaskId: string | null;
  readonly callingRoomId?: string | null;
  readonly targetRoomId: string | null;
  readonly prompt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Reloading the Task prevents a selector closure from trusting browser input. */
export interface CodexTaskExecutionRouteReader {
  getTask(taskId: string): Promise<CodexPersistedRouteTask | null>;
}

export function createCodexTaskExecutionRouteReader(
  db: DirectDatabase,
): CodexTaskExecutionRouteReader {
  return {
    async getTask(taskId) {
      const [row] = await db
        .select({
          id: tasks.id,
          ownerId: tasks.ownerId,
          requestorId: tasks.requestorId,
          agentId: tasks.agentId,
          parentTaskId: tasks.parentTaskId,
          callingRoomId: tasks.callingRoomId,
          targetRoomId: tasks.targetRoomId,
          prompt: tasks.prompt,
          metadata: tasks.metadata,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1);
      return row ?? null;
    },
  };
}

export interface CodexExecutionAdmissionFactoryPort {
  /** Builds the private, immutable admission. */
  create(input: {
    readonly facts: TaskExecutionRouteFacts;
    readonly scope: CodexDerivedBindingScope;
    readonly jobId: string;
    readonly prompt: string;
    readonly selectedModel: string | null;
    readonly outputContract: CodexModelOutputContract;
    readonly collaborationMode: "work" | "plan";
    readonly workingDirectory: string | null;
    readonly signal: AbortSignal;
  }): Promise<CodexExecutionAdmission>;
}

export interface HarnessOutputProjectionPort {
  project(
    output: HarnessExecutionOutput,
    context: {
      readonly ownerId: string;
      readonly agentId: string;
      readonly roomId: string;
      readonly taskId: string;
      readonly taskRunId: string;
      readonly jobId: string;
      readonly laneKey: string;
      readonly facts: TaskExecutionRouteFacts;
    },
  ): ServerEvent | readonly ServerEvent[] | null | Promise<ServerEvent | readonly ServerEvent[] | null>;
}

export interface CodexTaskExecutionRouteDeps {
  readonly preferences: CodexHarnessPreferencePort;
  readonly tasks: CodexTaskExecutionRouteReader;
  readonly taskRuns: HarnessTaskRunLifecyclePort;
  readonly preflight: CodexExecutionPreflightPort;
  readonly models: {
    list(profile: CodexProfile): Promise<{
      readonly models: readonly {
        readonly id: string;
        readonly model: string;
      }[];
    }>;
  };
  readonly limits: {
    resolve(modelId: string): Promise<CodexModelExecutionLimits>;
  };
  readonly authority: CodexHarnessAuthorityPort;
  readonly admissionFactory: CodexExecutionAdmissionFactoryPort;
  readonly controlPlane: HarnessControlPlane;
  readonly outputProjection: HarnessOutputProjectionPort;
}

/**
 * Strict metadata discriminator for the server-authored native-Genie harness
 * Task. Any user-shaped or future near-match remains native Task execution.
 */
export function isCodexHarnessExecutionMetadata(
  metadata: Readonly<Record<string, unknown>>,
): boolean {
  if (Object.keys(metadata).length !== 1 || !("execution" in metadata)) return false;
  const execution = metadata["execution"];
  if (typeof execution !== "object" || execution === null || Array.isArray(execution)) return false;
  const record = execution as Record<string, unknown>;
  const harnessModelId = record["harnessModelId"];
  const workingDirectory = record["workingDirectory"];
  const allowedKeys = new Set([
    "version", "harnessId", "source", "collaborationMode", "harnessModelId",
    "outputContract", "readiness", "workingDirectory",
  ]);
  const keys = Object.keys(record);
  return (keys.length === 6 || keys.length === 7 || keys.length === 8)
    && keys.every((key) => allowedKeys.has(key))
    && record["version"] === 1
    && record["harnessId"] === "codex"
    && record["source"] === "genie"
    && (record["collaborationMode"] === "work" || record["collaborationMode"] === "plan")
    && typeof harnessModelId === "string"
    && harnessModelId.length > 0
    && new TextEncoder().encode(harnessModelId).byteLength <= 512
    && (record["outputContract"] === undefined ||
      parseCodexModelOutputContract(record["outputContract"]) !== null)
    && (workingDirectory === undefined || (
      typeof workingDirectory === "string"
      && workingDirectory.length > 0
      && new TextEncoder().encode(workingDirectory).byteLength <= 4096
    ))
    && codexHarnessReadiness(record["readiness"]) !== null;
}

function codexHarnessOutputContract(
  metadata: Readonly<Record<string, unknown>>,
): CodexModelOutputContract | null {
  if (!isCodexHarnessExecutionMetadata(metadata)) {
    throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
  }
  const value = (metadata["execution"] as Record<string, unknown>)["outputContract"];
  return value === undefined ? null : parseCodexModelOutputContract(value);
}

function codexHarnessWorkingDirectory(
  metadata: Readonly<Record<string, unknown>>,
): string | null {
  if (!isCodexHarnessExecutionMetadata(metadata)) {
    throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
  }
  const execution = metadata["execution"] as Record<string, unknown>;
  return typeof execution["workingDirectory"] === "string"
    ? execution["workingDirectory"]
    : null;
}

function codexHarnessReadiness(value: unknown): CodexHarnessReadinessReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    typeof record["relayId"] !== "string" || record["relayId"].length === 0 ||
    typeof record["pairingGenerationRef"] !== "string" || record["pairingGenerationRef"].length === 0 ||
    !Number.isSafeInteger(record["capabilityRevision"]) || (record["capabilityRevision"] as number) < 0
  ) return null;
  return record as CodexHarnessReadinessReceipt;
}

function codexHarnessCollaborationMode(
  metadata: Readonly<Record<string, unknown>>,
): "work" | "plan" {
  if (!isCodexHarnessExecutionMetadata(metadata)) {
    throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
  }
  return (metadata["execution"] as Record<string, unknown>)["collaborationMode"] as "work" | "plan";
}

function codexHarnessModelId(
  metadata: Readonly<Record<string, unknown>>,
): string {
  if (!isCodexHarnessExecutionMetadata(metadata)) {
    throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
  }
  return (metadata["execution"] as Record<string, unknown>)["harnessModelId"] as string;
}

function readinessMatches(
  scope: CodexDerivedBindingScope,
  metadata: Readonly<Record<string, unknown>>,
): boolean {
  if (!isCodexHarnessExecutionMetadata(metadata)) return false;
  const readiness = codexHarnessReadiness(
    (metadata["execution"] as Record<string, unknown>)["readiness"],
  );
  return readiness !== null &&
    readiness.relayId === scope.relayId &&
    readiness.pairingGenerationRef === scope.pairingGenerationRef &&
    readiness.capabilityRevision === scope.capabilityRevision;
}

function sameAssistantCompletion(
  left: Extract<HarnessExecutionOutput, { readonly kind: "assistant_completed" }>,
  right: Extract<HarnessExecutionOutput, { readonly kind: "assistant_completed" }>,
): boolean {
  return left.text === right.text
    && left.attribution.bindingId === right.attribution.bindingId
    && left.attribution.bindingGeneration === right.attribution.bindingGeneration
    && left.attribution.taskId === right.attribution.taskId
    && left.attribution.roomId === right.attribution.roomId
    && left.attribution.vendorSessionId === right.attribution.vendorSessionId
    && left.attribution.vendorTurnId === right.attribution.vendorTurnId
    && left.attribution.vendorItemId === right.attribution.vendorItemId;
}

function exactFacts(task: CodexPersistedRouteTask, facts: TaskExecutionRouteFacts): boolean {
  return task.id === facts.taskId
    && task.ownerId === facts.ownerId
    && task.requestorId === facts.requestorId
    && task.agentId === facts.agentId
    && task.parentTaskId === facts.parentTaskId
    && task.targetRoomId === facts.roomId;
}

/**
 * One canonical post-TaskRun route selector. It selects only the sealed
 * internal descriptor; all ordinary Tasks keep the native executor unchanged.
 */
export class CodexTaskExecutionRouteSelector {
  constructor(private readonly deps: CodexTaskExecutionRouteDeps) {}

  readonly select: TaskExecutionRouteSelector = async (facts) => {
    const task = await this.deps.tasks.getTask(facts.taskId);
    if (!task || !isCodexHarnessExecutionMetadata(task.metadata)) return undefined;
    if (!exactFacts(task, facts)) {
      throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
    }

    const ownerPreference = await this.deps.preferences.getOwnerPreference(facts.ownerId);
    if (!ownerPreference.enabled) throw new CodexHarnessAdmissionFailure("CODEX_NOT_ENABLED");

    if (!ownerPreference.accountProfileId) {
      throw new CodexHarnessAdmissionFailure("CODEX_PROFILE_UNAVAILABLE");
    }

    const profile = await this.deps.preferences.getProfile(
      facts.ownerId,
      ownerPreference.accountProfileId,
    );
    if (
      !profile
      || profile.id !== ownerPreference.accountProfileId
      || profile.userId !== facts.ownerId
      || profile.authState !== "signed_in"
      || profile.removalState !== "active"
    ) {
      throw new CodexHarnessAdmissionFailure("CODEX_PROFILE_UNAVAILABLE");
    }

    const immutableFacts = Object.freeze({ ...facts });
    const immutableTask = Object.freeze({ ...task });
    const collaborationMode = codexHarnessCollaborationMode(task.metadata);
    return {
      coalescing: "separate",
      contention: "serialize",
      modelAttribution: "external",
      executor: this.createExecutor({
        facts: immutableFacts,
        task: immutableTask,
        profile,
        posture: ownerPreference.defaultPosture,
        collaborationMode,
      }),
    } satisfies ForegroundExecutionRoute;
  };

  private createExecutor(input: {
    readonly facts: TaskExecutionRouteFacts;
    readonly task: CodexPersistedRouteTask;
    readonly profile: CodexProfile;
    readonly posture: CodexPosture;
    readonly collaborationMode: "work" | "plan";
  }): ForegroundExecutionRoute["executor"] {
    const deps = this.deps;
    return async function* codexTaskExecutor(
      _persistedJobInput,
      jobId,
      _laneKey,
      signal,
    ): AsyncGenerator<ServerEvent> {
      let linked = false;
      let terminal: "completed" | "failed" | "interrupted" | null = null;
      let assistantResult: Extract<
        HarnessExecutionOutput,
        { readonly kind: "assistant_completed" }
      > | null = null;
      let lifecycleTerminalized = false;
      let stage = "link_task_run";
      try {
        await deps.taskRuns.linkJob({
          taskId: input.facts.taskId,
          taskRunId: input.facts.taskRunId,
          parentTaskId: input.facts.parentTaskId,
          source: "room",
          jobId,
        });
        linked = true;

        stage = "execution_preflight";
        await deps.preflight.prepare(input.profile);
        stage = "resolve_harness_model";
        const modelCatalog = await deps.models.list(input.profile);
        const selectedModel = modelCatalog.models.find(
          (model) => model.id === codexHarnessModelId(input.task.metadata),
        );
        if (!selectedModel) {
          throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
        }
        const capabilityModelId = codexCapabilityModelId(selectedModel.model);
        const outputContract = createCodexModelOutputContract(
          selectedModel.model,
          await deps.limits.resolve(capabilityModelId),
        );
        const sealedOutputContract = codexHarnessOutputContract(input.task.metadata);
        if (
          sealedOutputContract &&
          sealedOutputContract.capabilityModelId !== outputContract.capabilityModelId
        ) {
          throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
        }
        stage = "derive_authority";
        const scope = await deps.authority.deriveScope({
          actorId: input.facts.ownerId,
          agentId: input.facts.agentId,
          taskId: input.facts.taskId,
          taskRunId: input.facts.taskRunId,
          jobId,
          roomId: input.facts.roomId,
          profileId: input.profile.id,
          laneKey: input.facts.laneKey,
          posture: input.posture,
          collaborationMode: input.collaborationMode,
        });
        if (!readinessMatches(scope, input.task.metadata)) {
          throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
        }
        stage = "create_admission";
        const admission = await deps.admissionFactory.create({
          facts: input.facts,
          scope,
          jobId,
          prompt: input.task.prompt,
          selectedModel: selectedModel.model,
          outputContract,
          collaborationMode: input.collaborationMode,
          workingDirectory: codexHarnessWorkingDirectory(input.task.metadata),
          signal,
        });
        assertCodexExecutionAdmission(admission);

        // This is deliberately lazy and after binding authority/admission.
        stage = "resolve_driver";
        const driver = await deps.controlPlane.requireOperation(CODEX_HARNESS_ID, "start");
        stage = "execute_turn";
        for await (const output of driver.execution.start(admission)) {
          if (output.kind === "terminal") {
            terminal = output.status;
            // An authoritative completion is the lifecycle linearization
            // point.  Do this immediately rather than after the stream loop:
            // a Stop that happens later is then idempotent against the
            // completed Task/TaskRun, while a Stop that closed the exact
            // stream first never lets a late terminal reach this branch.
            if (terminal === "completed") {
              if (!assistantResult) {
                throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
              }
              await deps.taskRuns.complete({
                taskId: input.facts.taskId,
                taskRunId: input.facts.taskRunId,
                parentTaskId: input.facts.parentTaskId,
                source: "room",
                jobId,
                resultText: assistantResult.text,
              });
              lifecycleTerminalized = true;
              return;
            }
            continue;
          }
          if (output.kind === "assistant_completed") {
            if (
              output.text.trim().length === 0
              || output.attribution.taskId !== input.facts.taskId
              || output.attribution.roomId !== input.facts.roomId
            ) {
              throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
            }
            if (assistantResult) {
              if (!sameAssistantCompletion(assistantResult, output)) {
                throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
              }
              continue;
            }
            assistantResult = output;
            continue;
          }
          // Requests, response previews, and semantic progress share the
          // owner-private Room projection. Only assistant_completed remains
          // reserved for canonical Task report-back.
          const projected = await deps.outputProjection.project(output, {
            ownerId: input.facts.ownerId,
            agentId: input.facts.agentId,
            roomId: input.facts.roomId,
            taskId: input.facts.taskId,
            taskRunId: input.facts.taskRunId,
            jobId,
            laneKey: input.facts.laneKey,
            facts: input.facts,
          });
          if (!projected) continue;
          if (Array.isArray(projected)) {
            for (const event of projected as readonly ServerEvent[]) yield event;
          }
          else yield projected as ServerEvent;
        }

        // Once ordinary Stop has aborted the local job, it owns cancellation;
        // every other terminal (including provider "interrupted") is a failed
        // Codex execution and must not leave the TaskRun running.
        if (signal.aborted) return;
        await deps.taskRuns.fail({
          taskId: input.facts.taskId,
          taskRunId: input.facts.taskRunId,
          parentTaskId: input.facts.parentTaskId,
          source: "room",
          jobId,
          code: "CODEX_EXECUTION_FAILED",
        });
        lifecycleTerminalized = true;
        throw new CodexHarnessAdmissionFailure("CODEX_EXECUTION_FAILED");
      } catch (error) {
        const failureCode = harnessFailureCode(error);
        logError(
          "[codex] task execution failed",
          `stage=${stage}`,
          `task=${input.facts.taskId}`,
          `run=${input.facts.taskRunId}`,
        );
        if (linked && !lifecycleTerminalized && !signal.aborted) {
          await deps.taskRuns.fail({
            taskId: input.facts.taskId,
            taskRunId: input.facts.taskRunId,
            parentTaskId: input.facts.parentTaskId,
            source: "room",
            jobId,
            code: failureCode,
          }).catch(() => undefined);
        }
        throw new CodexHarnessAdmissionFailure(failureCode);
      }
    };
  }
}

function harnessFailureCode(error: unknown): CodexHarnessAdmissionFailureCode {
  return error instanceof CodexHarnessAdmissionFailure &&
      error.code === "CODEX_WORKSPACE_UNAVAILABLE"
    ? "CODEX_WORKSPACE_UNAVAILABLE"
    : error && typeof error === "object" && "code" in error &&
        (error as { readonly code?: unknown }).code === "CODEX_WORKSPACE_UNAVAILABLE"
      ? "CODEX_WORKSPACE_UNAVAILABLE"
      : "CODEX_EXECUTION_FAILED";
}

export function createCodexTaskExecutionRouteSelector(
  deps: CodexTaskExecutionRouteDeps,
): TaskExecutionRouteSelector {
  return new CodexTaskExecutionRouteSelector(deps).select;
}
