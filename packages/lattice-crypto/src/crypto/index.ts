/**
 * Concrete crypto module — hardened (roadmap item 2).
 *
 * Audited, standardized, cross-runtime primitives (browser / Electron / Node):
 *  - Seal-to-a-public-key: HPKE (RFC 9180) via `@hpke/core` — DHKEM(P-256,
 *    HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM. WebCrypto-based → ASYNC.
 *    (P-256 KEM chosen over X25519 for universal WebCrypto support incl. Bun;
 *    both are standard RFC 9180 suites. Swappable in one line here.)
 *  - Object AEAD + DEK wrapping: XChaCha20-Poly1305 (`@noble/ciphers`) —
 *    192-bit random nonce, misuse-resistant for long-lived keys. Sync.
 *  - Grant signatures: Ed25519 (`@noble/curves`). Sync.
 *  - Hash / HKDF: SHA-256 / HKDF-SHA256 (`@noble/hashes`). Sync.
 *
 * NOT a swap axis (PQ is out of scope). Only the RNG + clock are injectable,
 * for deterministic tests. See docs/security-primitives.md.
 *
 * The seal/open (HPKE) methods are async because WebCrypto is async; this is
 * forward-compatible with ts-mls (also async). The rest is synchronous.
 */

import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, readU16, u16 } from "../util/bytes.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export interface Rng {
  /** Returns a fresh buffer whose ownership transfers to the caller. */
  bytes(n: number): Uint8Array;
}

export interface Clock {
  now(): number;
}

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface RecoveryKit {
  formatVersion: 1;
  /** The high-entropy material rendered as a checksummed human recovery code.
   * It never leaves the device except through the user's offline copy. */
  secret: Uint8Array;
  /** Safe to publish; deterministically derived from `secret`. */
  publicKey: Uint8Array;
  keyId: string;
}

export const systemRng: Rng = {
  bytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  },
};

/** Deterministic RNG for reproducible property tests. NOT for production. */
export function seededRng(seed: number): Rng {
  let s = seed >>> 0 || 0x9e3779b9;
  return {
    bytes(n: number): Uint8Array {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        b[i] = s & 0xff;
      }
      return b;
    },
  };
}

export const systemClock: Clock = { now: () => Date.now() };

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export function manualClock(start = 0): ManualClock {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

const XNONCE_LEN = 24;
const KEY_LEN = 32;
const HPKE_ENCAPSULATED_KEY_LEN = 65;
const AES_GCM_TAG_LEN = 16;
/** DHKEM-P256 private scalar length. WebCrypto/@hpke sometimes serialize a
 *  private scalar with its leading zero byte stripped (~1/256), and strict
 *  deserialization then rejects the short length. We left-pad to the canonical
 *  fixed length so round-trips are deterministic. */
const P256_SCALAR_LEN = 32;

function leftPad(b: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  out.set(b, len - b.length);
  return out;
}

/** Copy a view into a standalone ArrayBuffer (HPKE key (de)serialization
 *  wants ArrayBuffer, and subarray views must not leak neighbouring bytes). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.length);
  copy.set(u8);
  return copy.buffer;
}

export class LatticeCrypto {
  private readonly suite: CipherSuite;

  constructor(
    public readonly rng: Rng = systemRng,
    public readonly clock: Clock = systemClock,
  ) {
    this.suite = new CipherSuite({
      kem: new DhkemP256HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes256Gcm(),
    });
  }

  randomBytes(n: number): Uint8Array {
    const provided = this.rng.bytes(n);
    try {
      if (!(provided instanceof Uint8Array) || provided.length !== n) {
        throw new RangeError(
          `RNG returned ${provided instanceof Uint8Array ? provided.length : "invalid"} bytes for a ${n}-byte request`,
        );
      }
      return copyOwnedBytesV2(provided);
    } finally {
      if (provided instanceof Uint8Array) {
        provided.fill(0);
      }
    }
  }

  hash(data: Uint8Array): Uint8Array {
    return sha256(data);
  }

  /** HKDF-SHA256. `label` domain-separates derived keys (e.g. the
   *  human_e2ee_root vs ai_accessible_root split off the MLS exporter). */
  deriveKey(ikm: Uint8Array, label: string, length = KEY_LEN): Uint8Array {
    return hkdf(sha256, ikm, new Uint8Array(0), new TextEncoder().encode(label), length);
  }

  /** XChaCha20-Poly1305. Output = nonce(24) || (ciphertext+tag). */
  aeadSeal(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
    const nonce = this.randomBytes(XNONCE_LEN);
    const cipher = aad
      ? xchacha20poly1305(key, nonce, aad)
      : xchacha20poly1305(key, nonce);
    return concat(nonce, cipher.encrypt(plaintext));
  }

  aeadOpen(key: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Uint8Array | null {
    if (blob.length < XNONCE_LEN) return null;
    const nonce = blob.subarray(0, XNONCE_LEN);
    const sealed = blob.subarray(XNONCE_LEN);
    try {
      const cipher = aad
        ? xchacha20poly1305(key, nonce, aad)
        : xchacha20poly1305(key, nonce);
      return cipher.decrypt(sealed);
    } catch {
      return null;
    }
  }

  generateSigningKeyPair(): KeyPair {
    const privateKey = this.randomBytes(32);
    const publicKey = ed25519.getPublicKey(privateKey);
    return { publicKey, privateKey };
  }

  sign(signingPrivateKey: Uint8Array, message: Uint8Array): Uint8Array {
    return ed25519.sign(message, signingPrivateKey);
  }

  verify(signingPublicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
    try {
      return ed25519.verify(signature, message, signingPublicKey);
    } catch {
      return false;
    }
  }

  /** HPKE KEM keypair (X25519). Serialized to raw bytes for storage/transport. */
  async generateEncryptionKeyPair(): Promise<KeyPair> {
    const kp = await this.suite.kem.generateKeyPair();
    const publicKey = new Uint8Array(await this.suite.kem.serializePublicKey(kp.publicKey));
    const rawPrivate = new Uint8Array(await this.suite.kem.serializePrivateKey(kp.privateKey));
    try {
      // Canonical fixed-length scalar — see P256_SCALAR_LEN.
      const privateKey = leftPad(rawPrivate, P256_SCALAR_LEN);
      return { publicKey, privateKey };
    } finally {
      rawPrivate.fill(0);
    }
  }

  /** Deterministically derive an HPKE keypair from high-entropy input. This is
   * used only for recovery credentials: the server receives the public key,
   * while the 256-bit input is encoded into the user's offline recovery kit. */
  async deriveEncryptionKeyPair(ikm: Uint8Array): Promise<KeyPair> {
    const serializedIkm = toArrayBuffer(ikm);
    try {
      const kp = await this.suite.kem.deriveKeyPair(serializedIkm);
      const publicKey = new Uint8Array(
        await this.suite.kem.serializePublicKey(kp.publicKey),
      );
      const rawPrivate = new Uint8Array(
        await this.suite.kem.serializePrivateKey(kp.privateKey),
      );
      try {
        return {
          publicKey,
          privateKey: leftPad(rawPrivate, P256_SCALAR_LEN),
        };
      } finally {
        rawPrivate.fill(0);
      }
    } finally {
      new Uint8Array(serializedIkm).fill(0);
    }
  }

  async createRecoveryKit(): Promise<RecoveryKit> {
    const secret = this.randomBytes(32);
    let keyPair: KeyPair | undefined;
    try {
      keyPair = await this.deriveEncryptionKeyPair(secret);
      return {
        formatVersion: 1,
        secret,
        publicKey: keyPair.publicKey,
        keyId: `recovery_${Array.from(this.hash(keyPair.publicKey).subarray(0, 16))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")}`,
      };
    } catch (error) {
      secret.fill(0);
      throw error;
    } finally {
      keyPair?.privateKey.fill(0);
    }
  }

  /**
   * HPKE single-shot seal to a recipient public key. This is how a member
   * device encrypts a grant secret TO a non-member recipient (the agent).
   * Output = u16(encLen) || enc || ciphertext.
   */
  async sealTo(recipientPublicKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    const serializedPublicKey = toArrayBuffer(recipientPublicKey);
    const ownedPlaintext = copyOwnedBytesV2(plaintext);
    try {
      const pk = await this.suite.kem.deserializePublicKey(serializedPublicKey);
      const sender = await this.suite.createSenderContext({ recipientPublicKey: pk });
      const ct = new Uint8Array(await sender.seal(ownedPlaintext));
      const enc = new Uint8Array(sender.enc);
      return concat(u16(enc.length), enc, ct);
    } finally {
      ownedPlaintext.fill(0);
    }
  }

  async openSealed(recipientPrivateKey: Uint8Array, sealed: Uint8Array): Promise<Uint8Array | null> {
    const serializedPrivateKey = toArrayBuffer(recipientPrivateKey);
    const ownedSealed = copyOwnedBytesV2(sealed);
    try {
      const encLen = readU16(ownedSealed, 0);
      if (
        encLen !== HPKE_ENCAPSULATED_KEY_LEN
        || ownedSealed.length < 2 + encLen + AES_GCM_TAG_LEN
      ) return null;
      const enc = ownedSealed.subarray(2, 2 + encLen);
      const ct = ownedSealed.subarray(2 + encLen);
      try {
        const sk = await this.suite.kem.deserializePrivateKey(serializedPrivateKey);
        const recipient = await this.suite.createRecipientContext({
          recipientKey: sk,
          enc: toArrayBuffer(enc),
        });
        return new Uint8Array(await recipient.open(ct));
      } catch {
        return null;
      }
    } finally {
      new Uint8Array(serializedPrivateKey).fill(0);
    }
  }
}
