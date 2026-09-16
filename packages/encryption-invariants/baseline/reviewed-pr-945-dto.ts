import type { DtoDeclaration } from "../src/node/dto-inventory";

export const REVIEWED_PR_945_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    observationId:
      "wire.http.request.response.put.api.push.installations.bindingid.badge.preference.1xywv1u",
    locator:
      "http:request_response:PUT /api/push/installations/:bindingId/badge-preference",
    structuralSignatures: [
      "request.params:{bindingId:string}",
      "response.body:{bindingId:string;enabled:boolean;tokenGeneration:number;version:1}",
    ],
    arbitraryPayloads: [],
  },
];
