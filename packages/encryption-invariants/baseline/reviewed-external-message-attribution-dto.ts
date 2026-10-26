import type { DtoDeclaration } from "../src/node/dto-inventory";

const EXTERNAL_FIELDS = 'externalAttributionInvalid?:true;externalOrigin?:{bindingId:string;chatId:string;connectionId:string;createdAt:string;kind:"external_message";messageId:string;origin:"https://bolter.chat";provider:"bolter";providerAgentId:string;senderId:string;senderLabel:string;senderType:"anima"|"user";threadRootId?:string;version:1};';
const STRUCTURAL_SOURCE = 'selectedSource:{authorAgentId?:string;';
type Replacement = Readonly<{ from: string; to: string; count: number }>;
const message = (count: number): Replacement => ({
  from: ";editedAt?:string;id:string;", to: `;editedAt?:string;${EXTERNAL_FIELDS}id:string;`, count,
});
const hit: Replacement = { from: ";createdAt:string;messageId:string;", to: `;createdAt:string;${EXTERNAL_FIELDS}messageId:string;`, count: 1 };
const structural = (count: number): Replacement => ({
  from: STRUCTURAL_SOURCE, to: `${STRUCTURAL_SOURCE}externalAttributionInvalid?:true;`, count,
});
const REPLACEMENTS: Readonly<Record<string, readonly Replacement[]>> = {
  "http:request_response:GET /api/rooms/:id/messages": [message(4)],
  "http:request_response:GET /api/rooms/:id/messages/:messageId/around": [message(1), structural(4)],
  "http:request_response:GET /api/rooms/:id/messages/search": [hit],
  "http:request_response:GET /api/rooms/:id/thread-detail": [message(1)],
  "http:request_response:GET /api/rooms/search": [hit],
  "http:request_response:GET /api/sessions/latest": [message(4)],
  "http:request_response:GET /api/tasks/pending-attention": [{
    from: ";editRevision?:number;imageAssistance?:", to: `;editRevision?:number;${EXTERNAL_FIELDS}imageAssistance?:`, count: 1,
  }],
  "http:request_response:POST /api/message-backfill/source": [structural(10)],
  "http:request_response:POST /api/rooms/:id/messages/shadow-read": [structural(8)],
};

/** Closed provenance fields add no execution or payer authority. Ordinary
 * attribution retains the existing plaintext transcript boundary; protected
 * projections carry only a restrictive flag and suppress local author IDs.
 * Inherited arbitrary-payload debt and unrelated shape drift stay unchanged. */
export function reviewedExternalMessageAttributionDtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return declarations.map((declaration) => {
    const replacements = REPLACEMENTS[declaration.locator];
    if (!replacements) return declaration;
    let structuralSignatures = [...(declaration.structuralSignatures ?? [])];
    for (const { from, to, count } of replacements) {
      let matches = 0;
      structuralSignatures = structuralSignatures.map((signature) => {
        if (!signature.startsWith("response.body:")) return signature;
        matches += signature.split(from).length - 1;
        return signature.replaceAll(from, to);
      });
      if (matches !== count) throw new Error(`External attribution DTO predecessor mismatch for ${declaration.locator}: expected ${count}, found ${matches}`);
    }
    return { ...declaration, structuralSignatures };
  });
}
