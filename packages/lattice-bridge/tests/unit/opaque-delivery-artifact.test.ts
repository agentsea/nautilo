import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  OPAQUE_DELIVERY_ARTIFACT_MAX_BYTES,
  OPAQUE_DELIVERY_CHUNK_PAYLOAD_BYTES,
  OPAQUE_DELIVERY_ROW_MAX_BYTES,
  chunkOpaqueDeliveryArtifact,
  decodeOpaqueDeliveryArtifactChunk,
  reassembleOpaqueDeliveryArtifact,
  serializeOpaqueDeliveryArtifactChunk,
} from "../../src/index.ts";

const crypto = new LatticeCrypto();

describe("opaque delivery artifact chunks", () => {
  test("round trips one-byte and multi-row artifacts deterministically", () => {
    for (const artifact of [
      new Uint8Array([0x41]),
      new Uint8Array(OPAQUE_DELIVERY_CHUNK_PAYLOAD_BYTES * 2 + 17)
        .map((_, index) => index % 251),
    ]) {
      const chunks = chunkOpaqueDeliveryArtifact({
        crypto,
        kind: "device_transfer",
        operationId: "operation_chunk_round_trip",
        recipientDeviceId: "device_chunk_recipient",
        artifactBytes: artifact,
      });
      const decoded = chunks.map((chunk) => {
        const serialized = serializeOpaqueDeliveryArtifactChunk(
          chunk,
          crypto,
        );
        expect(serialized.length).toBeLessThanOrEqual(
          OPAQUE_DELIVERY_ROW_MAX_BYTES,
        );
        return decodeOpaqueDeliveryArtifactChunk(serialized, crypto);
      });
      expect(reassembleOpaqueDeliveryArtifact({
        crypto,
        chunks: decoded.reverse(),
      })).toEqual(artifact);
    }
  });

  test("rejects oversized artifacts and serialized rows", () => {
    expect(() => chunkOpaqueDeliveryArtifact({
      crypto,
      kind: "device_transfer",
      operationId: "operation_too_large",
      recipientDeviceId: "device_chunk_recipient",
      artifactBytes: new Uint8Array(
        OPAQUE_DELIVERY_ARTIFACT_MAX_BYTES + 1,
      ),
    })).toThrow("artifact is out of bounds");
    expect(() => decodeOpaqueDeliveryArtifactChunk(
      new Uint8Array(OPAQUE_DELIVERY_ROW_MAX_BYTES + 1),
      crypto,
    )).toThrow("chunk is out of bounds");
  });

  test("rejects missing, duplicate, mixed, and corrupted chunks", () => {
    const chunks = chunkOpaqueDeliveryArtifact({
      crypto,
      kind: "device_transfer",
      operationId: "operation_chunk_rejection",
      recipientDeviceId: "device_chunk_recipient",
      artifactBytes: new Uint8Array(
        OPAQUE_DELIVERY_CHUNK_PAYLOAD_BYTES + 8,
      ).fill(0x51),
    });
    expect(() => reassembleOpaqueDeliveryArtifact({
      crypto,
      chunks: [chunks[0]!],
    })).toThrow("different artifacts");
    expect(() => reassembleOpaqueDeliveryArtifact({
      crypto,
      chunks: [chunks[0]!, chunks[0]!],
    })).toThrow("sequence is incomplete");
    expect(() => reassembleOpaqueDeliveryArtifact({
      crypto,
      chunks: [
        chunks[0]!,
        { ...chunks[1]!, operationId: "operation_other" },
      ],
    })).toThrow("chunk hash does not match");
    expect(() => reassembleOpaqueDeliveryArtifact({
      crypto,
      chunks: [
        chunks[0]!,
        {
          ...chunks[1]!,
          payloadBytes: Uint8Array.from(chunks[1]!.payloadBytes, (byte) =>
            byte ^ 1
          ),
        },
      ],
    })).toThrow("chunk hash does not match");
  });

  test("rejects cross-device substitution before reassembly", () => {
    const [chunk] = chunkOpaqueDeliveryArtifact({
      crypto,
      kind: "recovery_activation",
      operationId: "operation_recovery_chunk",
      recipientDeviceId: "device_recovery_target",
      artifactBytes: new Uint8Array([0x61]),
    });
    expect(() => reassembleOpaqueDeliveryArtifact({
      crypto,
      chunks: [{
        ...chunk!,
        recipientDeviceId: "device_attacker",
      }],
    })).toThrow("chunk hash does not match");
  });
});
