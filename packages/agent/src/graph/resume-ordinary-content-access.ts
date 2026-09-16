import type { BaseCheckpointSaver, StateSnapshot } from "@langchain/langgraph";
import { getPolicyResolver } from "@nautilo/trust";
import { runWithTurn } from "@nautilo/logger";
import { createNautiloGraph, type NautiloGraphDeps } from "../agent/graph";
import type { NautiloState } from "../agent/state";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import {
  matchesOrdinaryContentAccessBinding,
  OrdinaryContentAccessRetryRequiredError,
  type OrdinaryContentAccessForState,
} from "../runtime/ordinary-content-access";
import { emitChainedInterrupts, type StreamEventProcessor } from "./resume-approval";
import { resolveGraphExecutionPolicy } from "./execution-policy";

/** Server-resolved coordinates, never a client-selected checkpoint address. */
export interface OrdinaryContentAccessRecoveryScope {
  readonly originalJobId: string;
  readonly graphThreadId: string;
  readonly laneKey: string;
  readonly roomId: string;
  readonly humanUserId: string;
  readonly humanActorId: string;
  readonly agentId: string;
  /** Proven by the existing durable Job or TaskRun owner, never client input. */
  readonly executionOwner?:
    | { readonly kind: "fork"; readonly parentThreadId: string; readonly transcriptThreadId: string }
    | { readonly kind: "task"; readonly taskId: string; readonly taskRunId: string };
}

/** Content-free locator. Tokens, commands and object identifiers stay in the saver. */
export interface OrdinaryContentAccessRecoveryCoordinate extends OrdinaryContentAccessRecoveryScope {
  readonly checkpointId: string;
  readonly turnId: string;
  readonly toolCallId: string;
}

export type OrdinaryContentAccessRecoveryDeps = NautiloGraphDeps & {
  readonly ordinaryContentAccessForState: OrdinaryContentAccessForState;
  /** Existing saver seam for hermetic tests; production uses the canonical saver. */
  readonly checkpointSaver?: BaseCheckpointSaver;
};

export class OrdinaryContentAccessRecoveryUnavailableError extends Error {
  constructor() {
    super("The exact failed content access checkpoint is no longer recoverable.");
    this.name = "OrdinaryContentAccessRecoveryUnavailableError";
  }
}

/** @internal Pure inspection of the latest snapshot, not authorization by itself. */
function inspectOrdinaryContentAccessRecoveryCheckpoint(
  scope: OrdinaryContentAccessRecoveryScope,
  checkpoint: StateSnapshot | undefined,
): OrdinaryContentAccessRecoveryCoordinate | null {
  if (!checkpoint?.config || !checkpoint.tasks || !checkpoint.next) return null;
  const state = checkpoint.values as NautiloState;
  const checkpointId: unknown = checkpoint.config.configurable?.["checkpoint_id"];
  const task = checkpoint.tasks[0];
  const error = task?.error as { name?: unknown; message?: unknown } | undefined;
  const expectedError = new OrdinaryContentAccessRetryRequiredError();
  const call = state.approvedToolCalls?.[0];
  const owner = scope.executionOwner;
  const taskOwned = owner?.kind === "task";
  const ownerMatches = taskOwned
    ? Boolean(owner.taskId && owner.taskRunId)
      && state.currentTaskId === owner.taskId && state.currentTaskRunId === owner.taskRunId
      && state.taskRun === true && state.turnId === owner.taskRunId
    : !state.currentTaskId && !state.currentTaskRunId && !(state.subagentDepth > 0)
      && state.causalHumanUserId === scope.humanUserId
      && (owner?.kind === "fork"
        ? Boolean(owner.parentThreadId && owner.transcriptThreadId)
          && state.trustedExecutionEntrypoint === "foreground.fork"
          && state.currentThreadId === owner.transcriptThreadId
        : state.trustedExecutionEntrypoint !== "foreground.fork");
  if (Object.values(scope).some((value) => !value)
    || typeof checkpointId !== "string" || !checkpointId
    || checkpoint.next.length !== 1 || checkpoint.next[0] !== "tools"
    || checkpoint.tasks.length !== 1 || task?.name !== "tools"
    || (task.interrupts?.length ?? 0) !== 0
    || error?.name !== expectedError.name || error.message !== expectedError.message
    || !ownerMatches
    || state.langgraphThreadId !== scope.graphThreadId
    || state.approvalLaneKey !== scope.laneKey || state.roomId !== scope.roomId
    || state.userId !== scope.humanUserId
    || state.agentId !== scope.agentId || !state.turnId
    || state.memoryAccessEnvelope?.actorId !== scope.humanActorId
    || state.memoryAccessEnvelope.ownerId !== scope.humanUserId
    || !call?.id || !matchesOrdinaryContentAccessBinding(state, call, state.ordinaryContentAccessBindings?.[call.id])) return null;
  return { ...scope, checkpointId, turnId: state.turnId, toolCallId: call.id };
}

function graphForRecovery(deps: OrdinaryContentAccessRecoveryDeps) {
  return createNautiloGraph(deps.checkpointSaver ?? createCheckpointSaver(), getPolicyResolver(), deps);
}

export async function readOrdinaryContentAccessRecovery(
  scope: OrdinaryContentAccessRecoveryScope,
  deps: OrdinaryContentAccessRecoveryDeps,
): Promise<OrdinaryContentAccessRecoveryCoordinate | null> {
  const graph = graphForRecovery(deps);
  const checkpoint = await graph.getState({ configurable: { thread_id: scope.graphThreadId } }) as StateSnapshot | undefined;
  const coordinate = inspectOrdinaryContentAccessRecoveryCheckpoint(scope, checkpoint);
  if (coordinate === null || checkpoint === undefined) return null;
  const selected = await deps.ordinaryContentAccessForState(checkpoint.values as NautiloState);
  return selected.mode === "plaintext_only" && selected.port !== undefined ? coordinate : null;
}

/** Caller holds the canonical graph-thread lock throughout this continuation. */
export async function resumeOrdinaryContentAccessRecovery(
  expected: OrdinaryContentAccessRecoveryCoordinate,
  deps: OrdinaryContentAccessRecoveryDeps,
  processor: StreamEventProcessor,
  signal?: AbortSignal,
): Promise<void> {
  const graph = graphForRecovery(deps);
  const config = { configurable: { thread_id: expected.graphThreadId } };
  const checkpoint = await graph.getState(config) as StateSnapshot | undefined;
  const actual = inspectOrdinaryContentAccessRecoveryCheckpoint(expected, checkpoint);
  const selection = actual === null || checkpoint === undefined ? null : await deps.ordinaryContentAccessForState(checkpoint.values as NautiloState);
  if (actual === null || actual.checkpointId !== expected.checkpointId
    || actual.turnId !== expected.turnId || actual.toolCallId !== expected.toolCallId
    || selection?.mode !== "plaintext_only" || selection.port === undefined) {
    throw new OrdinaryContentAccessRecoveryUnavailableError();
  }
  signal?.throwIfAborted();
  await runWithTurn(expected.turnId, async () => {
    try {
      await processor.beginResume?.(expected.graphThreadId, expected.turnId);
      signal?.throwIfAborted();
      for await (const event of graph.streamEvents(null, {
        ...config, version: "v2", recursionLimit: resolveGraphExecutionPolicy().recursionLimit,
        ...(signal === undefined ? {} : { signal }),
      })) {
        signal?.throwIfAborted();
        await processor.process(event);
      }
      signal?.throwIfAborted();
      await emitChainedInterrupts(graph, expected.graphThreadId, expected.laneKey, processor, "ordinary-content-access-recovery");
    } catch (error) {
      await processor.failResume?.();
      throw error;
    } finally { processor.flush(); }
  });
}
