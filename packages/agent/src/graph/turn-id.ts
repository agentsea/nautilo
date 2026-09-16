import { randomUUID } from "node:crypto";
import { getPolicyResolver } from "@nautilo/trust";
import { createNautiloGraph } from "../agent/graph";
import { createCheckpointSaver } from "../checkpoints/checkpoint-saver";
import type { EncryptedCheckpointSaver } from "../checkpoints/encrypted-checkpoint-saver";

/**
 * D082 PR B — shared helper for resume paths.
 *
 * The chat route generates a UUID `turnId` and persists it in
 * `NautiloState.turnId` (see `packages/agent/src/agent/state.ts`).
 * Resume handlers (`/api/auth/approval-reply`,
 * `/api/auth/identity-challenge`, `/api/auth/prove-and-resume`)
 * fire on DIFFERENT HTTP requests than the original chat — so the
 * caller's AsyncLocalStorage store doesn't carry forward. We pull
 * the turnId back out of the checkpoint before re-binding it via
 * `runWithTurn(turnId, ...)`.
 *
 * If the checkpoint has no turnId (legacy thread created before
 * this PR, or a resume fired without a prior chat turn), we mint
 * a fresh one so the resume itself is still grep-correlated.
 */
export interface TurnIdReadable {
  getState(
    config: { configurable: { thread_id: string } },
  ): Promise<unknown>;
}

export async function readTurnIdFromCheckpoint(
  graph: TurnIdReadable,
  threadId: string,
): Promise<string> {
  try {
    const state = (await graph.getState({
      configurable: { thread_id: threadId },
    })) as { values?: { turnId?: unknown } } | undefined;
    const raw = state?.values?.turnId;
    if (typeof raw === "string" && raw) return raw;
  } catch {
    // fall through to a fresh id
  }
  return randomUUID();
}

/**
 * D082 PR B — callable from server routes (e.g. auth.ts) that
 * don't otherwise need a graph instance. Internally composes the
 * memoized checkpoint saver + compiled graph and reads `turnId`
 * from the checkpoint, falling back to a fresh uuid on miss.
 *
 * Cost: the saver is memoized; graph compilation is fast
 * (StateGraph.compile builds a routing table). At human-reaction
 * latency (PIN submit, approval tap), the few-millisecond
 * overhead is invisible.
 *
 * Degradation: failures at ANY layer (missing DB_CONNECTION_STRING,
 * saver construction, graph compile, checkpoint lookup) all yield
 * a fresh uuid. This keeps server unit tests that exercise these
 * routes without a real DB working AND gives production a sane
 * fallback if the checkpointer is transiently unavailable — the
 * resume itself will still fail downstream with a clearer error,
 * but observability doesn't cascade-block the handler.
 */
export async function readTurnIdForThread(
  threadId: string,
  invocationCheckpointSaver?: EncryptedCheckpointSaver,
): Promise<string> {
  try {
    const checkpointSaver =
      invocationCheckpointSaver ?? createCheckpointSaver();
    const policyResolver = getPolicyResolver();
    const graph = createNautiloGraph(checkpointSaver, policyResolver);
    return await readTurnIdFromCheckpoint(graph, threadId);
  } catch {
    return randomUUID();
  }
}

/** M233 — read explicit causal Human provenance from a foreground checkpoint. */
export async function readCausalHumanUserIdForThread(
  threadId: string,
  invocationCheckpointSaver?: EncryptedCheckpointSaver,
): Promise<string | null> {
  try {
    const checkpointSaver =
      invocationCheckpointSaver ?? createCheckpointSaver();
    const policyResolver = getPolicyResolver();
    const graph = createNautiloGraph(checkpointSaver, policyResolver);
    return await readCausalHumanUserIdFromCheckpoint(graph, threadId);
  } catch {
    return null;
  }
}

/**
 * Resolve the Agent identity checkpointed on the paused foreground graph.
 *
 * Resume HTTP requests are authenticated as a Human and may carry that
 * Human's default Agent in their memory envelope. In a multi-Agent Room that
 * default is not necessarily the Agent whose graph raised the interrupt. The
 * checkpoint is the canonical speaker identity for the resumed turn.
 */
export async function readAgentIdForThread(
  threadId: string,
  invocationCheckpointSaver?: EncryptedCheckpointSaver,
): Promise<string | null> {
  try {
    const checkpointSaver =
      invocationCheckpointSaver ?? createCheckpointSaver();
    const policyResolver = getPolicyResolver();
    const graph = createNautiloGraph(checkpointSaver, policyResolver);
    return await readAgentIdFromCheckpoint(graph, threadId);
  } catch {
    return null;
  }
}

export async function readAgentIdFromCheckpoint(
  graph: TurnIdReadable,
  threadId: string,
): Promise<string | null> {
  try {
    const state = (await graph.getState({
      configurable: { thread_id: threadId },
    })) as { values?: { agentId?: unknown } } | undefined;
    const raw = state?.values?.agentId;
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

export async function readCausalHumanUserIdFromCheckpoint(
  graph: TurnIdReadable,
  threadId: string,
): Promise<string | null> {
  try {
    const state = (await graph.getState({
      configurable: { thread_id: threadId },
    })) as { values?: { causalHumanUserId?: unknown } } | undefined;
    const raw = state?.values?.causalHumanUserId;
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

export type ConnectedWebActionResumeBinding = Readonly<{
  agentId: string;
  laneKey: string;
}>;

/** Read the exact originating Genie and reply lane from a parked checkpoint. */
export async function readConnectedWebActionResumeBindingFromCheckpoint(
  graph: TurnIdReadable,
  threadId: string,
): Promise<ConnectedWebActionResumeBinding | null> {
  try {
    const state = (await graph.getState({
      configurable: { thread_id: threadId },
    })) as { values?: { agentId?: unknown; approvalLaneKey?: unknown } } | undefined;
    const agentId = state?.values?.agentId;
    const laneKey = state?.values?.approvalLaneKey;
    return typeof agentId === "string" && agentId.trim().length > 0
      && typeof laneKey === "string" && laneKey.trim().length > 0
      ? { agentId, laneKey }
      : null;
  } catch {
    return null;
  }
}

/** Production checkpoint reader for resume routes that must bind one Genie. */
export async function readConnectedWebActionResumeBindingForThread(
  threadId: string,
  invocationCheckpointSaver?: EncryptedCheckpointSaver,
): Promise<ConnectedWebActionResumeBinding | null> {
  try {
    const checkpointSaver = invocationCheckpointSaver ?? createCheckpointSaver();
    const graph = createNautiloGraph(checkpointSaver, getPolicyResolver());
    return await readConnectedWebActionResumeBindingFromCheckpoint(graph, threadId);
  } catch {
    return null;
  }
}
