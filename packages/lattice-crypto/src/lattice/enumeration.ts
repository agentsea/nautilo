import type { LatticeCrypto } from "../crypto/index.ts";
import { wrappedDekAad } from "../format/object-v1.ts";
import { LATTICE_LIMITS } from "../limits.ts";
import type { NamespaceId } from "../types/index.ts";
import { encodeJson, fromHex, toHex } from "../util/bytes.ts";
import {
  assertBytes,
  assertEpoch,
  assertId,
  assertIdList,
  isPlainRecord,
} from "../validation.ts";
import type {
  DeriveGrantParams,
  LatticeScheme,
  SchemeAccess,
  UnwrapContext,
  WrapContext,
} from "./scheme.ts";

/**
 * v1 — the "enumerate namespaces" scheme. This is the crypto-bearing analogue
 * of Nautilo's `findReadableNamespacesForSubset`: a grant for scope S wraps
 * the KEK of every namespace N where `S ⊆ N`, sealed to the recipient.
 *
 * Trade-off: grant size is O(#accessible namespaces). Fine for a personal AI;
 * a future ABE scheme collapses this to O(1) behind the same interface.
 */

/** Concrete access: namespaceId -> epoch -> hex(KEK). */
type EnumAccess = Record<NamespaceId, Record<string, string>>;
const keyHexPattern = /^[0-9a-f]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function accessKey(
  access: SchemeAccess,
  namespaceId: NamespaceId,
  epoch: number,
): Uint8Array | null {
  if (!isPlainRecord(access)) return null;
  const epochs = access[namespaceId];
  if (!isPlainRecord(epochs)) return null;
  const hex = epochs[String(epoch)];
  if (typeof hex !== "string" || !keyHexPattern.test(hex)) return null;
  try {
    return fromHex(hex);
  } catch {
    return null;
  }
}

export class EnumerationScheme implements LatticeScheme {
  readonly id = "enumeration";

  wrapDek(dek: Uint8Array, ctx: WrapContext, crypto: LatticeCrypto): Promise<Uint8Array> {
    // The DEK is sealed under the namespace KEK for this epoch (sync AEAD).
    const aad = wrappedDekAad(ctx);
    if (!aad) return Promise.reject(new Error("invalid v1 wrapped-DEK context"));
    return Promise.resolve(crypto.aeadSeal(ctx.namespaceKey, dek, aad));
  }

  wrapDekWithAccess(
    dek: Uint8Array,
    ctx: UnwrapContext,
    access: SchemeAccess,
    crypto: LatticeCrypto,
  ): Promise<Uint8Array | null> {
    const key = accessKey(access, ctx.namespaceId, ctx.epoch);
    if (!key) return Promise.resolve(null);
    const aad = wrappedDekAad(ctx);
    if (!aad) return Promise.resolve(null);
    // Same wrapped format as wrapDek — the KEK just comes from the grant access.
    return Promise.resolve(crypto.aeadSeal(key, dek, aad));
  }

  unwrapDek(
    wrappedDek: Uint8Array,
    ctx: UnwrapContext,
    access: SchemeAccess,
    crypto: LatticeCrypto,
  ): Promise<Uint8Array | null> {
    const key = accessKey(access, ctx.namespaceId, ctx.epoch);
    if (!key) return Promise.resolve(null);
    const aad = wrappedDekAad(ctx);
    if (!aad) return Promise.resolve(null);
    return Promise.resolve(crypto.aeadOpen(key, wrappedDek, aad));
  }

  async deriveGrantSecret(params: DeriveGrantParams, crypto: LatticeCrypto): Promise<Uint8Array> {
    assertIdList(
      "grant scope",
      params.scope,
      1,
      LATTICE_LIMITS.grantScope,
    );
    assertBytes(
      "recipient public key",
      params.recipientPublicKey,
      LATTICE_LIMITS.hpkePublicKeyBytes,
      LATTICE_LIMITS.hpkePublicKeyBytes,
    );
    if (
      params.covered.length > LATTICE_LIMITS.totalGrantEpochs
    ) {
      throw new RangeError("covered namespace keys exceed the grant epoch limit");
    }
    const map: EnumAccess = {};
    const namespaceIds = new Set<NamespaceId>();
    const namespaceEpochs = new Set<string>();
    const covered = [...params.covered].sort((left, right) =>
      left.namespaceId.localeCompare(right.namespaceId) ||
      left.epoch - right.epoch
    );
    for (const c of covered) {
      assertId("covered namespace id", c.namespaceId);
      assertEpoch("covered namespace epoch", c.epoch);
      assertBytes("namespace key", c.namespaceKey, 32, 32);
      namespaceIds.add(c.namespaceId);
      if (namespaceIds.size > LATTICE_LIMITS.coveredNamespaces) {
        throw new RangeError("covered namespaces exceed their limit");
      }
      const pair = `${c.namespaceId}\u0000${c.epoch}`;
      if (namespaceEpochs.has(pair)) {
        throw new RangeError("covered namespace epochs must be unique");
      }
      namespaceEpochs.add(pair);
      const epochs = map[c.namespaceId] ?? {};
      epochs[String(c.epoch)] = toHex(c.namespaceKey);
      map[c.namespaceId] = epochs;
    }
    const encoded = encodeJson(map);
    if (encoded.length > LATTICE_LIMITS.grantSecretBytes) {
      throw new RangeError("encoded grant access exceeds its byte limit");
    }
    return crypto.sealTo(params.recipientPublicKey, encoded);
  }

  async openGrantSecret(
    encryptedSecret: Uint8Array,
    recipientPrivateKey: Uint8Array,
    crypto: LatticeCrypto,
  ): Promise<SchemeAccess | null> {
    if (
      !(encryptedSecret instanceof Uint8Array) ||
      encryptedSecret.length < 1 ||
      encryptedSecret.length > LATTICE_LIMITS.grantSecretBytes ||
      !(recipientPrivateKey instanceof Uint8Array) ||
      recipientPrivateKey.length !== LATTICE_LIMITS.hpkePrivateKeyBytes
    ) return null;
    const opened = await crypto.openSealed(recipientPrivateKey, encryptedSecret);
    if (!opened || opened.length > LATTICE_LIMITS.grantSecretBytes) return null;
    try {
      const decoded: unknown = JSON.parse(decoder.decode(opened));
      if (!isPlainRecord(decoded)) return null;
      const namespaceEntries = Object.entries(decoded);
      if (
        namespaceEntries.length > LATTICE_LIMITS.coveredNamespaces
      ) return null;
      const namespaceIds = namespaceEntries.map(([namespaceId]) => namespaceId);
      const sortedNamespaceIds = [...namespaceIds].sort((left, right) =>
        left.localeCompare(right)
      );
      if (namespaceIds.some((id, index) => id !== sortedNamespaceIds[index])) {
        return null;
      }
      let totalEpochs = 0;
      for (const [namespaceId, epochValue] of namespaceEntries) {
        assertId("access namespace id", namespaceId);
        if (!isPlainRecord(epochValue)) return null;
        const epochEntries = Object.entries(epochValue);
        if (
          epochEntries.length < 1 ||
          epochEntries.length > LATTICE_LIMITS.epochsPerNamespace
        ) return null;
        totalEpochs += epochEntries.length;
        if (totalEpochs > LATTICE_LIMITS.totalGrantEpochs) return null;
        let previousEpoch = -1;
        for (const [epochText, hex] of epochEntries) {
          if (!/^(0|[1-9][0-9]*)$/.test(epochText)) return null;
          const epoch = Number(epochText);
          assertEpoch("access epoch", epoch);
          if (epoch <= previousEpoch) return null;
          previousEpoch = epoch;
          if (typeof hex !== "string" || !keyHexPattern.test(hex)) return null;
        }
      }
      return decoded;
    } catch {
      return null;
    }
  }
}
