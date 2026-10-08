import { warn } from "@nautilo/logger";
import { findResumedMemoryReviewAdmission, finishMemoryReviewTurn, memoryReviewCompletionState } from "../memory-review/admission";
import type { ServerEvent } from "@nautilo/types";
import { TokenBatcher, ToolCallTracker } from "../utils/token-batcher";
import { processStreamEvent } from "./langgraph-executor";
import { persistMessages } from "./persist-messages";
import { getCurrentLiveShadowTurnContext } from
  "../conversation/live-shadow-turn-context";
import {
  createLiveShadowAgentRuntimeTurn,
  type LiveShadowAgentRuntimeTurn,
} from "../conversation/live-shadow-agent-runtime";
import {
  protectLiveShadowAssistantToken,
  publishLiveShadowRuntimeMessages,
} from "../conversation/live-shadow-agent-runtime-events";
import {
  createForegroundContextRebuilder,
  ForegroundContextReceipts,
} from "./foreground-context-refresh";
import { foregroundRecordContextPortForRoom } from
  "../reflection/foreground-record-context";
import { protectLiveShadowForegroundRecordContext } from
  "../conversation/live-shadow-turn-context";

export interface PersistingProcessorDeps {
  threadId: string;
  ownerId: string;
  agentId?: string;
  roomId?: string;
  /** D426 — canonical child Room id for a resumed Subthread turn. */
  subthreadRoomId?: string;
  laneKey: string;
  eventBus: { emit(event: ServerEvent): void };
  humanTurnId?: string;
  causalHumanUserId?: string;
}

/**
 * M070 — same stream adapter as auth resume sites used inline, plus
 * `messagesToPersist` → `persistMessages` (matches `langgraphExecutor`).
 */
export function createPersistingProcessor(
  deps: PersistingProcessorDeps,
  internal: Readonly<{
    createForegroundContextRebuilder: typeof createForegroundContextRebuilder;
  }> = { createForegroundContextRebuilder },
) {
  const foregroundRefreshEnabled =
    deps.roomId !== undefined
    && deps.agentId !== undefined
    && deps.laneKey.startsWith("room:");
  const foregroundContextReceipts = foregroundRefreshEnabled
    ? new ForegroundContextReceipts(undefined, false)
    : undefined;
  let foregroundExecutionId = foregroundRefreshEnabled
    ? deps.humanTurnId?.trim() || undefined
    : undefined;
  const rebuildForegroundContext = foregroundContextReceipts === undefined
    ? undefined
    : (transition: Parameters<ReturnType<typeof createForegroundContextRebuilder>>[0]) => {
      const recordContextEligible =
        transition.state.trustedExecutionEntrypoint === "foreground.main"
        || transition.state.trustedExecutionEntrypoint === "foreground.fork";
      const ordinaryRecordContext = recordContextEligible
        ? foregroundRecordContextPortForRoom(deps.roomId!)
        : undefined;
      return internal.createForegroundContextRebuilder({
        roomId: deps.roomId!,
        ownerId: deps.ownerId,
        agentId: deps.agentId!,
        receipts: foregroundContextReceipts,
        // A resume processor is created before the protected session enters
        // its AsyncLocalStorage scope. Bind protection at rebuild time so the
        // reader sees the current resume grant and policy instead of retaining
        // the ordinary port selected outside that scope.
        ...(ordinaryRecordContext === undefined
          ? {}
          : {
              recordContext:
                protectLiveShadowForegroundRecordContext(ordinaryRecordContext),
            }),
      })(transition);
    };
  const tokenBatcher = new TokenBatcher({
    laneKey: deps.laneKey,
    ...(deps.agentId ? { authorAgentId: deps.agentId } : {}),
    ...(deps.humanTurnId ? { turnId: deps.humanTurnId } : {}),
  });
  const toolTracker = new ToolCallTracker(deps.agentId || undefined, deps.humanTurnId || undefined);
  const savedFingerprints = new Set<string>();
  let persistenceFailed = false;
  let resumedMemory: Awaited<ReturnType<typeof findResumedMemoryReviewAdmission>>;
  const finishResume = async (state: "pending" | "awaiting" | "completed" | "interrupted") => {
    if (!resumedMemory) return;
    await finishMemoryReviewTurn({ reviewTurnId: resumedMemory.id, threadId: resumedMemory.threadId,
      agentId: resumedMemory.agentId, turnId: resumedMemory.turnId, state });
  };
  let liveShadowRuntime: LiveShadowAgentRuntimeTurn | undefined;
  const liveShadowStreamState = { ordinals: new Map<string, number>() };
  const currentLiveShadowRuntime = (): LiveShadowAgentRuntimeTurn | undefined => {
    if (liveShadowRuntime !== undefined) return liveShadowRuntime;
    const context = getCurrentLiveShadowTurnContext();
    if (context?.session === null || context?.session === undefined) {
      return undefined;
    }
    liveShadowRuntime = createLiveShadowAgentRuntimeTurn(
      context.session,
      context.enforcementPolicy,
      context.observeBoundary,
      context.dataOperationPolicy,
      foregroundExecutionId,
    );
    return liveShadowRuntime;
  };

  const persistOrdinary = (
    messages: Parameters<typeof persistMessages>[2],
    assistantMessageKey?: string,
  ) => persistMessages(deps.threadId, deps.ownerId, messages, savedFingerprints, {
    eventBus: { emit(event) {
      if (event.type === "session.persistence_failed") persistenceFailed = true;
      deps.eventBus.emit(event);
    } },
    ...(resumedMemory ? { memoryReview: {
      ownerId: resumedMemory.ownerId, actorId: resumedMemory.actorId,
      accessScope: resumedMemory.accessScope, checkpointThreadId: resumedMemory.checkpointThreadId,
    } } : {}),
    ...(deps.agentId ? { agentId: deps.agentId } : {}),
    ...((resumedMemory?.roomId ?? deps.roomId) ? { roomId: resumedMemory?.roomId ?? deps.roomId } : {}),
    ...(deps.subthreadRoomId ? { subthreadRoomId: deps.subthreadRoomId } : {}),
    ...((resumedMemory?.turnId ?? deps.humanTurnId) ? { humanTurnId: resumedMemory?.turnId ?? deps.humanTurnId } : {}),
    ...(assistantMessageKey ? { assistantMessageKey } : {}),
    notificationContext: {
      mentionedHumanUserIds: [],
      causalHumanUserId: deps.causalHumanUserId ?? null,
      causalHumanTurnId: deps.causalHumanUserId
        ? deps.humanTurnId ?? null
        : null,
    },
    laneKey: deps.laneKey,
    ...(foregroundContextReceipts === undefined
      ? {}
      : {
          ...(foregroundExecutionId === undefined
            ? {}
            : { foregroundExecutionId }),
          onCommittedRows: (rows: readonly { id: string }[]) =>
            foregroundContextReceipts.recordIds(
              rows.map((row) => Number(row.id)),
            ),
          requireDurable: "foreground-context" as const,
        }),
  });

  return {
    ...(rebuildForegroundContext === undefined
      ? {}
      : { rebuildForegroundContext }),
    async beginResume(checkpointThreadId: string, turnId: string) {
      persistenceFailed = false;
      resumedMemory = undefined;
      if (foregroundRefreshEnabled && foregroundExecutionId === undefined) {
        foregroundExecutionId = turnId.trim() || undefined;
      }
      if (!deps.agentId) return;
      try {
        resumedMemory = await findResumedMemoryReviewAdmission({ checkpointThreadId, turnId,
          threadId: deps.threadId, transcriptOwnerId: deps.ownerId, agentId: deps.agentId });
        await finishResume("pending");
      } catch {
        warn("[memory-review] resume admission unavailable; original reservation remains recoverable");
      }
    },
    async finishResume(checkpoint: unknown) {
      const state = memoryReviewCompletionState(checkpoint);
      await finishResume(persistenceFailed && state === "completed" ? "interrupted" : state);
    },
    async failResume() { await finishResume("interrupted"); },
    liveShadowToolBoundaryForState: () =>
      currentLiveShadowRuntime()?.toolBoundary,
    async process(ev: unknown) {
      const { events, messagesToPersist, assistantMessageKey } = processStreamEvent(ev, tokenBatcher, toolTracker);
      const runtime = currentLiveShadowRuntime();
      const context = getCurrentLiveShadowTurnContext();
      for (const event of events) {
        if (runtime !== undefined && context !== undefined) {
          const protectedStream = await protectLiveShadowAssistantToken({
            runtime,
            operationId: context.operationId,
            laneKey: deps.laneKey,
            state: liveShadowStreamState,
            event,
            messagesToPersist,
            ...(foregroundExecutionId === undefined
              ? {}
              : { foregroundExecutionId }),
          });
          for (const protectedEvent of protectedStream.events) {
            deps.eventBus.emit(protectedEvent);
          }
          if (protectedStream.handled) continue;
        }
        deps.eventBus.emit(event);
      }
      if (messagesToPersist.length > 0) {
        if (runtime !== undefined && context !== undefined) {
          const protectedEvents = await publishLiveShadowRuntimeMessages({
            runtime,
            operationId: context.operationId,
            laneKey: deps.laneKey,
            agentId: deps.agentId ?? "",
            messages: messagesToPersist,
            ...(foregroundExecutionId === undefined
              ? {}
              : { foregroundExecutionId }),
            ...(foregroundContextReceipts === undefined
              ? {}
              : {
                  onCommittedMessageIds:
                    foregroundContextReceipts.recordIds,
                }),
            persistOrdinary: (messages) =>
              persistOrdinary([...messages], assistantMessageKey),
            warn: () => undefined,
          });
          for (const event of protectedEvents) deps.eventBus.emit(event);
        } else {
          await persistOrdinary(messagesToPersist, assistantMessageKey);
        }
      }
    },
    flush() {
      tokenBatcher.completeMessage();
      for (const event of tokenBatcher.drain()) deps.eventBus.emit(event);
    },
    emit(event: ServerEvent) {
      deps.eventBus.emit(event);
    },
  };
}
