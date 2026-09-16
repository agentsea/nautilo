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
export function createPersistingProcessor(deps: PersistingProcessorDeps) {
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
  });

  return {
    async beginResume(checkpointThreadId: string, turnId: string) {
      persistenceFailed = false;
      resumedMemory = undefined;
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
