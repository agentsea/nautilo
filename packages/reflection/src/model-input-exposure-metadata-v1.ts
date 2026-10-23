import {
  normalizeRecordModelExposureDependenciesV1,
  RECORD_PAYLOAD_V1_LIMITS,
  type RecordPayloadModelExposureDependencyV1,
} from "./record-payload-v1";

export type ModelInputExposureMetadataV1 =
  | Readonly<{ version: 1; status: "incomplete" }>
  | Readonly<{
      version: 1;
      status: "complete";
      dependencies: readonly RecordPayloadModelExposureDependencyV1[];
    }>;

const encoder = new TextEncoder();

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

/** Closed wire parser for the ordinary sibling of protected model-input evidence. */
export function parseModelInputExposureMetadataV1(
  value: unknown,
): ModelInputExposureMetadataV1 | null {
  const candidate = record(value);
  if (candidate === null || candidate["version"] !== 1) return null;
  if (candidate["status"] === "incomplete") {
    return exactKeys(candidate, ["version", "status"])
      ? Object.freeze({ version: 1 as const, status: "incomplete" as const })
      : null;
  }
  if (
    candidate["status"] !== "complete"
    || !exactKeys(candidate, ["version", "status", "dependencies"])
  ) return null;
  try {
    if (encoder.encode(JSON.stringify(candidate)).byteLength
      > RECORD_PAYLOAD_V1_LIMITS.payloadBytes) return null;
    return Object.freeze({
      version: 1 as const,
      status: "complete" as const,
      dependencies: normalizeRecordModelExposureDependenciesV1(
        candidate["dependencies"],
      ),
    });
  } catch {
    return null;
  }
}
