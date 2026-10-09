import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_PAID_SERVICE_FUNDING_DTO_LOCATORS = new Set<string>([
  "http:request_response:DELETE /api/admin/users/:id",
  "http:request_response:GET /api/account/deletion/eligibility",
  "http:request_response:GET /api/connected-web-operations/:operationId",
  "http:request_response:POST /api/connected-web-operations/:operationId/stop",
]);

const PRIOR_OUTPUT_SHAPE = "outputs:never[];outputsTruncated:false";
const CURRENT_OUTPUT_SHAPE =
  "outputs:{artifactId:string;bytes:number;mime:string;path:string}[];outputsTruncated:boolean";
const PRIOR_DELETION_BLOCKER =
  '{code:"active_media_operation";eligible:false}';
const CURRENT_DELETION_BLOCKER =
  '{code:"active_conversion_operation";eligible:false}|{code:"active_media_operation";eligible:false}';

/** Preserve the existing plaintext-result debt while recording its current wire shape. */
export function reviewedPaidServiceFundingDtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return [...SUPERSEDED_PAID_SERVICE_FUNDING_DTO_LOCATORS].map((locator) => {
    const prior = declarations.find((entry) => entry.locator === locator);
    if (!prior?.structuralSignatures) {
      throw new Error(`Paid service funding DTO predecessor missing: ${locator}`);
    }
    const replacement = locator.includes("connected-web-operations")
      ? { from: PRIOR_OUTPUT_SHAPE, to: CURRENT_OUTPUT_SHAPE, expected: 1 }
      : {
        from: PRIOR_DELETION_BLOCKER,
        to: CURRENT_DELETION_BLOCKER,
        expected: locator.startsWith("http:request_response:DELETE") ? 2 : 1,
      };
    let matches = 0;
    const structuralSignatures = prior.structuralSignatures.map((signature) => {
      const count = signature.split(replacement.from).length - 1;
      matches += count;
      return signature.replaceAll(replacement.from, replacement.to);
    });
    if (matches !== replacement.expected) {
      throw new Error(
        `Paid service funding DTO predecessor mismatch for ${locator}: expected ${replacement.expected}, found ${matches}`,
      );
    }
    return { ...prior, structuralSignatures };
  });
}
