import { AsyncLocalStorage } from "node:async_hooks";
import type { ComputerUseContractDescriptor, ComputerUseContractCatalogueEntry } from "./schema";

const selection = new AsyncLocalStorage<readonly ComputerUseContractDescriptor[] | undefined>();

export function sameComputerUseContract(a: ComputerUseContractDescriptor, b: ComputerUseContractDescriptor): boolean {
  return a.contractNamespace === b.contractNamespace && a.contractId === b.contractId
    && a.contractVersion === b.contractVersion && a.schemaDigest === b.schemaDigest
    && a.effectClass === b.effectClass && a.replayClass === b.replayClass
    && a.authorityClass === b.authorityClass && a.attachmentClass === b.attachmentClass
    && a.disclosureClass === b.disclosureClass;
}

/**
 * undefined: process registration (latest schemas); null: unadvertised legacy
 * Desktop (release-reviewed baseline); []: no usable Host. An advertisement
 * selects signed schemas, never supplies schemas or authorizes execution.
 */
export function selectComputerUseContracts(
  entries: readonly ComputerUseContractCatalogueEntry[],
  supported: readonly ComputerUseContractDescriptor[] | null | undefined,
): readonly ComputerUseContractCatalogueEntry[] {
  const selected = new Map<string, ComputerUseContractCatalogueEntry>();
  for (const entry of entries) {
    if (entry.executionLane !== "host") continue;
    if (supported === null && !entry.legacyDefault) continue;
    if (supported !== undefined && supported !== null
      && !supported.some((contract) => sameComputerUseContract(contract, entry.descriptor))) continue;
    const prior = selected.get(entry.projection.toolName);
    if (!prior || prior.descriptor.contractVersion < entry.descriptor.contractVersion) selected.set(entry.projection.toolName, entry);
  }
  return [...selected.values()];
}

export function currentComputerUseContractSelection() { return selection.getStore(); }

/** Node-local scope; concurrent Humans and graph runs never change a global catalogue. */
export function withComputerUseContractSelection<T>(contracts: readonly ComputerUseContractDescriptor[] | undefined, work: () => T): T {
  return selection.run(contracts, work);
}
