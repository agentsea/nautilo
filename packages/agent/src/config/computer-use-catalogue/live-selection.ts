import { parseComputerUseHostContracts } from "@nautilo/relay";
import type { NautiloState } from "../../agent/state";
import { getRelayRegistry } from "../../tools/invocation-service";
import { getActiveComputerUseContractCatalogueSync } from "./runtime-catalogue";
import { selectComputerUseContracts, sameComputerUseContract } from "./selection";
import type { ComputerUseContractDescriptor } from "./schema";

/** Discovery is scoped to the same authenticated Desktop as normal admission. */
function advertisedContractsForState(state: NautiloState) {
  const origin = state.verifiedOrdinaryOrigin;
  const registry = getRelayRegistry();
  if (!registry || origin?.kind !== "local_electron" || state.trustedExecutionEntrypoint !== "foreground.main"
    || origin.userId !== state.userId || registry.getUserId?.(origin.relayId) !== state.userId
    || registry.getDesktopSessionId?.(origin.relayId) !== origin.desktopSessionId
    || registry.getPairingGeneration?.(origin.relayId) !== origin.pairingGeneration) return [];
  const capabilities = registry.getCapabilities(origin.relayId);
  const grant = capabilities?.desktopAutomation;
  const route = state.desktopAutomationRouteBinding;
  const provenance = state.desktopAutomationProvenance;
  if (!capabilities?.canControlDesktop || !grant?.enabled || grant.agentId !== state.agentId
    || !route || !provenance || grant.installationEpoch !== provenance.installationEpoch
    || grant.grantGeneration !== provenance.grantGeneration || grant.grantGeneration !== route.grantGeneration
    || route.provider !== grant.provider
    || route.providerGeneration !== grant.providerGeneration) return [];
  return Object.hasOwn(capabilities, "computerUseHostContracts")
    ? parseComputerUseHostContracts(capabilities.computerUseHostContracts) ?? []
    : null;
}

export function computerUseContractsForState(state: NautiloState) {
  return selectComputerUseContracts(getActiveComputerUseContractCatalogueSync().contracts, advertisedContractsForState(state))
    .map((entry) => entry.descriptor);
}

/** Recheck support at dispatch without upgrading a previously selected contract. */
export function computerUseContractSupportedForState(state: NautiloState, contract: ComputerUseContractDescriptor): boolean {
  const supported = advertisedContractsForState(state);
  return supported === null
    ? getActiveComputerUseContractCatalogueSync().contracts.some((entry) => entry.legacyDefault && sameComputerUseContract(entry.descriptor, contract))
    : supported.some((entry) => sameComputerUseContract(entry, contract));
}
