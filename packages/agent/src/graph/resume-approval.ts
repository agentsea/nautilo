import { Command } from "@langchain/langgraph";
import type { ServerEvent } from "@nautilo/types";
import { createNautiloGraph, type NautiloGraphDeps } from "../agent/graph";
import { bindProtectedMemoryResumeDeps } from "./protected-memory-resume-deps";
import { defaultPostModelDeps } from "../agent/post-model-deps";
import type { LiveShadowToolBoundary } from "../nodes/tools";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import type { EncryptedCheckpointSaver } from "../checkpoints/encrypted-checkpoint-saver";
import { getPolicyResolver } from "@nautilo/trust";
import { log, warn, runWithTurn } from "@nautilo/logger";
import {
  collectPendingInterruptEvents,
  requirePendingProveItInterrupt,
} from "./interrupt-mapping";
import { readTurnIdFromCheckpoint } from "./turn-id";
import {
  resolveGraphExecutionPolicy,
  GraphExecutionMetrics,
  toGraphBudgetOutcome,
} from "./execution-policy";

export interface StreamEventProcessor {
  process(ev: unknown): void | Promise<void>;
  flush(): void;
  /** Persisting foreground processors reconnect the original durable turn. */
  beginResume?(checkpointThreadId: string, turnId: string): Promise<void>;
  finishResume?(checkpoint: unknown): Promise<void>;
  failResume?(): Promise<void>;
  /**
   * D084 — emit a ServerEvent directly onto the bus without routing
   * through the graph-stream adapter. Used by resume paths to surface
   * a chained interrupt (approval.ask / prove_it.challenge) that was
   * raised on the very next step after the resume — the graph's
   * stream ends before it gets a chance to flow through `process()`.
   *
   * Optional: existing callers without the method are unaffected; the
   * resume paths guard with a typeof check so a missing `emit` is a
   * no-op (chained interrupt simply isn't surfaced — matches legacy
   * behavior for callers that haven't been updated).
   */
  emit?(event: ServerEvent): void;
}

/**
 * Resume an interrupted graph after a prove_it approval or denial.
 * The graph was paused by interrupt() inside the post_model node.
 *
 * Unlike resumeGraphWithIdentity, this uses a `processEvent` callback
 * for each stream event so the caller can pipe them to the event bus
 * and forward to connected clients in real time.
 *
 * M042B: `threadId` is the opaque LangGraph saver key (`graphThreadId`,
 * = `"app:default"` for the seeded default room). The caller owns the
 * lane-key routing separately — see `/api/auth/prove-and-resume`.
 */
export async function resumeGraphWithApproval(
  threadId: string,
  approved: boolean,
  processEvent: StreamEventProcessor,
  laneKey?: string,
  invocationCheckpointSaver?: EncryptedCheckpointSaver,
  signal?: AbortSignal,
  liveShadowToolBoundaryForState?: () => LiveShadowToolBoundary | undefined,
  invocationMemoryDeps?: NautiloGraphDeps,
  expectedChallengeId?: string,
): Promise<void> {
  const checkpointSaver =
    invocationCheckpointSaver ?? createCheckpointSaver();
  const policyResolver = getPolicyResolver();
  // Stack 208 P0 — one shared graph execution policy seam (recursion ceiling
  // resolved here, threaded into `resumeConfig` below). Metrics counts
  // supersteps / model invocations / tool calls from the existing
  // `streamEvents` hook; logged at stream end / on error (telemetry-only).
  const executionPolicy = resolveGraphExecutionPolicy();
  const metrics = new GraphExecutionMetrics();
  const memoryResume = invocationMemoryDeps === undefined ? undefined
    : bindProtectedMemoryResumeDeps({ ...defaultPostModelDeps, ...invocationMemoryDeps,
      ...(liveShadowToolBoundaryForState === undefined ? {} : { liveShadowToolBoundaryForState }) });
  const graph = createNautiloGraph(
    checkpointSaver,
    policyResolver,
    memoryResume?.deps ?? (liveShadowToolBoundaryForState === undefined
      ? defaultPostModelDeps
      : { ...defaultPostModelDeps, liveShadowToolBoundaryForState }),
  );
  // D082 PR B — re-bind the original turnId from checkpoint state
  // before streaming. A continuous grep across server.log by this
  // id reconstructs the full flow: chat entry → post_model
  // interrupt → /api/auth/prove-and-resume → resume here → tool.
  const turnId = await readTurnIdFromCheckpoint(graph, threadId);

  const resumeConfig = {
    configurable: { thread_id: threadId },
    version: "v2" as const,
    recursionLimit: executionPolicy.recursionLimit,
    ...(signal ? { signal } : {}),
  };

  // Bind the browser-visible challenge to the exact currently parked
  // LangGraph interrupt before entering the durable resume lifecycle.
  const preResumeCheckpoint = expectedChallengeId === undefined
    ? undefined
    : await graph.getState({ configurable: { thread_id: threadId } });
  if (expectedChallengeId !== undefined) {
    requirePendingProveItInterrupt(
      preResumeCheckpoint as { tasks?: Array<Record<string, unknown>> } | undefined,
      expectedChallengeId,
    );
  }

  await runWithTurn(turnId, async () => {
    log(`[agent/resume-approval] Resuming thread ${threadId} with approved=${approved}`);

    try {
      await processEvent.beginResume?.(threadId, turnId);
      // Preparation belongs to this attempt: a failed fresh-custody restore
      // must interrupt its durable admission, not leave the old approval live.
      if (memoryResume !== undefined) {
        const checkpoint = preResumeCheckpoint ?? await graph.getState({
          configurable: { thread_id: threadId },
        });
        if (approved) await memoryResume.restoreCheckpoint(checkpoint);
        else memoryResume.bindCheckpoint(checkpoint);
      }
      const resumePayload = { approved };
      let resume: typeof resumePayload | Record<string, typeof resumePayload> = resumePayload;
      if (expectedChallengeId !== undefined) {
        // Re-read immediately before stream so a replaced/restarted checkpoint
        // cannot consume a decision prepared for its predecessor.
        const currentCheckpoint = await graph.getState({
          configurable: { thread_id: threadId },
        });
        const pending = requirePendingProveItInterrupt(
          currentCheckpoint as { tasks?: Array<Record<string, unknown>> } | undefined,
          expectedChallengeId,
        );
        resume = { [pending.id!]: resumePayload };
      }
      for await (const ev of graph.streamEvents(
        new Command({ resume }),
        resumeConfig,
      )) {
        metrics.noteStreamEvent(ev);
        await Promise.resolve(processEvent.process(ev));
      }

      // D084 — scan for a chained interrupt raised on the very next
      // step (a second prove_it_challenge, a follow-up approval_ask,
      // etc.). Without this, a continuous multi-step destructive-tool
      // task stalls silently after the first approval.
      await emitChainedInterrupts(graph, threadId, laneKey, processEvent, "resume-approval");

      processEvent.flush();
      log(`[agent/resume-approval] Thread ${threadId} resume complete ${metrics.formatLogToken()}`);
    } catch (error) {
      await processEvent.failResume?.();
      processEvent.flush();
      // Stack 208 P0 — surface the typed internal graph-budget outcome distinctly
      // in telemetry (R9). The user-safe sentence is produced by
      // `toFriendlyError` at the runtime job-loop catch site.
      const budgetOutcome = toGraphBudgetOutcome(error, executionPolicy.recursionLimit);
      if (budgetOutcome) {
        warn(
          `[agent/resume-approval] Graph budget exceeded thread=${threadId} ` +
            `outcome=${budgetOutcome.kind} recursionLimit=${budgetOutcome.recursionLimit} ${metrics.formatLogToken()}`,
        );
      } else {
        warn(
          `[agent/resume-approval] Resume failed: ${error instanceof Error ? error.message : String(error)} ${metrics.formatLogToken()}`,
        );
      }
      throw error;
    }
  });
}

/**
 * Narrow surface area the chained-interrupt scan actually uses.
 * Accepts the real LangGraph `CompiledGraph` at runtime, plus any
 * test stub that implements `.getState()` — lets unit tests inject
 * a synthetic post-resume state without faking the rest of the
 * graph API surface.
 */
export interface GraphLikeForInterruptScan {
  getState(
    config: { configurable: { thread_id: string } },
  ): Promise<unknown>;
}

/**
 * Shared D084 helper — surface chained interrupts after a resume
 * stream drains. Safe to call with an undefined `emit` (older caller
 * or pre-D084 processor): degrades gracefully to a no-op + warn.
 */
export async function emitChainedInterrupts(
  graph: GraphLikeForInterruptScan,
  threadId: string,
  laneKey: string | undefined,
  processEvent: StreamEventProcessor,
  logTag: string,
): Promise<void> {
  let postState: { tasks?: Array<Record<string, unknown>> } | undefined;
  try {
    postState = (await graph.getState({
      configurable: { thread_id: threadId },
    })) as { tasks?: Array<Record<string, unknown>> } | undefined;

    const events = collectPendingInterruptEvents(
      postState,
      threadId,
      laneKey ?? "app:default",
    );

    if (events.length > 0 && typeof processEvent.emit !== "function") {
      warn(`[agent/${logTag}] ${events.length} chained interrupt(s) detected but processor has no emit() — dropping. Update the caller to pass a D084-aware StreamEventProcessor.`);
    } else {
      for (const event of events) {
        log(`[agent/${logTag}] Chained ${event.type} interrupt detected`);
        processEvent.emit?.(event);
      }
    }
  } catch (err) {
    postState = undefined;
    warn(
      `[agent/${logTag}] Chained interrupt scan failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await processEvent.finishResume?.(postState);
}
