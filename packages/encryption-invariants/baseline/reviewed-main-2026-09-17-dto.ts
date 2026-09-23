import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_MAIN_2026_09_17_DTO_LOCATORS = new Set<string>([
  "app_bridge:app_to_host:nautilo.app.media.req#openPreview",
  "app_bridge:app_to_host:nautilo.app.video-generation.req#importReference",
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions",
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest",
  "http:accepted_arbitrary:packages/types/src/api.ts#ActiveMiniAppRequestContext",
  "http:accepted_arbitrary:packages/types/src/api.ts#IssueLiveMiniAppSessionRequest",
  "http:accepted_arbitrary:packages/types/src/api.ts#RefreshLiveMiniAppSessionRequest",
  "http:accepted_arbitrary:packages/types/src/api.ts#SendMessageRequest",
  "http:request_response:GET /api/rooms/:id/messages/:messageId/around",
  "http:request_response:GET /api/connected-web-operations/:operationId",
  "http:request_response:GET /api/tasks/pending-attention",
  "http:request_response:POST /api/apps/:appId/live-session",
  "http:request_response:POST /api/apps/:appId/live-session/revoke",
  "http:request_response:POST /api/chat",
  "http:request_response:POST /api/connected-web-operations/:operationId/stop",
  "http:request_response:POST /api/message-backfill/source",
  "http:request_response:POST /api/rooms/:id/messages/shadow-read",
  "http:request_response:POST /api/rooms/:roomId/messages",
  "http:request_response:POST /api/rooms/:roomId/pending-attention",
  "http:request_response:POST /api/rooms/:roomId/pending-attention/read",
  "http:request_response:POST /api/video-generations/prepare",
]);

const METADATA_RICH_SIGNER_EVIDENCE =
  "signerEvidence:{committerDeviceSigningPublicKeyBase64url?:string;kind:\"human_ai_readable_live_shadow_request_v1\"|\"human_ai_readable_live_shadow_request_v2\";operationId:string;planBytesBase64url:string;requestBytesBase64url:string;requestDigestBase64url:string}|{evidenceBytesBase64url:string;kind:\"agent_runtime_publication\"|\"processor_authorization\"}";
const LEGACY_SIGNER_EVIDENCE =
  "signerEvidence:{evidenceBytesBase64url:string;kind:\"agent_runtime_publication\"|\"processor_authorization\"}|{kind:\"human_ai_readable_live_shadow_request_v1\"|\"human_ai_readable_live_shadow_request_v2\";operationId:string;planBytesBase64url:string;requestBytesBase64url:string;requestDigestBase64url:string}";
const METADATA_RICH_READY_END =
  ";status:\"ready\";terminalExecutions:{classification:\"cancelled\"|\"process_lost\";executionId:string;messageId:number}[]}";
const LEGACY_READY_END = ";status:\"ready\"}";

function replaceExact(
  locator: string,
  signatures: readonly string[],
  from: string,
  to: string,
  expectedMatches = 1,
): readonly string[] {
  let matches = 0;
  const updated = signatures.map((signature) => {
    const fragments = signature.split(from);
    matches += fragments.length - 1;
    return fragments.join(to);
  });
  if (matches !== expectedMatches) {
    throw new Error(
      `September 17 DTO predecessor mismatch for ${locator}: expected ${expectedMatches} matches, found ${matches}`,
    );
  }
  return updated;
}

function toLegacyRoomHistoryReadySignature(
  locator: string,
  signature: string,
): string {
  const withoutSignerMetadata = replaceExact(
    locator,
    [signature],
    METADATA_RICH_SIGNER_EVIDENCE,
    LEGACY_SIGNER_EVIDENCE,
  )[0];
  if (withoutSignerMetadata === undefined) {
    throw new Error(`September 17 DTO signature missing for ${locator}`);
  }
  const withoutTerminalMetadata = replaceExact(
    locator,
    [withoutSignerMetadata],
    METADATA_RICH_READY_END,
    LEGACY_READY_END,
  )[0];
  if (withoutTerminalMetadata === undefined) {
    throw new Error(`September 17 DTO signature missing for ${locator}`);
  }
  return withoutTerminalMetadata;
}

function includeNegotiatedRoomHistoryReadyAlternative(
  locator: string,
  signatures: readonly string[],
): readonly string[] {
  let matches = 0;
  const updated = signatures.map((signature) => {
    if (!signature.includes(METADATA_RICH_SIGNER_EVIDENCE)) return signature;
    const readyStart = signature.indexOf("{acknowledgement?:");
    const readyEnd = signature.indexOf(METADATA_RICH_READY_END, readyStart);
    if (readyStart < 0 || readyEnd < 0) return signature;
    matches += 1;
    const end = readyEnd + METADATA_RICH_READY_END.length;
    const metadataRichReady = signature.slice(readyStart, end);
    return `${signature.slice(0, end)}|${toLegacyRoomHistoryReadySignature(locator, metadataRichReady)}${signature.slice(end)}`;
  });
  if (matches !== 1) {
    throw new Error(
      `September 17 negotiated DTO predecessor mismatch for ${locator}: expected 1 match, found ${matches}`,
    );
  }
  return updated;
}

function updateStructuralSignatures(
  locator: string,
  input: readonly string[],
): readonly string[] {
  let signatures = input;
  const replace = (from: string, to: string, expectedMatches = 1): void => {
    signatures = replaceExact(locator, signatures, from, to, expectedMatches);
  };

  switch (locator) {
    case "app_bridge:app_to_host:nautilo.app.media.req#openPreview":
      replace(
        "frame.payload:{mediaId:string}|{ref:string}&{op:\"openPreview\"",
        "frame.payload:{mediaId:string}|{ref:string}|{referenceId:string}&{op:\"openPreview\"",
      );
      break;
    case "app_bridge:app_to_host:nautilo.app.video-generation.req#importReference":
      replace(
        "frame.payload:{mediaKind:\"audio\"|\"image\"|\"video\";op:\"importReference\";requestId:string;type:\"nautilo.app.video-generation.req\"}",
        "frame.payload:{mediaKind:\"audio\"|\"image\"|\"video\";op:\"importReference\"}|{mediaKind:\"image\";op:\"importReferences\"}&{requestId:string;type:\"nautilo.app.video-generation.req\"}",
      );
      break;
    case "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions":
      replace(
        "onVideoGenerationImportReference?:(input: { mediaKind: \"image\" | \"video\" | \"audio\" }) => Promise<VideoGenerationReferenceImportBridgeResult> | VideoGenerationReferenceImportBridgeResult;onVideoGenerationListTakes?",
        "onVideoGenerationImportReference?:(input: { mediaKind: \"image\" | \"video\" | \"audio\" }) => Promise<VideoGenerationReferenceImportBridgeResult> | VideoGenerationReferenceImportBridgeResult;onVideoGenerationImportReferences?:(input: { mediaKind: \"image\" }) => Promise<VideoGenerationReferencesImportBridgeResult> | VideoGenerationReferencesImportBridgeResult;onVideoGenerationListTakes?",
      );
      replace(
        "onVideoHostLayout?:(input: { enabled: boolean }) => Promise<void> | void;onVideoProjectPromotion?",
        "onVideoHostLayout?:(input: { enabled: boolean }) => Promise<void> | void;onVideoMediaPick?:(input: VideoMediaPickInput) => Promise<VideoMediaPickResult>;onVideoProjectPromotion?",
      );
      replace(
        "onVideoWorkspaceMediaOpenPreview?:(input: { mediaId: string; signal: AbortSignal })",
        "onVideoWorkspaceMediaOpenPreview?:(input: ({ mediaId: string } | { referenceId: string }) & { signal: AbortSignal })",
      );
      break;
    case "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest":
      replace(
        "|{mediaId:string}|{ref:string}&{op:\"openPreview\"",
        "|{mediaId:string}|{ref:string}|{referenceId:string}&{op:\"openPreview\"",
      );
      replace(
        "|{mediaKind:\"audio\"|\"image\"|\"video\";op:\"importReference\";requestId:string;type:\"nautilo.app.video-generation.req\"}",
        "|{mediaKind:\"audio\"|\"image\"|\"video\";op:\"importReference\"}|{mediaKind:\"image\";op:\"importReferences\"}&{requestId:string;type:\"nautilo.app.video-generation.req\"}|{multiple:boolean;purpose:\"media\"|\"references\"}&{op:\"pick\";requestId:string;type:\"nautilo.app.media.req\"}",
      );
      break;
    case "http:accepted_arbitrary:packages/types/src/api.ts#IssueLiveMiniAppSessionRequest":
      replace(
        "relativePath:string;relayIdHint:string;targetKind:\"currentFile\"}",
        "relativePath:string;relayIdHint:string;targetKind:\"currentFile\"}&{clientSessionId?:string;issuanceToken?:string}",
      );
      break;
    case "http:accepted_arbitrary:packages/types/src/api.ts#RefreshLiveMiniAppSessionRequest":
      replace(
        "relativePath:string;relayIdHint:string;targetKind:\"currentFile\"}&{sessionToken:string}",
        "relativePath:string;relayIdHint:string;targetKind:\"currentFile\"}&{clientSessionId?:string;issuanceToken?:string}&{sessionToken:string}",
      );
      break;
    case "http:request_response:GET /api/connected-web-operations/:operationId":
    case "http:request_response:POST /api/connected-web-operations/:operationId/stop":
      replace("result?:{account:{", "result?:{account?:{");
      replace(
        "provenance:\"authenticated_website\"|\"user_connected_website\"",
        "provenance:\"authenticated_website\"|\"public_website\"|\"user_connected_website\"",
      );
      break;
    // These history routes negotiate authority metadata at their HTTP boundary.
    // Current clients opt into terminal summaries and retained Human-device signer
    // material; legacy clients receive the prior strict response shape. Both forms
    // carry protected-history authority only and preserve every open-path decision.
    // The scanner collapses the around route's assignable union to its legacy shape;
    // runtime contract tests separately prove that its opted-in rich form survives.
    case "http:request_response:GET /api/rooms/:id/messages/:messageId/around":
      replace(METADATA_RICH_SIGNER_EVIDENCE, LEGACY_SIGNER_EVIDENCE);
      replace(METADATA_RICH_READY_END, LEGACY_READY_END);
      break;
    case "http:request_response:POST /api/message-backfill/source":
      signatures = includeNegotiatedRoomHistoryReadyAlternative(locator, signatures);
      replace(";history?:{acknowledgement?:", ";history:{acknowledgement?:");
      break;
    case "http:request_response:POST /api/rooms/:id/messages/shadow-read":
      signatures = includeNegotiatedRoomHistoryReadyAlternative(locator, signatures);
      break;
    case "http:request_response:POST /api/apps/:appId/live-session":
      signatures = [...signatures, "response.body:{error:string}"].sort();
      break;
    case "http:request_response:POST /api/apps/:appId/live-session/revoke":
      signatures = [...signatures, "request.body:{clientSessionId?:unknown}"].sort();
      break;
    case "http:accepted_arbitrary:packages/types/src/api.ts#ActiveMiniAppRequestContext":
    case "http:accepted_arbitrary:packages/types/src/api.ts#SendMessageRequest":
    case "http:request_response:POST /api/chat":
    case "http:request_response:POST /api/rooms/:roomId/messages":
      replace(
        "appName?:string;documentPath?:string;selection?:unknown",
        "appName?:string;documentPath?:string;mode?:\"edit\"|\"preview\";selection?:unknown",
      );
      break;
    case "http:request_response:GET /api/tasks/pending-attention":
    case "http:request_response:POST /api/rooms/:roomId/pending-attention":
    case "http:request_response:POST /api/rooms/:roomId/pending-attention/read":
      replace(
        "quote:{amountMicros:number;currency:\"USD\";display:string};referenceImages?:",
        "quote:{amountMicros:number;currency:\"USD\";display:string};referenceAudios?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};durationSeconds:number;index:number;label:string}[];referenceImages?:",
      );
      break;
    case "http:request_response:POST /api/video-generations/prepare":
      replace(
        "quote:{amountMicros:number;currency:\"USD\";display:string};referenceImages?:",
        "quote:{amountMicros:number;currency:\"USD\";display:string};referenceAudios?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};durationSeconds:number;index:number;label:string}[];referenceImages?:",
        2,
      );
      break;
    default:
      throw new Error(`Unreviewed September 17 DTO replacement: ${locator}`);
  }
  return signatures;
}

/** Preserve every prior arbitrary-payload decision while updating exact source shapes. */
export function reviewedMain20260917DtoReplacements(
  previous: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return [...SUPERSEDED_MAIN_2026_09_17_DTO_LOCATORS].map((locator) => {
    const prior = previous.find((declaration) => declaration.locator === locator);
    if (!prior?.structuralSignatures) {
      throw new Error(`September 17 DTO predecessor missing: ${locator}`);
    }
    const arbitraryPayloads = locator.endsWith("/live-session/revoke")
      ? [
        ...prior.arbitraryPayloads,
        { path: "request.body.clientSessionId", schema: "uuid-v4" } as const,
      ]
      : prior.arbitraryPayloads;
    return {
      ...prior,
      structuralSignatures: updateStructuralSignatures(
        locator,
        prior.structuralSignatures,
      ),
      arbitraryPayloads,
    };
  });
}

export const REVIEWED_MAIN_2026_09_17_NEW_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    observationId: "wire.app.bridge.app.to.host.nautilo.app.media.req.pick.franq9",
    locator: "app_bridge:app_to_host:nautilo.app.media.req#pick",
    structuralSignatures: [
      "frame.payload:{multiple:boolean;purpose:\"media\"|\"references\"}&{op:\"pick\";requestId:string;type:\"nautilo.app.media.req\"}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.videomediapickresult.t2fy3u",
    locator: "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#VideoMediaPickResult",
    structuralSignatures: [
      "declaration.payload:{code:string;kind:\"unavailable\"}|{failures:{code:string;label:string}[];imports:unresolved<Extract>[];kind:\"ready\";mediaIds:string[];references:Extract<VideoGenerationReferenceImportBridgeResult, { kind: \"ready\" }>[\"asset\"][]}",
    ],
    arbitraryPayloads: [
      { path: "imports[]", schema: "isSafeVideoWorkspaceImportResult" },
    ],
  },
  {
    observationId: "wire.http.request.response.get.api.event.feed.preference.7ozk5b",
    locator: "http:request_response:GET /api/event-feed/preference",
    structuralSignatures: [
      "request.query:object",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{mode:\"active\"}|{mode:\"quiet\"}|{mode:\"snoozed\";until:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.post.api.apps.appid.live.session.prepare.1kaeq9x",
    locator: "http:request_response:POST /api/apps/:appId/live-session/prepare",
    structuralSignatures: [
      "request.body:{clientSessionId?:unknown}",
      "request.params:{appId:string}",
      "response.body:{error:string}",
      "response.body:{issuanceToken:string}",
    ],
    arbitraryPayloads: [
      { path: "request.body.clientSessionId", schema: "uuid-v4" },
    ],
  },
  {
    observationId: "wire.http.request.response.put.api.event.feed.preference.1n5ep5c",
    locator: "http:request_response:PUT /api/event-feed/preference",
    structuralSignatures: [
      "request.body:unknown",
      "request.query:object",
      "response.body:{code:\"invalid_cursor\"|\"invalid_input\"|\"not_found\";error:string}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{mode:\"active\"}|{mode:\"quiet\"}|{mode:\"snoozed\";until:string}",
    ],
    arbitraryPayloads: [
      { path: "request.body", schema: "eventFeedPreferenceSchema" },
    ],
  },
];
