import { createHash } from "node:crypto";
import type { QualifiedSurplusChatRoute } from "./surplus-route";
import type { SurplusWireReceipt } from "./surplus-transport";

/** Bind later request-detail reads to the creating credential without storing it. */
export function surplusCredentialFingerprint(apiKey: string): string {
  return createHash("sha256").update("nautilo:surplus:receipt:v1\0").update(apiKey.trim()).digest("hex");
}

export function surplusAttemptBinding(route: QualifiedSurplusChatRoute, apiKey: string) {
  return {
    surplusModelId: route.surplusModelId,
    surplusProviderPin: route.providerPin,
    surplusCredentialFingerprint: surplusCredentialFingerprint(apiKey),
  };
}

/** Persist only bounded protocol metadata, never arbitrary upstream strings. */
export function surplusReceiptTelemetry(receipt: SurplusWireReceipt): Record<string, unknown> {
  const servedBy = ["marketplace", "preferred_key", "fallback_key"].includes(receipt.servedBy ?? "")
    ? receipt.servedBy : undefined;
  const adaptedParameters = receipt.adaptedParameters?.split(",").map((part) => part.trim());
  const safeParameters = adaptedParameters?.length && adaptedParameters.length <= 32
    && adaptedParameters.every((part) => /^[a-z][a-z0-9_.:-]{0,63}$/i.test(part))
    ? adaptedParameters : undefined;
  return {
    ...(servedBy ? { surplusServedBy: servedBy } : {}),
    ...(receipt.marketplaceAttempts === undefined ? {} : { surplusMarketplaceAttempts: receipt.marketplaceAttempts }),
    ...(safeParameters ? { surplusAdaptedParameters: safeParameters } : {}),
    surplusTruncated: receipt.truncated,
  };
}

export interface SurplusSettlementBinding {
  requestId: string;
  surplusModelId: string;
  providerPin: string;
}

/** The observed accrued credit receipt is confirmed financial evidence, not answer success. */
export function readConfirmedSurplusSettlement(value: unknown, binding: SurplusSettlementBinding): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row["request_id"] !== binding.requestId || row["model"] !== binding.surplusModelId
    || row["provider"] !== binding.providerPin) return null;
  if (row["settlement_status"] !== "accrued" || row["settlement_type"] !== "credit"
    || (row["settlement_error"] !== undefined && row["settlement_error"] !== null)) return null;
  const confirmedAt = row["confirmed_at"];
  if (typeof confirmedAt !== "string" || !Number.isFinite(Date.parse(confirmedAt))) return null;
  const cost = row["buyer_cost_micro"];
  return typeof cost === "number" && Number.isSafeInteger(cost) && cost >= 0 ? cost : null;
}

/** Content-free fixed-origin lookup. A refusal/missing receipt remains unresolved. */
export async function fetchSurplusSettlement(input: {
  binding: SurplusSettlementBinding;
  apiKey: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<number | null> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.binding.requestId)) return null;
  const response = await (input.fetchImpl ?? fetch)(
    `https://api.surplusintelligence.ai/v1/requests/${encodeURIComponent(input.binding.requestId)}`,
    { method: "GET", redirect: "error", signal: input.signal, headers: { Authorization: `Bearer ${input.apiKey.trim()}` } },
  );
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  // Request detail has no reason to carry captured request/response bodies.
  // Bound even a malformed server response before parsing it.
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) { await reader.cancel(); return null; }
      size += value.byteLength;
      if (size > 65_536) { await reader.cancel(); return null; }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return readConfirmedSurplusSettlement(JSON.parse(new TextDecoder().decode(bytes)), input.binding);
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
