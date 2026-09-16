import type { DtoDeclaration } from "../src/node/dto-inventory";

const FAMILIES = [
  "message",
  "memory",
  "journal_event",
  "reflection_record",
  "artifact",
  "task",
] as const;

function familySignature(family: (typeof FAMILIES)[number]): string {
  return `{accessible:null;encryptedCounterpart:null;family:"${family}";measurement:"unavailable";plaintextPresent:null}`
    + `|{accessible:string;encryptedCounterpart:null;family:"${family}";measurement:"unsupported";plaintextPresent:string}`
    + `|{accessible:string;encryptedCounterpart:string;family:"${family}";measurement:"measured";plaintextPresent:string}`;
}

const RESPONSE_SIGNATURE =
  "response.body:{computedAt:null;dtoVersion:1;families:unknown[];policy:\"plaintext_only\"}"
  + "|{computedAt:string;dtoVersion:1;families:["
  + FAMILIES.map(familySignature).join(",")
  + ",unknown];policy:\"encrypted_only\"|\"shadow_encryption\"}";

export const REVIEWED_M308_DTO_DECLARATIONS: readonly DtoDeclaration[] = [{
  observationId:
    "wire.http.request.response.get.api.encryption.coverage.me.14354wl",
  locator: "http:request_response:GET /api/encryption/coverage/me",
  structuralSignatures: [
    "request.query:{[key:string]:unknown}",
    RESPONSE_SIGNATURE,
    "response.body:{error:string}",
  ],
  arbitraryPayloads: [
    { path: "request.query", schema: "EmptyPersonalEncryptionCoverageQueryV1" },
    {
      path: "response.body.families[6]",
      schema: "PersonalEncryptionCoverageFamilyV1",
    },
    {
      path: "response.body.families[]",
      schema: "PersonalEncryptionCoverageFamilyV1",
    },
  ],
}];
