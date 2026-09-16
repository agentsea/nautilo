import type { DtoDeclaration } from "../src/node/dto-inventory";
import { REVIEWED_WAVE_12_DTO_DECLARATIONS } from "./reviewed-wave-12-dto";
import { REVIEWED_WAVE_13_DTO_DECLARATIONS } from "./reviewed-wave-13-dto";

const ACCESS_PROOF_INSERTION =
  "accessManifestBytesBase64url:string;accessManifestProofBytesBase64url?:string[];cryptoObjectId:string";

function wave12(locator: string): DtoDeclaration {
  const declaration = REVIEWED_WAVE_12_DTO_DECLARATIONS.find(
    (candidate) => candidate.locator === locator,
  );
  if (declaration === undefined) {
    throw new Error(`Wave 14 DTO predecessor is absent: ${locator}`);
  }
  return declaration;
}

function wave13(locator: string): DtoDeclaration {
  const declaration = REVIEWED_WAVE_13_DTO_DECLARATIONS.find(
    (candidate) => candidate.locator === locator,
  );
  if (declaration === undefined) {
    throw new Error(`Wave 14 DTO predecessor is absent: ${locator}`);
  }
  return declaration;
}

function withAccessProof(signature: string): string {
  return signature.replaceAll(
    "accessManifestBytesBase64url:string;cryptoObjectId:string",
    ACCESS_PROOF_INSERTION,
  );
}

function evolved(
  declaration: DtoDeclaration,
  transform: (signature: string) => string = withAccessProof,
): DtoDeclaration {
  return {
    ...declaration,
    structuralSignatures: (declaration.structuralSignatures ?? []).map(transform),
  };
}

const protectedPayloadLocators = [
  "http:request_response:GET /api/memory/brief",
  "http:request_response:GET /api/memory/brief/readonly",
  "http:request_response:GET /api/memory",
  "http:request_response:PATCH /api/memory/:id",
  "http:request_response:POST /api/memory/protected-create",
  "http:request_response:POST /api/memory/search",
] as const;

const protectedPayloadDeclarations = protectedPayloadLocators.map((locator) =>
  evolved(wave12(locator))
);

const detailDeclaration = evolved(
  wave13("http:request_response:GET /api/memory/:id"),
  (signature) => withAccessProof(signature).replaceAll(
    "canArchive:boolean;canDeleteConnection:boolean;canEdit:boolean;canManageAccess:boolean",
    "canArchive:boolean;canEdit:boolean;canManageAccess:boolean",
  ),
);

const deleteDeclaration: DtoDeclaration = {
  ...wave12("http:request_response:DELETE /api/memory/:id"),
  structuralSignatures: (wave12("http:request_response:DELETE /api/memory/:id")
    .structuralSignatures ?? []).filter((signature) =>
      signature
        !== "response.body:{error:string;hint?:string;namespaceCount:number;namespaceIds:string[]}"
      && signature
        !== "response.body:{memoryMode:\"namespace\"|\"scope\";status:\"deleted\"|\"detached\"}"
    ),
};

function withoutRetiredProtectedBranch(
  locator: string,
  retiredSignature: string,
): DtoDeclaration {
  const declaration = wave12(locator);
  return {
    ...declaration,
    structuralSignatures: (declaration.structuralSignatures ?? []).filter((signature) =>
      !signature.startsWith("response.body:{dtoVersion:1;reason:")
      && signature !== retiredSignature
    ),
  };
}

const retiredLegacyMutationDeclarations = [
  withoutRetiredProtectedBranch(
    "http:request_response:POST /api/memory/:id/grant",
    "response.body:{minted:boolean;roomLabel:string;status:\"granted\"}|{namespaceId:string;status:\"granted\"}",
  ),
  withoutRetiredProtectedBranch(
    "http:request_response:POST /api/memory/:id/make_private",
    "response.body:{skipped:string[];status:\"private\"}",
  ),
  withoutRetiredProtectedBranch(
    "http:request_response:POST /api/memory/:id/revoke",
    "response.body:{reHomed:number;skipped:string[];status:\"revoked\"}",
  ),
];

const exactAccessDeclarations: readonly DtoDeclaration[] = [
  {
    observationId:
      "wire.http.request.response.post.api.protected.memories.id.access.1g6tznr",
    locator: "http:request_response:POST /api/protected/memories/:id/access",
    structuralSignatures: [
      "response.body:{cryptoAccessRevision:number;dtoVersion:1;memoryId:string;operationId:string;requiredNamespaceIds:string[];status:\"replayed\"|\"updated\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId:
      "wire.http.request.response.post.api.protected.memories.id.access.plan.1vown7p",
    locator: "http:request_response:POST /api/protected/memories/:id/access-plan",
    structuralSignatures: [
      "response.body:{addedNamespaceIds:string[];cryptoObjectId:string;currentBindings:{bindingHashBase64url:string;domainId:string;expectedAccessRevision:number;expectedPolicyRevision:number;namespaceId:string}[];currentNamespaceIds:string[];deadlineAt:number;dtoVersion:1;expectedContentRevision:number;expectedCryptoAccessRevision:number;memoryId:string;operationId:string;planVersion:1;removedNamespaceIds:string[];sourceAuthorized:true;status:\"planned\";targetAuthorized:true;targetBindings:{bindingHashBase64url:string;domainId:string;expectedAccessRevision:number;expectedPolicyRevision:number;namespaceId:string}[];targetNamespaceIds:string[]}|{cryptoAccessRevision:number;dtoVersion:1;memoryId:string;requiredNamespaceIds:string[];status:\"unchanged\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
];

/** Exact current Memory DTOs after Wave 14's M:N access clean break. */
export const REVIEWED_WAVE_14_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
    deleteDeclaration,
    detailDeclaration,
    ...protectedPayloadDeclarations,
    ...retiredLegacyMutationDeclarations,
    ...exactAccessDeclarations,
  ];

/** Locators whose complete current signatures are replaced or retired by Wave 14. */
export const SUPERSEDED_WAVE_14_DTO_LOCATORS = new Set<string>([
  "http:request_response:DELETE /api/memory/:id",
  "http:request_response:DELETE /api/protected/memories/:id/connection",
  "http:request_response:GET /api/memory/:id",
  "http:request_response:GET /api/memory/brief",
  "http:request_response:GET /api/memory/brief/readonly",
  "http:request_response:GET /api/memory",
  "http:request_response:PATCH /api/memory/:id",
  "http:request_response:POST /api/memory/:id/grant",
  "http:request_response:POST /api/memory/:id/make_private",
  "http:request_response:POST /api/memory/:id/revoke",
  "http:request_response:POST /api/memory/protected-create",
  "http:request_response:POST /api/memory/search",
]);
