import type { DtoDeclaration } from "../src/node/dto-inventory";

const SUPERSEDED = [
  "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody",
  "http:accepted_arbitrary:packages/types/src/api.ts#SendMessageRequest",
  "http:request_response:GET /api/config/models",
  "http:request_response:GET /api/directory/search",
  "http:request_response:PATCH /api/profile/fallback",
  "http:request_response:POST /api/chat",
  "http:request_response:POST /api/rooms",
  "http:request_response:POST /api/rooms/:roomId/messages",
  "http:request_response:PUT /api/profile",
  "http:request_response:PUT /api/rooms/:roomId/agents/:agentId/model-control-selection",
] as const;

export const SUPERSEDED_MAIN_2026_08_14_DTO_LOCATORS = new Set<string>(
  SUPERSEDED,
);

function replaceSignature(
  declaration: DtoDeclaration,
  before: string,
  after: string,
): DtoDeclaration {
  return {
    ...declaration,
    structuralSignatures: (declaration.structuralSignatures ?? []).map(
      (signature) => signature.replace(before, after),
    ),
  };
}

function updateDeclaration(declaration: DtoDeclaration): DtoDeclaration {
  let updated = declaration;
  switch (declaration.locator) {
    case "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody":
      updated = replaceSignature(
        declaration,
        "autoApprove?:boolean;content:string",
        "autoApprove?:boolean;clientActionSessionId?:unknown;content:string",
      );
      return {
        ...updated,
        arbitraryPayloads: [
          ...updated.arbitraryPayloads,
          { path: "clientActionSessionId", schema: "ClientActionSessionIdV1" },
        ],
      };
    case "http:accepted_arbitrary:packages/types/src/api.ts#SendMessageRequest":
      return replaceSignature(
        declaration,
        "autoApprove?:boolean|undefined;currentFolder?",
        "autoApprove?:boolean|undefined;clientActionSessionId?:string|undefined;currentFolder?",
      );
    case "http:request_response:GET /api/config/models":
      return replaceSignature(
        declaration,
        'availability:"filtered"|"missing-key"|"selectable";',
        'availability:"filtered"|"missing-key"|"selectable"|"unknown-model"|"unsupported-capability";',
      );
    case "http:request_response:GET /api/directory/search":
      return replaceSignature(
        declaration,
        "request.query:{kind?:string;",
        "request.query:{agentScope?:string;kind?:string;",
      );
    case "http:request_response:PATCH /api/profile/fallback":
      return {
        ...declaration,
        structuralSignatures: [
          ...(declaration.structuralSignatures ?? []).filter((signature) =>
            signature !== "response.body:{error:string;unknown:string[]}"
          ),
          'response.body:{code:string;error:string;models:{availability:"filtered"|"missing-key"|"selectable"|"unknown-model"|"unsupported-capability";modelId:string;reason:string}[]}',
        ].sort(),
      };
    case "http:request_response:POST /api/chat":
      return replaceSignature(
        declaration,
        "autoApprove?:boolean;currentFolder?",
        "autoApprove?:boolean;clientActionSessionId?:string;currentFolder?",
      );
    case "http:request_response:POST /api/rooms/:roomId/messages": {
      updated = replaceSignature(
        declaration,
        "autoApprove?:boolean;content:string",
        "autoApprove?:boolean;clientActionSessionId?:unknown;content:string",
      );
      return {
        ...updated,
        arbitraryPayloads: [
          ...updated.arbitraryPayloads,
          {
            path: "request.body.clientActionSessionId",
            schema: "ClientActionSessionIdV1",
          },
        ],
      };
    }
    case "http:request_response:POST /api/rooms":
      updated = replaceSignature(
        declaration,
        'request.body:{kind?:"group"|"open"|"private";',
        'request.body:{catalogueKind?:"chat"|"room";directHumanUserId?:string;kind?:"group"|"open"|"private";',
      );
      updated = replaceSignature(
        updated,
        "members?:{id:string;kind:\"agent\"|\"user\"}[]}",
        "members?:{id:string;kind:\"agent\"|\"user\"}[];personalAgentId?:string}",
      );
      return {
        ...updated,
        structuralSignatures: [
          ...(updated.structuralSignatures ?? []),
          'response.body:{error:"agent_not_found"|"agent_not_reachable"|"user_not_found"|"user_not_reachable";memberId:string;memberKind:"agent"|"user"}',
        ].sort(),
      };
    case "http:request_response:PUT /api/profile":
      return {
        ...declaration,
        structuralSignatures: [
          ...(declaration.structuralSignatures ?? []),
          'response.body:{code:string;error:string;model:{availability:"filtered"|"missing-key"|"unknown-model"|"unsupported-capability";modelId:string;reason:string}}',
        ].sort(),
      };
    case "http:request_response:PUT /api/rooms/:roomId/agents/:agentId/model-control-selection":
      return {
        ...declaration,
        structuralSignatures: [
          ...(declaration.structuralSignatures ?? []),
          "response.body:{code:string;error:string}",
        ].sort(),
      };
    default:
      throw new Error(`Unexpected 2026-08-14 DTO replacement: ${declaration.locator}`);
  }
}

export function reviewedMain20260814DtoReplacements(
  previous: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return SUPERSEDED.map((locator) => {
    const declaration = previous.find((candidate) => candidate.locator === locator);
    if (declaration === undefined) {
      throw new Error(`Missing superseded DTO declaration: ${locator}`);
    }
    return updateDeclaration(declaration);
  });
}

export const REVIEWED_MAIN_2026_08_14_NEW_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
  {
    observationId: "wire.http.request.response.get.api.protected.artifacts.artifactid.ciphertext.vksajv",
    locator: "http:request_response:GET /api/protected/artifacts/:artifactId/ciphertext",
    structuralSignatures: [
      "request.query:object",
      "response.body:Buffer",
      'response.body:{dtoVersion:1;reason:"authorization_required"|"encryption_pending"|"integrity_failure"|"journal_full"|"stale_revision"|"storage_unavailable"|"target_encryption_not_ready";status:"unavailable"}',
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.get.api.protected.artifacts.artifactid.e0bvui",
    locator: "http:request_response:GET /api/protected/artifacts/:artifactId",
    structuralSignatures: [
      'response.body:{accessManifestBytesBase64url:string;accessManifestProofBytesBase64url:string[];archived:boolean;artifactId:string;artifactRevision:number;blobGeneration:number;blobId:string;canManageAccess:boolean;chunkCount:number;chunkPlaintextBytes:1048576;ciphertextLength:number;ciphertextSha256Base64url:string;cryptoAccessRevision:number;cryptoObjectId:string;dtoVersion:1;encryptedControlPayloadBytesBase64url:string;mimeClass:"archive"|"audio"|"binary"|"document"|"image"|"text"|"video";namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];requiredNamespaceIds:string[];sizeBucket:"empty"|"le_100_mib"|"le_10_mib"|"le_1_mib"|"le_64_kib";status:"encrypted"}|{dtoVersion:1;reason:"authorization_required"|"encryption_pending"|"integrity_failure"|"journal_full"|"stale_revision"|"storage_unavailable"|"target_encryption_not_ready";status:"unavailable"}',
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.get.api.protected.artifacts.iue46s",
    locator: "http:request_response:GET /api/protected/artifacts",
    structuralSignatures: [
      "request.query:{[key:string]:unknown}",
      'response.body:{dtoVersion:1;items:{accessManifestBytesBase64url:string;accessManifestProofBytesBase64url:string[];archived:boolean;artifactId:string;artifactRevision:number;blobGeneration:number;blobId:string;canManageAccess:boolean;chunkCount:number;chunkPlaintextBytes:1048576;ciphertextLength:number;ciphertextSha256Base64url:string;cryptoAccessRevision:number;cryptoObjectId:string;dtoVersion:1;encryptedControlPayloadBytesBase64url:string;mimeClass:"archive"|"audio"|"binary"|"document"|"image"|"text"|"video";namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];requiredNamespaceIds:string[];sizeBucket:"empty"|"le_100_mib"|"le_10_mib"|"le_1_mib"|"le_64_kib";status:"encrypted"}[];nextCursor?:string}|{dtoVersion:1;reason:"authorization_required"|"encryption_pending"|"integrity_failure"|"journal_full"|"stale_revision"|"storage_unavailable"|"target_encryption_not_ready";status:"unavailable"}',
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [
      { path: "request.query", schema: "ProtectedArtifactListQueryV1" },
    ],
  },
  {
    observationId: "wire.http.request.response.post.api.config.models.resolve.qialku",
    locator: "http:request_response:POST /api/config/models/resolve",
    structuralSignatures: [
      'response.body:{availability:"filtered"|"missing-key"|"selectable"|"unknown-model"|"unsupported-capability";capabilities:{e2ee:boolean;reasoning:boolean;tools:boolean;vision:boolean;webSearch:boolean};controls?:{reasoning?:{canDisable:boolean;defaultLevel:"high"|"low"|"max"|"medium"|"minimal"|"off"|"xhigh";levels:"high"|"low"|"max"|"medium"|"minimal"|"xhigh"[];mandatory:boolean};serving?:{defaultProfile:string;profiles:{description?:string;id:string;intent:"balanced"|"reliability"|"throughput";label:string;pricing?:{cachedInputPerMtok:number;inputPerMtok:number;outputPerMtok:number}}[]}};costCoefficient:number;displayName:string;enabled:boolean;id:string;priority:number;provider:string;routing?:"china-anonymized"|"unknown"|"venice-hosted"|"western-anonymized";unavailableReason?:string}[]',
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.post.api.protected.artifacts.artifactid.access.1kxeml7",
    locator: "http:request_response:POST /api/protected/artifacts/:artifactId/access",
    structuralSignatures: [
      'response.body:{artifactId:string;cryptoAccessRevision:number;dtoVersion:1;operationId:string;requiredNamespaceIds:string[];status:"replayed"|"updated"}|{dtoVersion:1;reason:"authorization_required"|"encryption_pending"|"integrity_failure"|"journal_full"|"stale_revision"|"storage_unavailable"|"target_encryption_not_ready";status:"unavailable"}',
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.post.api.protected.artifacts.artifactid.access.plan.yf78ll",
    locator: "http:request_response:POST /api/protected/artifacts/:artifactId/access-plan",
    structuralSignatures: [
      'response.body:{addedNamespaceIds:string[];artifactId:string;artifactRevision:number;blobGeneration:number;blobId:string;cryptoObjectId:string;currentBindings:{bindingHashBase64url:string;domainId:string;expectedAccessRevision:number;expectedPolicyRevision:number;namespaceId:string}[];currentNamespaceIds:string[];deadlineAt:number;dtoVersion:1;expectedCryptoAccessRevision:number;nextCryptoAccessRevision:number;operationId:string;planVersion:1;removedNamespaceIds:string[];sourceAuthorized:true;status:"planned";targetAuthorized:true;targetBindings:{bindingHashBase64url:string;domainId:string;expectedAccessRevision:number;expectedPolicyRevision:number;namespaceId:string}[];targetNamespaceIds:string[]}|{artifactId:string;cryptoAccessRevision:number;dtoVersion:1;requiredNamespaceIds:string[];status:"unchanged"}|{dtoVersion:1;reason:"authorization_required"|"encryption_pending"|"integrity_failure"|"journal_full"|"stale_revision"|"storage_unavailable"|"target_encryption_not_ready";status:"unavailable"}',
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.post.api.protected.artifacts.artifactid.publication.6lw14t",
    locator: "http:request_response:POST /api/protected/artifacts/:artifactId/publication",
    structuralSignatures: [
      'response.body:{artifactId:string;artifactRevision:number;blobGeneration:number;blobId:string;cryptoAccessRevision:number;dtoVersion:1;operationId:string;requiredNamespaceIds:string[];status:"published"|"replayed"}|{dtoVersion:1;reason:"authorization_required"|"encryption_pending"|"integrity_failure"|"journal_full"|"stale_revision"|"storage_unavailable"|"target_encryption_not_ready";status:"unavailable"}',
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.post.api.protected.artifacts.publication.plan.oajzjp",
    locator: "http:request_response:POST /api/protected/artifacts/publication-plan",
    structuralSignatures: [
      'response.body:{anchorNamespaceId:string;artifactId:string;artifactRowId:string;bindings:{bindingHashBase64url:string;domainId:string;expectedAccessRevision:number;expectedPolicyRevision:number;namespaceId:string}[];chunkPlaintextBytes:1048576;cryptoObjectId:string;deadlineAt:number;dtoVersion:1;expectedArtifactRevision:number;expectedBlobGeneration:number;expectedBlobId?:string;expectedCryptoAccessRevision:number;lifecycleAction:"activate"|"archive";maxCiphertextBytes:number;maxPlaintextBytes:number;mimeClass:"archive"|"audio"|"binary"|"document"|"image"|"text"|"video";nextArtifactRevision:number;operation:"create"|"replace_content"|"revise_control";operationId:string;planDigestBase64url:string;planVersion:1;requiredNamespaceIds:string[];resultBlobGeneration:number;resultBlobId:string;resultCryptoAccessRevision:0;sizeBucket:"empty"|"le_100_mib"|"le_10_mib"|"le_1_mib"|"le_64_kib";status:"planned"}|{dtoVersion:1;reason:"authorization_required"|"encryption_pending"|"integrity_failure"|"journal_full"|"stale_revision"|"storage_unavailable"|"target_encryption_not_ready";status:"unavailable"}',
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.put.api.protected.artifacts.artifactid.ciphertext.operationid.a0pub1",
    locator: "http:request_response:PUT /api/protected/artifacts/:artifactId/ciphertext/:operationId",
    structuralSignatures: [
      "request.body:AsyncIterable",
      'response.body:{artifactId:string;blobGeneration:number;blobId:string;ciphertextLength:number;ciphertextSha256Base64url:string;dtoVersion:1;operationId:string;status:"replayed"|"staged"}|{dtoVersion:1;reason:"authorization_required"|"encryption_pending"|"integrity_failure"|"journal_full"|"stale_revision"|"storage_unavailable"|"target_encryption_not_ready";status:"unavailable"}',
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.ws.server.to.client.client.session.v1.1k71ylc",
    locator: "ws:server_to_client:client.session.v1",
    structuralSignatures: [],
    arbitraryPayloads: [],
  },
];
