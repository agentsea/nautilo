import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { auditDtoDeclarations, discoverHttpDtoInventory } from "../../src/node/dto-inventory";

const root = resolve(import.meta.dir, "../../../..");
const locators = [
  "http:request_response:GET /api/protected/tasks/:taskId/definition",
  "http:request_response:GET /api/protected/tasks/:taskId/runs/:taskRunId/result",
];

test("protected Task readers declare their exact public generation authority and ciphertext contracts", async () => {
  const observations = (await discoverHttpDtoInventory(root))
    .filter((entry) => locators.includes(entry.locator));
  const declarations = DTO_BASELINE_DECLARATIONS
    .filter((entry) => locators.includes(entry.locator));
  expect(observations).toHaveLength(2);
  expect(declarations).toHaveLength(2);
  expect(auditDtoDeclarations({ observations, declarations }).ok).toBe(true);
  for (const declaration of declarations) {
    expect(declaration.arbitraryPayloads).toEqual([]);
    const body = declaration.structuralSignatures?.find((signature) =>
      signature.startsWith("response.body:{accessManifestBytesBase64url:"));
    expect(body).toContain("readAuthority:{currentGeneration:number;namespaceId:string;retainedGenerations:");
    expect(body).toContain("encryptedPayloadBytesBase64url:string");
    expect(body).toContain("signerEvidence:");
    expect(body).toContain("task_runtime_signer_certificate");
    expect(body).not.toMatch(/privateKey|namespaceKey|resultText|prompt:/);
  }

  // An otherwise identical route cannot silently remove read authority or add
  // an undeclared plaintext body field while retaining this review.
  for (const change of [
    (signature: string) => signature.replace("readAuthority:", "removedReadAuthority:"),
    (signature: string) => signature.replace("response.body:{", "response.body:{plaintextTaskBody:string;"),
  ]) {
    const altered = observations.map((entry) => ({
      ...entry,
      structuralSignatures: entry.structuralSignatures.map((signature) =>
        signature.startsWith("response.body:{accessManifestBytesBase64url:")
          ? change(signature)
          : signature),
    }));
    expect(auditDtoDeclarations({ observations: altered, declarations }).ok).toBe(false);
  }
}, 120_000);
