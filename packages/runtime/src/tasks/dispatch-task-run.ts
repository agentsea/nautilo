import {
  getLatestResumableTaskRun,
  getTaskById,
  insertTaskRun,
  startTaskRunForWriterReviewVerification,
  pauseClaimedTaskForAuthorizationDenial,
  markTaskRunning,
  markTaskRunStatus,
  updateTask,
  attachArtifactToNamespace,
  findArtifactByIdForNamespaces,
  rooms,
  eq,
  type DirectDatabase,
  type Task,
} from "@nautilo/db";
import {
  getProfileByAgentId,
  getDefaultModel,
  validateSubagentToolWhitelist,
  MAX_SUBAGENT_DEPTH,
  resolveTaskModel,
  ModelSelectionError,
  assertExactTaskModelSelection,
  getRelayRegistry,
  assertSecurityResearchResumeBinding,
} from "@nautilo/agent";
import {
  getPolicyResolver,
  assertCanInvokeAgent,
  assertCanUseServerProviderCredentials,
  AgentInvocationDeniedError,
  ServerProviderCredentialsDeniedError,
  createAcceptedInvocationAuthority,
  envelopeReadableNamespaces,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import type {
  PolicyResolver,
  MemoryAccessEnvelope,
} from "@nautilo/trust";
import { log } from "@nautilo/logger";
import type { ChatArtifactRef, ResolvedFocusedResource } from "@nautilo/types";
import type {
  CreateForegroundJobResult,
  ForegroundExecutionRoute,
} from "../job-manager";
import { eventBus } from "../event-bus";
import { isSecurityReportDeliveryRetry, resumeSecurityResearchRun, pauseSecurityResearchResume } from "./security-report-recovery";
import {
  resolveTargetRoom,
  type HumanRoomMember,
} from "./resolve-target-room";
import { taskRunExecutor } from "./task-run-executor";
import {
  createMaintenanceAcceptanceAuthority,
  getMaintenanceGate,
  type MaintenanceAcceptanceAuthority,
  type MaintenanceGate,
} from "../maintenance-controller";
import { registerTaskRunAcceptance } from "./report-back";
import {
  hasWriterReviewAcceptedContinuation,
  parseLiveMiniAppTaskDelegationIntent,
  resolveTaskReturnBinding,
  restoreTaskReturnBindingFromCheckpoint,
} from "./task-return-binding";
import { resolveTaskMemoryEnvelope } from "./resolve-task-memory-envelope";

export {
  selectTaskEnvelopeMode,
  type TaskEnvelopeMode,
} from "./resolve-task-memory-envelope";

const WRITER_REVIEW_VERIFICATION_CONTINUATION = [
  "A prior run of this same Task completed a Human-accepted canonical Writer save.",
  "This run is the required post-save verification continuation.",
  "Re-read the entire currently bound Writer document at its current version.",
  "If it now fulfills the original brief, report success for the overall Task; do not claim that no changes were saved merely because this verification run made none.",
  "If errors remain, propose the remaining corrections through the normal Writer review flow and wait for review again.",
].join(" ");

/** The slice of `JobManager` `dispatchTaskRun` needs (injectable for tests). */
export interface TaskJobManager {
  createForegroundJob(
    ownerId: string,
    requestorId: string,
    laneKey: string,
    input: Record<string, unknown>,
    executorOverride?: import("../job").JobExecutor,
    authority?: MaintenanceAcceptanceAuthority,
    executionRoute?: ForegroundExecutionRoute,
    invocationAuthority?: AcceptedInvocationAuthority,
  ): Promise<CreateForegroundJobResult>;
}

/**
 * Durable, server-authored identity available to an optional Task execution
 * selector. This is deliberately smaller than the Task row and excludes
 * mutable host, workspace, profile, and prompt-derived authority. A selector
 * may choose a per-turn execution route, but it cannot manufacture or replace
 * the canonical Task / TaskRun identities.
 */
export interface TaskExecutionRouteFacts {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly parentTaskId: string | null;
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  /** Resolved canonical Room target (including a hidden orphan Task Room). */
  readonly roomId: string;
  readonly laneKey: string;
  readonly graphThreadId: string;
}

/**
 * Server composition may select an immutable execution route for one durable
 * TaskRun. Returning `undefined` retains the native Task executor exactly.
 * The selector runs only after `task_runs` has been inserted and before a Job
 * is accepted, so a harness receives real Task/TaskRun/Job identity in that
 * order without storing routing policy on a graph thread.
 */
export type TaskExecutionRouteSelector = (
  facts: TaskExecutionRouteFacts,
) => Promise<ForegroundExecutionRoute | undefined> | ForegroundExecutionRoute | undefined;

export interface DispatchTaskRunDeps {
  db: DirectDatabase;
  jobManager: TaskJobManager;
  /** Defaults to the process policy resolver. */
  resolver?: PolicyResolver;
  /** D420 — gate scheduled/claimed task starts before any task-run write. */
  maintenanceGate?: MaintenanceGate;
  /**
   * Optional server-owned selection seam for an already-created TaskRun.
   * Native Task execution remains the default when it is omitted or returns
   * undefined. Runtime deliberately knows no provider or harness ids.
   */
  executionRouteSelector?: TaskExecutionRouteSelector;
  /** Test seam for the current-RBAC durable-fire decision. */
  assertInvocation?: typeof assertCanInvokeAgent;
  assertServerFunding?: typeof assertCanUseServerProviderCredentials;
  /**
   * Server-owned realtime convergence for Rooms created by target resolution.
   * It must finish before Job creation can publish the Room's first message.
   */
  convergeCreatedRoomCatalog?: (
    humans: readonly HumanRoomMember[],
  ) => Promise<void>;
}

export type DispatchTaskRunResult =
  | {
      kind: "dispatched";
      jobId: string;
      runId: string;
      graphThreadId: string;
      roomId: string;
    }
  | {
      kind: "authorization_paused";
      jobId?: never;
      runId?: never;
      graphThreadId?: never;
      roomId?: never;
    };

/**
 * Resolve the run's tool composition from `tools_mode`:
 * - `auto` leaves the whitelist undefined, selecting the progressive default
 *   (core tools plus tools activated during this run).
 * - `none` uses an empty whitelist, binding no tools.
 * - `whitelist` is an explicit hard ceiling; the graph still intersects it
 *   with its core/activated progressive selection and normal eligibility.
 *
 * The `whitelist` case is validated at dispatch time against the run's
 * effective parent catalog (the single source of truth for every surface; the
 * shortcut tools only *store* the requested tools).
 * `validateSubagentToolWhitelist` needs the built envelope's `toolPolicy`, so
 * the envelope is threaded in.
 *
 * On validation failure we throw — the observer marks the task `errored` and
 * the report-back ping surfaces the message; this is preferable to silently
 * running with a degraded (empty) tool set.
 */
/**
 * Read the server-authored Artifact handoff marker produced only by the
 * `ask_peer` shortcut. Generic Task metadata never gains sharing semantics.
 */
function readArtifactAwareAskPeerRefs(task: Task): ChatArtifactRef[] {
  if (task.preset !== "ask_peer" || task.metadata["artifactAwareAskPeer"] !== true) {
    return [];
  }
  const raw = task.metadata["artifactRefs"];
  if (!Array.isArray(raw)) return [];
  const refs: ChatArtifactRef[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const ref = value as Record<string, unknown>;
    const artifactId = typeof ref["artifactId"] === "string"
      ? ref["artifactId"].trim()
      : "";
    const path = typeof ref["path"] === "string" ? ref["path"] : "";
    const mimeType = typeof ref["mimeType"] === "string" && ref["mimeType"]
      ? ref["mimeType"]
      : "application/octet-stream";
    const size = typeof ref["size"] === "number" && Number.isFinite(ref["size"])
      ? Math.max(0, ref["size"])
      : 0;
    if (!artifactId || refs.some((existing) => existing.artifactId === artifactId)) continue;
    refs.push({ artifactId, path, mimeType, size });
  }
  return refs;
}

/**
 * M144 (R2, S3) — the seam's envelope discriminator. Pure + exported so the
 * dominant seam risk (a requester-only `in_background` task must NOT be
 * captured by the wide branch) is unit-testable without a DB.
 *
 * Both `in_background` and `in_private_namespace` are requester-only, so we key
 * on `use_scope` / `preset`, NOT on `target_user_ids` (which would mis-scope
 * every background task into the wide branch). `target_user_ids` is consumed
 * INSIDE the `namespace` branch (M165) to derive the run's namespace envelope —
 * it does not select the mode.
 */
export function resolveToolWhitelist(
  task: Task,
  envelope: MemoryAccessEnvelope,
): string[] | undefined {
  switch (task.toolsMode) {
    case "none":
      return [];
    case "whitelist": {
      const validated = validateSubagentToolWhitelist({
        requestedTools: task.toolsWhitelist,
        parentEnvelope: envelope,
        actorRole: "owner",
        toolPolicy: envelope.toolPolicy,
        // M150 — authorization-only validation. A relay-executor tool
        // (`run_shell`, fs writes) the owner is authorized for must NOT be
        // rejected at dispatch just because no relay is connected at this
        // instant. Relay PRESENCE is gated at run start: `task-run-executor`
        // threads live `relayCapabilities` into the run's catalog, so the tool
        // is available iff a relay is live then, else the run degrades to
        // cloud-only (D1/R2). Pre-M150 this passed no relay tokens, so every
        // `whitelist: ["run_shell"]` task was rejected here with "Tool(s)
        // unavailable in this context" — even with a relay actually connected.
        skipRelayLiveCheck: true,
        subagentDepth: task.depth + 1,
        subagentMaxDepth: MAX_SUBAGENT_DEPTH,
      });
      if (!validated.ok) {
        throw new Error(
          `dispatchTaskRun: tool whitelist rejected for task ${task.id}: ${validated.message}`,
        );
      }
      return validated.whitelist;
    }
    case "auto":
    default:
      // Omit the field rather than passing an eager catalog: `undefined` is
      // the graph state's progressive default, while [] intentionally means
      // tool-free.
      return undefined;
  }
}

/**
 * M142 (spec §5.1) — the single dispatch seam. Called ONLY by the
 * `TaskObserver`. Resolves the target room + thread, builds the run's memory
 * envelope + model, inserts a `task_runs` row, and creates the subagent job
 * (its own thread, a task-only lane) that runs `runScopeSubagentUntilPause`.
 *
 * Report-back is NOT here (M143). The run's completion handler
 * (`taskRunExecutor`) sets the interim terminal status; M143 replaces it.
 */
export async function dispatchTaskRun(
  task: Task,
  deps: DispatchTaskRunDeps,
): Promise<DispatchTaskRunResult> {
  if (task.contentRepresentation === "protected" || task.contentRepresentation === "dual") {
    throw new TypeError("Protected Task execution is unavailable");
  }
  const { db, jobManager } = deps;
  const resolver = deps.resolver ?? getPolicyResolver();
  // M254 R6 — a durable Task never carries creation-time authority. Re-read
  // the requestor's current RBAC state before resolving a Room, Scope, model,
  // TaskRun, or Job. Known absence is a lifecycle outcome; lookup failure is
  // still an exception and therefore fails closed without changing the Task.
  try {
    await (deps.assertInvocation ?? assertCanInvokeAgent)({
      humanUserId: task.requestorId,
      origin: "task_dispatch",
      taskId: task.id,
      agentId: task.agentId,
      ...(task.targetRoomId ? { roomId: task.targetRoomId } : {}),
    });
    await (deps.assertServerFunding ?? assertCanUseServerProviderCredentials)(
      task.requestorId,
      "task_dispatch",
    );
  } catch (error) {
    if (!(error instanceof AgentInvocationDeniedError)
      && !(error instanceof ServerProviderCredentialsDeniedError)) throw error;
    if (!task.fireLockId) {
      throw new Error(
        `dispatchTaskRun: authorization denial for unclaimed task ${task.id}`,
      );
    }
    const transition = await pauseClaimedTaskForAuthorizationDenial(db, {
      taskId: task.id,
      fireLockId: task.fireLockId,
    });
    if (transition.transitioned && transition.task) {
      eventBus.emit({
        type: "task.status",
        taskId: task.id,
        ownerId: transition.task.ownerId,
        status: "paused",
      });
      log(`[task-dispatch] authorization paused task=${task.id}`);
    }
    return { kind: "authorization_paused" };
  }
  // D420 (Wave 2 task 2.2.1) — dispatch can be called outside the observer
  // in tests or future schedulers, so it re-checks admission immediately
  // before it can create a task run / Job. A drain rejection leaves the task
  // unstarted; TaskObserver's pre-claim gate prevents normal production
  // callers from claiming it in the first place.
  await (deps.maintenanceGate ?? getMaintenanceGate()).assertAcceptingNewWork();
  // The Task is accepted at this gate. Carry that authority through the
  // subsequent task-run writes so a drain that begins before Job creation
  // cannot reject the second gate and strand a running task_run with no Job.
  const acceptanceAuthority = createMaintenanceAcceptanceAuthority();
  const invocationAuthority = createAcceptedInvocationAuthority(task.requestorId, { originTaskId: task.id });
  if (!resolver) {
    throw new Error("dispatchTaskRun: no PolicyResolver configured (initPolicyResolver not called)");
  }

  // 1. Target room + graph thread.
  //
  // M147 (R4) — resume detection. A parked (`paused`) run means this dispatch
  // is an UNPAUSE re-entry (the observer re-claimed the task after
  // `unpauseTask` set it back to `pending` + `next_fire_at = now`). The
  // preserved LangGraph checkpoint lives on the PRIOR run's `graphThreadId`, so
  // we reuse it verbatim and bypass `resolveTargetRoom`'s thread mint
  // (`orphanRunThreadId` re-mints a fresh `subagent:…:<uuid>` every call, which
  // would orphan the checkpoint). The room is already memoized on
  // `tasks.target_room_id`, so `resolveTargetRoom` still returns the right
  // `roomId`; we only override the thread.
  const resumableRun = await getLatestResumableTaskRun(db, task.id);
  const deliveryOnlyResume = isSecurityReportDeliveryRetry(resumableRun);
  const securityResearchResume = resumableRun !== undefined && Boolean(resumableRun.modelId)
    && task.toolsMode === "whitelist" && task.toolsWhitelist?.includes("security_scan") === true;
  if (deliveryOnlyResume && !securityResearchResume) throw new Error("SECURITY_RESEARCH_RESUME_SCOPE_MISMATCH");
  const researchCheckpoint = securityResearchResume
    ? await assertSecurityResearchResumeBinding({ threadId: resumableRun.graphThreadId, taskId: task.id,
      taskRunId: resumableRun.id, userId: task.ownerId, modelId: resumableRun.modelId! }) : undefined;
  const restoredResearchBinding = researchCheckpoint && resumableRun
    ? restoreTaskReturnBindingFromCheckpoint({ taskId: task.id, taskRunId: resumableRun.id, ownerId: task.ownerId,
      graphThreadId: resumableRun.graphThreadId, taskCreatedAt: task.createdAt, checkpointState: researchCheckpoint },
      getRelayRegistry() as Parameters<typeof restoreTaskReturnBindingFromCheckpoint>[1]) : undefined;
  if (restoredResearchBinding && restoredResearchBinding.status !== "available") {
    await pauseSecurityResearchResume(db, { taskId: task.id, taskRunId: resumableRun!.id, ownerId: task.ownerId,
      fireLockId: task.fireLockId, reason: restoredResearchBinding.status });
    return { kind: "authorization_paused" };
  }
  const resolvedTarget = await resolveTargetRoom(task, { db });
  const { roomId, graphThreadId: freshThreadId } = resolvedTarget;
  if (
    resolvedTarget.createdHumanRoomMembers
    && resolvedTarget.createdHumanRoomMembers.length > 0
    && deps.convergeCreatedRoomCatalog
  ) {
    await deps.convergeCreatedRoomCatalog(resolvedTarget.createdHumanRoomMembers);
  }
  const graphThreadId = resumableRun?.graphThreadId ?? freshThreadId;
  const isResume = resumableRun !== undefined;

  // M151 (R6 prerequisite) — persist `target_room_id` for ALL room-backed
  // targets. `resolveOrphan` + `resolveDm` already memoize it, but the
  // namespace resolvers return a `roomId` without persisting; the reply hook's
  // `findAwaitingTaskForRoom` matches on `tasks.target_room_id = roomId`, so a
  // namespace-target await task would otherwise be unfindable. Idempotent.
  if (roomId && task.targetRoomId !== roomId) {
    await updateTask(db, task.id, { targetRoomId: roomId });
  }

  // M151 — the await set: the requester (the common namespace-await case where
  // `target_user_ids` may be empty) ∪ the named targets (the `ask_peer` peer,
  // persisted into `target_user_ids` by `resolveDm`). Re-read so a peer
  // appended during this dispatch is included. Informational for the WS event
  // + node payload; the resume match is done by `findAwaitingTaskForRoom`.
  const awaitTask = task.awaitResponse ? (await getTaskById(db, task.id)) ?? task : task;
  const awaitFromUserIds = Array.from(
    new Set([awaitTask.requestorId, ...awaitTask.targetUserIds].filter(Boolean)),
  );

  // M151 — the run's transcript session must be owned by a MEMBER of the
  // target room, else `getRoomMessagesAcrossMemberSessions` (member-owned only)
  // hides it. The room owner is always a member: requester for namespace/orphan
  // targets (unchanged), the PEER for an `ask_peer` DM. Fall back to the task
  // owner if the room row is unexpectedly missing.
  let transcriptOwnerId = task.ownerId;
  let targetRoomNamespaceId: string | null = null;
  if (roomId) {
    const [rm] = await db
      .select({ ownerId: rooms.ownerId, namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (rm?.ownerId) transcriptOwnerId = rm.ownerId;
    targetRoomNamespaceId = rm?.namespaceId ?? null;
  }

  // `orphan` rooms have no human members, so the agent RLS role cannot write a
  // `sessions` row scoped to them (`sessions_path_c` requires the writer be a
  // room member). The orphan room is still created + memoized on
  // `tasks.target_room_id` (M143 report-back uses it); the 2a run itself
  // persists its transcript with a NULL session room — the proven subagent
  // path. Room-backed (namespace) targets always include the owner as a
  // member, so they pass RLS and keep their room linkage.
  const sessionRoomId = task.targetChat === "orphan" ? "" : roomId;

  // 2. Resolve the run's Memory envelope through the single Task resolver.
  const laneKey = `task:${task.id}`;
  const { envelope } = await resolveTaskMemoryEnvelope({
    task,
    db,
    resolver,
    laneKey,
    sessionRoomId,
    targetUserIds: awaitTask.targetUserIds,
  });

  // D570 — `ask_peer` may carry an exact Artifact handoff prepared by the
  // shortcut. Re-resolve every external id through the freshly built
  // requester+peer envelope, then attach it to the canonical Agent↔peer DM
  // namespace before the question is persisted. This is what makes the
  // existing Artifact card relation safe and visible to the peer; it never
  // asks the requester to create a Room and never selects a broader common
  // Room. A failure is explicit: access may already have been granted by the
  // shortcut, but no peer contact is attempted from this dispatch.
  const requestedAskPeerArtifactRefs = readArtifactAwareAskPeerRefs(task);
  const askPeerArtifactRefs: ChatArtifactRef[] = [];
  const askPeerFocusedResources: ResolvedFocusedResource[] = [];
  if (requestedAskPeerArtifactRefs.length > 0) {
    if (!targetRoomNamespaceId) {
      throw new Error(
        `shared_but_not_contacted: ask_peer task ${task.id} has no canonical target Room namespace`,
      );
    }
    const readableNamespaceIds = envelopeReadableNamespaces(envelope);
    for (const requested of requestedAskPeerArtifactRefs) {
      const artifact = await findArtifactByIdForNamespaces(
        {
          artifactId: requested.artifactId,
          readableNamespaceIds,
        },
        db,
      );
      if (!artifact) {
        throw new Error(
          `shared_but_not_contacted: Artifact ${requested.artifactId} is not readable in the exact requester-and-peer access namespace`,
        );
      }
      await attachArtifactToNamespace(
        { artifactId: artifact.id, namespaceId: targetRoomNamespaceId },
        db,
      );
      const authoritative: ChatArtifactRef = {
        artifactId: artifact.artifactId,
        path: artifact.path,
        mimeType: artifact.mimeType ?? "application/octet-stream",
        size: typeof artifact.size === "number" ? artifact.size : Number(artifact.size ?? 0),
      };
      askPeerArtifactRefs.push(authoritative);
      askPeerFocusedResources.push({
        kind: "workspace-artifact",
        displayName: artifact.path.split(/[\\/]+/).filter(Boolean).at(-1) ?? artifact.artifactId,
        mimeType: authoritative.mimeType,
        size: authoritative.size,
        location: "server",
        lifetime: "workspace",
        capabilities: ["read"],
        toolTarget: { tool: "file", zone: "workspace", path: artifact.path },
        locator: { artifactId: artifact.artifactId },
      });
    }
  }

  // 3. Model. Two mutually-exclusive modes (D429 Phase 3):
  //   - exact pin (`task.requestedModelId`): a STRICT same-model pin. The
  //     dispatch seam revalidates current credentials/routing/capabilities
  //     (a curated id may have lost its key since create-time) and throws a
  //     stable `[task-model-selection]` error if it is no longer runnable.
  //     Phase 4 will enforce no cross-model fallback off this branch; here we
  //     only resolve + flag it. We do NOT add any arbitrary fallback field.
  //   - otherwise: the M152 multi-axis profile/spec resolver (unchanged).
  const profile = await getProfileByAgentId(task.agentId);
  // The Task resolver validates the inherited model with Task capabilities and
  // current operator routing consent. An exact pin validates its own route.
  let modelId: string;
  let exactModelSelection = false;
  if (securityResearchResume && resumableRun?.modelId) {
    // The continuing graph retains its original model. Delivery-only Resume
    // makes no provider request; ordinary audit Resume revalidates eligibility.
    if (task.requestedModelId && task.requestedModelId !== resumableRun.modelId) {
      throw new Error("SECURITY_RESEARCH_RESUME_MODEL_CHANGED");
    }
    if (!deliveryOnlyResume) assertExactTaskModelSelection({ requestedModelId: resumableRun.modelId,
      toolsMode: task.toolsMode, toolsWhitelist: task.toolsWhitelist });
    modelId = resumableRun.modelId;
    exactModelSelection = true;
  } else if (task.requestedModelId !== null && task.requestedModelId !== undefined) {
    // Revalidate the exact pin at dispatch time. `assertExactTaskModelSelection`
    // throws a stable, prefixed error the observer records verbatim (mirrors
    // the M152 `[task-model-selection]` contract). Curated-id membership,
    // credential/routing/disabled state, and strict tool-capability truth are
    // all checked here without a paid provider call.
    assertExactTaskModelSelection({
      requestedModelId: task.requestedModelId,
      toolsMode: task.toolsMode,
      toolsWhitelist: task.toolsWhitelist,
    });
    modelId = task.requestedModelId;
    exactModelSelection = true;
  } else {
    try {
      // Security research retains the configured model and explicit selection intent.
      const baseModelId = profile?.defaultModel?.trim() || getDefaultModel().id;
      const resolution = resolveTaskModel({
        baseModelId,
        profile: task.selectionProfile,
        spec: task.selectionSpec,
      });
      modelId = resolution.modelId;
    } catch (e) {
      if (e instanceof ModelSelectionError) {
        // A8 runtime guard — surface the clear, actionable message. The observer
        // catches this, marks the task `errored` + `last_error`, and pings back.
        throw new Error(`[task-model-selection] ${e.detail.message}`);
      }
      throw e;
    }
  }

  // 4. Insert the run row + mark the task running.
  const writerReviewVerification = hasWriterReviewAcceptedContinuation(task.metadata);
  const runInput = {
    taskId: task.id,
    graphThreadId,
    status: "running",
    modelId,
  } as const;
  const run = securityResearchResume
    ? await resumeSecurityResearchRun(db, { taskId: task.id, taskRunId: resumableRun.id, ownerId: task.ownerId,
      threadId: graphThreadId, modelId, deliveryOnly: deliveryOnlyResume })
    : writerReviewVerification
    ? await startTaskRunForWriterReviewVerification(db, runInput)
    : await insertTaskRun(db, runInput);
  if (!run) {
    if (securityResearchResume) return { kind: "authorization_paused" };
    throw new Error(`dispatchTaskRun: accepted Writer verification was no longer pending for task ${task.id}`);
  }
  if (!writerReviewVerification && !securityResearchResume) await markTaskRunning(db, task.id);

  // 5. Create the subagent job on its OWN thread + a task-only lane, so no
  // human room lane is held. The executor runs `runScopeSubagentUntilPause`
  // and links the real job id onto the run row when it starts.
  const toolWhitelist = resolveToolWhitelist(task, envelope);
  // Server composition writes this tiny, non-authorizing intent only after it
  // has selected eligible live-app tools. A restart therefore cannot silently
  // degrade such a Task into cloud-only provider work.
  const liveMiniAppTaskDelegation = parseLiveMiniAppTaskDelegationIntent(task.metadata);
  const taskMessage = writerReviewVerification
    ? `${task.prompt}\n\n${WRITER_REVIEW_VERIFICATION_CONTINUATION}`
    : task.preset === "schedule" && task.callingRoomId
      ? `${task.prompt}\n\n[Scheduled Task delivery] Your final answer is returned automatically to the conversation that scheduled this Task. If this is a reminder for the requesting Human, state the reminder in your final answer. Do not use ask_peer merely to deliver it to that same Human; use ask_peer when a separate conversation or reply is actually needed.`
      : task.prompt;
  // D560 — a background Task has no ambient Desktop authority. Resolve the
  // task's creation-time binding immediately before the Job is accepted and
  // carry it only when the exact relay/session/folder is still live. The graph
  // revalidates the same continuation at each host-scoped dispatch; an absent
  // binding is intentionally cloud-only rather than a fallback to another
  // relay or folder.
  const taskReturnBinding = restoredResearchBinding ?? resolveTaskReturnBinding(
    task.id,
    task.ownerId,
    getRelayRegistry() as Parameters<typeof resolveTaskReturnBinding>[2],
  );
  const hasLiveTaskReturnBinding = taskReturnBinding.status === "available";
  const input: Record<string, unknown> = {
    // schema-recognized job fields (survive the coalescer directly):
    message: taskMessage,
    ownerId: task.ownerId,
    requestorId: task.requestorId,
    agentId: task.agentId,
    roomId: sessionRoomId,
    callingRoomId: task.callingRoomId ?? "",
    // Durable task identity for nested `task create` lineage. This is the
    // Task row id, not a lane/thread/Room-derived approximation.
    currentTaskId: task.id,
    // M151 — transcript session owner (room member); see computation above.
    transcriptOwnerId,
    graphThreadId,
    turnId: run.id,
    actorRole: "owner",
    memoryAccessEnvelope: envelope,
    roomRoster: [],
    // passthrough fields the task executor reads:
    taskId: task.id,
    taskRunId: run.id,
    // The verification requirement is a server-authored job fact. It never
    // exposes receipt identity and cannot be supplied by a model tool call.
    ...(writerReviewVerification ? { writerReviewVerification: true } : {}),
    scheduleKind: task.scheduleKind,
    // D363 — preset + metadata so the executor can branch to the repo-docs
    // wrapper (preset "repo_docs") and read its target/mode/publish from metadata.
    preset: task.preset,
    resultDelivery: task.resultDelivery,
    metadata: task.metadata,
    ...(askPeerArtifactRefs.length > 0
      ? {
          artifactRefs: askPeerArtifactRefs,
          focusedResources: askPeerFocusedResources,
          assistantArtifactExternalIds: askPeerArtifactRefs.map((artifact) => artifact.artifactId),
        }
      : {}),
    parentThreadId: task.callingRoomId ? `room:${task.callingRoomId}` : `task:${task.id}`,
    modelId,
    // D429 Phase 3 — explicit job-input flag identifying an exact-model
    // selection so Phase 4 can enforce no cross-model fallback off this run
    // WITHOUT inferring exactness by comparing modelId to profile defaults.
    exactModelSelection,
    assistantName: profile?.name ?? "Genie",
    soulFile: profile?.soulFile ?? "",
    ...(hasLiveTaskReturnBinding
      ? {
          currentFolder: taskReturnBinding.currentFolder,
          workspacePath: taskReturnBinding.workspacePath,
          taskReportBackContinuation: taskReturnBinding,
        }
      : {}),
    ...(task.expectedOutput ? { expectedOutput: task.expectedOutput } : {}),
    ...(toolWhitelist !== undefined ? { toolWhitelist } : {}),
    ...(liveMiniAppTaskDelegation
      ? {
          liveMiniAppAppId: liveMiniAppTaskDelegation.appId,
          requiresLiveMiniApp: true,
        }
      : {}),
    subagentDepth: task.depth + 1,
    subagentMaxDepth: 5,
    // M147 (R4) — tell the executor to continue the preserved checkpoint on
    // the reused `graphThreadId` instead of cold-starting the brief.
    ...(isResume ? { resumeFromCheckpoint: true } : {}),
    ...(deliveryOnlyResume ? { securityReportDeliveryOnly: true } : {}),
    // M151 (Task Phase 7a) — await-response context. The executor forwards
    // these into `runScopeSubagentUntilPause`; the `await_reply` graph node
    // parks on `await_human_reply` after the agent's final message.
    awaitResponse: task.awaitResponse,
    awaitRoomId: roomId,
    awaitFromUserIds,
    awaitTaskId: task.id,
    awaitTaskRunId: run.id,
    awaitOwnerId: task.ownerId,
  };

  // Route selection happens only after the durable TaskRun exists. It is a
  // per-accepted-turn choice (never graph-thread state), so distinct Tasks
  // targeting one Room cannot replace each other's executor or queue policy.
  let executionRoute: ForegroundExecutionRoute | undefined;
  try {
    executionRoute = await deps.executionRouteSelector?.(
      Object.freeze({
        taskId: task.id,
        taskRunId: run.id,
        parentTaskId: task.parentTaskId,
        ownerId: task.ownerId,
        requestorId: task.requestorId,
        agentId: task.agentId,
        roomId,
        laneKey,
        graphThreadId,
      }),
    );
    if (securityResearchResume && executionRoute?.modelAttribution === "external") {
      throw new Error("SECURITY_RESEARCH_RESUME_REQUIRES_NATIVE_EXECUTION");
    }
  } catch (error) {
    // The TaskRun is now durable, so do not leave it indefinitely `running`
    // when an optional server route cannot be selected. TaskObserver retains
    // the existing task-level error handling after this error is rethrown.
    const message = error instanceof Error ? error.message : String(error);
    await markTaskRunStatus(db, run.id, "errored", {
      lastError: message,
      completedAt: new Date(),
    }).catch(() => {});
    throw error;
  }

  // A provider harness owns its model namespace. Do not leave the native
  // dispatch model on the TaskRun: that would falsely attribute external work
  // to the Genie's model and collapse two deliberately separate catalogs.
  if (executionRoute?.modelAttribution === "external") {
    await markTaskRunStatus(db, run.id, "running", { modelId: null });
    input["modelId"] = null;
  }

  // Preserve the native call shape and executor when no external route is
  // selected. A selected route supplies its own executor and immutable
  // coalescing/contention policy to JobManager.
  const created = executionRoute
    ? await jobManager.createForegroundJob(
        task.ownerId,
        task.requestorId,
        laneKey,
        input,
        executionRoute.executor,
        acceptanceAuthority,
        executionRoute,
        invocationAuthority,
      )
    : await jobManager.createForegroundJob(
        task.ownerId,
        task.requestorId,
        laneKey,
        input,
        taskRunExecutor,
        acceptanceAuthority,
        undefined,
        invocationAuthority,
      );
  if (created.acceptanceAuthority && created.invocationAcceptanceAuthority) {
    registerTaskRunAcceptance(
      run.id,
      created.acceptanceAuthority,
      created.invocationAcceptanceAuthority,
    );
  }

  log(
    `[task-dispatch] task=${task.id} run=${run.id} thread=${graphThreadId} lane=${laneKey} job=${created.id}`,
  );

  // M143 — owner-scoped lifecycle signal that a run has fired.
  eventBus.emit({
    type: "task.fired",
    taskId: task.id,
    taskRunId: run.id,
    laneKey,
    ownerId: task.ownerId,
  });

  return {
    kind: "dispatched",
    jobId: created.id,
    runId: run.id,
    graphThreadId,
    roomId,
  };
}
