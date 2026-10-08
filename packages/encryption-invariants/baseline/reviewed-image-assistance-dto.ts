import type { DtoDeclaration } from "../src/node/dto-inventory";

const SUMMARY = '{attachmentIds:string[];modelDisplayName:string;modelId:string;status:"completed"}';

const REPLACEMENTS: Readonly<Record<string, readonly Readonly<{
  from: string; to: string; count: number;
}>[]>> = {
  "http:request_response:GET /api/config/models": [
    { from: ";id:string;priority:", to: ';id:string;imageInput?:"assisted"|"direct"|"unavailable";priority:', count: 1 },
  ],
  "http:request_response:POST /api/config/models/resolve": [
    { from: ";id:string;priority:", to: ';id:string;imageInput?:"assisted"|"direct"|"unavailable";priority:', count: 1 },
  ],
  "http:request_response:GET /api/rooms/:id/messages": [
    { from: ";id:string;", to: `;id:string;imageAssistance?:${SUMMARY};`, count: 4 },
  ],
  "http:request_response:GET /api/rooms/:id/messages/:messageId/around": [
    { from: ";id:string;", to: `;id:string;imageAssistance?:${SUMMARY};`, count: 1 },
  ],
  "http:request_response:GET /api/rooms/:id/thread-detail": [
    { from: ";id:string;", to: `;id:string;imageAssistance?:${SUMMARY};`, count: 1 },
  ],
  "http:request_response:GET /api/sessions/latest": [
    { from: ";id:string;", to: `;id:string;imageAssistance?:${SUMMARY};`, count: 4 },
  ],
  "http:request_response:GET /api/tasks/pending-attention": [
    { from: ";editRevision?:number;laneKey:string;logicalMessageKey?:string;messageId:string;",
      to: `;editRevision?:number;imageAssistance?:${SUMMARY};laneKey:string;logicalMessageKey?:string;messageId:string;`, count: 1 },
    { from: ';errorCategory?:"auth"|"bad_request"|"context_exceeded"|"provider_unavailable"|"rate_limit"|"timeout"|"unknown";jobId:string;',
      to: ';errorCategory?:"auth"|"bad_request"|"context_exceeded"|"provider_unavailable"|"rate_limit"|"timeout"|"unknown";errorCode?:"image_assistance_failed";jobId:string;', count: 1 },
  ],
};

/** Review only the closed image-route, attribution and failure fields. Inherited
 * arbitrary-payload debt and all unrelated structural drift remain unchanged.
 * Attribution contains no observation text, image bytes or funding authority. */
export function reviewedImageAssistanceDtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return declarations.map((declaration) => {
    const replacements = REPLACEMENTS[declaration.locator];
    if (replacements === undefined) return declaration;
    let structuralSignatures = [...(declaration.structuralSignatures ?? [])];
    for (const { from, to, count } of replacements) {
      let matches = 0;
      structuralSignatures = structuralSignatures.map((signature) => {
        if (!signature.startsWith("response.body:")) return signature;
        matches += signature.split(from).length - 1;
        return signature.replaceAll(from, to);
      });
      if (matches !== count) {
        throw new Error(`Image assistance DTO predecessor mismatch for ${declaration.locator}: expected ${count}, found ${matches}`);
      }
    }
    return { ...declaration, structuralSignatures };
  });
}
