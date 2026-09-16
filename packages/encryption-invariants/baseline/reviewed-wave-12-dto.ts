import type { DtoDeclaration } from "../src/node/dto-inventory";

/** Exact protected and legacy Memory HTTP DTOs reviewed for Wave 12. */
export const REVIEWED_WAVE_12_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.request.response.delete.api.memory.id.1r7yjxy",
    "locator": "http:request_response:DELETE /api/memory/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "request.query:{confirmShared?:string;mode?:string}",
      "response.body:{error:string;hint:string;namespaceCount:number;namespaceIds:string[]}",
      "response.body:{error:string;hint?:string;namespaceCount:number;namespaceIds:string[]}",
      "response.body:{error:string;namespaceCount:number;namespaceIds:string[]}",
      "response.body:{error:string}",
      "response.body:{memoryMode:\"namespace\";status:\"deleted\"|\"detached_only\"}",
      "response.body:{memoryMode:\"namespace\";status:string}",
      "response.body:{memoryMode:\"namespace\"|\"scope\";status:\"deleted\"|\"detached\"}",
      "response.body:{memoryMode:\"scope\";status:\"deleted\"|\"detached_only\"}",
      "response.body:{memoryMode:\"scope\";status:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.memory.brief.1ii48m2",
    "locator": "http:request_response:GET /api/memory/brief",
    "structuralSignatures": [
      "response.body:{brief:string}",
      "response.body:{dtoVersion:1;items:{dtoVersion:1;projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;namespaceIds:string[];requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"incomplete_access_set\"|\"lost_key_material\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}}[];memoryMode:\"namespace\"|\"scope\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.memory.brief.readonly.1qafhm5",
    "locator": "http:request_response:GET /api/memory/brief/readonly",
    "structuralSignatures": [
      "response.body:{brief:string}",
      "response.body:{dtoVersion:1;items:{dtoVersion:1;projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;namespaceIds:string[];requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"incomplete_access_set\"|\"lost_key_material\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}}[];memoryMode:\"namespace\"|\"scope\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.memory.id.1d5thzp",
    "locator": "http:request_response:GET /api/memory/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};dtoVersion:1;memory:{dtoVersion:1;projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;namespaceIds:string[];requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"incomplete_access_set\"|\"lost_key_material\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};memoryMode:\"namespace\"|\"scope\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};memory:{accessList:{displayName:string;userHandle:string}[];content:string;createdAt:Date;demotedAt:Date;demotedFrom:number;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date};memoryMode:\"namespace\"}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};memory:{content:string;createdAt:Date;demotedAt:Date;demotedFrom:number;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date};memoryMode:\"scope\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.memory.ppbrt",
    "locator": "http:request_response:GET /api/memory",
    "structuralSignatures": [
      "request.query:{audience?:string;person?:string;room?:string}",
      "response.body:{dtoVersion:1;items:{dtoVersion:1;projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;namespaceIds:string[];requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"incomplete_access_set\"|\"lost_key_material\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}}[];memoryMode:\"namespace\"|\"scope\";nextCursor?:string;total?:number}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}",
      "response.body:{items:undefined[];memoryMode:\"namespace\";nextCursor:null;total:number}",
      "response.body:{items:{accessList:{displayName:string;userHandle:string}[]}&{content:string;createdAt:Date;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date}[];memoryMode:\"namespace\";nextCursor:string;total:number}",
      "response.body:{items:{content:string;createdAt:Date;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date}[];memoryMode:\"scope\";nextCursor:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.memory.search.18jkqwa",
    "locator": "http:request_response:GET /api/memory/search",
    "structuralSignatures": [
      "request.query:{includeArchive?:string;limit?:string;mode?:string;q?:string}",
      "response.body:{error:string}",
      "response.body:{memoryMode:\"namespace\";results:undefined[]}",
      "response.body:{memoryMode:\"namespace\";results:{content:string;createdAt:Date;id:string;importance:number;score:number;tier:number;type:string}[]}",
      "response.body:{memoryMode:\"scope\";results:{content:string;createdAt:Date;id:string;importance:number;score:number;tier:number;type:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.profile.bundle.export.ltsid3",
    "locator": "http:request_response:GET /api/profile/bundle/export",
    "structuralSignatures": [
      "response.body:{avatarMedia:{mediaEntry:string;mimeType:string;sha256:string;size:number};bundleId:string;records:{avatar:{height:number;mediaEntry:string;mimeType:string;sha256:string;width:number};recordKind:\"avatar\"}|{bytesEntry:string;mimeType:string;path:string;recordKind:\"artifact\";sha256:string;size:number}|{content:string;createdAt:string;recordKind:\"memory\";scope:\"private\";type:string}|{content:string;createdAt:string;recordKind:\"memory\";scope:\"private\";type?:never}|{disabledByDefault:true;kind:\"command\"|\"skill\";name:string;recordKind:\"skill\"}|{handleIntent:string;name:string;recordKind:\"identity\"}|{policy:{fallbackModel:string;primaryModel:string;temperature:number};recordKind:\"modelPolicy\"}|{preferences:{[key:string]:false|number|string|true};recordKind:\"preferences\"}|{recordKind:\"personality\";text:string}|{recordKind:\"soul\";text:string}|{recordKind:\"voices\";voices:{label:string;provider:string;slot?:string;voiceId:string;voiceUri:string}[]}[];scopes:\"avatar\"|\"privateArtifacts\"|\"privateMemories\"|\"profile\"|\"skills\"[];semanticVersion:{major:number;minor:number}}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.patch.api.memory.id.1v4c0hr",
    "locator": "http:request_response:PATCH /api/memory/:id",
    "structuralSignatures": [
      "request.body:{content?:string;importance?:number;namespaceId?:string}",
      "request.params:{id:string}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};memory:{content:string;createdAt:Date;demotedAt:Date;demotedFrom:number;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date};memoryMode:\"namespace\"}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};memory:{content:string;createdAt:Date;demotedAt:Date;demotedFrom:number;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date};memoryMode:\"scope\"}",
      "response.body:{dtoVersion:1;memory:{dtoVersion:1;projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;namespaceIds:string[];requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"incomplete_access_set\"|\"lost_key_material\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};status:\"published\"|\"replayed\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.memory.id.grant.1sy9kci",
    "locator": "http:request_response:POST /api/memory/:id/grant",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:any}",
      "response.body:{error:string}",
      "response.body:{minted:boolean;roomLabel:string;status:\"granted\"}|{namespaceId:string;status:\"granted\"}",
      "response.body:{minted:boolean;roomLabel:string;status:string}",
      "response.body:{namespaceId:string;status:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.li39i"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.memory.id.make.private.12fcsye",
    "locator": "http:request_response:POST /api/memory/:id/make_private",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}",
      "response.body:{skipped:string[];status:\"private\"}",
      "response.body:{skipped:string[];status:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.memory.id.revoke.ybmnki",
    "locator": "http:request_response:POST /api/memory/:id/revoke",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}",
      "response.body:{reHomed:number;skipped:string[];status:\"revoked\"}",
      "response.body:{reHomed:number;skipped:string[];status:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.memory.protected.create.7joo75",
    "locator": "http:request_response:POST /api/memory/protected-create",
    "structuralSignatures": [
      "response.body:{dtoVersion:1;memory:{dtoVersion:1;projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;namespaceIds:string[];requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"incomplete_access_set\"|\"lost_key_material\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};status:\"published\"|\"replayed\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.memory.protected.create.plan.1tm4bcn",
    "locator": "http:request_response:POST /api/memory/protected-create-plan",
    "structuralSignatures": [
      "response.body:{deadlineAt:number;dtoVersion:1;expectedContentRevision:0;memoryId:string;nextContentRevision:1;operationId:string;productAuthority?:{mode:\"namespace\"}|{mode:\"scope\";originWritableNamespaceId:string;scopeId:string};requiredNamespaceIds:string[]}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.memory.search.1v76gw4",
    "locator": "http:request_response:POST /api/memory/search",
    "structuralSignatures": [
      "response.body:{dtoVersion:1;items:{memory:{dtoVersion:1;projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;namespaceIds:string[];requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"incomplete_access_set\"|\"lost_key_material\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};score:number}[];memoryMode:\"namespace\"|\"scope\";queryDisclosure:\"embedding_provider\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  }
];

/** Locators whose complete current signatures are replaced by the Wave 12 review. */
export const SUPERSEDED_WAVE_12_DTO_LOCATORS = new Set<string>([
  "http:request_response:DELETE /api/memory/:id",
  "http:request_response:GET /api/memory/brief",
  "http:request_response:GET /api/memory/brief/readonly",
  "http:request_response:GET /api/memory/:id",
  "http:request_response:GET /api/memory",
  "http:request_response:GET /api/memory/search",
  "http:request_response:GET /api/profile/bundle/export",
  "http:request_response:PATCH /api/memory/:id",
  "http:request_response:POST /api/memory/:id/grant",
  "http:request_response:POST /api/memory/:id/make_private",
  "http:request_response:POST /api/memory/:id/revoke",
  "http:request_response:POST /api/memory/protected-create",
  "http:request_response:POST /api/memory/protected-create-plan",
  "http:request_response:POST /api/memory/search"
]);
