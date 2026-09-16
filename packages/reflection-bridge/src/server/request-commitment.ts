import { createHmac } from "node:crypto";

import type { DurableRecordPublication } from "@nautilo/reflection/durable";

import type { RecordRequestCommitmentPort } from "./contracts";

/** Product-keyed replay commitment; the key and raw semantic hash are never persisted. */
export function createHmacRecordRequestCommitmentPort(
  key: Uint8Array,
): RecordRequestCommitmentPort {
  if (key.byteLength < 32) {
    throw new TypeError("Record commitment key must contain at least 32 bytes");
  }
  const ownedKey = key.slice();
  return Object.freeze({
    commit(payloadBytes: Uint8Array, publication: DurableRecordPublication): Uint8Array {
      const hmac = createHmac("sha256", ownedKey);
      const fields = [
        "nautilo-reflection-record-publication-v2",
        publication.idempotencyKey,
        publication.record.recordRef,
        publication.record.lifecycle,
        String(publication.record.structuralHeight),
        String(publication.record.processingGeneration),
        publication.publicationBindingRef,
        publication.predecessor === undefined ? "none" : "some",
        publication.predecessor?.recordRef ?? "",
        publication.predecessor?.relation ?? "",
      ];
      for (const field of fields) {
        const encoded = Buffer.from(field, "utf8");
        hmac.update(String(encoded.byteLength), "utf8");
        hmac.update(":", "utf8");
        hmac.update(encoded);
      }
      if (publication.originPublicationBindingRef !== undefined) {
        for (const field of [
          "origin_publication_binding_ref",
          publication.originPublicationBindingRef,
        ]) {
          const encoded = Buffer.from(field, "utf8");
          hmac.update(String(encoded.byteLength), "utf8");
          hmac.update(":", "utf8");
          hmac.update(encoded);
        }
      }
      hmac.update(String(payloadBytes.byteLength), "utf8");
      hmac.update(":", "utf8");
      hmac.update(payloadBytes);
      return new Uint8Array(hmac.digest());
    },
  });
}
