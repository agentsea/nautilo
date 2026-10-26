import type { SurplusWireReceipt } from "./surplus-transport";

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_REQUEST_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export interface SafeSurplusErrorDiagnostics {
  readonly vendorCode?: string;
  readonly responseStatus?: number;
  readonly traceId?: string;
}

export class SurplusMarketplaceAttemptError extends Error {
  readonly code = "surplus_marketplace_attempt_failed" as const;
  readonly vendorCode?: string;
  readonly status?: number;
  readonly traceId?: string;

  constructor(diagnostics: SafeSurplusErrorDiagnostics) {
    super("The Surplus marketplace attempt did not return a usable completion.");
    this.name = "SurplusMarketplaceAttemptError";
    if (diagnostics.vendorCode !== undefined) this.vendorCode = diagnostics.vendorCode;
    if (diagnostics.responseStatus !== undefined) this.status = diagnostics.responseStatus;
    if (diagnostics.traceId !== undefined) this.traceId = diagnostics.traceId;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeSurplusVendorCode(value: unknown): string | undefined {
  const outer = record(value);
  const nested = record(outer?.["error"]);
  const candidate = typeof outer?.["vendorCode"] === "string" ? outer["vendorCode"]
    : typeof outer?.["code"] === "string" ? outer["code"] : nested?.["code"];
  if (typeof candidate !== "string") return undefined;
  const normalized = candidate.trim().toLowerCase();
  return SAFE_CODE.test(normalized) ? normalized : undefined;
}

function safeSurplusRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return SAFE_REQUEST_ID.test(normalized) ? normalized : undefined;
}

function safeResponseStatus(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < 400 || value > 599) return undefined;
  return value;
}

export function safeSurplusErrorDiagnostics(
  error: unknown,
  responseStatus: number | undefined,
): SafeSurplusErrorDiagnostics {
  const vendorCode = safeSurplusVendorCode(error);
  const status = safeResponseStatus(responseStatus);
  return {
    ...(vendorCode === undefined ? {} : { vendorCode }),
    ...(status === undefined ? {} : { responseStatus: status }),
  };
}

/** Affirmative routing refusal evidence distinguishes a trace from a financial request. */
export function provenPreRoutingSurplusTrace(input: {
  readonly error: unknown;
  readonly responseStatus: number | undefined;
  readonly receipt: SurplusWireReceipt | undefined;
  readonly requestId?: string;
}): SafeSurplusErrorDiagnostics | null {
  const vendorCode = safeSurplusVendorCode(input.error);
  const responseStatus = safeResponseStatus(input.responseStatus);
  const traceId = safeSurplusRequestId(input.requestId ?? input.receipt?.requestId);
  if (!vendorCode || responseStatus === undefined || !traceId
    || input.receipt?.marketplaceAttempts !== 0
    || input.receipt.truncated || input.receipt.adaptedParameters?.trim()
    || (input.receipt.buyerCostMicro ?? 0) !== 0) return null;
  const proven = (responseStatus === 404 && vendorCode === "no_sellers_for_model")
    || (responseStatus === 503 && vendorCode === "no_healthy_sellers");
  return proven ? { vendorCode, responseStatus, traceId } : null;
}

export function surplusErrorTelemetry(diagnostics: SafeSurplusErrorDiagnostics): Record<string, unknown> {
  return {
    ...(diagnostics.vendorCode === undefined ? {} : { surplusErrorCode: diagnostics.vendorCode }),
    ...(diagnostics.responseStatus === undefined ? {} : { surplusResponseStatus: diagnostics.responseStatus }),
    ...(diagnostics.traceId === undefined ? {} : { surplusTraceId: diagnostics.traceId }),
  };
}

interface BoundedBodyReader {
  read(): Promise<Readonly<{ done?: boolean; value?: unknown }>>;
  cancel(): Promise<unknown>;
  releaseLock(): void;
}

/** Read only the bounded stable code and request reference from a discarded error body. */
export async function readBoundedSurplusErrorBody(reader: BoundedBodyReader | undefined): Promise<Readonly<{
  vendorCode?: string;
  requestId?: string;
}>> {
  if (!reader) return {};
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) return {};
      size += chunk.value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return {};
      }
      parts.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const row = record(value);
    const vendorCode = safeSurplusVendorCode(row);
    const requestId = safeSurplusRequestId(row?.["request_id"]);
    return {
      ...(vendorCode === undefined ? {} : { vendorCode }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  } catch {
    return {};
  } finally {
    reader.releaseLock();
  }
}
