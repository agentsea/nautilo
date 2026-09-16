import * as core from "./human-ai-readable-live-shadow-core.ts";

export {
  HUMAN_AI_READABLE_LIVE_SHADOW_FORMAT_VERSION_V1,
  HUMAN_AI_READABLE_LIVE_SHADOW_PLAN_PURPOSE_V1,
  HUMAN_AI_READABLE_LIVE_SHADOW_PLAN_DOMAIN_V1,
  HUMAN_AI_READABLE_LIVE_SHADOW_REQUEST_PURPOSE_V1,
  HUMAN_AI_READABLE_LIVE_SHADOW_REQUEST_DOMAIN_V1,
  HUMAN_AI_READABLE_LIVE_SHADOW_ACK_PURPOSE_V1,
  HUMAN_AI_READABLE_LIVE_SHADOW_ACK_DOMAIN_V1,
  HUMAN_AI_READABLE_LIVE_SHADOW_NORMALIZATION_VERSION_V1,
  HUMAN_AI_READABLE_LIVE_SHADOW_MAX_TTL_MS_V1,
  MAX_HUMAN_AI_READABLE_LIVE_SHADOW_PLAN_WIRE_BYTES_V1,
  MAX_HUMAN_AI_READABLE_LIVE_SHADOW_REQUEST_WIRE_BYTES_V1,
  MAX_HUMAN_AI_READABLE_LIVE_SHADOW_ACK_WIRE_BYTES_V1,
  type HumanAiReadableLiveShadowExecutionInputV1,
  humanAiReadableLiveShadowExecutionInputSetDigestV1,
  type HumanAiReadableLiveShadowAcknowledgementStatusV1,
  type HumanAiReadableLiveShadowAcknowledgementReasonV1,
  type HumanAiReadableLiveShadowAcknowledgementUnsignedV1,
  type HumanAiReadableLiveShadowAcknowledgementV1,
  type ResolveCurrentHumanAiReadableDeviceAuthorityV1,
  humanAiReadableLiveShadowAcknowledgementSigningBytesV1,
  encodeHumanAiReadableLiveShadowAcknowledgementV1,
  decodeHumanAiReadableLiveShadowAcknowledgementV1,
  prepareHumanAiReadableLiveShadowAcknowledgementV1,
  verifyHumanAiReadableLiveShadowAcknowledgementV1,
  humanAiReadableLiveShadowAcknowledgementDigestV1,
} from "./human-ai-readable-live-shadow-core.ts";

export type HumanAiReadableLiveShadowMessagePlanV1 =
  Omit<core.HumanAiReadableLiveShadowMessagePlan, "formatVersion">
  & Readonly<{ formatVersion: 1 }>;

export type HumanAiReadableLiveShadowMessageRequestUnsignedV1 =
  Omit<core.HumanAiReadableLiveShadowMessageRequestUnsigned, "formatVersion">
  & Readonly<{ formatVersion: 1 }>;

export type HumanAiReadableLiveShadowMessageRequestV1 =
  Omit<core.HumanAiReadableLiveShadowMessageRequest, "formatVersion">
  & Readonly<{ formatVersion: 1 }>;

function requireVersion<T extends { readonly formatVersion: 1 | 2 }>(value: T): T & { readonly formatVersion: 1 } {
  if (value.formatVersion !== 1) {
    for (const field of Object.values(value) as unknown[]) {
      if (field instanceof Uint8Array) field.fill(0);
    }
    throw new TypeError("Human AI-readable V1 format mismatch");
  }
  return value as T & { readonly formatVersion: 1 };
}

export function decodeHumanAiReadableLiveShadowMessagePlanV1(bytes: Uint8Array): HumanAiReadableLiveShadowMessagePlanV1 {
  return requireVersion(core.decodeHumanAiReadableLiveShadowMessagePlan(bytes));
}

export function encodeHumanAiReadableLiveShadowMessagePlanV1(value: HumanAiReadableLiveShadowMessagePlanV1): Uint8Array {
  if (value.formatVersion !== 1) throw new TypeError("Human AI-readable V1 format mismatch");
  return core.encodeHumanAiReadableLiveShadowMessagePlan(value);
}

export function humanAiReadableLiveShadowMessagePlanDigestV1(bytes: Uint8Array): Uint8Array {
  const value = decodeHumanAiReadableLiveShadowMessagePlanV1(bytes);
  for (const field of Object.values(value)) {
    if (field instanceof Uint8Array) field.fill(0);
  }
  return core.humanAiReadableLiveShadowMessagePlanDigest(bytes);
}

export function decodeHumanAiReadableLiveShadowMessageRequestV1(bytes: Uint8Array): HumanAiReadableLiveShadowMessageRequestV1 {
  return requireVersion(core.decodeHumanAiReadableLiveShadowMessageRequest(bytes));
}

export function encodeHumanAiReadableLiveShadowMessageRequestV1(value: HumanAiReadableLiveShadowMessageRequestV1): Uint8Array {
  if (value.formatVersion !== 1) throw new TypeError("Human AI-readable V1 format mismatch");
  return core.encodeHumanAiReadableLiveShadowMessageRequest(value);
}

export function humanAiReadableLiveShadowMessageRequestDigestV1(bytes: Uint8Array): Uint8Array {
  const value = decodeHumanAiReadableLiveShadowMessageRequestV1(bytes);
  for (const field of Object.values(value)) {
    if (field instanceof Uint8Array) field.fill(0);
  }
  return core.humanAiReadableLiveShadowMessageRequestDigest(bytes);
}

export function humanAiReadableLiveShadowMessageRequestSigningBytesV1(value: HumanAiReadableLiveShadowMessageRequestV1): Uint8Array {
  if (value.formatVersion !== 1) throw new TypeError("Human AI-readable V1 format mismatch");
  return core.humanAiReadableLiveShadowMessageRequestSigningBytes(value);
}

export function prepareHumanAiReadableLiveShadowMessageRequestV1(
  crypto: Parameters<typeof core.prepareHumanAiReadableLiveShadowMessageRequest>[0],
  input: Parameters<typeof core.prepareHumanAiReadableLiveShadowMessageRequest>[1],
) {
  const result = core.prepareHumanAiReadableLiveShadowMessageRequest(crypto, input, 1);
  return Object.freeze({ ...result, request: requireVersion(result.request) });
}

export function verifyHumanAiReadableLiveShadowMessageRequestV1(
  crypto: Parameters<typeof core.verifyHumanAiReadableLiveShadowMessageRequest>[0],
  input: Parameters<typeof core.verifyHumanAiReadableLiveShadowMessageRequest>[1],
): HumanAiReadableLiveShadowMessageRequestV1 {
  const decoded = decodeHumanAiReadableLiveShadowMessageRequestV1(input.requestBytes);
  for (const field of Object.values(decoded)) {
    if (field instanceof Uint8Array) field.fill(0);
  }
  return requireVersion(core.verifyHumanAiReadableLiveShadowMessageRequest(crypto, input));
}

export function verifyHumanAiReadableLiveShadowMessageRequestExactReplayV1(
  crypto: Parameters<typeof core.verifyHumanAiReadableLiveShadowMessageRequestExactReplay>[0],
  input: Parameters<typeof core.verifyHumanAiReadableLiveShadowMessageRequestExactReplay>[1],
): HumanAiReadableLiveShadowMessageRequestV1 {
  const decoded = decodeHumanAiReadableLiveShadowMessageRequestV1(input.requestBytes);
  for (const field of Object.values(decoded)) {
    if (field instanceof Uint8Array) field.fill(0);
  }
  return requireVersion(core.verifyHumanAiReadableLiveShadowMessageRequestExactReplay(crypto, input));
}
