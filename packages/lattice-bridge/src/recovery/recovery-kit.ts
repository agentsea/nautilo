import {
  entropyToMnemonic,
  mnemonicToEntropy,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";

export const RECOVERY_KIT_FORMAT_VERSION = 1 as const;
export const RECOVERY_KIT_DOCUMENT_HEADER =
  "Nautilo Recovery Kit v1" as const;
export const RECOVERY_KIT_ENTROPY_BYTES = 32 as const;
export const RECOVERY_KIT_WORDS = 24 as const;

export type RecoveryKitFormatErrorCode =
  | "invalid_entropy"
  | "invalid_word_count"
  | "invalid_words_or_checksum";

export class RecoveryKitFormatError extends Error {
  readonly code: RecoveryKitFormatErrorCode;

  constructor(code: RecoveryKitFormatErrorCode) {
    super(`Recovery kit is invalid (${code})`);
    this.name = "RecoveryKitFormatError";
    this.code = code;
  }
}

export interface RecoveryMnemonicCredential {
  readonly formatVersion: typeof RECOVERY_KIT_FORMAT_VERSION;
  readonly mnemonic: string;
  readonly keyId: string;
  readonly publicKey: Uint8Array;
}

export interface OpenedRecoveryCredential {
  readonly formatVersion: typeof RECOVERY_KIT_FORMAT_VERSION;
  readonly keyId: string;
  readonly publicKey: Uint8Array;
  /**
   * Client-only secret. The caller must immediately hand this to the recovery
   * workflow and wipe it; UI, IPC, logs, and server DTOs must never receive it.
   */
  readonly privateKey: Uint8Array;
}

function recoveryKeyId(
  publicKey: Uint8Array,
  crypto: Pick<LatticeCrypto, "hash">,
): string {
  const digest = crypto.hash(publicKey);
  try {
    if (!(digest instanceof Uint8Array) || digest.length !== 32) {
      throw new Error("Recovery credential hash is invalid");
    }
    return `recovery_${
      Array.from(
        digest.subarray(0, 16),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("")
    }`;
  } finally {
    digest.fill(0);
  }
}

export async function createRecoveryMnemonicCredential(
  crypto: Pick<LatticeCrypto, "createRecoveryKit" | "hash">,
): Promise<RecoveryMnemonicCredential> {
  const kit = await crypto.createRecoveryKit();
  try {
    if (
      kit.formatVersion !== RECOVERY_KIT_FORMAT_VERSION
      || !(kit.secret instanceof Uint8Array)
      || kit.secret.length !== RECOVERY_KIT_ENTROPY_BYTES
      || !(kit.publicKey instanceof Uint8Array)
      || kit.publicKey.length !== 65
      || kit.keyId !== recoveryKeyId(kit.publicKey, crypto)
    ) {
      throw new Error("Generated recovery credential is invalid");
    }
    return Object.freeze({
      formatVersion: RECOVERY_KIT_FORMAT_VERSION,
      mnemonic: encodeRecoveryMnemonic(kit.secret),
      keyId: kit.keyId,
      publicKey: Uint8Array.from(kit.publicKey),
    });
  } finally {
    kit.secret.fill(0);
  }
}

export async function deriveRecoveryCredentialFromMnemonic(
  mnemonic: string,
  crypto: Pick<LatticeCrypto, "deriveEncryptionKeyPair" | "hash">,
): Promise<OpenedRecoveryCredential> {
  const entropy = decodeRecoveryMnemonic(mnemonic);
  let privateKey: Uint8Array | undefined;
  try {
    const keyPair = await crypto.deriveEncryptionKeyPair(entropy);
    privateKey = keyPair.privateKey;
    if (
      !(keyPair.publicKey instanceof Uint8Array)
      || keyPair.publicKey.length !== 65
      || !(privateKey instanceof Uint8Array)
      || privateKey.length !== 32
    ) {
      throw new Error("Derived recovery credential is invalid");
    }
    const result = Object.freeze({
      formatVersion: RECOVERY_KIT_FORMAT_VERSION,
      keyId: recoveryKeyId(keyPair.publicKey, crypto),
      publicKey: Uint8Array.from(keyPair.publicKey),
      privateKey,
    });
    privateKey = undefined;
    return result;
  } finally {
    entropy.fill(0);
    privateKey?.fill(0);
  }
}

function normalizeMnemonic(value: string): string {
  return value.normalize("NFKD").trim().split(/\s+/u).join(" ");
}

export function encodeRecoveryMnemonic(entropy: Uint8Array): string {
  if (entropy.length !== RECOVERY_KIT_ENTROPY_BYTES) {
    throw new RecoveryKitFormatError("invalid_entropy");
  }

  return entropyToMnemonic(entropy, wordlist);
}

export function decodeRecoveryMnemonic(mnemonic: string): Uint8Array {
  const normalized = normalizeMnemonic(mnemonic);
  if (normalized.split(" ").length !== RECOVERY_KIT_WORDS) {
    throw new RecoveryKitFormatError("invalid_word_count");
  }

  try {
    const entropy = mnemonicToEntropy(normalized, wordlist);
    if (entropy.length !== RECOVERY_KIT_ENTROPY_BYTES) {
      entropy.fill(0);
      throw new RecoveryKitFormatError("invalid_entropy");
    }
    return entropy;
  } catch (error) {
    if (error instanceof RecoveryKitFormatError) throw error;
    throw new RecoveryKitFormatError("invalid_words_or_checksum");
  }
}
