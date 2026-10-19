import { RELAY_DELEGATED_LOCAL_EXECUTION_PROTOCOL_VERSION, type RelayCapabilities } from "@nautilo/relay";
import {
  roomGraphThreadFromLaneThread,
  type TaskCreationReturnContext,
} from "@nautilo/agent";
import { getEncryptionTransitionPolicy } from "@nautilo/db";
import {
  readHumanTerminalSourceAuthority,
  type HumanTerminalSourceAuthorityDatabase,
} from "@nautilo/trust";

/** Protected repo-docs keeps the model file-only while its trusted wrapper
 * needs the same captured project authority as an executable Task. */
export function taskNeedsLocalExecutionCapture(
  candidate: Readonly<{ preset?: string | undefined; toolsMode?: string | undefined; toolsWhitelist?: readonly string[] | undefined }>,
  protectedCreation: boolean,
): boolean {
  if (protectedCreation && candidate.preset === "repo_docs") {
    return candidate.toolsMode === "whitelist"
      && candidate.toolsWhitelist?.length === 1
      && candidate.toolsWhitelist[0] === "file";
  }
  return candidate.toolsMode !== "none" && (candidate.toolsMode !== "whitelist"
    || candidate.toolsWhitelist?.some(name => name === "exec_command" || name === "write_stdin") === true);
}

interface CaptureRegistry {
  getCapabilities(relayId: string): RelayCapabilities | null | undefined;
  getProtocolVersion(relayId: string): number | null;
  getUserId(relayId: string): string | null;
  getRelaySessionId(relayId: string): string | null;
  getDesktopSessionId(relayId: string): string | null;
  getPairingGeneration(relayId: string): string | null;
  getLocalExecutionPairingGeneration(relayId: string): string | null;
  isRelayHeartbeatFresh(relayId: string): boolean;
}

type TaskLocalExecutionCaptureDatabase = HumanTerminalSourceAuthorityDatabase
  & Parameters<typeof getEncryptionTransitionPolicy>[0];

interface TaskLocalExecutionCaptureAdmissionInput {
  readonly database: TaskLocalExecutionCaptureDatabase;
  readonly humanUserId: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly conversationId: string;
  readonly assertCurrentProtected?: () => Promise<void>;
}

interface TaskLocalExecutionCaptureAdmissionDeps {
  readonly readPolicy?: (database: TaskLocalExecutionCaptureDatabase) =>
    Promise<Readonly<{ mode: string; revision: number }>>;
  readonly readSourceAuthority?: typeof readHumanTerminalSourceAuthority;
}

/** Supply the Human Terminal owner with transaction-bound policy and source
 * facts while its original signal and before/after algorithm remain in force. */
export function createTaskLocalExecutionCaptureAdmission(
  input: TaskLocalExecutionCaptureAdmissionInput,
  deps: TaskLocalExecutionCaptureAdmissionDeps = {},
): Parameters<NonNullable<TaskCreationReturnContext["localExecutionSource"]>["withBorrowedAdmission"]>[0] {
  const readPolicy = deps.readPolicy ?? getEncryptionTransitionPolicy;
  const readSourceAuthority = deps.readSourceAuthority ?? readHumanTerminalSourceAuthority;
  return {
    readPolicy: () => readPolicy(input.database),
    readScope: () => readSourceAuthority(input.database, {
      humanUserId: input.humanUserId,
      agentId: input.agentId,
      roomId: input.roomId,
      graphThreadId: roomGraphThreadFromLaneThread(input.conversationId),
    }),
    async validateProtected() {
      if (!input.assertCurrentProtected) throw new Error("TASK_LOCAL_EXECUTION_PROTECTED_SOURCE_UNAVAILABLE");
      // The protected product owner pins the enforcement revision while this
      // borrowed reader loads that same policy through its held transaction.
      // Human Terminal still compares both reads around dispatch.
      await input.assertCurrentProtected();
    },
  };
}

/** Ordinary-origin context pins the raw pairing row. The managed wire carries
 * its opaque reference instead; both must remain current across capture. */
export function resolveTaskLocalExecutionCaptureTarget(
  context: Pick<TaskCreationReturnContext, "relayId" | "relaySessionId" | "desktopSessionId" | "pairingGeneration">,
  humanUserId: string,
  registry: CaptureRegistry,
) {
  const { relayId, relaySessionId, desktopSessionId, pairingGeneration: rawPairingGeneration } = context;
  const pairingGeneration = registry.getLocalExecutionPairingGeneration(relayId);
  if (!rawPairingGeneration || !pairingGeneration) return null;
  const isCurrent = () => registry.getUserId(relayId) === humanUserId
    && registry.getRelaySessionId(relayId) === relaySessionId
    && registry.getDesktopSessionId(relayId) === desktopSessionId
    && registry.getPairingGeneration(relayId) === rawPairingGeneration
    && registry.getLocalExecutionPairingGeneration(relayId) === pairingGeneration
    && registry.isRelayHeartbeatFresh(relayId)
    && registry.getCapabilities(relayId)?.canDelegateLocalExecution === true
    && (registry.getProtocolVersion(relayId) ?? 0) >= RELAY_DELEGATED_LOCAL_EXECUTION_PROTOCOL_VERSION;
  return isCurrent() ? {
    rawPairingGeneration,
    captureBinding: { desktopSessionId, pairingGeneration },
    isCurrent,
  } : null;
}
