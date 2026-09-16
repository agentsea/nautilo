import {
  authorizationRevision, cryptoDeviceId, encryptObjectPayload, humanId,
  objectId, prepareHumanObjectAccessManifestGenesisSet, unixTimestamp,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import { decodeNamespaceObjectEnvelopeV2, encodeEncryptedPayloadV2 } from "@nautilo/lattice-crypto/wire";
import { deriveMemoryCryptoObjectIdV1, MEMORY_OBJECT_TYPE } from "../../memory/memory-repository.ts";
import { encodeMemoryPayloadV1, type MemoryPayloadV1 } from "../../memory/memory-payload-v1.ts";

/** Shared device crypto construction for semantic writes and representation
 * repair. It does not allocate a product row, run embedding, or record an edit.
 * The custody owner supplies authenticated Namespace wrapping and owns all
 * returned ciphertext buffers. The transient DEK never survives this call. */
export async function prepareHumanMemoryCiphertext(input: Readonly<{
  crypto: LatticeCrypto;
  memoryId: string;
  contentRevision: number;
  createdAt: number;
  payload: MemoryPayloadV1;
  namespaceIds: readonly string[];
  subjectHumanId: string;
  deviceId: string;
  hostAuthorizationRevision: number;
  signingPublicKey: Uint8Array;
  signingPrivateKey: Uint8Array;
  wrapNamespace(input: Readonly<{
    namespaceId: string; cryptoObjectId: string; dek: Uint8Array;
  }>): Promise<Uint8Array>;
}>): Promise<Readonly<{
  cryptoObjectId: string;
  payloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
}>> {
  if (input.namespaceIds.length === 0 || input.namespaceIds.some((id, index) =>
    index > 0 && input.namespaceIds[index - 1]! >= id)) {
    throw new TypeError("Human Memory ciphertext requires its canonical exact Namespace set");
  }
  const cryptoObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId: input.memoryId, contentRevision: input.contentRevision,
  });
  const plaintext = encodeMemoryPayloadV1(input.payload);
  let dek: Uint8Array | undefined;
  let payloadBytes: Uint8Array | undefined;
  let manifestBytes: Uint8Array | undefined;
  const envelopeBytes: Uint8Array[] = [];
  try {
    const encrypted = encryptObjectPayload(input.crypto, {
      objectId: objectId(cryptoObjectId), keyClass: "ai", objectType: MEMORY_OBJECT_TYPE,
      createdAt: unixTimestamp(input.createdAt),
    }, plaintext);
    dek = encrypted.dek;
    payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    for (const namespaceId of input.namespaceIds) {
      const bytes = await input.wrapNamespace({ namespaceId, cryptoObjectId, dek });
      envelopeBytes.push(bytes);
      const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
      if (envelope.context.namespaceId !== namespaceId
        || envelope.context.objectId !== cryptoObjectId || envelope.context.keyClass !== "ai") {
        throw new TypeError("Human Memory wrapping substituted its exact audience or object");
      }
    }
    const payloadHash = input.crypto.hash(payloadBytes);
    try {
      const genesis = prepareHumanObjectAccessManifestGenesisSet(input.crypto, {
        objectId: objectId(cryptoObjectId), payloadHash, envelopeBytes,
        sourceAuthorized: true, targetAuthorized: true,
        subjectHumanId: humanId(input.subjectHumanId), committerDeviceId: cryptoDeviceId(input.deviceId),
        hostAuthorizationRevision: authorizationRevision(input.hostAuthorizationRevision),
        committerSigningPublicKey: input.signingPublicKey,
        committerSigningPrivateKey: input.signingPrivateKey,
      });
      manifestBytes = genesis.manifestBytes;
      return Object.freeze({ cryptoObjectId, payloadBytes, manifestBytes, envelopeBytes });
    } finally { payloadHash.fill(0); }
  } catch (error) {
    payloadBytes?.fill(0);
    manifestBytes?.fill(0);
    envelopeBytes.forEach((bytes) => bytes.fill(0));
    throw error;
  } finally {
    plaintext.fill(0);
    dek?.fill(0);
  }
}
