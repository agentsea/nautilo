/**
 * Key-slot registry types. Wave 0 declares the slot shapes and validates the
 * declared Argon2id bounds and slot invariants. It does NOT implement Argon2id
 * derivation, key wrapping, or keychain access — those are out of Wave 0.
 *
 * `RecoverySlot` is the only slot kind with declared bounds validated in
 * Wave 0. `KeychainSlot` is declared (opaque OS-keychain slot, deferred per
 * spec §5 P0 item 4) and validated only for shape; the validator reports
 * `KEYCHAIN_SLOT_NOT_IMPLEMENTED` so callers cannot mistake it for working.
 */

import type { Argon2idParams } from "../protection/argon2-bounds";

export type RecoverySlot = {
  readonly kind: "recovery";
  readonly slotId: number;
  readonly kdf: "argon2id";
  readonly kdfParams: Argon2idParams;
  readonly salt: Uint8Array;
  readonly wrappedDek: Uint8Array;
  readonly aad: Uint8Array;
};

export type KeychainSlot = {
  readonly kind: "keychain";
  readonly slotId: number;
  readonly keychainLabel: string;
  readonly wrappedDek: Uint8Array;
  readonly aad: Uint8Array;
};

export type KeySlotV1 = RecoverySlot | KeychainSlot;

export type KeySlotKind = KeySlotV1["kind"];
