import {sha256} from "@noble/hashes/sha2.js";
import {bytesToHex} from "@noble/hashes/utils.js";
import {assertPortableId, assertU64Counter} from "../v2-types/ids.ts";
import type {LatticeCrypto} from "../crypto/index.ts";
import {concatV2, encodeU64, frame, frameText} from "../format/v2-primitives.ts";
import {STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2} from "./work-descriptor-v2.ts";

export interface StenographerOrdinaryOutputProvenance {
  readonly kind: "extraction" | "compaction";
  readonly receiptId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly rebuildGeneration: number;
  readonly fallbackReason: "device" | "authority";
  readonly outputs: readonly Readonly<{
    logicalId: string;
    objectType: "nautilo.reflection.record.v1" | "room_event_rollup";
    createdAt: number;
    payloadBytes: Uint8Array;
  }>[];
}

/** Commit the actual ordinary publication, before any later protected object ID
 * is allocated. The same canonical bytes are used by its exact repair loader. */
export function stenographerOrdinaryOutputFingerprint(input: StenographerOrdinaryOutputProvenance): Uint8Array {
  for (const id of [input.receiptId, input.roomId, input.namespaceId]) assertPortableId("Ordinary Journal receipt", id);
  if (!["extraction", "compaction"].includes(input.kind)
    || !["device", "authority"].includes(input.fallbackReason)
    || !Number.isSafeInteger(input.rebuildGeneration) || input.rebuildGeneration < 0) {
    throw new TypeError("Ordinary Journal provenance is invalid");
  }
  const seen = new Set<string>();
  const outputs = input.outputs.map(output => {
    assertPortableId("Ordinary Journal output", output.logicalId);
    if (seen.has(output.logicalId) || !Number.isSafeInteger(output.createdAt) || output.createdAt < 0
      || !(output.payloadBytes instanceof Uint8Array)
      || output.objectType !== (input.kind === "extraction" ? "nautilo.reflection.record.v1" : "room_event_rollup")) {
      throw new TypeError("Ordinary Journal output inventory is invalid");
    }
    seen.add(output.logicalId);
    const digest = sha256(output.payloadBytes);
    try {return [output.logicalId, output.objectType, output.createdAt, bytesToHex(digest)];}
    finally {digest.fill(0);}
  });
  const bytes = new TextEncoder().encode(JSON.stringify([
    "nautilo/stenographer/ordinary-output/v1", input.kind, input.receiptId,
    input.roomId, input.namespaceId, input.rebuildGeneration, input.fallbackReason, outputs,
  ]));
  try {return sha256(bytes);} finally {bytes.fill(0);}
}

/** Complete metadata inventory of one immutable ordinary fallback result. */
export interface ProcessorOutputRepairBindingV2 {
  readonly receipt: Readonly<{
    kind: "extraction" | "compaction";
    id: string;
    roomId: string;
    namespaceId: string;
    rebuildGeneration: number;
    fallbackReason: "device" | "authority";
    ordinaryOutputFingerprint: Uint8Array;
  }>;
  readonly outputs: readonly Readonly<{
    logicalId: string;
    objectId: string;
    objectType: "nautilo.reflection.record.v1" | "room_event_rollup";
    createdAt: number;
    disposition: "existing" | "create";
    representationGeneration: number;
    ordinaryRepresentationGeneration: number | null;
  }>[];
}

/** Commit the original aggregate and exact existing/new representation inventory. */
export function outputRepairFingerprintV2(
  crypto: Pick<LatticeCrypto, "hash">, binding: ProcessorOutputRepairBindingV2,
): Uint8Array {
  const receipt = binding.receipt;
  for (const id of [receipt.id, receipt.roomId, receipt.namespaceId]) assertPortableId("Repair receipt", id);
  assertU64Counter("Repair rebuild generation", receipt.rebuildGeneration);
  if (!["extraction", "compaction"].includes(receipt.kind)
    || !["device", "authority"].includes(receipt.fallbackReason)
    || !(receipt.ordinaryOutputFingerprint instanceof Uint8Array) || receipt.ordinaryOutputFingerprint.length !== 32
    || !Array.isArray(binding.outputs as unknown) || binding.outputs.length < 1
    || binding.outputs.length > STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2
    || (receipt.kind === "compaction" && binding.outputs.length !== 1)) {
    throw new TypeError("Output repair receipt is invalid");
  }
  const logicalIds = new Set<string>();
  const objectIds = new Set<string>();
  const outputs = binding.outputs.flatMap(output => {
    assertPortableId("Repair logical output", output.logicalId);
    assertPortableId("Repair crypto output", output.objectId);
    for (const [name, value] of [["creation time", output.createdAt], ["representation generation", output.representationGeneration]] as const) assertU64Counter(name, value);
    if (receipt.kind === "extraction") {
      if (output.ordinaryRepresentationGeneration === null) throw new TypeError("Record repair requires its ordinary generation");
      assertU64Counter("ordinary generation", output.ordinaryRepresentationGeneration);
    }
    if ((receipt.kind === "compaction" && output.ordinaryRepresentationGeneration !== null)
      || logicalIds.has(output.logicalId) || objectIds.has(output.objectId)
      || !["existing", "create"].includes(output.disposition)
      || output.objectType !== (receipt.kind === "extraction" ? "nautilo.reflection.record.v1" : "room_event_rollup")) {
      throw new TypeError("Output repair inventory is invalid");
    }
    logicalIds.add(output.logicalId); objectIds.add(output.objectId);
    return [frameText(output.logicalId), frameText(output.objectId), frameText(output.objectType), encodeU64(output.createdAt),
      frameText(output.disposition), encodeU64(output.representationGeneration),
      frame(output.ordinaryRepresentationGeneration === null ? new Uint8Array() : encodeU64(output.ordinaryRepresentationGeneration))];
  });
  const bytes = concatV2(frameText("nautilo/stenographer/output-repair/v2"), frameText(receipt.kind), frameText(receipt.id),
    frameText(receipt.roomId), frameText(receipt.namespaceId), encodeU64(receipt.rebuildGeneration), frameText(receipt.fallbackReason),
    frame(receipt.ordinaryOutputFingerprint), encodeU64(binding.outputs.length), ...outputs);
  try {return crypto.hash(bytes);} finally {bytes.fill(0);}
}

export function copyOutputRepairBindingV2(binding: ProcessorOutputRepairBindingV2): ProcessorOutputRepairBindingV2 {
  return {receipt: {...binding.receipt, ordinaryOutputFingerprint: Uint8Array.from(binding.receipt.ordinaryOutputFingerprint)},
    outputs: binding.outputs.map(output => ({...output}))};
}

/** Proven mismatch between the committed ordinary result and its protected representation. */
export class ProcessorOutputRepairIntegrityErrorV2 extends Error {
  override readonly name = "ProcessorOutputRepairIntegrityErrorV2";
}
