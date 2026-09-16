import type { LatticeCrypto } from "../crypto/index.ts";
import type { Epoch, NamespaceId, ObjectId, UserId } from "../types/index.ts";

/**
 * The swap axis. `EnumerationScheme` (v1) and a future ABE/SPE scheme (v2)
 * both implement this. They AGREE on the access predicate (`S ⊆ N`, computed
 * by the engine); they DIFFER only in how a scope obtains a namespace's key.
 *
 * Every value crossing this boundary is opaque to the engine:
 *  - `wrappedDek` / `encryptedSecret` are opaque byte bundles,
 *  - object wrap/unwrap context carries the persisted format version + AAD IDs,
 *  - `SchemeAccess` is whatever the scheme recovered from a grant secret.
 * The engine never inspects them, so v2 can use wildly different key shapes
 * without touching a single engine call site.
 */

export interface WrapContext {
  formatVersion: number;
  objectId: ObjectId;
  namespaceId: NamespaceId;
  epoch: Epoch;
  /** The namespace KEK the engine derived (from the MLS exporter secret). */
  namespaceKey: Uint8Array;
}

export interface UnwrapContext {
  formatVersion: number;
  objectId: ObjectId;
  namespaceId: NamespaceId;
  epoch: Epoch;
}

export interface CoveredNamespaceKey {
  namespaceId: NamespaceId;
  epoch: Epoch;
  namespaceKey: Uint8Array;
}

export interface DeriveGrantParams {
  scope: UserId[];
  /** Every namespace N with `scope ⊆ N`, with its current KEK. v1 wraps each;
   *  v2 would ignore the list and emit one policy key. */
  covered: CoveredNamespaceKey[];
  recipientPublicKey: Uint8Array;
}

/** Opaque to the engine; each scheme defines its own concrete shape and casts
 *  internally. Typed as `object` (not `unknown`) so `SchemeAccess | null`
 *  stays meaningful — the engine still never inspects its contents. */
export type SchemeAccess = object;

export interface LatticeScheme {
  readonly id: string;

  /** Format v1 implementations must authenticate the complete context. Reuse
   *  the package's `wrappedDekAad()` helper for canonical encoding. */
  wrapDek(dek: Uint8Array, ctx: WrapContext, crypto: LatticeCrypto): Promise<Uint8Array>;

  /**
   * Agent-side counterpart to `wrapDek`: wrap a fresh DEK using the key material
   * recovered from a grant (`access`) instead of the device-held namespace key.
   * Returns null if the access does not cover the target namespace. This is what
   * lets the agent AUTHOR new objects server-side during its grant window.
   */
  wrapDekWithAccess(
    dek: Uint8Array,
    ctx: UnwrapContext,
    access: SchemeAccess,
    crypto: LatticeCrypto,
  ): Promise<Uint8Array | null>;

  unwrapDek(
    wrappedDek: Uint8Array,
    ctx: UnwrapContext,
    access: SchemeAccess,
    crypto: LatticeCrypto,
  ): Promise<Uint8Array | null>;

  deriveGrantSecret(params: DeriveGrantParams, crypto: LatticeCrypto): Promise<Uint8Array>;

  openGrantSecret(
    encryptedSecret: Uint8Array,
    recipientPrivateKey: Uint8Array,
    crypto: LatticeCrypto,
  ): Promise<SchemeAccess | null>;
}
