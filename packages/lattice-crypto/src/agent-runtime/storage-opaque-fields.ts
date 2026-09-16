import {
  assertOpaqueBytes,
  type OpaqueByteKind,
} from "../v2-types/opaque.ts";

function assertOpaqueRecordField(
  records: unknown,
  field: string,
  label: string,
  expectedKind: OpaqueByteKind,
): void {
  if (!Array.isArray(records)) return;
  for (const record of records as readonly unknown[]) {
    if (
      typeof record === "object"
      && record !== null
      && Object.hasOwn(record, field)
    ) {
      assertOpaqueBytes(
        label,
        (record as Record<string, unknown>)[field],
        expectedKind,
      );
    }
  }
}

/**
 * Authenticate every opaque field carried by an atomic Runtime state before a
 * one-shot persistence capability is minted. Generic object cloning cannot
 * infer provenance from attacker-controlled classification tags.
 */
export function assertAgentRuntimeStorageOpaqueFields(
  state: unknown,
): void {
  if (typeof state !== "object" || state === null) return;
  const candidate = state as Record<string, unknown>;
  assertOpaqueRecordField(
    candidate["configObjects"],
    "wrappedDek",
    "Runtime config DEK",
    "agent-runtime-config-dek",
  );
  assertOpaqueRecordField(
    candidate["domainEnvelopes"],
    "envelopeBytes",
    "Agent Runtime Domain envelope",
    "agent-runtime-domain-envelope",
  );
}
