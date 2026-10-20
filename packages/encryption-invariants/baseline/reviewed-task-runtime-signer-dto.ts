import type { DtoDeclaration } from "../src/node/dto-inventory";

export const REVIEWED_TASK_RUNTIME_SIGNER_DTO_LOCATORS = [
  "http:request_response:GET /api/memory/:id",
  "http:request_response:GET /api/memory/brief/readonly",
  "http:request_response:GET /api/memory/brief",
  "http:request_response:GET /api/memory",
  "http:request_response:PATCH /api/memory/:id",
  "http:request_response:POST /api/message-backfill/source",
  "http:request_response:POST /api/memory/protected-create",
  "http:request_response:POST /api/memory/search",
  "http:request_response:POST /api/protected/memories/:id/repair-plan",
] as const;

const PRIOR_SIGNER_EVIDENCE =
  '{evidenceBytesBase64url:string;kind:"agent_runtime_publication"|"processor_authorization"}';
const TASK_RUNTIME_SIGNER_EVIDENCE =
  '{evidenceBytesBase64url:string;kind:"task_runtime_signer_certificate"}';

/** A Task runtime signer certificate is signed public authorization evidence.
 * It adds no plaintext content or secret key bytes and grants no independent
 * execution or payer authority. The message-backfill source binds the same
 * evidence at its two exact signer-certificate positions. Unrelated DTO shapes
 * remain unchanged. */
export function reviewedTaskRuntimeSignerDtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  const locators = new Set<string>(
    REVIEWED_TASK_RUNTIME_SIGNER_DTO_LOCATORS,
  );
  const found = new Set<string>();
  const replaced = declarations.map((declaration) => {
    if (!locators.has(declaration.locator)) return declaration;
    if (found.has(declaration.locator)) {
      throw new Error(
        `Task runtime signer DTO predecessor is ambiguous: ${declaration.locator}`,
      );
    }
    found.add(declaration.locator);
    const expectedMatches = declaration.locator ===
        "http:request_response:POST /api/message-backfill/source"
      ? 2
      : 1;
    let matches = 0;
    const structuralSignatures = (declaration.structuralSignatures ?? []).map(
      (signature) => {
        matches += signature.split(PRIOR_SIGNER_EVIDENCE).length - 1;
        return signature.replaceAll(
          PRIOR_SIGNER_EVIDENCE,
          `${PRIOR_SIGNER_EVIDENCE}|${TASK_RUNTIME_SIGNER_EVIDENCE}`,
        );
      },
    );
    if (matches !== expectedMatches) {
      throw new Error(
        `Task runtime signer DTO predecessor mismatch for ${declaration.locator}: expected ${expectedMatches}, found ${matches}`,
      );
    }
    return { ...declaration, structuralSignatures };
  });
  const missing = REVIEWED_TASK_RUNTIME_SIGNER_DTO_LOCATORS.filter(
    (locator) => !found.has(locator),
  );
  if (missing.length > 0) {
    throw new Error(
      `Task runtime signer DTO predecessors are missing: ${missing.join(", ")}`,
    );
  }
  return replaced;
}
