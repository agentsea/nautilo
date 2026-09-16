import {
  fullEncryptionMessagePreparedRequestV2Schema,
  liveShadowMessagePreparedRequestV1Schema,
  type FullEncryptionMessagePreparedRequestV2,
  type LiveShadowMessagePreparedRequestV1,
} from "@nautilo/api-client";
import {
  decodeHumanAiReadableLiveShadowMessagePlan,
  decodeHumanAiReadableLiveShadowMessageRequest,
} from "@nautilo/lattice-crypto";

interface DecodedPreparedMessageCoordinates {
  planBytes: Uint8Array;
  requestBytes: Uint8Array;
  encryptedPayloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  envelopeBytes: Uint8Array;
  grantBytes: Uint8Array;
  authorizationScheme: "foreground_session_v1" | "human_peer_v1"
    | "shared_agent_v1" | "human_ai_readable_v1"
    | "human_ai_readable_v2" | null;
}

type DecodedShadowMessage = DecodedPreparedMessageCoordinates & Readonly<{
  representationMode: "shadow_encryption";
  ordinaryPayloadBytes: Uint8Array;
}>;
type DecodedFullMessage = DecodedPreparedMessageCoordinates & Readonly<{
  representationMode: "full_encryption";
  ordinaryPayloadBytes?: never;
}>;
export type DecodedPreparedMessage = DecodedShadowMessage | DecodedFullMessage;

function decode(value: string): Uint8Array | null {
  const bytes = Buffer.from(value, "base64url");
  return bytes.length > 0 && bytes.toString("base64url") === value
    ? new Uint8Array(bytes) : null;
}

function destroyByteFields(value: object): void {
  for (const field of Object.values(value)) {
    if (field instanceof Uint8Array) field.fill(0);
  }
}

function matchesHumanAiReadableScheme(input: Readonly<{
  authorizationScheme: "human_ai_readable_v1" | "human_ai_readable_v2";
  planBytes: Uint8Array;
  requestBytes: Uint8Array;
}>): boolean {
  let plan: ReturnType<typeof decodeHumanAiReadableLiveShadowMessagePlan> | undefined;
  let request: ReturnType<typeof decodeHumanAiReadableLiveShadowMessageRequest> | undefined;
  try {
    plan = decodeHumanAiReadableLiveShadowMessagePlan(input.planBytes);
    request = decodeHumanAiReadableLiveShadowMessageRequest(input.requestBytes);
    const expectedVersion = input.authorizationScheme === "human_ai_readable_v1"
      ? 1
      : 2;
    return plan.formatVersion === expectedVersion
      && request.formatVersion === expectedVersion;
  } catch {
    return false;
  } finally {
    if (plan) destroyByteFields(plan);
    if (request) destroyByteFields(request);
  }
}

/** Reject an authenticated-protocol label substituted onto another framed
 * format before any topology may select an ordinary fallback path. */
export function preparedAuthorizationSchemeMatchesWireFormat(
  attempt: LiveShadowMessagePreparedRequestV1 | FullEncryptionMessagePreparedRequestV2,
): boolean {
  if (!("authorizationScheme" in attempt)) return true;
  const authorizationScheme = attempt.authorizationScheme;
  if (
    authorizationScheme !== "human_ai_readable_v1"
    && authorizationScheme !== "human_ai_readable_v2"
  ) return true;
  const planBytes = decode(attempt.planBytesBase64url);
  const requestBytes = decode(attempt.signedRequestBytesBase64url);
  if (planBytes === null || requestBytes === null) {
    planBytes?.fill(0);
    requestBytes?.fill(0);
    return false;
  }
  try {
    return matchesHumanAiReadableScheme({
      authorizationScheme,
      planBytes,
      requestBytes,
    });
  } finally {
    planBytes.fill(0);
    requestBytes.fill(0);
  }
}

export function decodePreparedLiveShadowAttempt(
  attempt: LiveShadowMessagePreparedRequestV1,
): DecodedShadowMessage | null;
export function decodePreparedLiveShadowAttempt(
  attempt: FullEncryptionMessagePreparedRequestV2,
): DecodedFullMessage | null;
export function decodePreparedLiveShadowAttempt(
  attempt: LiveShadowMessagePreparedRequestV1 | FullEncryptionMessagePreparedRequestV2,
): DecodedPreparedMessage | null;
/** One decoder for both transport representations; never invent an ordinary sibling. */
export function decodePreparedLiveShadowAttempt(
  attempt: LiveShadowMessagePreparedRequestV1 | FullEncryptionMessagePreparedRequestV2,
): DecodedPreparedMessage | null {
  const parsed = attempt.requestVersion === 2
    ? fullEncryptionMessagePreparedRequestV2Schema.safeParse(attempt)
    : liveShadowMessagePreparedRequestV1Schema.safeParse(attempt);
  if (!parsed.success) return null;
  const source = parsed.data;
  const planBytes = decode(source.planBytesBase64url);
  const requestBytes = decode(source.signedRequestBytesBase64url);
  const encryptedPayloadBytes = decode(source.encryptedPayloadBytesBase64url);
  const manifestBytes = decode(source.accessManifestBytesBase64url);
  const envelopeBytes = decode(source.namespaceEnvelopeBytesBase64url);
  const ordinaryPayloadBytes = source.requestVersion === 1
    ? decode(source.ordinaryPayloadBytesBase64url) : undefined;
  const grantBytes = "grantBytesBase64url" in source
    ? decode(source.grantBytesBase64url) : new Uint8Array(0);
  if (planBytes === null || requestBytes === null || encryptedPayloadBytes === null
    || manifestBytes === null || envelopeBytes === null || grantBytes === null
    || ordinaryPayloadBytes === null) {
    for (const bytes of [planBytes, requestBytes, encryptedPayloadBytes, manifestBytes,
      envelopeBytes, grantBytes, ordinaryPayloadBytes]) bytes?.fill(0);
    return null;
  }
  const authorizationScheme = "authorizationScheme" in source
    ? source.authorizationScheme
    : null;
  if (!preparedAuthorizationSchemeMatchesWireFormat(source)) {
    for (const bytes of [planBytes, requestBytes, encryptedPayloadBytes,
      manifestBytes, envelopeBytes, grantBytes, ordinaryPayloadBytes]) {
      bytes?.fill(0);
    }
    return null;
  }
  const coordinates: DecodedPreparedMessageCoordinates = {
    planBytes, requestBytes, encryptedPayloadBytes, manifestBytes, envelopeBytes, grantBytes,
    authorizationScheme,
  };
  return ordinaryPayloadBytes === undefined
    ? Object.freeze({ ...coordinates, representationMode: "full_encryption" })
    : Object.freeze({ ...coordinates, representationMode: "shadow_encryption", ordinaryPayloadBytes });
}

export function destroyDecodedPreparedMessage(message: DecodedPreparedMessage): void {
  for (const bytes of [message.planBytes, message.requestBytes, message.encryptedPayloadBytes,
    message.manifestBytes, message.envelopeBytes, message.grantBytes,
    message.ordinaryPayloadBytes]) bytes?.fill(0);
}
