import { describe, expect, test } from "bun:test";
import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";

import {
  protectedTaskPreparedCreateRequestV1Schema,
  protectedTaskPreparedPublicationRequestV1Schema,
  protectedTaskPreparedUpdateRequestV1Schema,
  type ProtectedTaskPreparedCreateRequestV1,
} from "../../src/browser.ts";

const TASK_ID = "91000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "91000000-0000-4000-8000-000000000002";

function createRequest(): ProtectedTaskPreparedCreateRequestV1 {
  return {
    requestVersion: 1,
    operationId: "task:create:1",
    planDigestBase64url: "A".repeat(43),
    taskId: TASK_ID,
    expectedContentRevision: 0,
    nextContentRevision: 1,
    expectedCryptoAccessRevision: 0,
    resultCryptoAccessRevision: 0,
    cryptoObjectId: `task:v1:${TASK_ID}:1`,
    payloadVersion: 1,
    requiredNamespaceIds: [NAMESPACE_ID],
    encryptedPayloadBytesBase64url: "Y2lwaGVydGV4dA",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    namespaceEnvelopes: [{
      namespaceId: NAMESPACE_ID,
      envelopeBytesBase64url: "ZW52ZWxvcGU",
    }],
    signedPublicationRequestBytesBase64url: "c2lnbmVk",
    operation: "create",
  };
}

describe("protected Task prepared publication schema", () => {
  test("accepts exact create and adjacent update coordinates", () => {
    const create = createRequest();
    expect(protectedTaskPreparedPublicationRequestV1Schema.parse(create)).toEqual(create);

    const update = {
      ...create,
      operation: "update" as const,
      operationId: "task:update:1",
      expectedContentRevision: 7,
      nextContentRevision: 8,
      expectedCryptoAccessRevision: 3,
      cryptoObjectId: `task:v1:${TASK_ID}:8`,
    };
    expect(protectedTaskPreparedUpdateRequestV1Schema.parse(update)).toEqual(update);
  });

  test("rejects unknown fields, mismatched authority, and invalid revisions", () => {
    const create = createRequest();
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      prompt: "must never enter the prepared transport",
    })).toThrow();
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      namespaceEnvelopes: [{
        ...create.namespaceEnvelopes[0],
        namespaceId: "91000000-0000-4000-8000-000000000003",
      }],
    })).toThrow();
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      expectedCryptoAccessRevision: 1,
    })).toThrow();
    expect(() => protectedTaskPreparedUpdateRequestV1Schema.parse({
      ...create,
      operation: "update",
      expectedContentRevision: 4,
      nextContentRevision: 6,
    })).toThrow();
  });

  test("uses the lattice ciphertext bound without truncation", () => {
    const maximumEncodedLength = Math.ceil(
      LATTICE_LIMITS.ciphertextBytes * 4 / 3,
    );
    const create = createRequest();
    for (const length of [maximumEncodedLength - 1, maximumEncodedLength]) {
      expect(protectedTaskPreparedCreateRequestV1Schema.parse({
        ...create,
        encryptedPayloadBytesBase64url: "A".repeat(length),
      }).encryptedPayloadBytesBase64url).toHaveLength(length);
    }
    expect(() => protectedTaskPreparedCreateRequestV1Schema.parse({
      ...create,
      encryptedPayloadBytesBase64url: "A".repeat(maximumEncodedLength + 1),
    })).toThrow();
  });
});
