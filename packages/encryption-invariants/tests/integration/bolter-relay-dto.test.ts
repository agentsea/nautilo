import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { reviewedBolterRelayDtoReplacements } from "../../baseline/reviewed-bolter-relay-dto";
import { discoverNamedDtoInventory, type DtoDeclaration } from "../../src/node/dto-inventory";

const prefix = "relay:declared_arbitrary:packages/relay/src/protocol.ts#";
const members = ["RelayBolterDesktopMessage", "RelayBolterServerMessage"] as const;
const locators = [`${prefix}RelayClientMessage`, `${prefix}RelayServerMessage`];

test("declares both actual Bolter union members without refreshing unrelated Relay shapes", async () => {
  const observations = await discoverNamedDtoInventory(resolve(import.meta.dir, "../../../.."));
  for (const [index, locator] of locators.entries()) {
    const observation = observations.find(entry => entry.locator === locator);
    const declaration = DTO_BASELINE_DECLARATIONS.find(entry => entry.locator === locator);
    expect(observation).toBeDefined();
    expect(declaration).toBeDefined();
    const member = `unresolved<${members[index]!}>`;
    expect(observation!.structuralSignatures.join("\n").split(member)).toHaveLength(2);
    expect(declaration!.structuralSignatures!.join("\n").split(member)).toHaveLength(2);
  }
  const predecessors = DTO_BASELINE_DECLARATIONS.map(entry => locators.includes(entry.locator)
    ? { ...entry, structuralSignatures: entry.structuralSignatures!.map(signature =>
      members.reduce((value, member) => value.replace(`unresolved<${member}>|`, ""), signature)) }
    : entry);
  const result = reviewedBolterRelayDtoReplacements(predecessors);
  expect(result).toEqual(DTO_BASELINE_DECLARATIONS);
  expect(predecessors.every((entry, index) => locators.includes(entry.locator) || result[index] === entry)).toBe(true);
  expect(predecessors.every((entry, index) => result[index]!.arbitraryPayloads === entry.arbitraryPayloads)).toBe(true);
}, 120_000);

test("fails closed on absent, repeated or already amended predecessors", () => {
  const declarations: DtoDeclaration[] = locators.map((locator, index) => ({
    observationId: `synthetic.relay.${index}`, locator, arbitraryPayloads: [],
    structuralSignatures: [`declaration.payload:unresolved<${index === 0 ? "RelayAcpClientMessage" : "RelayAcpServerMessage"}>|unresolved<OtherContract>`],
  }));
  expect(() => reviewedBolterRelayDtoReplacements([])).toThrow();
  expect(() => reviewedBolterRelayDtoReplacements([...declarations, declarations[0]!])).toThrow();
  expect(() => reviewedBolterRelayDtoReplacements(declarations.map(entry => ({ ...entry, structuralSignatures: [] })))).toThrow();
  expect(() => reviewedBolterRelayDtoReplacements(declarations.map(entry => ({ ...entry,
    structuralSignatures: [...entry.structuralSignatures!, ...entry.structuralSignatures!] })))).toThrow();
  expect(() => reviewedBolterRelayDtoReplacements(reviewedBolterRelayDtoReplacements(declarations))).toThrow();
});
