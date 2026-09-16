import {
  cryptoDeviceId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";

export const OPAQUE_DELIVERY_ARTIFACT_FORMAT_VERSION = 1 as const;
export const OPAQUE_DELIVERY_ROW_MAX_BYTES = 1_048_616;
export const OPAQUE_DELIVERY_ARTIFACT_MAX_BYTES = 67_108_864;
export const OPAQUE_DELIVERY_ARTIFACT_MAX_CHUNKS = 4_096;
export const OPAQUE_DELIVERY_CHUNK_PAYLOAD_BYTES = 1_048_000;

export type OpaqueDeliveryArtifactKind =
  | "device_transfer"
  | "recovery_activation"
  | "domain_transition"
  | "membership_rebind"
  | "target_domain_bootstrap";

export interface OpaqueDeliveryArtifactChunk {
  readonly formatVersion:
    typeof OPAQUE_DELIVERY_ARTIFACT_FORMAT_VERSION;
  readonly kind: OpaqueDeliveryArtifactKind;
  readonly operationId: string;
  readonly recipientDeviceId: string;
  readonly artifactHash: Uint8Array;
  readonly artifactByteLength: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly payloadBytes: Uint8Array;
  readonly chunkHash: Uint8Array;
}

class ChunkReader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u32(): number {
    if (this.#offset + 4 > this.bytes.length) {
      throw new RangeError("Opaque delivery chunk is truncated");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getUint32(this.#offset);
    this.#offset += 4;
    return value;
  }

  u64(): number {
    if (this.#offset + 8 > this.bytes.length) {
      throw new RangeError("Opaque delivery chunk is truncated");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getBigUint64(this.#offset);
    this.#offset += 8;
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized)) {
      throw new RangeError("Opaque delivery chunk counter is unsafe");
    }
    return normalized;
  }

  frame(maximum: number): Uint8Array {
    const length = this.u32();
    if (length > maximum || this.#offset + length > this.bytes.length) {
      throw new RangeError("Opaque delivery chunk frame is out of bounds");
    }
    const value = this.bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  finish(): void {
    if (this.#offset !== this.bytes.length) {
      throw new RangeError("Opaque delivery chunk has trailing bytes");
    }
  }
}

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Opaque delivery chunk counter is out of bounds");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Opaque delivery artifact length is unsafe");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  output.set(u32(bytes.length));
  output.set(bytes, 4);
  return output;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function portableId(label: string, value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

function assertHash(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RangeError(`${label} must be exactly 32 bytes`);
  }
}

function kindCode(kind: OpaqueDeliveryArtifactKind): number {
  switch (kind) {
    case "device_transfer":
      return 1;
    case "recovery_activation":
      return 2;
    case "domain_transition":
      return 3;
    case "membership_rebind":
      return 4;
    case "target_domain_bootstrap":
      return 5;
  }
}

function codeKind(code: number): OpaqueDeliveryArtifactKind {
  switch (code) {
    case 1:
      return "device_transfer";
    case 2:
      return "recovery_activation";
    case 3:
      return "domain_transition";
    case 4:
      return "membership_rebind";
    case 5:
      return "target_domain_bootstrap";
    default:
      throw new TypeError("Opaque delivery artifact kind is unsupported");
  }
}

function chunkSigningBytes(
  chunk: Omit<OpaqueDeliveryArtifactChunk, "chunkHash">,
): Uint8Array {
  return concat([
    text("nautilo/lattice-bridge/opaque-delivery-artifact/v1"),
    u32(chunk.formatVersion),
    u32(kindCode(chunk.kind)),
    text(chunk.operationId),
    text(chunk.recipientDeviceId),
    frame(chunk.artifactHash),
    u64(chunk.artifactByteLength),
    u32(chunk.chunkIndex),
    u32(chunk.chunkCount),
    frame(chunk.payloadBytes),
  ]);
}

function assertChunkShape(
  chunk: OpaqueDeliveryArtifactChunk,
  crypto: Pick<LatticeCrypto, "hash">,
): void {
  if (
    typeof chunk !== "object"
    || chunk === null
    || chunk.formatVersion !== OPAQUE_DELIVERY_ARTIFACT_FORMAT_VERSION
  ) {
    throw new TypeError("Opaque delivery chunk is malformed");
  }
  kindCode(chunk.kind);
  portableId("Opaque delivery operation id", chunk.operationId);
  cryptoDeviceId(chunk.recipientDeviceId);
  assertHash("Opaque delivery artifact hash", chunk.artifactHash);
  assertHash("Opaque delivery chunk hash", chunk.chunkHash);
  if (
    !Number.isSafeInteger(chunk.artifactByteLength)
    || chunk.artifactByteLength < 1
    || chunk.artifactByteLength > OPAQUE_DELIVERY_ARTIFACT_MAX_BYTES
    || !Number.isInteger(chunk.chunkIndex)
    || chunk.chunkIndex < 0
    || !Number.isInteger(chunk.chunkCount)
    || chunk.chunkCount < 1
    || chunk.chunkCount > OPAQUE_DELIVERY_ARTIFACT_MAX_CHUNKS
    || chunk.chunkIndex >= chunk.chunkCount
    || !(chunk.payloadBytes instanceof Uint8Array)
    || chunk.payloadBytes.length < 1
    || chunk.payloadBytes.length > OPAQUE_DELIVERY_CHUNK_PAYLOAD_BYTES
  ) {
    throw new RangeError("Opaque delivery chunk is out of bounds");
  }
  const expected = crypto.hash(chunkSigningBytes(chunk));
  if (!equalBytes(expected, chunk.chunkHash)) {
    throw new Error("Opaque delivery chunk hash does not match");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function chunkOpaqueDeliveryArtifact(input: {
  readonly crypto: Pick<LatticeCrypto, "hash">;
  readonly kind: OpaqueDeliveryArtifactKind;
  readonly operationId: string;
  readonly recipientDeviceId: string;
  readonly artifactBytes: Uint8Array;
}): readonly OpaqueDeliveryArtifactChunk[] {
  portableId("Opaque delivery operation id", input.operationId);
  cryptoDeviceId(input.recipientDeviceId);
  if (
    !(input.artifactBytes instanceof Uint8Array)
    || input.artifactBytes.length < 1
    || input.artifactBytes.length > OPAQUE_DELIVERY_ARTIFACT_MAX_BYTES
  ) {
    throw new RangeError("Opaque delivery artifact is out of bounds");
  }
  const artifactHash = input.crypto.hash(input.artifactBytes);
  const count = Math.ceil(
    input.artifactBytes.length / OPAQUE_DELIVERY_CHUNK_PAYLOAD_BYTES,
  );
  const chunks: OpaqueDeliveryArtifactChunk[] = [];
  for (let index = 0; index < count; index++) {
    const payloadBytes = input.artifactBytes.slice(
      index * OPAQUE_DELIVERY_CHUNK_PAYLOAD_BYTES,
      Math.min(
        (index + 1) * OPAQUE_DELIVERY_CHUNK_PAYLOAD_BYTES,
        input.artifactBytes.length,
      ),
    );
    const unsigned = Object.freeze({
      formatVersion: OPAQUE_DELIVERY_ARTIFACT_FORMAT_VERSION,
      kind: input.kind,
      operationId: input.operationId,
      recipientDeviceId: input.recipientDeviceId,
      artifactHash: Uint8Array.from(artifactHash),
      artifactByteLength: input.artifactBytes.length,
      chunkIndex: index,
      chunkCount: count,
      payloadBytes,
    });
    const chunk = Object.freeze({
      ...unsigned,
      chunkHash: input.crypto.hash(chunkSigningBytes(unsigned)),
    });
    assertChunkShape(chunk, input.crypto);
    chunks.push(chunk);
  }
  return Object.freeze(chunks);
}

export function serializeOpaqueDeliveryArtifactChunk(
  chunk: OpaqueDeliveryArtifactChunk,
  crypto: Pick<LatticeCrypto, "hash">,
): Uint8Array {
  assertChunkShape(chunk, crypto);
  const bytes = concat([
    chunkSigningBytes(chunk),
    frame(chunk.chunkHash),
  ]);
  if (bytes.length > OPAQUE_DELIVERY_ROW_MAX_BYTES) {
    throw new RangeError("Serialized opaque delivery chunk exceeds row limit");
  }
  return bytes;
}

export function decodeOpaqueDeliveryArtifactChunk(
  bytes: Uint8Array,
  crypto: Pick<LatticeCrypto, "hash">,
): OpaqueDeliveryArtifactChunk {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > OPAQUE_DELIVERY_ROW_MAX_BYTES
  ) {
    throw new RangeError("Serialized opaque delivery chunk is out of bounds");
  }
  const reader = new ChunkReader(bytes);
  const domain = new TextDecoder("utf-8", { fatal: true }).decode(
    reader.frame(128),
  );
  if (domain !== "nautilo/lattice-bridge/opaque-delivery-artifact/v1") {
    throw new TypeError("Opaque delivery chunk domain is unsupported");
  }
  const formatVersion = reader.u32();
  const kind = codeKind(reader.u32());
  const operationId = new TextDecoder("utf-8", { fatal: true }).decode(
    reader.frame(128),
  );
  const recipientDeviceId = new TextDecoder("utf-8", {
    fatal: true,
  }).decode(reader.frame(128));
  const artifactHash = reader.frame(32);
  const artifactByteLength = reader.u64();
  const chunkIndex = reader.u32();
  const chunkCount = reader.u32();
  const payloadBytes = reader.frame(OPAQUE_DELIVERY_CHUNK_PAYLOAD_BYTES);
  const chunkHash = reader.frame(32);
  reader.finish();
  const chunk = Object.freeze({
    formatVersion,
    kind,
    operationId,
    recipientDeviceId,
    artifactHash,
    artifactByteLength,
    chunkIndex,
    chunkCount,
    payloadBytes,
    chunkHash,
  }) as OpaqueDeliveryArtifactChunk;
  assertChunkShape(chunk, crypto);
  return chunk;
}

export function reassembleOpaqueDeliveryArtifact(input: {
  readonly crypto: Pick<LatticeCrypto, "hash">;
  readonly chunks: readonly OpaqueDeliveryArtifactChunk[];
}): Uint8Array {
  if (
    input.chunks.length < 1
    || input.chunks.length > OPAQUE_DELIVERY_ARTIFACT_MAX_CHUNKS
  ) {
    throw new RangeError("Opaque delivery chunk collection is out of bounds");
  }
  input.chunks.forEach((chunk) => assertChunkShape(chunk, input.crypto));
  const first = input.chunks[0]!;
  if (
    input.chunks.length !== first.chunkCount
    || input.chunks.some((chunk) =>
      chunk.kind !== first.kind
      || chunk.operationId !== first.operationId
      || chunk.recipientDeviceId !== first.recipientDeviceId
      || chunk.artifactByteLength !== first.artifactByteLength
      || chunk.chunkCount !== first.chunkCount
      || !equalBytes(chunk.artifactHash, first.artifactHash)
    )
  ) {
    throw new Error("Opaque delivery chunks describe different artifacts");
  }
  const sorted = [...input.chunks].sort(
    (left, right) => left.chunkIndex - right.chunkIndex,
  );
  for (let index = 0; index < sorted.length; index++) {
    if (sorted[index]!.chunkIndex !== index) {
      throw new Error("Opaque delivery chunk sequence is incomplete");
    }
  }
  const artifact = concat(sorted.map((chunk) => chunk.payloadBytes));
  if (
    artifact.length !== first.artifactByteLength
    || !equalBytes(input.crypto.hash(artifact), first.artifactHash)
  ) {
    artifact.fill(0);
    throw new Error("Opaque delivery artifact hash does not match");
  }
  return artifact;
}
