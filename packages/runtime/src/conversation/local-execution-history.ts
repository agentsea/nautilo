import type { LocalExecutionHistoryPort, LocalExecutionHistoryReference, NautiloState } from "@nautilo/agent";
import { getEncryptionTransitionPolicy, getSharedDirectDb } from "@nautilo/db";
import { findActorByOwnerId, getRoomDetailForMember } from "@nautilo/trust";
import type { MessagePayloadV2 } from "@nautilo/lattice-bridge";
import type { RoomHistoryHit } from "../conductor/history-search";
import { defaultBuildTranscriptContextDeps } from "../context/build-transcript-context-deps";
import { getCurrentLiveShadowTurnContext } from "./live-shadow-turn-context";

interface Scope { readonly agentActorId: string; readonly graphThreadId: string }
interface Policy { readonly mode: string; readonly revision: number }
export interface LocalExecutionHistoryAdmission {
  readonly signal?: AbortSignal;
  readonly conversationId: string;
  readPolicy(): Promise<Policy>;
  readScope(): Promise<Scope | null>;
  readTranscript(policy: Policy): Promise<readonly RoomHistoryHit[]>;
  openProtected?(rows: readonly RoomHistoryHit[]): Promise<readonly Readonly<{ messageId: number; payload: MessagePayloadV2 }>[] | null>;
}

function belongsToRoom(conversationId: string, graphThreadId: string): boolean {
  return conversationId === graphThreadId || [":bot:", ":user:", ":fork:"].some(suffix => conversationId.startsWith(`${graphThreadId}${suffix}`));
}

/** Fresh transcript reads own source provenance; narration and model arguments
 * cannot manufacture a history reference. This port holds no replay authority. */
export function createLocalExecutionHistoryPort(admission: LocalExecutionHistoryAdmission): LocalExecutionHistoryPort {
  const unavailable = () => new Error("LOCAL_EXECUTION_HISTORY_SOURCE_UNAVAILABLE");
  const readReferences = async (executionId: string, expectedPolicy?: Policy) => {
    admission.signal?.throwIfAborted();
    const policy = await admission.readPolicy();
    if (expectedPolicy && (policy.mode !== expectedPolicy.mode || policy.revision !== expectedPolicy.revision)) throw unavailable();
    const scope = await admission.readScope();
    if (!scope || !belongsToRoom(admission.conversationId, scope.graphThreadId)) throw unavailable();
    const rows = (await admission.readTranscript(policy)).filter(row => row.role === "tool" && row.authorActorId === scope.agentActorId);
    const protectedRows = policy.mode === "plaintext_only" ? null : await admission.openProtected?.(rows);
    if (policy.mode !== "plaintext_only" && !protectedRows) throw unavailable();
    const references: LocalExecutionHistoryReference[] = [];
    for (const row of rows) {
      const opened = protectedRows?.filter(value => value.messageId === row.messageId);
      if (opened && (opened.length !== 1 || opened[0]!.payload.role !== "tool")) continue;
      const payload = opened?.[0]?.payload;
      const toolName = protectedRows ? payload?.toolName : row.toolName;
      if (toolName !== "exec_command" && toolName !== "write_stdin") continue;
      try {
        const value = JSON.parse(payload?.content ?? row.snippet) as Record<string, unknown>;
        if (value && value["executionId"] === executionId && value["session_id"] === executionId
          && typeof value["generation"] === "string" && value["generation"].length > 0) {
          references.push({ executionId, generation: value["generation"], sourceMessageId: row.messageId });
        }
      } catch { /* A malformed or projected transcript is not source proof. */ }
    }
    const currentScope = await admission.readScope();
    if (!currentScope || currentScope.agentActorId !== scope.agentActorId || currentScope.graphThreadId !== scope.graphThreadId) throw unavailable();
    const currentPolicy = await admission.readPolicy();
    if (currentPolicy.revision !== policy.revision || currentPolicy.mode !== policy.mode) throw unavailable();
    admission.signal?.throwIfAborted();
    return { references, policy };
  };
  return {
    async withReference(executionId, read) {
      const before = await readReferences(executionId);
      const reference = before.references.at(-1);
      if (!reference || before.references.some(other => other.generation !== reference.generation)) throw unavailable();
      const result = await read(reference);
      const after = await readReferences(executionId, before.policy);
      if (!after.references.some(other => other.sourceMessageId === reference.sourceMessageId && other.generation === reference.generation)) throw unavailable();
      return result;
    },
  };
}

/** Composed only for a current ordinary foreground Room turn. Protected reads
 * borrow the existing Agent crypto session, never a Human UI opener. */
export function foregroundLocalExecutionHistoryPort(state: NautiloState, signal: AbortSignal, admittedHistory: readonly RoomHistoryHit[]): LocalExecutionHistoryPort | undefined {
  const origin = state.verifiedOrdinaryOrigin;
  const humanUserId = state.causalHumanUserId || origin?.userId;
  const conversationId = state.currentThreadId || state.langgraphThreadId;
  if (state.trustedExecutionEntrypoint !== "foreground.main" || state.taskRun || state.subagentRun
    || origin?.kind !== "local_electron" || !humanUserId || origin.userId !== humanUserId
    || !state.roomId || !state.agentId || !conversationId) return undefined;
  const roomId = state.roomId;
  const agentId = state.agentId;
  const crypto = getCurrentLiveShadowTurnContext();
  return createLocalExecutionHistoryPort({ signal, conversationId,
    readPolicy: () => getEncryptionTransitionPolicy(getSharedDirectDb()),
    async readScope() {
      const human = await findActorByOwnerId(humanUserId);
      const room = human ? await getRoomDetailForMember(roomId, human.id) : null;
      const member = room?.members.find(value => value.kind === "agent" && value.agentId === agentId);
      return room && member ? { graphThreadId: room.graphThreadId, agentActorId: member.actorId } : null;
    },
    async readTranscript(policy) {
      // Protected selection uses only coordinates from the already-admitted
      // initial transcript. Fresh verified bytes are opened below, never read
      // from the ordinary SQL body as a protected-history fallback.
      if (policy.mode !== "plaintext_only") return admittedHistory.map(row => ({ ...row, snippet: "" }));
      const reader = defaultBuildTranscriptContextDeps();
      try { return await reader.readRoomTranscript({ kind: "room", roomId, ownerId: humanUserId, agentId }); }
      finally { await reader.close(); }
    },
    async openProtected(rows) {
      const session = crypto?.session;
      if (!crypto || !session?.protectForegroundHistory || session.authorizationSignal?.aborted
        || (session.authorizationDeadlineAt !== undefined && Date.now() >= session.authorizationDeadlineAt)) return null;
      const current = await crypto.dataOperationPolicy?.resolve();
      if (!current || current.revalidationToken !== crypto.enforcementPolicy.revision) return null;
      const result = await session.protectForegroundHistory({ messageIds: rows.map(row => row.messageId), signal });
      await crypto.dataOperationPolicy!.revalidate(current.revalidationToken);
      if (session.authorizationSignal?.aborted || (session.authorizationDeadlineAt !== undefined && Date.now() >= session.authorizationDeadlineAt)) return null;
      return result.status === "verified" ? result.messages : null;
    },
  });
}
