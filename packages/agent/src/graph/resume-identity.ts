import { Command } from "@langchain/langgraph";
import { createNautiloGraph, type NautiloGraphDeps } from "../agent/graph";
import { defaultPostModelDeps } from "../agent/post-model-deps";
import {
  bindProtectedMemoryResumeDeps,
  identityEnrollmentToolCallIds,
} from "./protected-memory-resume-deps";
import type { LiveShadowToolBoundary } from "../nodes/tools";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import type { EncryptedCheckpointSaver } from "../checkpoints/encrypted-checkpoint-saver";
import {
  getPolicyResolver,
  findRoomIdByGraphThreadIdForUser,
  type MemoryAccessEnvelope,
  type RuntimePolicyContext,
} from "@nautilo/trust";
import { log, warn, runWithTurn } from "@nautilo/logger";
import { emitChainedInterrupts, type StreamEventProcessor } from "./resume-approval";
import { readTurnIdFromCheckpoint } from "./turn-id";

/**
 * Resume an interrupted graph after successful identity verification.
 * The graph was paused by interrupt() inside the verify_identity tool.
 *
 * Resolves a fresh owner envelope and passes it with the resume command
 * so the tail of the interrupted turn immediately operates with owner
 * access rather than the stale guest envelope from the checkpoint.
 *
 * When a processEvent callback is provided, stream events are forwarded
 * to the event bus so connected clients see the
 * assistant's response in real time.
 *
 * M042B: `threadId` is the opaque LangGraph saver key (`graphThreadId`).
 * M075: caller identity comes from `policyContext` — never from
 * `NAUTILO_OWNER_*` env vars.
 *
 * D084 — after the resume stream drains, scans for a chained interrupt
 * raised on the very next step (e.g. the user PIN-verifies at cold
 * start, the first assistant turn reaches a destructive tool, graph
 * re-interrupts with `approval_ask`). Without this, the follow-up
 * dock never surfaces and the session silently stalls. Mirror of the
 * scan in `resume-approval.ts` / `resume-approval-ask.ts`.
 */
export async function resumeGraphWithIdentity(
  threadId: string,
  policyContext: RuntimePolicyContext,
  agentId: string,
  processEvent?: StreamEventProcessor,
  laneKey?: string,
  channel: string = "workbench",
  invocationCheckpointSaver?: EncryptedCheckpointSaver,
  signal?: AbortSignal,
  liveShadowToolBoundaryForState?: () => LiveShadowToolBoundary | undefined,
  invocationMemoryDeps?: NautiloGraphDeps,
): Promise<void> {
  // M125 Phase 2.8: agentId is required. Pre-M125 the optional + `??
  // getBootstrapDefaultAgentId()` fallback meant any caller that
  // didn't thread an explicit agentId (rare for healthy bearer flows,
  // expected for half-bound users) silently resumed the turn into the
  // operator's agent partition.
  if (!agentId) {
    throw new Error(
      "resumeGraphWithIdentity: agentId is required (M125 Phase 2.8)",
    );
  }
  const effectiveAgentId = agentId;

  const checkpointSaver =
    invocationCheckpointSaver ?? createCheckpointSaver();
  const policyResolver = getPolicyResolver();
  const memoryResume = invocationMemoryDeps === undefined ? undefined
    : bindProtectedMemoryResumeDeps({
        ...defaultPostModelDeps,
        ...invocationMemoryDeps,
        ...(liveShadowToolBoundaryForState === undefined
          ? {}
          : { liveShadowToolBoundaryForState }),
      });
  const graph = createNautiloGraph(
    checkpointSaver,
    policyResolver,
    memoryResume?.deps ?? (liveShadowToolBoundaryForState === undefined
      ? defaultPostModelDeps
      : { ...defaultPostModelDeps, liveShadowToolBoundaryForState }),
  );

  const ownerActorId = policyContext.actorId;
  const ownerUserId = policyContext.memoryAccess.ownerId;

  let memoryAccessEnvelope: MemoryAccessEnvelope | undefined;
  if (policyResolver && ownerActorId && ownerUserId) {
    const federatedId = policyContext.actorFederatedId;
    let requestedRoomId: string | undefined;
    const rid = await findRoomIdByGraphThreadIdForUser(ownerUserId, threadId);
    if (rid) requestedRoomId = rid;
    const ctx = await policyResolver.resolveContext(
      channel,
      federatedId,
      effectiveAgentId,
      requestedRoomId,
    );
    memoryAccessEnvelope = ctx.memoryAccess;
    log(`[agent/resume] Resolved envelope for user ${ownerUserId} actor ${ownerActorId}`);
  }

  const turnId = await readTurnIdFromCheckpoint(graph, threadId);

  const resumeConfig = {
    configurable: { thread_id: threadId },
    version: "v2" as const,
    ...(signal ? { signal } : {}),
  };

  await runWithTurn(turnId, async () => {
    log(`[agent/resume] Resuming thread ${threadId} with verified identity`);

    try {
      await processEvent?.beginResume?.(threadId, turnId);
      const checkpoint = await graph.getState({
        configurable: { thread_id: threadId },
      });
      const enrollmentToolCallIds = identityEnrollmentToolCallIds(checkpoint);
      if (memoryResume !== undefined) {
        await memoryResume.restoreIdentityCheckpoint(checkpoint);
      }
      for await (const ev of graph.streamEvents(
        new Command({
          resume: { verified: true, memoryAccessEnvelope },
          ...(enrollmentToolCallIds.length === 0 ? {} : {
            update: { identityEnrollmentToolCallIds: enrollmentToolCallIds },
          }),
        }),
        resumeConfig,
      )) {
        if (processEvent) {
          await Promise.resolve(processEvent.process(ev));
        }
      }

      if (processEvent) {
        await emitChainedInterrupts(
          graph,
          threadId,
          laneKey,
          processEvent,
          "resume-identity",
        );
      }

      processEvent?.flush();
      log(`[agent/resume] Thread ${threadId} resume complete`);
    } catch (error) {
      await processEvent?.failResume?.();
      processEvent?.flush();
      warn(
        `[agent/resume] Resume failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  });
}
