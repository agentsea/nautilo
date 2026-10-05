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

export type SurplusSettlementReadResult =
  | { status: "settled"; costMicro: number }
  | {
      status: "retryable";
      failureCode:
        | "receipt_not_found"
        | "receipt_not_confirmed"
        | "receipt_rate_limited"
        | "receipt_service_unavailable";
    }
  | {
      status: "blocked_repair";
      failureCode: "receipt_read_unauthorized" | "receipt_request_rejected";
    };

/** The observed accrued credit receipt is confirmed financial evidence, not answer success. */
export function readConfirmedSurplusSettlement(value: unknown, binding: SurplusSettlementBinding): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  // The creating key and exact request ID bind this charge to its attempt.
  // Surplus resolves provider aliases to a canonical model in request detail;
  // that spelling change must not discard a confirmed financial receipt.
  // Model/answer correctness is a separate execution concern.
  if (row["request_id"] !== binding.requestId || row["provider"] !== binding.providerPin) return null;
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
}): Promise<SurplusSettlementReadResult> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.binding.requestId)) {
    return { status: "blocked_repair", failureCode: "receipt_request_rejected" };
  }
  const response = await (input.fetchImpl ?? fetch)(
    `https://api.surplusintelligence.ai/v1/requests/${encodeURIComponent(input.binding.requestId)}`,
    { method: "GET", redirect: "error", signal: input.signal, headers: { Authorization: `Bearer ${input.apiKey.trim()}` } },
  );
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) {
      return { status: "blocked_repair", failureCode: "receipt_read_unauthorized" };
    }
    // The request-detail contract does not define 404 as permanent. Preserve
    // the unknown charge and retry because a recent request log may not yet be
    // visible to the read path.
    if (response.status === 404) {
      return { status: "retryable", failureCode: "receipt_not_found" };
    }
    if (response.status === 429) {
      return { status: "retryable", failureCode: "receipt_rate_limited" };
    }
    if (response.status >= 500) {
      return { status: "retryable", failureCode: "receipt_service_unavailable" };
    }
    return { status: "blocked_repair", failureCode: "receipt_request_rejected" };
  }
  // Request detail has no reason to carry captured request/response bodies.
  // Bound even a malformed server response before parsing it.
  const reader = response.body?.getReader();
  if (!reader) return { status: "retryable", failureCode: "receipt_not_confirmed" };
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel();
        return { status: "retryable", failureCode: "receipt_not_confirmed" };
      }
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return { status: "retryable", failureCode: "receipt_not_confirmed" };
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const costMicro = readConfirmedSurplusSettlement(
      JSON.parse(new TextDecoder().decode(bytes)),
      input.binding,
    );
    return costMicro === null
      ? { status: "retryable", failureCode: "receipt_not_confirmed" }
      : { status: "settled", costMicro };
  } catch {
    return { status: "retryable", failureCode: "receipt_not_confirmed" };
  } finally {
    reader.releaseLock();
  }
}
