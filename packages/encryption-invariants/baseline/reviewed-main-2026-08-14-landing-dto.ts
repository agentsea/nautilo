import type { DtoDeclaration } from "../src/node/dto-inventory";

const SUPERSEDED = [
  "http:request_response:DELETE /api/groups/:id/members/:userId",
  "http:request_response:PUT /api/groups/:id/members/:userId",
] as const;

export const SUPERSEDED_MAIN_2026_08_14_LANDING_DTO_LOCATORS =
  new Set<string>(SUPERSEDED);

export function reviewedMain20260814LandingDtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return SUPERSEDED.map((locator) => {
    const declaration = declarations.find((candidate) =>
      candidate.locator === locator
    );
    if (declaration === undefined) {
      throw new Error(`required landing DTO declaration is missing: ${locator}`);
    }
    return {
      ...declaration,
      structuralSignatures: (declaration.structuralSignatures ?? []).filter(
        (signature) => signature !== "response.body:void",
      ),
    };
  });
}
