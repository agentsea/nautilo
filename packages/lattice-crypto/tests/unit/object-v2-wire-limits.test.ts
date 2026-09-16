import { describe, expect, test } from "bun:test";

import {
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
  MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
  NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  accessRevision,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

describe("Object V2 codec wire maxima", () => {
  test("match the largest values admitted by each canonical encoder", () => {
    const encrypted = encodeEncryptedPayloadV2({
      formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
      context: {
        objectId: objectId("o".repeat(V2_LIMITS.idBytes)),
        keyClass: "human",
        objectType: "t".repeat(V2_LIMITS.schemeIdBytes),
        createdAt: unixTimestamp(Number.MAX_SAFE_INTEGER),
      },
      ciphertext: new Uint8Array(V2_LIMITS.ciphertextBytes),
    });
    expect(encrypted).toHaveLength(MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2);

    const envelope = encodeNamespaceObjectEnvelopeV2({
      formatVersion: NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
      context: {
        objectId: objectId("o".repeat(V2_LIMITS.idBytes)),
        namespaceId: namespaceId("n".repeat(V2_LIMITS.idBytes)),
        keyClass: "human",
        keyGeneration: namespaceGeneration(Number.MAX_SAFE_INTEGER),
        bindingRevisionAtWrap: accessRevision(Number.MAX_SAFE_INTEGER),
      },
      wrappedDek: new Uint8Array(V2_LIMITS.wrappedDekBytes),
    });
    expect(envelope).toHaveLength(MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2);
  });
});
