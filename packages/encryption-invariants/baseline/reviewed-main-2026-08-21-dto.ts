import type { DtoDeclaration } from "../src/node/dto-inventory";

const LOCATORS = [
  "http:request_response:GET /api/setup/research-provider",
  "http:request_response:PUT /api/setup/research-provider",
] as const;

export const SUPERSEDED_MAIN_2026_08_21_DTO_LOCATORS =
  new Set<string>(LOCATORS);

export function reviewedMain20260821DtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return LOCATORS.map((locator) => {
    const declaration = declarations.find((candidate) =>
      candidate.locator === locator
    );
    if (declaration === undefined) {
      throw new Error(`required 2026-08-21 DTO declaration is missing: ${locator}`);
    }
    let replacements = 0;
    const structuralSignatures = (declaration.structuralSignatures ?? []).map(
      (signature) => {
        if (!signature.includes("tavilyConfigured:boolean")) return signature;
        replacements += 1;
        return signature.replace(
          "tavilyConfigured:boolean",
          "tavilyConfigured?:boolean",
        );
      },
    );
    if (replacements !== 1) {
      throw new Error(
        `2026-08-21 research DTO replacement matched ${replacements} signatures for ${locator}`,
      );
    }
    return { ...declaration, structuralSignatures };
  });
}
