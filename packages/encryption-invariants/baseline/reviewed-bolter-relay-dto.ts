import type { DtoDeclaration } from "../src/node/dto-inventory";

const MEMBERS = new Map<string, readonly [string, string]>([
  ["relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayClientMessage", ["RelayAcpClientMessage", "RelayBolterDesktopMessage"]],
  ["relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage", ["RelayAcpServerMessage", "RelayBolterServerMessage"]],
] as const);

/** Add only the finite Bolter union members. Their exact plaintext carriers
 * have separate declarations; unrelated Relay shapes and debt stay unchanged. */
export function reviewedBolterRelayDtoReplacements(declarations: readonly DtoDeclaration[]): readonly DtoDeclaration[] {
  for (const locator of MEMBERS.keys()) {
    if (declarations.filter(entry => entry.locator === locator).length !== 1) {
      throw new Error(`Bolter Relay DTO predecessor is absent or ambiguous: ${locator}`);
    }
  }
  return declarations.map(entry => {
    const members = MEMBERS.get(entry.locator);
    if (!members) return entry;
    const [predecessor, added] = members;
    const before = `unresolved<${predecessor}>|`;
    const member = `unresolved<${added}>|`;
    const signatures = entry.structuralSignatures ?? [];
    if (signatures.some(signature => signature.includes(member))
      || signatures.reduce((count, signature) => count + signature.split(before).length - 1, 0) !== 1) {
      throw new Error(`Bolter Relay DTO predecessor shape is absent or ambiguous: ${entry.locator}`);
    }
    return { ...entry, structuralSignatures: signatures.map(signature => signature.replace(before, `${before}${member}`)) };
  });
}
