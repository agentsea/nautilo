import {
  createDedicatedEncryptedCheckpointPool,
  createEncryptedCheckpointSaver,
  readPendingInterruptEventsForThread,
  type EncryptedCheckpointSaver,
} from "@nautilo/agent";
import type { LiveShadowAgentTurnSession } from
  "@nautilo/lattice-bridge/server";
import type { StrictShadowEnforcementPolicy } from
  "@nautilo/lattice-bridge";
import { disposeProtectedCheckpointSaver } from
  "./protected-checkpoint-saver-disposal";

/**
 * Fallback Shadow deliberately retains the established ordinary LangGraph
 * checkpoint. Its contract permits ordinary bytes when protected processing
 * is unavailable, so making graph liveness depend on checkpoint crypto would
 * turn Fallback into an accidental Strict mode. Strict Shadow and Full require
 * every model/tool/resume checkpoint cell to use the protected saver.
 */
export function requiresEncryptedForegroundCheckpoint(
  policy: StrictShadowEnforcementPolicy | undefined,
): boolean {
  return policy?.mode === "encrypted_only"
    || (policy?.mode === "shadow_encryption"
      && policy.shadowBehavior === "strict");
}

/**
 * Bind the existing encrypted LangGraph facade to one live Shadow session.
 * The caller owns the returned saver and must dispose it after the graph.
 */
export function createLiveShadowCheckpointSaver(input: Readonly<{
  logicalThreadId: string;
  checkpoint: NonNullable<LiveShadowAgentTurnSession["checkpoint"]>;
}>): EncryptedCheckpointSaver {
  return createEncryptedCheckpointSaver({
    dedicatedPool: createDedicatedEncryptedCheckpointPool(),
    crypto: input.checkpoint.crypto,
    scope: {
      logicalThreadId: input.logicalThreadId,
      namespaceId: input.checkpoint.namespaceId,
      keyClass: "ai",
      expectedAccessRevision:
        input.checkpoint.namespaceAccessRevision,
      expectedPolicyRevision:
        input.checkpoint.agentAuthorizationRevision,
      authorizationSession: input.checkpoint.authorizationSession,
    },
  });
}

/**
 * Resume one parked live-Shadow graph under a newly accepted foreground
 * authorization. Unlike a fresh turn, this deliberately preserves the
 * encrypted thread so LangGraph can reopen the pending interrupt.
 */
export async function withLiveShadowCheckpointSaver<Value>(input: Readonly<{
  logicalThreadId: string;
  session: LiveShadowAgentTurnSession;
  work(saver: EncryptedCheckpointSaver): Promise<Value>;
}>): Promise<Value> {
  if (input.session.checkpoint === undefined) {
    throw new Error(
      "Live Shadow resume requires encrypted checkpoint authority",
    );
  }
  const saver = createLiveShadowCheckpointSaver({
    logicalThreadId: input.logicalThreadId,
    checkpoint: input.session.checkpoint,
  });
  let primaryErrorPresent = false;
  try {
    return await input.work(saver);
  } catch (error) {
    primaryErrorPresent = true;
    throw error;
  } finally {
    await disposeProtectedCheckpointSaver({ saver, primaryErrorPresent });
  }
}

/** Read the canonical interrupt without resuming or reserving graph execution. */
export async function readProtectedPendingInterruptEvents(input: Readonly<{
  logicalThreadId: string;
  laneKey: string;
  checkpoint: NonNullable<LiveShadowAgentTurnSession["checkpoint"]>;
}>) {
  const saver = createLiveShadowCheckpointSaver(input);
  let primaryErrorPresent = false;
  try {
    return await readPendingInterruptEventsForThread(
      input.logicalThreadId,
      input.laneKey,
      saver,
    );
  } catch (error) {
    primaryErrorPresent = true;
    throw error;
  } finally {
    await disposeProtectedCheckpointSaver({ saver, primaryErrorPresent });
  }
}
