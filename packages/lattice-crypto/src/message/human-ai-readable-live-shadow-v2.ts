import * as core from "./human-ai-readable-live-shadow-core.ts";

export {
  HUMAN_AI_READABLE_LIVE_SHADOW_MAX_TTL_MS_V2,
  HUMAN_AI_READABLE_LIVE_SHADOW_PLAN_DOMAIN_V2,
  HUMAN_AI_READABLE_LIVE_SHADOW_REQUEST_DOMAIN_V2,
} from "./human-ai-readable-live-shadow-core.ts";

export type HumanAiReadableLiveShadowMessagePlanV2 =
  Omit<core.HumanAiReadableLiveShadowMessagePlan, "formatVersion">
  & Readonly<{ formatVersion: 2 }>;

export type HumanAiReadableLiveShadowMessageRequestUnsignedV2 =
  Omit<core.HumanAiReadableLiveShadowMessageRequestUnsigned, "formatVersion">
  & Readonly<{ formatVersion: 2 }>;

export type HumanAiReadableLiveShadowMessageRequestV2 =
  Omit<core.HumanAiReadableLiveShadowMessageRequest, "formatVersion">
  & Readonly<{ formatVersion: 2 }>;

function requireVersion<T extends { readonly formatVersion: 1 | 2 }>(value: T): T & { readonly formatVersion: 2 } {
  if (value.formatVersion !== 2) {
    for (const field of Object.values(value) as unknown[]) {
      if (field instanceof Uint8Array) field.fill(0);
    }
    throw new TypeError("Human AI-readable V2 format mismatch");
  }
  return value as T & { readonly formatVersion: 2 };
}

export function decodeHumanAiReadableLiveShadowMessagePlanV2(bytes: Uint8Array): HumanAiReadableLiveShadowMessagePlanV2 {
  return requireVersion(core.decodeHumanAiReadableLiveShadowMessagePlan(bytes));
}

export function encodeHumanAiReadableLiveShadowMessagePlanV2(value: HumanAiReadableLiveShadowMessagePlanV2): Uint8Array {
  if (value.formatVersion !== 2) throw new TypeError("Human AI-readable V2 format mismatch");
  return core.encodeHumanAiReadableLiveShadowMessagePlan(value);
}

export function humanAiReadableLiveShadowMessagePlanDigestV2(bytes: Uint8Array): Uint8Array {
  const value = decodeHumanAiReadableLiveShadowMessagePlanV2(bytes);
  for (const field of Object.values(value)) {
    if (field instanceof Uint8Array) field.fill(0);
  }
  return core.humanAiReadableLiveShadowMessagePlanDigest(bytes);
}

export function decodeHumanAiReadableLiveShadowMessageRequestV2(bytes: Uint8Array): HumanAiReadableLiveShadowMessageRequestV2 {
  return requireVersion(core.decodeHumanAiReadableLiveShadowMessageRequest(bytes));
}

export function encodeHumanAiReadableLiveShadowMessageRequestV2(value: HumanAiReadableLiveShadowMessageRequestV2): Uint8Array {
  if (value.formatVersion !== 2) throw new TypeError("Human AI-readable V2 format mismatch");
  return core.encodeHumanAiReadableLiveShadowMessageRequest(value);
}

export function humanAiReadableLiveShadowMessageRequestDigestV2(bytes: Uint8Array): Uint8Array {
  const value = decodeHumanAiReadableLiveShadowMessageRequestV2(bytes);
  for (const field of Object.values(value)) {
    if (field instanceof Uint8Array) field.fill(0);
  }
  return core.humanAiReadableLiveShadowMessageRequestDigest(bytes);
}

export function humanAiReadableLiveShadowMessageRequestSigningBytesV2(value: HumanAiReadableLiveShadowMessageRequestV2): Uint8Array {
  if (value.formatVersion !== 2) throw new TypeError("Human AI-readable V2 format mismatch");
  return core.humanAiReadableLiveShadowMessageRequestSigningBytes(value);
}

export function prepareHumanAiReadableLiveShadowMessageRequestV2(
  crypto: Parameters<typeof core.prepareHumanAiReadableLiveShadowMessageRequest>[0],
  input: Parameters<typeof core.prepareHumanAiReadableLiveShadowMessageRequest>[1],
) {
  const result = core.prepareHumanAiReadableLiveShadowMessageRequest(crypto, input, 2);
  return Object.freeze({ ...result, request: requireVersion(result.request) });
}

export function verifyHumanAiReadableLiveShadowMessageRequestV2(
  crypto: Parameters<typeof core.verifyHumanAiReadableLiveShadowMessageRequest>[0],
  input: Parameters<typeof core.verifyHumanAiReadableLiveShadowMessageRequest>[1],
): HumanAiReadableLiveShadowMessageRequestV2 {
  const decoded = decodeHumanAiReadableLiveShadowMessageRequestV2(input.requestBytes);
  for (const field of Object.values(decoded)) {
    if (field instanceof Uint8Array) field.fill(0);
  }
  return requireVersion(core.verifyHumanAiReadableLiveShadowMessageRequest(crypto, input));
}

export function verifyHumanAiReadableLiveShadowMessageRequestExactReplayV2(
  crypto: Parameters<typeof core.verifyHumanAiReadableLiveShadowMessageRequestExactReplay>[0],
  input: Parameters<typeof core.verifyHumanAiReadableLiveShadowMessageRequestExactReplay>[1],
): HumanAiReadableLiveShadowMessageRequestV2 {
  const decoded = decodeHumanAiReadableLiveShadowMessageRequestV2(input.requestBytes);
  for (const field of Object.values(decoded)) {
    if (field instanceof Uint8Array) field.fill(0);
  }
  return requireVersion(core.verifyHumanAiReadableLiveShadowMessageRequestExactReplay(crypto, input));
}
