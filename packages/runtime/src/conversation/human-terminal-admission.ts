import { roomGraphThreadFromLaneThread, type NautiloState } from "@nautilo/agent";
import type {
  BorrowedHumanTerminalAdmission,
  HumanTerminalAdmissionPort,
} from "../../../agent/src/tools/terminal/admission";
import { getEncryptionTransitionPolicy, getSharedDirectDb } from "@nautilo/db";
import { readHumanTerminalSourceAuthority } from "@nautilo/trust";
import { getCurrentLiveShadowTurnContext } from "./live-shadow-turn-context";

export interface HumanTerminalSourceAdmission extends BorrowedHumanTerminalAdmission {
  readonly signal: AbortSignal;
}

/** Admission is checked around each read and input. A post-effect denial never
 * retries the input, and no result bytes are released after that denial. */
export function createHumanTerminalAdmissionPort(source: HumanTerminalSourceAdmission): HumanTerminalAdmissionPort {
  const unavailable = () => new Error("HUMAN_TERMINAL_SOURCE_UNAVAILABLE");
  const inspect = async (admission: BorrowedHumanTerminalAdmission) => {
    source.signal.throwIfAborted();
    const policy = await admission.readPolicy();
    const scope = await admission.readScope();
    if (!scope) throw unavailable();
    if (policy.mode !== "plaintext_only") await admission.validateProtected(policy);
    const currentScope = await admission.readScope();
    if (!currentScope || currentScope.roomId !== scope.roomId || currentScope.graphThreadId !== scope.graphThreadId
      || currentScope.agentActorId !== scope.agentActorId) throw unavailable();
    const currentPolicy = await admission.readPolicy();
    if (currentPolicy.mode !== policy.mode || currentPolicy.revision !== policy.revision) throw unavailable();
    source.signal.throwIfAborted();
    return { policy, scope };
  };
  const runAdmission = async <T>(
    admission: BorrowedHumanTerminalAdmission,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const before = await inspect(admission);
    const result = await work(source.signal);
    const after = await inspect(admission);
    if (before.policy.mode !== after.policy.mode || before.policy.revision !== after.policy.revision
      || before.scope.roomId !== after.scope.roomId || before.scope.graphThreadId !== after.scope.graphThreadId
      || before.scope.agentActorId !== after.scope.agentActorId) throw unavailable();
    return result;
  };
  return {
    withAdmission: work => runAdmission(source, work),
    withBorrowedAdmission: (admission, work) => runAdmission(admission, work),
  };
}

/** This adapter borrows the ordinary foreground Room and live Shadow owners.
 * A Room locator or renderer selection alone cannot create source authority. */
const foregroundOwners = {
  readPolicy: () => getEncryptionTransitionPolicy(getSharedDirectDb()),
  readSourceAuthority: (input: Parameters<typeof readHumanTerminalSourceAuthority>[1]) =>
    readHumanTerminalSourceAuthority(getSharedDirectDb(), input),
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
    readScope: () => owners.readSourceAuthority({ humanUserId, agentId, roomId,
      graphThreadId: roomGraphThreadFromLaneThread(conversationId) }),
    async validateProtected(policy) {
      const session = crypto?.session;
      const scope = crypto?.capability?.scope;
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
