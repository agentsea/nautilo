import { RELAY_DELEGATED_LOCAL_EXECUTION_PROTOCOL_VERSION, type RelayCapabilities } from "@nautilo/relay";
import type { TaskCreationReturnContext } from "@nautilo/agent";

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
