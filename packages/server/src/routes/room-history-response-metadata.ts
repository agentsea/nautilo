import type { RoomHistoryShadowReadResponseV1 } from "@nautilo/api-client";

/** Older open clients strictly validate V1 responses. Only an explicit request
 * opts into retained signer and terminal metadata; cryptographic content and
 * admission remain unchanged. Keep this at every HTTP serialization boundary. */
export function selectRoomHistoryResponseMetadata(
  response: RoomHistoryShadowReadResponseV1,
  query: unknown,
) {
  if (response.status !== "ready"
    || (typeof query === "object" && query !== null
      && "shadowReadMetadataVersion" in query
      && query.shadowReadMetadataVersion === "1")) return response;
  const { terminalExecutions: _terminalExecutions, ...legacy } = response;
  return {
    ...legacy,
    signerEvidence: legacy.signerEvidence.map((evidence) => {
      if (evidence.kind !== "human_ai_readable_live_shadow_request_v1"
        && evidence.kind !== "human_ai_readable_live_shadow_request_v2") return evidence;
      const { committerDeviceSigningPublicKeyBase64url: _signer, ...original } = evidence;
      return original;
    }),
  };
}
