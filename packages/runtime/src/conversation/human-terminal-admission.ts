import { roomGraphThreadFromLaneThread, type NautiloState } from "@nautilo/agent";
import type { HumanTerminalAdmissionPort } from "../../../agent/src/tools/terminal/admission";
import { getEncryptionTransitionPolicy, getSharedDirectDb } from "@nautilo/db";
import { assertCanInvokeAgent, getUserCapabilities, findActorByOwnerId, findRoomIdByGraphThreadIdForUser, getRoomDetailForMember } from "@nautilo/trust";
import { getCurrentLiveShadowTurnContext } from "./live-shadow-turn-context";

interface Policy { readonly mode: string; readonly revision: number }
interface Scope { readonly roomId: string; readonly graphThreadId: string; readonly agentActorId: string }
export interface HumanTerminalSourceAdmission {
  readonly signal: AbortSignal;
  readPolicy(): Promise<Policy>;
  readScope(): Promise<Scope | null>;
  /** Existing protected turn owner validates its policy and live authorization.
   * The tools node separately self-opens the exact assistant tool call. */
  validateProtected(policy: Policy): Promise<void>;
}

/** Admission is checked around each read and input. A post-effect denial never
 * retries the input, and no result bytes are released after that denial. */
export function createHumanTerminalAdmissionPort(source: HumanTerminalSourceAdmission): HumanTerminalAdmissionPort {
  const unavailable = () => new Error("HUMAN_TERMINAL_SOURCE_UNAVAILABLE");
  const inspect = async () => {
    source.signal.throwIfAborted();
    const policy = await source.readPolicy();
    const scope = await source.readScope();
    if (!scope) throw unavailable();
    if (policy.mode !== "plaintext_only") await source.validateProtected(policy);
    const currentScope = await source.readScope();
    if (!currentScope || currentScope.roomId !== scope.roomId || currentScope.graphThreadId !== scope.graphThreadId
      || currentScope.agentActorId !== scope.agentActorId) throw unavailable();
    const currentPolicy = await source.readPolicy();
    if (currentPolicy.mode !== policy.mode || currentPolicy.revision !== policy.revision) throw unavailable();
    source.signal.throwIfAborted();
    return { policy, scope };
  };
  return {
    async withAdmission(work) {
      const before = await inspect();
      const result = await work(source.signal);
      const after = await inspect();
      if (before.policy.mode !== after.policy.mode || before.policy.revision !== after.policy.revision
        || before.scope.roomId !== after.scope.roomId || before.scope.graphThreadId !== after.scope.graphThreadId
        || before.scope.agentActorId !== after.scope.agentActorId) throw unavailable();
      return result;
    },
  };
}

/** This adapter borrows the ordinary foreground Room and live Shadow owners.
 * A Room locator or renderer selection alone cannot create source authority. */
const foregroundOwners = {
  readPolicy: () => getEncryptionTransitionPolicy(getSharedDirectDb()),
  assertCanInvokeAgent, getUserCapabilities, findActorByOwnerId, findRoomIdByGraphThreadIdForUser, getRoomDetailForMember,
  getCurrentLiveShadowTurnContext,
};
export type HumanTerminalForegroundOwners = typeof foregroundOwners;

export function foregroundHumanTerminalAdmissionPort(state: NautiloState, signal: AbortSignal, owners: HumanTerminalForegroundOwners = foregroundOwners): HumanTerminalAdmissionPort | undefined {
  const origin = state.verifiedOrdinaryOrigin;
  const humanUserId = state.causalHumanUserId || origin?.userId;
  const conversationId = state.currentThreadId || state.langgraphThreadId;
  if (state.trustedExecutionEntrypoint !== "foreground.main" || state.taskRun || state.subagentRun
    || origin?.kind !== "local_electron" || !humanUserId || origin.userId !== humanUserId
    || !state.roomId || !state.agentId || !conversationId) return undefined;
  const roomId = state.roomId;
  const agentId = state.agentId;
  const crypto = owners.getCurrentLiveShadowTurnContext();
  const authorizationSignal = crypto?.session?.authorizationSignal;
  return createHumanTerminalAdmissionPort({
    signal: authorizationSignal ? AbortSignal.any([signal, authorizationSignal]) : signal,
    readPolicy: owners.readPolicy,
    async readScope() {
      await owners.assertCanInvokeAgent({ humanUserId, agentId, roomId, origin: "room_message" });
      if (!(await owners.getUserCapabilities(humanUserId)).includes("use_workstation")) return null;
      const persistedRoomId = await owners.findRoomIdByGraphThreadIdForUser(humanUserId, roomGraphThreadFromLaneThread(conversationId));
      if (persistedRoomId !== roomId) return null;
      const actor = await owners.findActorByOwnerId(humanUserId);
      const room = actor ? await owners.getRoomDetailForMember(roomId, actor.id) : null;
      const member = room?.members.find(value => value.kind === "agent" && value.agentId === agentId);
      return room && member ? { roomId: room.id, graphThreadId: room.graphThreadId, agentActorId: member.actorId } : null;
    },
    async validateProtected(policy) {
      const session = crypto?.session;
      const scope = crypto?.capability.scope;
      if (!crypto || !session || !scope || scope.subjectHumanId !== humanUserId
        || ("recipientKind" in scope ? scope.topLevelRoomId !== roomId : scope.roomId !== roomId || scope.recipientAgentId !== agentId)
        || session.authorizationSignal?.aborted
        || (session.authorizationDeadlineAt !== undefined && Date.now() >= session.authorizationDeadlineAt)) {
        throw new Error("HUMAN_TERMINAL_PROTECTED_SOURCE_UNAVAILABLE");
      }
      const current = await crypto.dataOperationPolicy?.resolve();
      if (!current || current.revalidationToken !== policy.revision || current.policy.mode !== policy.mode
        || current.revalidationToken !== crypto.enforcementPolicy.revision
        || current.policy.mode !== crypto.enforcementPolicy.mode
        || current.policy.shadowBehavior !== crypto.enforcementPolicy.shadowBehavior) throw new Error("HUMAN_TERMINAL_PROTECTED_POLICY_CHANGED");
      await crypto.dataOperationPolicy!.revalidate(current.revalidationToken);
      if (session.authorizationSignal?.aborted
        || (session.authorizationDeadlineAt !== undefined && Date.now() >= session.authorizationDeadlineAt)) throw new Error("HUMAN_TERMINAL_PROTECTED_SOURCE_UNAVAILABLE");
    },
  });
}
