import type { DtoDeclaration } from "../src/node/dto-inventory";

const SUPERSEDED = [
  "http:request_response:GET /api/memory/:id",
  "http:request_response:GET /api/memory/brief/readonly",
  "http:request_response:GET /api/memory/brief",
  "http:request_response:GET /api/memory",
  "http:request_response:GET /api/protected/artifacts/:artifactId",
  "http:request_response:GET /api/protected/artifacts",
  "http:request_response:PATCH /api/memory/:id",
  "http:request_response:POST /api/memory/protected-create",
  "http:request_response:POST /api/memory/search",
] as const;

export const SUPERSEDED_PR_944_DTO_LOCATORS = new Set<string>(SUPERSEDED);

const MEMORY_PROOF = "accessManifestProofBytesBase64url?:string[];";
const ARTIFACT_PROOF = "accessManifestProofBytesBase64url:string[];";
const SIGNER_EVIDENCE =
  'accessSignerEvidence:{evidenceBytesBase64url:string;kind:"agent_runtime_publication"|"processor_authorization"}[];';

function addSignerEvidence(declaration: DtoDeclaration): DtoDeclaration {
  let replacements = 0;
  const structuralSignatures = (declaration.structuralSignatures ?? []).map(
    (signature) => {
      for (const proof of [MEMORY_PROOF, ARTIFACT_PROOF]) {
        if (!signature.includes(proof) || signature.includes(SIGNER_EVIDENCE)) {
          continue;
        }
        replacements += 1;
        return signature.replace(proof, `${proof}${SIGNER_EVIDENCE}`);
      }
      return signature;
    },
  );
  if (replacements !== 1) {
    throw new Error(
      `PR 944 expected one protected signer-evidence DTO replacement for ${declaration.locator}, got ${replacements}`,
    );
  }
  return { ...declaration, structuralSignatures };
}

export function reviewedPr944DtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return SUPERSEDED.map((locator) => {
    const declaration = declarations.find((candidate) =>
      candidate.locator === locator
    );
    if (declaration === undefined) {
      throw new Error(`required PR 944 DTO declaration is missing: ${locator}`);
    }
    return addSignerEvidence(declaration);
  });
}
