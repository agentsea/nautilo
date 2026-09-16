import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_POST_M320_MERGE_DTO_LOCATORS = new Set<string>([
  "http:request_response:GET /api/memory/processor-recipient",
  "http:request_response:POST /api/protected/memories/:id/repair",
  "http:request_response:POST /api/protected/memories/:id/repair-plan",
  "http:request_response:POST /api/protected/memories/read-observation"
]);

export const REVIEWED_POST_M320_MERGE_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.request.response.get.api.memory.processor.recipient.10ywp8",
    "locator": "http:request_response:GET /api/memory/processor-recipient",
    "structuralSignatures": [
      "response.body:{embedding?:{dimensions:1536;model:string;provider:\"openai\"|\"openrouter\"|\"venice\"};formatVersion:1;publicKeyBase64url:string;purpose:\"memory.foreground_embedding\";recipientId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.memories.id.repair.1wuadv4",
    "locator": "http:request_response:POST /api/protected/memories/:id/repair",
    "structuralSignatures": [
      "response.body:{contentRevision:number;cryptoAccessRevision:number;direction:\"ordinary_to_protected\"|\"protected_to_ordinary\";dtoVersion:1;memoryId:string;operationId:string;status:\"repaired\"|\"replayed\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"protected_representation_missing\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.memories.id.repair.plan.qntqzk",
    "locator": "http:request_response:POST /api/protected/memories/:id/repair-plan",
    "structuralSignatures": [
      "response.body:{createdAt:number;cryptoObjectId:string;deadlineAt:number;direction:\"ordinary_to_protected\";dtoVersion:1;expectedContentRevision:number;expectedCryptoAccessRevision:number;memoryId:string;mode:\"shadow_encryption\";operationId:string;policyRevision:number;repairInput:{content:string;formatVersion:1;type:string};requiredNamespaceFingerprintBase64url:string;requiredNamespaceIds:string[];shadowBehavior:\"fallback\"|\"strict\";status:\"planned\";targetAuthorities:{currentGeneration:number;namespaceId:string;retainedGenerations:{accessRevision:number;audienceFingerprintBase64url:string;generation:number;headDigestBase64url:string;publicationDigestBase64url:string;publicationSetDigestBase64url:string}[];sourceRoomId:string}[];targetContentRevision:number}|{createdAt:number;cryptoObjectId:string;deadlineAt:number;direction:\"protected_to_ordinary\";dtoVersion:1;expectedContentRevision:number;expectedCryptoAccessRevision:number;memoryId:string;mode:\"shadow_encryption\";operationId:string;policyRevision:number;repairInput:{dtoVersion:1;ordinaryFallback?:{payload:{content:string;formatVersion:1;type:string};policyRevision:number};projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;mutationAuthorities?:{currentGeneration:number;namespaceId:string;retainedGenerations:{accessRevision:number;audienceFingerprintBase64url:string;generation:number;headDigestBase64url:string;publicationDigestBase64url:string;publicationSetDigestBase64url:string}[];sourceRoomId:string}[];namespaceIds:string[];readAuthorities:{currentGeneration:number;namespaceId:string;retainedGenerations:{accessRevision:number;audienceFingerprintBase64url:string;generation:number;headDigestBase64url:string;publicationDigestBase64url:string;publicationSetDigestBase64url:string}[];sourceRoomId:string}[];representationRepair?:\"ordinary_to_protected\"|\"protected_to_ordinary\";requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;accessManifestProofBytesBase64url?:string[];accessSignerEvidence:{committerDeviceId:string;hostAuthorizationRevision:number;kind:\"human_device\";signingPublicKeyBase64url:string;subjectHumanId:string}|{deviceId:string;hostAuthorizationRevision:number;kind:\"evidence_issuer_human_device\";signingPublicKeyBase64url:string;subjectHumanId:string}|{evidenceBytesBase64url:string;kind:\"agent_runtime_publication\"|\"processor_authorization\"}|{kind:\"foreground_agent_accepted_execution\";planBytesBase64url:string;planDigestBase64url:string}[];cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason?:\"authorization_required\"|\"corrupt\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"lost_key_material\"|\"missing_mapping\"|\"protected_representation_missing\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"};readObservationAdmission?:{expiresAt:number;issuedAt:number;policyRevision:number;tokenBase64url:string};shadowComparison?:{algorithm:\"sha256-memory-payload-v1\";digestBase64url:string}};requiredNamespaceFingerprintBase64url:string;requiredNamespaceIds:string[];shadowBehavior:\"fallback\"|\"strict\";status:\"planned\";targetAuthorities:{currentGeneration:number;namespaceId:string;retainedGenerations:{accessRevision:number;audienceFingerprintBase64url:string;generation:number;headDigestBase64url:string;publicationDigestBase64url:string;publicationSetDigestBase64url:string}[];sourceRoomId:string}[];targetContentRevision:number}|{dtoVersion:1;memoryId:string;status:\"not_needed\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"protected_representation_missing\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.memories.read.observation.1gklzjy",
    "locator": "http:request_response:POST /api/protected/memories/read-observation",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{status:\"accepted\"|\"conflict\"|\"unavailable\"}"
    ],
    "arbitraryPayloads": []
  }
];
