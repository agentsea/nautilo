import {
  createCheckpointSaver,
  EncryptedCheckpointSaver,
  type PostgresSaver,
} from "@nautilo/agent";
import type { BaseMessage } from "@langchain/core/messages";

import type {
  ActiveConversationRepository,
  ProtectedAgentMessageWritePreparer,
} from "./active-conversation-repository";
import type {
  ForegroundAuthorizationView,
} from "../protected-execution/foreground-authorization-session";
import type { RoomHistoryHit } from "../conductor/history-search";
import type { ProtectedMessageDtoV2 } from "@nautilo/types";
import type { RoomJournalContext } from "../context/build-transcript-context";

/**
 * Invocation-scoped services passed into an active conversation executor.
 *
 * The base bag keeps legacy composition on its existing repository seam.
 * Protected composition extends it with every authority-bearing dependency so
 * executors never reach process-global protected state.
 */
export interface ConversationExecutionServices {
  readonly repository: ActiveConversationRepository;
}

/**
 * Protected foreground execution additionally requires an authorized
 * preparer/writer. Possession of an opened aiRoot alone is deliberately
 * insufficient to satisfy this contract.
 */
export interface ProtectedConversationExecutionServices
  extends ConversationExecutionServices
{
  /** Exact root or child view for this foreground execution only. */
  readonly authorization: ForegroundAuthorizationView;
  /**
   * Invocation-bound saver carrying the same live foreground authorization as
   * the protected repository. Protected execution must never reconstruct the
   * process-global plaintext saver when this service bag is present.
   */
  readonly checkpointSavers: ProtectedConversationCheckpointSaverProvider;
  readonly protectedAgentMessagePreparer: ProtectedAgentMessageWritePreparer;
}

/**
 * Ephemeral data plane supplied only while the repository's foreground
 * transcript authorization callback is live.
 */
export interface ProtectedConversationExecutorTurnScope {
  readonly history: readonly RoomHistoryHit[];
  /** Already-authorized protected Journal only; absence never falls back. */
  readonly journal?: RoomJournalContext;
  readonly persist: (
    messages: readonly BaseMessage[],
  ) => Promise<readonly ProtectedMessageDtoV2[]>;
}

export type ProtectedCheckpointExecutionKind =
  | "foreground.main"
  | "foreground.fork"
  | "subagent.scope"
  | "resume.approval"
  | "resume.approval_ask"
  | "resume.identity";

export type ProtectedCheckpointInvocation = Readonly<{
  readonly logicalThreadId: string;
  readonly kind: ProtectedCheckpointExecutionKind;
  readonly authorization: ForegroundAuthorizationView;
}>;

export interface ProtectedConversationCheckpointSaverProvider {
  createForInvocation(
    invocation: ProtectedCheckpointInvocation,
  ): EncryptedCheckpointSaver;
}

export type ConversationCheckpointSaver =
  | PostgresSaver
  | EncryptedCheckpointSaver;

/**
 * Select the graph saver at the execution boundary.
 *
 * Legacy callers omit the service bag and retain the existing memoized saver.
 * A protected caller must carry the concrete encrypted facade; malformed
 * protected wiring fails closed instead of quietly persisting plaintext.
 */
export function checkpointSaverForConversationExecution(
  services: undefined,
  invocation?: undefined,
  createLegacySaver?: () => PostgresSaver,
): PostgresSaver;
export function checkpointSaverForConversationExecution(
  services: ProtectedConversationExecutionServices,
  invocation: ProtectedCheckpointInvocation,
  createLegacySaver?: () => PostgresSaver,
): EncryptedCheckpointSaver;
export function checkpointSaverForConversationExecution(
  services: ProtectedConversationExecutionServices | undefined,
  invocation?: ProtectedCheckpointInvocation,
  createLegacySaver?: () => PostgresSaver,
): ConversationCheckpointSaver;
export function checkpointSaverForConversationExecution(
  services: ProtectedConversationExecutionServices | undefined,
  invocation?: ProtectedCheckpointInvocation,
  createLegacySaver: () => PostgresSaver = createCheckpointSaver,
): ConversationCheckpointSaver {
  if (services === undefined) return createLegacySaver();
  if (invocation === undefined) {
    throw new TypeError(
      "Protected conversation execution requires a checkpoint invocation",
    );
  }
  const saver = services.checkpointSavers?.createForInvocation(invocation);
  if (!(saver instanceof EncryptedCheckpointSaver)) {
    throw new TypeError(
      "Protected conversation execution requires an encrypted checkpoint saver",
    );
  }
  return saver;
}
