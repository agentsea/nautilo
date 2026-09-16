import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_M311_DTO_LOCATORS = new Set<string>([
  "http:request_response:GET /api/tasks/pending-attention",
]);

/** Account for the closed, content-free foreground context progress kind. */
export function reviewedM311DtoReplacements(
  previous: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return previous
    .filter((declaration) =>
      SUPERSEDED_M311_DTO_LOCATORS.has(declaration.locator)
    )
    .map((declaration) => declaration.structuralSignatures === undefined
      ? declaration
      : {
        ...declaration,
        structuralSignatures: declaration.structuralSignatures.map(
          (signature) => signature.replaceAll(
            'kind?:"deep-research"',
            'kind?:"deep-research"|"foreground-context"',
          ),
        ),
      });
}
