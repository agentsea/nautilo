import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { SUPERSEDED_PR_944_DTO_LOCATORS } from "../../baseline/reviewed-pr-944-dto";

const OBJECT_SIGNER_EVIDENCE =
  'accessSignerEvidence:{evidenceBytesBase64url:string;kind:"agent_runtime_publication"|"processor_authorization"}[];';
const MEMORY_SIGNER_EVIDENCE =
  'accessSignerEvidence:{committerDeviceId:string;hostAuthorizationRevision:number;kind:"human_device";signingPublicKeyBase64url:string;subjectHumanId:string}|{deviceId:string;hostAuthorizationRevision:number;kind:"evidence_issuer_human_device";signingPublicKeyBase64url:string;subjectHumanId:string}|{evidenceBytesBase64url:string;kind:"agent_runtime_publication"|"processor_authorization"}|{kind:"foreground_agent_accepted_execution";planBytesBase64url:string;planDigestBase64url:string}[];';
const MEMORY_SIGNER_EVIDENCE_LOCATORS = new Set([
  "http:request_response:GET /api/memory/:id",
  "http:request_response:GET /api/memory/brief/readonly",
  "http:request_response:GET /api/memory/brief",
  "http:request_response:GET /api/memory",
  "http:request_response:PATCH /api/memory/:id",
  "http:request_response:POST /api/memory/protected-create",
  "http:request_response:POST /api/memory/search",
]);

function exactSignerEvidence(signature: string): string | null {
  return signature.match(/accessSignerEvidence:.*?\}\[\];/u)?.[0] ?? null;
}

function expectedSignerEvidence(locator: string): string {
  return MEMORY_SIGNER_EVIDENCE_LOCATORS.has(locator)
    ? MEMORY_SIGNER_EVIDENCE
    : OBJECT_SIGNER_EVIDENCE;
}

describe("PR 944 common protected-content DTO security decisions", () => {
  test("pins bounded public signer evidence on every protected read response", () => {
    expect(SUPERSEDED_PR_944_DTO_LOCATORS.size).toBe(9);
    for (const locator of SUPERSEDED_PR_944_DTO_LOCATORS) {
      const declaration = DTO_BASELINE_DECLARATIONS.find((candidate) =>
        candidate.locator === locator
      );
      expect(declaration, locator).toBeDefined();
      const signerEvidence = declaration?.structuralSignatures
        ?.map(exactSignerEvidence)
        .filter((value): value is string => value !== null);
      expect(signerEvidence, locator).toEqual([
        expectedSignerEvidence(locator),
      ]);
      expect(
        declaration?.arbitraryPayloads.some((entry) =>
          entry.path.includes("accessSignerEvidence")
        ),
        locator,
      ).toBe(false);
    }
  });

  test("does not admit an unbounded or unknown signer kind", () => {
    for (const declaration of DTO_BASELINE_DECLARATIONS.filter((candidate) =>
      SUPERSEDED_PR_944_DTO_LOCATORS.has(candidate.locator)
    )) {
      const signerEvidence = declaration.structuralSignatures
        ?.map(exactSignerEvidence)
        .filter((value): value is string => value !== null);
      expect(signerEvidence).toEqual([
        expectedSignerEvidence(declaration.locator),
      ]);
      expect(signerEvidence?.[0]).not.toMatch(
        /kind:(?:string|unknown|any)\b/u,
      );
      expect(signerEvidence?.[0]).not.toContain("{[key:string]:unknown}");
    }
  });
});
