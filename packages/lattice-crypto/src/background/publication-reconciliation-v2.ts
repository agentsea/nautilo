import type {LatticeCrypto} from "../crypto/index.ts";
import {concatV2, encodeU64, frame, frameText} from "../format/v2-primitives.ts";
import {assertPortableId, assertU64Counter} from "../v2-types/ids.ts";
import {STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2} from "./work-descriptor-v2.ts";

/** Public immutable evidence for one already committed result; never model input. */
export interface ProcessorPublicationReconciliationBindingV2 {
  readonly originalRequestId: string;
  readonly originalWorkId: string;
  readonly originalRecipientGeneration: number;
  readonly originalDescriptorHash: Uint8Array;
  readonly attachmentPlanHash: Uint8Array;
  readonly outputs: readonly Readonly<{
    objectId: string;
    objectType: "nautilo.reflection.record.v1" | "room_event_rollup";
    createdAt: number;
    payloadHash: Uint8Array;
    envelopeHash: Uint8Array;
  }>[];
}

/** Domain-separated commitment to the original receipt and exact stored prefix. */
export function publicationReconciliationFingerprintV2(
  crypto: Pick<LatticeCrypto, "hash">, binding: ProcessorPublicationReconciliationBindingV2,
): Uint8Array {
  const digest = (value: Uint8Array): Uint8Array => {
    if (!(value instanceof Uint8Array) || value.length !== 32) throw new TypeError("Reconciliation requires exact hashes");
    return frame(value);
  };
  assertPortableId("Original request", binding.originalRequestId);
  assertPortableId("Original work", binding.originalWorkId);
  assertU64Counter("Original recipient generation", binding.originalRecipientGeneration);
  if (!Array.isArray(binding.outputs as unknown) || binding.outputs.length > STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2) {
    throw new TypeError("Reconciliation output prefix is invalid");
  }
  const seen = new Set<string>();
  const outputs = binding.outputs.flatMap(output => {
    assertPortableId("Committed output", output.objectId);
    assertU64Counter("Committed output time", output.createdAt);
    if (seen.has(output.objectId) || !["nautilo.reflection.record.v1", "room_event_rollup"].includes(output.objectType)) {
      throw new TypeError("Reconciliation output coordinates are invalid");
    }
    seen.add(output.objectId);
    return [frameText(output.objectId), frameText(output.objectType), encodeU64(output.createdAt),
      digest(output.payloadHash), digest(output.envelopeHash)];
  });
  const bytes = concatV2(frameText("nautilo/stenographer/publication-reconciliation/v2"),
    frameText(binding.originalRequestId), frameText(binding.originalWorkId), encodeU64(binding.originalRecipientGeneration),
    digest(binding.originalDescriptorHash), digest(binding.attachmentPlanHash), encodeU64(binding.outputs.length), ...outputs);
  try {return crypto.hash(bytes);} finally {bytes.fill(0);}
}

/** Snapshot caller-owned public evidence before any asynchronous authority lookup. */
export function copyPublicationReconciliationBindingV2(
  binding: ProcessorPublicationReconciliationBindingV2,
): ProcessorPublicationReconciliationBindingV2 {
  return {originalRequestId: binding.originalRequestId, originalWorkId: binding.originalWorkId,
    originalRecipientGeneration: binding.originalRecipientGeneration,
    originalDescriptorHash: Uint8Array.from(binding.originalDescriptorHash),
    attachmentPlanHash: Uint8Array.from(binding.attachmentPlanHash),
    outputs: binding.outputs.map(output => ({objectId: output.objectId, objectType: output.objectType,
      createdAt: output.createdAt, payloadHash: Uint8Array.from(output.payloadHash), envelopeHash: Uint8Array.from(output.envelopeHash)}))};
}

/** Authenticated stored output failed its exact retained-result proof. */
export class ProcessorReconciliationIntegrityErrorV2 extends Error {
  override readonly name = "ProcessorReconciliationIntegrityErrorV2";
}
