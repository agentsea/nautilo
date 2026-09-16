import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_M301_DTO_LOCATORS = new Set<string>([
  "http:request_response:POST /api/profile/bundle/import/commit",
  "http:request_response:POST /api/profile/bundle/import/plan",
  "http:request_response:GET /api/rooms/:id/messages/:messageId/around",
  "http:request_response:GET /api/sessions/latest",
  "http:request_response:POST /api/protected/devices/initial-domain/plan",
  "http:request_response:GET /api/admin/encryption-transition",
  "http:request_response:GET /api/rooms/:id/messages",
  "http:request_response:POST /api/admin/encryption-transition",
  "http:request_response:POST /api/protected/devices/additional/begin",
  "http:request_response:POST /api/protected/devices/additional/:operationId/plan-page",
  "http:request_response:POST /api/protected/devices/additional/pending",
  "http:request_response:GET /api/tasks/pending-attention",
]);

function replaceRequired(value: string, from: string, to: string): string {
  if (!value.includes(from)) return value;
  return value.replaceAll(from, to);
}

function updateSignature(locator: string, signature: string): string {
  switch (locator) {
    case "http:request_response:POST /api/profile/bundle/import/commit":
      return signature.includes('choice:"source"')
        ? replaceRequired(
          signature,
          "planToken:string;semanticRoot:string",
          "planToken:string;privateMemoryAddedCount:number;privateMemoryAlreadyPresentCount:number;semanticRoot:string",
        )
        : signature.includes('choice:"target"')
        ? replaceRequired(
          signature,
          "planToken:string;semanticRoot:string",
          "planToken:string;privateMemoryAddedCount:0;privateMemoryAlreadyPresentCount:0;semanticRoot:string",
        )
        : signature;
    case "http:request_response:POST /api/profile/bundle/import/plan":
      return replaceRequired(
        signature,
        "privateArtifactCount:number;privateMemoryCount:number",
        "privateArtifactCount:number;privateMemoryAddedCount:number;privateMemoryAlreadyPresentCount:number;privateMemoryCount:number",
      );
    case "http:request_response:GET /api/rooms/:id/messages/:messageId/around":
    case "http:request_response:GET /api/rooms/:id/messages":
      return replaceRequired(
        signature,
        "authorAgentId?:string;content:string",
        "authorAgentId?:string;authorHarnessId?:string;content:string",
      );
    case "http:request_response:GET /api/sessions/latest":
      return replaceRequired(
        replaceRequired(
          signature,
          "attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];content:string;createdAt:Date",
          "attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;authorHarnessId?:string;content:string;createdAt:Date",
        ),
        "role:string;toolCalls:string",
        "role:string;sourceUserId?:string;toolCalls:string",
      );
    case "http:request_response:POST /api/protected/devices/initial-domain/plan":
      return replaceRequired(
        replaceRequired(
          replaceRequired(
            signature,
            'operationId:string;status:"planned"}',
            'operationId:string;status:"planned";trustedDeviceRevision:number;trustedHostAuthorizationRevision:number}',
          ),
          '|{deviceId:string;domainId:string;epoch:number',
          '|{deliveryHighWatermark:number;deviceId:string;domainId:string;epoch:number',
        ).replace(
          'stateHashBase64url:string;status:"active"}',
          'stateHashBase64url:string;status:"active";trustedDeviceRevision:number;trustedHostAuthorizationRevision:number}',
        ),
        'formatVersion:1;reason:',
        'formatVersion:1;migration?:{deliveryHighWatermark:number;trustedDeviceRevision:number;trustedHostAuthorizationRevision:number};reason:',
      );
    case "http:request_response:GET /api/admin/encryption-transition":
    case "http:request_response:POST /api/admin/encryption-transition":
      return replaceRequired(
        signature,
        "response.body:{dtoVersion:",
        'response.body:{domainKeyAuthority:{authority:{aiDomainHeads:string;aiNamespaceBundles:string;humanDomainHeads:string;humanNamespaceBundles:string};catchUp:{acknowledged:string;delivered:string;expired:string;requested:string;stale:string;unrecoverable:string;waiting:string};scope:"domain_key_v2"};dtoVersion:',
      );
    case "http:request_response:POST /api/protected/devices/additional/begin":
    case "http:request_response:POST /api/protected/devices/additional/:operationId/plan-page":
    case "http:request_response:POST /api/protected/devices/additional/pending":
      if (!signature.includes("formatVersion:2")) return signature;
      return replaceRequired(
        signature,
        ';progress?:"approval_required"|"awaiting_target"|"transfer_ready"',
        ';personalAuthority?:{namespaceId:string;roomId:string};progress?:"approval_required"|"awaiting_target"|"transfer_ready"',
      );
    case "http:request_response:GET /api/tasks/pending-attention":
      return replaceRequired(
        replaceRequired(
          signature,
          "authorAgentId?:string;content:string",
          "authorAgentId?:string;authorHarnessId?:string;content:string",
        ),
        '|{jobId:string;result:"failed"|"success"|"timed_out";type:"worker.complete"}|{laneKey:',
        '|{jobId:string;result:"failed"|"success"|"timed_out";type:"worker.complete"}|{keyClass:"ai"|"human";laneKey:string;namespaceId:string;roomId:string;type:"crypto.domain_key_catch_up_delivered"|"crypto.domain_key_catch_up_requested"}|{laneKey:',
      );
    default:
      return signature;
  }
}

export function reviewedM301DtoReplacements(
  previous: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return previous
    .filter((declaration) => SUPERSEDED_M301_DTO_LOCATORS.has(declaration.locator))
    .map((declaration) => declaration.structuralSignatures === undefined
      ? declaration
      : {
        ...declaration,
        structuralSignatures: declaration.structuralSignatures.map((signature) =>
          updateSignature(declaration.locator, signature)
        ),
      });
}

export const REVIEWED_M301_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    observationId: "wire.http.request.response.post.api.rooms.roomid.live.shadow.domain.key.namespaceid.bundle.plan.iu1qkw",
    locator: "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/bundle/plan",
    structuralSignatures: [
      "request.params:{namespaceId:string;roomId:string}",
      "response.body:{advanceGeneration:boolean;bindingBytesBase64url?:undefined;bindingDigestBase64url?:undefined;bundleRevision:number;domainAuthorizationRevision:number;domainHeadDigestBase64url:string;domainId:string;domainKeyGeneration:number;issuerDeviceId:string;issuerDeviceSigningGeneration:number;issuerHumanId:string;issuerSigningPublicKeyBase64url:string;keyClass:\"ai\"|\"human\";namespaceAccessRevision:number;namespaceCurrentGeneration:number;namespaceId:string;participantCount:number;participantDigestBase64url:string;previousBindingDigestBase64url:string;responseVersion:2;retainedGenerationCount:number;sourceBindingBytesBase64url:string;sourceBindingDigestBase64url:string;sourceEnvelopeBytesBase64url:string;sourceEnvelopeDigestBase64url:string;sourceEnvelopeIssuerSigningPublicKeyBase64url:string;sourceIssuerSigningPublicKeyBase64url:string;sourceRecipientDeviceSigningGeneration:number;status:\"create_required\"|\"replace_required\"}|{bindingBytesBase64url:string;bindingDigestBase64url:string;domainId:string;issuerSigningPublicKeyBase64url:string;keyClass:\"ai\"|\"human\";responseVersion:2;status:\"ready\"}|{bindingBytesBase64url?:undefined;bindingDigestBase64url?:undefined;domainId?:undefined;issuerSigningPublicKeyBase64url?:undefined;keyClass?:undefined;reason:\"authority_inconsistent\"|\"bundle_unavailable\"|\"device_unavailable\"|\"domain_unavailable\"|\"head_unavailable\"|\"recipient_sync_required\"|\"recipient_unavailable\"|\"request_unavailable\";responseVersion:2;status:\"unavailable\"}|{bundleRevision:number;domainAuthorizationRevision:number;domainHeadDigestBase64url:string;domainId:string;domainKeyGeneration:number;issuerDeviceId:string;issuerDeviceSigningGeneration:number;issuerHumanId:string;issuerSigningPublicKeyBase64url:string;keyClass:\"ai\"|\"human\";namespaceAccessRevision:number;namespaceCurrentGeneration:number;namespaceId:string;participantCount:number;participantDigestBase64url:string;previousBindingDigestBase64url:string;responseVersion:2;retainedGenerationCount:number;status:\"create_required\"|\"replace_required\"}",
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.post.api.rooms.roomid.live.shadow.domain.key.namespaceid.bundle.publish.1vkxkny",
    locator: "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/bundle/publish",
    structuralSignatures: [
      "request.params:{namespaceId:string;roomId:string}",
      "response.body:{bindingDigestBase64url:string;domainId:string;keyClass:\"ai\"|\"human\";namespaceId:string;operationId:string;responseVersion:number;status:\"published\"|\"replayed\"}",
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.post.api.rooms.roomid.live.shadow.domain.key.namespaceid.plan.hmw4oh",
    locator: "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/plan",
    structuralSignatures: [
      "request.params:{namespaceId:string;roomId:string}",
      "response.body:{authorizationRevision:number;deadlineAt:number;domainId:string;domainKeyGeneration:number;issuedAt:number;issuerDeviceId:string;issuerDeviceSigningGeneration:number;issuerHumanId:string;issuerSigningPublicKeyBase64url:string;keyClass:\"ai\"|\"human\";participantCount:number;participantDigestBase64url:string;previousHeadDigestBase64url:string;recipientEncryptionPublicKeyBase64url:string;recipientPublicKeyDigestBase64url:string;recoveryKeyGeneration:number;recoveryKeyId:string;recoveryPublicKeyBase64url:string;recoveryPublicKeyDigestBase64url:string;responseVersion:2;status:\"create_required\"}|{authorizationRevision:number;domainId:string;domainKeyGeneration:number;headBytesBase64url:string;headDigestBase64url:string;issuerSigningPublicKeyBase64url:string;keyClass:\"ai\"|\"human\";participantCount:number;participantDigestBase64url:string;recipientDeviceRevision:number;recipientDeviceSigningGeneration:number;recipientEnvelope:{envelopeBytesBase64url:string;envelopeDigestBase64url:string;issuerSigningPublicKeyBase64url:string};responseVersion:2;status:\"ready\"}|{authorizationRevision?:undefined;deadlineAt?:undefined;domainId?:undefined;domainKeyGeneration?:undefined;issuedAt?:undefined;issuerDeviceId?:undefined;issuerDeviceSigningGeneration?:undefined;issuerHumanId?:undefined;issuerSigningPublicKeyBase64url?:undefined;keyClass?:undefined;participantCount?:undefined;participantDigestBase64url?:undefined;previousHeadDigestBase64url?:undefined;reason:\"authority_inconsistent\"|\"bundle_unavailable\"|\"device_unavailable\"|\"domain_unavailable\"|\"head_unavailable\"|\"recipient_sync_required\"|\"recipient_unavailable\"|\"request_unavailable\";recipientEncryptionPublicKeyBase64url?:undefined;recipientPublicKeyDigestBase64url?:undefined;recoveryKeyGeneration?:undefined;recoveryKeyId?:undefined;recoveryPublicKeyBase64url?:undefined;recoveryPublicKeyDigestBase64url?:undefined;responseVersion:2;status:\"unavailable\"}",
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  ...[
    ["wire.http.request.response.post.api.rooms.roomid.live.shadow.domain.key.namespaceid.publish.ib3cf5", "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/publish", "response.body:{authorizationRevision:number;domainId:string;domainKeyGeneration:number;envelopeDigestBase64url:string;headDigestBase64url:string;keyClass:\"ai\"|\"human\";operationId:string;recoveryEnvelopeDigestBase64url:string;responseVersion:number;status:\"published\"|\"replayed\"}"],
    ["wire.http.request.response.post.api.rooms.roomid.live.shadow.domain.key.namespaceid.recipient.acknowledge.2oktpe", "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/acknowledge", "response.body:{acknowledgementDigestBase64url:string;responseVersion:number;status:\"acknowledged\"|\"replayed\"}"],
    ["wire.http.request.response.post.api.rooms.roomid.live.shadow.domain.key.namespaceid.recipient.fetch.1vmvfum", "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/fetch", "response.body:{envelopeBytesBase64url:string;envelopeDigestBase64url:string;issuerSigningPublicKeyBase64url:string;requestDigestBase64url:string;responseVersion:number;status:\"ready\"}"],
    ["wire.http.request.response.post.api.rooms.roomid.live.shadow.domain.key.namespaceid.recipient.fulfil.1t9bhm4", "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/fulfil", "response.body:{authorizationDigestBase64url:string;envelopeDigestBase64url:string;requestId:string;responseVersion:number;status:\"fulfilled\"|\"lost_race\"|\"replayed\"}"],
    ["wire.http.request.response.post.api.rooms.roomid.live.shadow.domain.key.namespaceid.recipient.pending.fm7bel", "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/pending", "response.body:{requests:{authorizationRevision:number;domainId:string;domainKeyGeneration:number;headDigestBase64url:string;keyClass:\"ai\"|\"human\";recipientDeviceGeneration:number;recipientDeviceId:string;recipientEncryptionPublicKeyBase64url:string;recipientHumanId:string;recipientPublicKeyDigestBase64url:string;recipientSigningPublicKeyBase64url:string;requestBytesBase64url:string;requestDigestBase64url:string;requestId:string}[];responseVersion:number}"],
    ["wire.http.request.response.post.api.rooms.roomid.live.shadow.domain.key.namespaceid.recipient.request.11edod3", "http:request_response:POST /api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/request", "response.body:{requestDigestBase64url:string;requestId:string;responseVersion:number;status:\"already_delivered\"|\"replayed\"|\"requested\"}"],
  ].map(([observationId, locator, success]) => ({
    observationId: observationId!,
    locator: locator!,
    structuralSignatures: [
      "request.params:{namespaceId:string;roomId:string}",
      success!,
      "response.body:{error:string}",
      ...(locator!.endsWith("/fetch")
        ? ["response.body:{responseVersion:number;status:\"pending\"|\"unavailable\"}"]
        : []),
    ].sort(),
    arbitraryPayloads: [],
  })),
  {
    observationId: "wire.ws.server.to.client.crypto.domain.key.catch.up.delivered.pf61bs",
    locator: "ws:server_to_client:crypto.domain_key_catch_up_delivered",
    structuralSignatures: [],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.ws.server.to.client.crypto.domain.key.catch.up.requested.kinjeg",
    locator: "ws:server_to_client:crypto.domain_key_catch_up_requested",
    structuralSignatures: [],
    arbitraryPayloads: [],
  },
];
