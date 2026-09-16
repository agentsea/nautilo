import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_M300_DTO_LOCATORS = new Set<string>([
  "http:request_response:POST /api/protected/devices/additional/begin",
  "http:request_response:POST /api/protected/devices/additional/pending",
  "http:request_response:POST /api/protected/devices/additional/:operationId/activate",
  "http:request_response:POST /api/protected/devices/additional/:operationId/transition-plan"
]);

export const REVIEWED_M300_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.begin.1ju9zwc",
    "locator": "http:request_response:POST /api/protected/devices/additional/begin",
    "structuralSignatures": [
      "response.body:{approver:{deviceId:string;signingPublicKeyBase64url:string};domainCount:number;domains:{authorizationRevision:number;committerDeviceId:string;committerSigningPublicKeyBase64url:string;domainId:string;expectedHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};namespaces:{accessRevision:number;aiEnvelopeBytesBase64url:string;bindingHashBase64url:string;bindingProofBytesBase64url:string[];humanEnvelopeBytesBase64url:string;namespaceId:string}[];participantDigestBase64url:string;rosterBytesBase64url:string}[];enrollment:{authorizationDigestBase64url:string;authorizationEvidenceDigestBase64url:string;challengeId:string;clientKind:\"browser\"|\"electron\";deviceGeneration:1;deviceId:string;deviceRevision:0;encryptionPublicKeyBase64url:string;expectedCustodyRevision:number;expectedRecoveryGeneration:number;expiresAt:number;formatVersion:1;humanActorId:string;idempotencyKey:string;installationLineageDigestBase64url:string;inventoryCount:number;inventoryDigestBase64url:string;inventoryRevision:number;issuedAt:number;method:\"device_approval\";operationId:string;signingPublicKeyBase64url:string;status:\"pending\";userId:string};formatVersion:2;page:{end:number;nextStart?:number;pageDigestBase64url:string;start:number};progress?:\"approval_required\"|\"awaiting_target\"|\"transfer_ready\"}",
      "response.body:{domains:{authorizationRevision:number;committerDeviceId:string;committerSigningPublicKeyBase64url:string;domainId:string;expectedHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};namespaces:{accessRevision:number;aiEnvelopeBytesBase64url:string;bindingHashBase64url:string;bindingProofBytesBase64url:string[];humanEnvelopeBytesBase64url:string;namespaceId:string}[];participantDigestBase64url:string;rosterBytesBase64url:string}[];enrollment:{authorizationDigestBase64url:string;authorizationEvidenceDigestBase64url:string;challengeId:string;clientKind:\"browser\"|\"electron\";deviceGeneration:1;deviceId:string;deviceRevision:0;encryptionPublicKeyBase64url:string;expectedCustodyRevision:number;expectedRecoveryGeneration:number;expiresAt:number;formatVersion:1;humanActorId:string;idempotencyKey:string;installationLineageDigestBase64url:string;inventoryCount:number;inventoryDigestBase64url:string;inventoryRevision:number;issuedAt:number;method:\"device_approval\";operationId:string;signingPublicKeyBase64url:string;status:\"pending\";userId:string};formatVersion:1;progress?:\"approval_required\"|\"awaiting_target\"|\"transfer_ready\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.grant.sync.pending.1uhcqqn",
    "locator": "http:request_response:POST /api/protected/devices/additional/grant-sync-pending",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{formatVersion:1;pending:{humanActorId:string;operationId:string;targetClientKind:\"browser\"|\"electron\";targetDeviceId:string;targetSigningPublicKeyBase64url:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.activate.c0y3tj",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/activate",
    "structuralSignatures": [
      "response.body:{custodyRevision?:number;deviceId:string;deviceRevision?:number;formatVersion:1;operationId:string;status:\"active\"|\"syncing\";syncReason?:\"current_domain_sync_required\"|\"delivery_pending\"|\"grant_sync_required\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.grant.sync.page.1lbqfso",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/grant-sync-page",
    "structuralSignatures": [
      "response.body:{domains:{grantDomainId:string;namespaceId:string;namespaces?:{namespaceId:string;roomId:string}[];roomId:string}[];formatVersion:1;operationId:string;page:{end:number;nextStart?:number;pageDigestBase64url:string;start:number};targetDeviceId:string;totalGrantDomains:number}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.plan.page.6x2cu3",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/plan-page",
    "structuralSignatures": [
      "response.body:{approver:{deviceId:string;signingPublicKeyBase64url:string};domainCount:number;domains:{authorizationRevision:number;committerDeviceId:string;committerSigningPublicKeyBase64url:string;domainId:string;expectedHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};namespaces:{accessRevision:number;aiEnvelopeBytesBase64url:string;bindingHashBase64url:string;bindingProofBytesBase64url:string[];humanEnvelopeBytesBase64url:string;namespaceId:string}[];participantDigestBase64url:string;rosterBytesBase64url:string}[];enrollment:{authorizationDigestBase64url:string;authorizationEvidenceDigestBase64url:string;challengeId:string;clientKind:\"browser\"|\"electron\";deviceGeneration:1;deviceId:string;deviceRevision:0;encryptionPublicKeyBase64url:string;expectedCustodyRevision:number;expectedRecoveryGeneration:number;expiresAt:number;formatVersion:1;humanActorId:string;idempotencyKey:string;installationLineageDigestBase64url:string;inventoryCount:number;inventoryDigestBase64url:string;inventoryRevision:number;issuedAt:number;method:\"device_approval\";operationId:string;signingPublicKeyBase64url:string;status:\"pending\";userId:string};formatVersion:2;page:{end:number;nextStart?:number;pageDigestBase64url:string;start:number};progress?:\"approval_required\"|\"awaiting_target\"|\"transfer_ready\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.transition.plan.1igivar",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/transition-plan",
    "structuralSignatures": [
      "response.body:{domainCount:number;domains:{joinPackageBytesBase64url:string;plan:{authorizationRevision:number;committerDeviceId:string;committerSigningPublicKeyBase64url:string;domainId:string;expectedHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};namespaces:{accessRevision:number;aiEnvelopeBytesBase64url:string;bindingHashBase64url:string;bindingProofBytesBase64url:string[];humanEnvelopeBytesBase64url:string;namespaceId:string}[];participantDigestBase64url:string;rosterBytesBase64url:string}}[];formatVersion:2;operationId:string;page:{end:number;nextStart?:number;pageDigestBase64url:string;start:number};targetDeviceId:string}",
      "response.body:{domains:{claim:{leaseExpiresAt:number;retryCount:number;state:\"awaiting_committer\"|\"preparing\";workerId:string};joinPackageBytesBase64url:string;plan:{authorizationRevision:number;committerDeviceId:string;committerSigningPublicKeyBase64url:string;domainId:string;expectedHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};namespaces:{accessRevision:number;aiEnvelopeBytesBase64url:string;bindingHashBase64url:string;bindingProofBytesBase64url:string[];humanEnvelopeBytesBase64url:string;namespaceId:string}[];participantDigestBase64url:string;rosterBytesBase64url:string}}[];formatVersion:1;operationId:string;targetDeviceId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.pending.13xpw22",
    "locator": "http:request_response:POST /api/protected/devices/additional/pending",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{formatVersion:1;pending:{domains:{authorizationRevision:number;committerDeviceId:string;committerSigningPublicKeyBase64url:string;domainId:string;expectedHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};namespaces:{accessRevision:number;aiEnvelopeBytesBase64url:string;bindingHashBase64url:string;bindingProofBytesBase64url:string[];humanEnvelopeBytesBase64url:string;namespaceId:string}[];participantDigestBase64url:string;rosterBytesBase64url:string}[];enrollment:{authorizationDigestBase64url:string;authorizationEvidenceDigestBase64url:string;challengeId:string;clientKind:\"browser\"|\"electron\";deviceGeneration:1;deviceId:string;deviceRevision:0;encryptionPublicKeyBase64url:string;expectedCustodyRevision:number;expectedRecoveryGeneration:number;expiresAt:number;formatVersion:1;humanActorId:string;idempotencyKey:string;installationLineageDigestBase64url:string;inventoryCount:number;inventoryDigestBase64url:string;inventoryRevision:number;issuedAt:number;method:\"device_approval\";operationId:string;signingPublicKeyBase64url:string;status:\"pending\";userId:string};formatVersion:1;progress?:\"approval_required\"|\"awaiting_target\"|\"transfer_ready\"}[]}",
      "response.body:{formatVersion:2;pending:{approver:{deviceId:string;signingPublicKeyBase64url:string};domainCount:number;domains:{authorizationRevision:number;committerDeviceId:string;committerSigningPublicKeyBase64url:string;domainId:string;expectedHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};namespaces:{accessRevision:number;aiEnvelopeBytesBase64url:string;bindingHashBase64url:string;bindingProofBytesBase64url:string[];humanEnvelopeBytesBase64url:string;namespaceId:string}[];participantDigestBase64url:string;rosterBytesBase64url:string}[];enrollment:{authorizationDigestBase64url:string;authorizationEvidenceDigestBase64url:string;challengeId:string;clientKind:\"browser\"|\"electron\";deviceGeneration:1;deviceId:string;deviceRevision:0;encryptionPublicKeyBase64url:string;expectedCustodyRevision:number;expectedRecoveryGeneration:number;expiresAt:number;formatVersion:1;humanActorId:string;idempotencyKey:string;installationLineageDigestBase64url:string;inventoryCount:number;inventoryDigestBase64url:string;inventoryRevision:number;issuedAt:number;method:\"device_approval\";operationId:string;signingPublicKeyBase64url:string;status:\"pending\";userId:string};formatVersion:2;page:{end:number;nextStart?:number;pageDigestBase64url:string;start:number};progress?:\"approval_required\"|\"awaiting_target\"|\"transfer_ready\"}[]}"
    ],
    "arbitraryPayloads": []
  }
];
