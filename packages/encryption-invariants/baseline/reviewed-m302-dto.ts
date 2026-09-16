import type { DtoDeclaration } from "../src/node/dto-inventory";

export const REVIEWED_M302_DTO_DECLARATIONS: readonly DtoDeclaration[] = [{
  observationId:
    "wire.http.request.response.get.api.encryption.transition.policy.1yuyn5w",
  locator: "http:request_response:GET /api/encryption-transition/policy",
  structuralSignatures: [
    "response.body:{canManage:boolean;coveragePreview:{protected:string;unexercised:string;unsupported:string};policy:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowBehavior:\"fallback\"|\"strict\";updatedAt:string};responseVersion:1}",
    "response.body:{error:string}",
  ],
  arbitraryPayloads: [],
}];
