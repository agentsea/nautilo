import type { DtoDeclaration } from "../src/node/dto-inventory";

const UNAVAILABLE_RESPONSE =
  "response.body:{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}";

/** Exact dormant single-audience Human Memory HTTP DTOs reviewed for Wave 13. */
export const REVIEWED_WAVE_13_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
  {
    observationId:
      "wire.http.request.response.delete.api.protected.memories.id.connection.1ubrdxy",
    locator:
      "http:request_response:DELETE /api/protected/memories/:id/connection",
    structuralSignatures: [
      "response.body:{dtoVersion:1;memoryId:string;operationId:string;status:\"deleted\"|\"replayed\"}",
      UNAVAILABLE_RESPONSE,
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.get.api.memory.id.1d5thzp",
    locator: "http:request_response:GET /api/memory/:id",
    structuralSignatures: [
      "request.params:{id:string}",
      "response.body:{actionAuthority:{canArchive:boolean;canDeleteConnection:boolean;canEdit:boolean;canManageAccess:boolean};dtoVersion:1;memory:{dtoVersion:1;projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;namespaceIds:string[];requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"incomplete_access_set\"|\"lost_key_material\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};memoryMode:\"namespace\"|\"scope\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};memory:{accessList:{displayName:string;userHandle:string}[];content:string;createdAt:Date;demotedAt:Date;demotedFrom:number;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date};memoryMode:\"namespace\"}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};memory:{content:string;createdAt:Date;demotedAt:Date;demotedFrom:number;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date};memoryMode:\"scope\"}",
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId:
      "wire.http.request.response.post.api.protected.memories.id.archive.1snt5yp",
    locator: "http:request_response:POST /api/protected/memories/:id/archive",
    structuralSignatures: [
      "response.body:{contentRevision:number;cryptoAccessRevision:number;dtoVersion:1;memoryId:string;operationId:string;status:\"archived\"|\"replayed\";tier:3}",
      UNAVAILABLE_RESPONSE,
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId:
      "wire.http.request.response.post.api.protected.memories.id.restore.1w6wkkt",
    locator: "http:request_response:POST /api/protected/memories/:id/restore",
    structuralSignatures: [
      "response.body:{contentRevision:number;cryptoAccessRevision:number;dtoVersion:1;memoryId:string;nextTier?:1|2;operationId:string;previousTier:3;status:\"replayed\"|\"restored\"}",
      UNAVAILABLE_RESPONSE,
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId:
      "wire.http.request.response.post.api.protected.memories.id.tier.4llenh",
    locator: "http:request_response:POST /api/protected/memories/:id/tier",
    structuralSignatures: [
      "response.body:{contentRevision:number;cryptoAccessRevision:number;dtoVersion:1;memoryId:string;nextTier?:1|2|3;operationId:string;previousTier?:1|2;status:\"demoted\"|\"promoted\"|\"replayed\"}",
      UNAVAILABLE_RESPONSE,
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
];

/** Locators whose complete current signatures are replaced by Wave 13. */
export const SUPERSEDED_WAVE_13_DTO_LOCATORS = new Set<string>([
  "http:request_response:GET /api/memory/:id",
]);
