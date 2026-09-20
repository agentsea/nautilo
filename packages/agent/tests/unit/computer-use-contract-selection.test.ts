import { afterEach, expect, test } from "bun:test";
import { bundledComputerUseContractCatalogue as catalogue } from "../../src/config/computer-use-catalogue/catalog";
import { computerUseContractCatalogueV1Schema } from "../../src/config/computer-use-catalogue/schema";
import { selectComputerUseContracts, withComputerUseContractSelection } from "../../src/config/computer-use-catalogue/selection";
import { activeComputerUseHostToolDefinitions, resolveComputerUseHostToolRequest } from "../../src/config/computer-use-catalogue/host-tool-admission";
import { computerUseContractsForState, computerUseContractSupportedForState } from "../../src/config/computer-use-catalogue/live-selection";
import { createComputerHostContractTool } from "../../src/tools/computer/computer-host-contract";
import { setRelayRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";
import type { NautiloState } from "../../src/agent/state";
import { parseComputerUseHostContracts } from "@nautilo/relay";
import { ToolCatalog } from "@nautilo/catalog";
import { reconcileComputerUseHostTools } from "../../src/tools/register-all";

const older = catalogue.contracts.filter((entry) => entry.legacyDefault);
const newer = selectComputerUseContracts(catalogue.contracts, undefined);
const descriptors = (entries: typeof older | readonly typeof older[number][]) => entries.map((entry) => entry.descriptor);
const version = (entries: readonly typeof older[number][], tool: string) => entries.find((entry) => entry.projection.toolName === tool)?.descriptor.contractVersion;
afterEach(() => setRelayRegistry(null));

test("unmatched contracts are excluded before factories run, without changing global registration", () => {
  const tools = new ToolCatalog();
  withComputerUseContractSelection([], () => {
    reconcileComputerUseHostTools(tools);
    expect(tools.resolveProgressiveTools({ relayCapabilities: { canUseComputer: true } }).tools).toEqual([]);
  });
  withComputerUseContractSelection(descriptors(older), () => {
    expect(tools.resolveProgressiveTools({ relayCapabilities: { canUseComputer: true } }).tools).toHaveLength(11);
  });
});

test("catalogue-first selects the old Host's exact contracts, not new native features", () => {
  const selected = selectComputerUseContracts(catalogue.contracts, descriptors(older));
  expect(version(selected, "computer_observe")).toBe(9);
  expect(version(selected, "computer_do")).toBe(11);
  withComputerUseContractSelection(descriptors(selected), () => {
    expect(resolveComputerUseHostToolRequest("computer_observe", { operation: "desktop_state" })?.contract.contractVersion).toBe(9);
    expect(JSON.stringify(createComputerHostContractTool("computer_observe").schema)).not.toContain("decisionPlan");
    expect(activeComputerUseHostToolDefinitions()).toHaveLength(11);
  });
});

test("Host-first keeps old schemas until the signed catalogue offers a supported upgrade", () => {
  const supported = catalogue.contracts.map((entry) => entry.descriptor);
  expect(version(selectComputerUseContracts(older, supported), "computer_observe")).toBe(9);
  expect(version(selectComputerUseContracts(catalogue.contracts, supported), "computer_observe")).toBe(11);
  expect(version(selectComputerUseContracts(catalogue.contracts, descriptors(newer)), "computer_do")).toBe(13);
});

test("legacy omission has an explicit baseline; empty, forged digest, and wrong classification do not", () => {
  expect(version(selectComputerUseContracts(catalogue.contracts, null), "computer_observe")).toBe(9);
  expect(selectComputerUseContracts(catalogue.contracts, [])).toEqual([]);
  const contract = newer[0]!.descriptor;
  expect(selectComputerUseContracts(catalogue.contracts, [{ ...contract, schemaDigest: "sha256:" + "f".repeat(64) }])).toEqual([]);
  expect(selectComputerUseContracts(catalogue.contracts, [{ ...contract, effectClass: "sensitive" }])).toEqual([]);
  expect(parseComputerUseHostContracts(undefined)).toBeNull();
  expect(parseComputerUseHostContracts([])).toEqual([]);
  expect(parseComputerUseHostContracts([contract, contract])).toBeNull();
});

test("concurrent runs retain different schemas without changing the process catalogue", async () => {
  const observe = () => resolveComputerUseHostToolRequest("computer_observe", { operation: "desktop_state" })!.contract.contractVersion;
  const results = await Promise.all([
    withComputerUseContractSelection(descriptors(older), async () => { await Promise.resolve(); return observe(); }),
    withComputerUseContractSelection(descriptors(newer), async () => { await Promise.resolve(); return observe(); }),
  ]);
  expect(results).toEqual([9, 11]);
  expect(observe()).toBe(11);
});

test("signed compatibility metadata cannot alias another tool family or downgrade effect classification", () => {
  const changed = structuredClone(catalogue);
  const previous = changed.contracts.find((entry) => entry.descriptor.contractId === "native.do" && entry.legacyDefault)!;
  previous.projection.toolName = "computer_observe";
  expect(computerUseContractCatalogueV1Schema.safeParse(changed).success).toBe(false);
});

test("live selection fences another Human/session and replacement Host; it does not silently upgrade an admitted call", () => {
  const state = {
    userId: "human", agentId: "genie", trustedExecutionEntrypoint: "foreground.main",
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human", relayId: "relay", desktopSessionId: "session", pairingGeneration: "pair" },
    desktopAutomationProvenance: { installationEpoch: "epoch", grantGeneration: 1 },
    desktopAutomationRouteBinding: { provider: "cua", providerGeneration: "provider", grantGeneration: 1 },
  } as NautiloState;
  let supported: unknown = descriptors(older);
  let owner = "human";
  setRelayRegistry({
    getUserId: () => owner, getDesktopSessionId: () => "session", getPairingGeneration: () => "pair",
    getCapabilities: () => ({
      profile: "desktop-agent", canControlDesktop: true,
      desktopAutomation: { enabled: true, agentId: "genie", installationEpoch: "epoch", grantGeneration: 1, provider: "cua", providerGeneration: "provider" },
      ...(supported === undefined ? {} : { computerUseHostContracts: supported }),
    }),
  } as unknown as ToolRelayRegistry);
  const before = computerUseContractsForState(state);
  const oldObserve = before.find((entry) => entry.contractId === "native.observe")!;
  expect(oldObserve.contractVersion).toBe(9);
  supported = catalogue.contracts.map((entry) => entry.descriptor);
  expect(computerUseContractSupportedForState(state, oldObserve)).toBe(true);
  expect(computerUseContractsForState(state).find((entry) => entry.contractId === "native.observe")?.contractVersion).toBe(11);
  supported = descriptors(newer);
  expect(computerUseContractSupportedForState(state, oldObserve)).toBe(false);
  supported = { invalid: true };
  expect(computerUseContractsForState(state)).toEqual([]);
  supported = undefined;
  expect(computerUseContractsForState(state).find((entry) => entry.contractId === "native.observe")?.contractVersion).toBe(9);
  owner = "another-human";
  expect(computerUseContractsForState(state)).toEqual([]);
});
