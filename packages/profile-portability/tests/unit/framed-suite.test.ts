/**
 * Wave 1A — `xchacha20poly1305-framed-v1` framed recovery protection tests.
 *
 * Covers: round-trip encryption/decryption, header-bound nonce/AAD derivation,
 * Argon2id recovery-slot DEK wrap/unwrap (with an injected deterministic KDF
 * stand-in for the real `argon2` runtime, which is not a declared dependency of
 * this package), terminal-manifest FINAL verification, and comprehensive
 * tamper / reorder / truncation / wrong-passphrase rejection.
 *
 * The deterministic KDF stand-in (`testArgon2id`) is NOT real Argon2id; it is a
 * passphrase/salt/params-dependent SHA-256 derivation used only to exercise the
 * wrap/unwrap + wrong-passphrase paths. Production callers inject the real
 * `argon2` runtime via `Argon2idDeriveFn`.
 */

import { describe, test, expect } from "bun:test";
import {
  computeHeaderDigest,
  deriveFrameNonce,
  deriveWrapNonce,
  computeFrameAad,
  computeSlotAad,
  generateDek,
  wrapDekWithRecoverySlot,
  unwrapDekFromRecoverySlot,
  encryptBundle,
  verifyFinalBundle,
  equalBytes,
  type Argon2idDeriveFn,
} from "../../src/protection/framed-suite";
import { sha256 } from "../../src/sha256";
import { canonicalJsonBytes } from "../../src/canonical";
import type { ContainerHeaderV1, EncryptedFrameV1 } from "../../src/container/types";
import type { RecoverySlot } from "../../src/key-slots/types";
import type { GenieLiveV1 } from "../../src/semantic/types";

// ---------------------------------------------------------------------------
// Deterministic Argon2id stand-in for tests.
// ---------------------------------------------------------------------------

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

const testArgon2id: Argon2idDeriveFn = ({ passphrase, salt, params }) => {
  // Passphrase / salt / params-dependent 32-byte derivation. Distinct inputs
  // produce distinct KEKs, which is all the wrap/unwrap + wrong-passphrase
  // tests need. This is NOT real Argon2id.
  return sha256(
    new Uint8Array([
      ...passphrase,
      ...salt,
      ...u32be(params.memoryCostKiB),
      ...u32be(params.timeCost),
      ...u32be(params.parallelism),
      ...u32be(params.outputLength),
    ]),
  ).subarray(0, 32);
};

const KDF_PARAMS = { memoryCostKiB: 19456, timeCost: 2, parallelism: 1, outputLength: 32 };
const PASSPHRASE = new TextEncoder().encode("correct horse battery staple");
const WRONG_PASSPHRASE = new TextEncoder().encode("wrong passphrase entirely");

function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** Await `p` and assert it rejects; avoids `expect().rejects` (await-thenable under bun-types). */
async function expectToReject(p: Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

// ---------------------------------------------------------------------------
// Fixture: a small GenieLiveV1 + matching header.
// ---------------------------------------------------------------------------

const records: GenieLiveV1["records"] = [
  { recordKind: "identity", name: "Aria", handleIntent: "aria" },
  { recordKind: "soul", text: "A calm, precise assistant." },
  { recordKind: "personality", text: "Warm but concise." },
  {
    recordKind: "preferences",
    preferences: { theme: "dark", notifications: true, volume: 0.8 },
  },
  { recordKind: "memory", scope: "private", content: "User prefers terse answers.", createdAt: "2026-07-14T10:00:00Z" },
];

async function buildBundle(passphrase: Uint8Array = PASSPHRASE): Promise<{
  header: ContainerHeaderV1;
  frames: EncryptedFrameV1[];
  dek: Uint8Array;
  slot: RecoverySlot;
  digest: string;
}> {
  const dek = generateDek();
  const salt = randomSalt();
  const slot = await wrapDekWithRecoverySlot({
    dek,
    passphrase,
    salt,
    kdfParams: KDF_PARAMS,
    slotId: 0,
    argon2id: testArgon2id,
  });
  const totalPayloadBytes = records.reduce((acc, r) => acc + canonicalJsonBytes(r).length, 0);
  const header: ContainerHeaderV1 = {
    containerVersion: 1,
    semanticVersion: { major: 1, minor: 0 },
    bundleId: "source-genie-001",
    payloadCodec: "genie-live-records",
    protectionSuite: "xchacha20poly1305-framed-v1",
    chunkSize: 64 * 1024,
    keySlots: [slot],
    frameCount: records.length + 1,
    totalPayloadBytes,
  };
  const enc = encryptBundle({ header, records, dek });
  if (!enc.ok) throw new Error(`encryptBundle failed: ${JSON.stringify(enc.errors)}`);
  return { header, frames: enc.frames, dek, slot, digest: enc.headerDigest };
}

// ---------------------------------------------------------------------------
// Nonce + AAD derivation
// ---------------------------------------------------------------------------

describe("nonce derivation + uniqueness", () => {
  test("frame nonces are 24 bytes and unique per ordinal", () => {
    const d = "0".repeat(64);
    const nonces = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const n = deriveFrameNonce(d, i);
      expect(n.length).toBe(24);
      nonces.add(Buffer.from(n).toString("hex"));
    }
    expect(nonces.size).toBe(1000);
  });

  test("frame nonces differ across header digests for the same ordinal", () => {
    const a = deriveFrameNonce("a".repeat(64), 0);
    const b = deriveFrameNonce("b".repeat(64), 0);
    expect(equalBytes(a, b)).toBe(false);
  });

  test("wrap nonces are 24 bytes and unique per (salt, slotId)", () => {
    const s1 = randomSalt();
    const s2 = randomSalt();
    expect(equalBytes(deriveWrapNonce(s1, 0), deriveWrapNonce(s1, 1))).toBe(false);
    expect(equalBytes(deriveWrapNonce(s1, 0), deriveWrapNonce(s2, 0))).toBe(false);
  });

  test("frame and wrap nonce domains are disjoint even with identical inputs", () => {
    // Same digest-shaped bytes and ordinal=0 vs salt+slotId=0 must not collide
    // because of the "frame" / "wrap" domain-separation tags.
    const d = "0".repeat(64);
    const frame = deriveFrameNonce(d, 0);
    const wrap = deriveWrapNonce(new TextEncoder().encode(d).subarray(0, 16), 0);
    expect(equalBytes(frame, wrap)).toBe(false);
  });
});

describe("AAD binding", () => {
  test("frame AAD includes digest/ordinal/kind/length/finality and is deterministic", () => {
    const d = "a".repeat(64);
    const a1 = computeFrameAad({ headerDigest: d, ordinal: 3, kind: "record", plaintextLength: 42 });
    const a2 = computeFrameAad({ headerDigest: d, ordinal: 3, kind: "record", plaintextLength: 42 });
    expect(equalBytes(a1, a2)).toBe(true);
    const json = new TextDecoder().decode(a1);
    expect(json).toContain('"digest":"');
    expect(json).toContain('"ordinal":3');
    expect(json).toContain('"kind":"record"');
    expect(json).toContain('"length":42');
    expect(json).toContain('"final":false');
  });

  test("terminal-manifest frame AAD carries final=true", () => {
    const d = "a".repeat(64);
    const a = computeFrameAad({ headerDigest: d, ordinal: 5, kind: "terminal-manifest", plaintextLength: 99 });
    expect(new TextDecoder().decode(a)).toContain('"final":true');
  });

  test("AAD changes when any bound element changes (tamper sensitivity)", () => {
    const d = "a".repeat(64);
    const base = computeFrameAad({ headerDigest: d, ordinal: 3, kind: "record", plaintextLength: 42 });
    expect(equalBytes(base, computeFrameAad({ headerDigest: "b".repeat(64), ordinal: 3, kind: "record", plaintextLength: 42 }))).toBe(false);
    expect(equalBytes(base, computeFrameAad({ headerDigest: d, ordinal: 4, kind: "record", plaintextLength: 42 }))).toBe(false);
    expect(equalBytes(base, computeFrameAad({ headerDigest: d, ordinal: 3, kind: "terminal-manifest", plaintextLength: 42 }))).toBe(false);
    expect(equalBytes(base, computeFrameAad({ headerDigest: d, ordinal: 3, kind: "record", plaintextLength: 43 }))).toBe(false);
  });

  test("slot AAD is deterministic and binds slotId/kdf", () => {
    const a = computeSlotAad({ slotId: 0, kind: "recovery", kdf: "argon2id" });
    const b = computeSlotAad({ slotId: 0, kind: "recovery", kdf: "argon2id" });
    expect(equalBytes(a, b)).toBe(true);
    const c = computeSlotAad({ slotId: 1, kind: "recovery", kdf: "argon2id" });
    expect(equalBytes(a, c)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DEK wrap / unwrap
// ---------------------------------------------------------------------------

describe("Argon2id recovery-slot DEK wrap/unwrap", () => {
  test("wipes the derived KEK after both wrapping and failed unwrapping", async () => {
    const outputs: Uint8Array[] = [];
    const trackingKdf: Argon2idDeriveFn = async (input) => {
      const output = new Uint8Array(await testArgon2id(input));
      outputs.push(output);
      return output;
    };
    const dek = new Uint8Array(32).fill(7);
    const slot = await wrapDekWithRecoverySlot({ dek, passphrase: PASSPHRASE, salt: randomSalt(), kdfParams: KDF_PARAMS, slotId: 0, argon2id: trackingKdf });
    expect(outputs[0]).toEqual(new Uint8Array(32));
    const rejected = await unwrapDekFromRecoverySlot({ slot, passphrase: WRONG_PASSPHRASE, argon2id: trackingKdf });
    expect(rejected.ok).toBe(false);
    expect(outputs[1]).toEqual(new Uint8Array(32));
  });
  test("round-trips the DEK with the correct passphrase", async () => {
    const dek = generateDek();
    const salt = randomSalt();
    const slot = await wrapDekWithRecoverySlot({
      dek,
      passphrase: PASSPHRASE,
      salt,
      kdfParams: KDF_PARAMS,
      slotId: 0,
      argon2id: testArgon2id,
    });
    const res = await unwrapDekFromRecoverySlot({ slot, passphrase: PASSPHRASE, argon2id: testArgon2id });
    expect(res.ok).toBe(true);
    if (res.ok) expect(equalBytes(res.dek, dek)).toBe(true);
  });

  test("wrong passphrase is rejected with WRONG_PASSPHRASE", async () => {
    const dek = generateDek();
    const salt = randomSalt();
    const slot = await wrapDekWithRecoverySlot({
      dek,
      passphrase: PASSPHRASE,
      salt,
      kdfParams: KDF_PARAMS,
      slotId: 0,
      argon2id: testArgon2id,
    });
    const res = await unwrapDekFromRecoverySlot({ slot, passphrase: WRONG_PASSPHRASE, argon2id: testArgon2id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("WRONG_PASSPHRASE");
  });

  test("tampered wrappedDek is rejected (auth failure)", async () => {
    const dek = generateDek();
    const salt = randomSalt();
    const slot = await wrapDekWithRecoverySlot({
      dek,
      passphrase: PASSPHRASE,
      salt,
      kdfParams: KDF_PARAMS,
      slotId: 0,
      argon2id: testArgon2id,
    });
    const tampered: RecoverySlot = {
      ...slot,
      wrappedDek: new Uint8Array(slot.wrappedDek),
    };
    tampered.wrappedDek[0] = tampered.wrappedDek[0]! ^ 0xff;
    const res = await unwrapDekFromRecoverySlot({ slot: tampered, passphrase: PASSPHRASE, argon2id: testArgon2id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("WRONG_PASSPHRASE");
  });

  test("wrap rejects bad DEK length, bad salt length, and out-of-bounds params", async () => {
    await expectToReject(
      wrapDekWithRecoverySlot({ dek: new Uint8Array(16), passphrase: PASSPHRASE, salt: randomSalt(), kdfParams: KDF_PARAMS, slotId: 0, argon2id: testArgon2id }),
    );
    await expectToReject(
      wrapDekWithRecoverySlot({ dek: generateDek(), passphrase: PASSPHRASE, salt: new Uint8Array(8), kdfParams: KDF_PARAMS, slotId: 0, argon2id: testArgon2id }),
    );
    await expectToReject(
      wrapDekWithRecoverySlot({
        dek: generateDek(),
        passphrase: PASSPHRASE,
        salt: randomSalt(),
        kdfParams: { ...KDF_PARAMS, timeCost: 1 },
        slotId: 0,
        argon2id: testArgon2id,
      }),
    );
  });

  test("wrap rejects a KDF that returns a short key", async () => {
    const badKdf: Argon2idDeriveFn = () => new Uint8Array(16);
    await expectToReject(
      wrapDekWithRecoverySlot({ dek: generateDek(), passphrase: PASSPHRASE, salt: randomSalt(), kdfParams: KDF_PARAMS, slotId: 0, argon2id: badKdf }),
    );
  });

  test("unwrap rejects an empty wrappedDek structurally", async () => {
    const slot: RecoverySlot = {
      kind: "recovery",
      slotId: 0,
      kdf: "argon2id",
      kdfParams: KDF_PARAMS,
      salt: randomSalt(),
      wrappedDek: new Uint8Array(0),
      aad: computeSlotAad({ slotId: 0, kind: "recovery", kdf: "argon2id" }),
    };
    const res = await unwrapDekFromRecoverySlot({ slot, passphrase: PASSPHRASE, argon2id: testArgon2id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("DEK_UNWRAP_FAILED");
  });
});

// ---------------------------------------------------------------------------
// Bundle round-trip + FINAL verification
// ---------------------------------------------------------------------------

describe("encryptBundle + verifyFinalBundle round-trip", () => {
  test("round-trips records and yields them only after FINAL verification", async () => {
    const { header, frames, dek } = await buildBundle();
    const res = verifyFinalBundle({ header, frames, dek });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.records.length).toBe(records.length);
      // Each yielded record's kind matches the original.
      for (let i = 0; i < records.length; i++) {
        expect((res.records[i] as { recordKind: string }).recordKind).toBe(records[i]!.recordKind);
      }
    }
  });

  test("the digest bound into frames equals computeHeaderDigest(header)", async () => {
    const { header, frames, digest } = await buildBundle();
    expect(computeHeaderDigest(header)).toBe(digest);
    // Every frame's AAD carries that digest.
    for (const f of frames) {
      expect(new TextDecoder().decode(f.aad)).toContain(`"digest":"${digest}"`);
    }
  });

  test("header digest changes when any immutable header field changes", async () => {
    const { header } = await buildBundle();
    const d1 = computeHeaderDigest(header);
    const d2 = computeHeaderDigest({ ...header, bundleId: "source-genie-002" });
    const d3 = computeHeaderDigest({ ...header, chunkSize: 32 * 1024 });
    expect(d1).not.toBe(d2);
    expect(d1).not.toBe(d3);
  });

  test("rejects a wrong-size DEK", async () => {
    const { header, frames } = await buildBundle();
    const res = verifyFinalBundle({ header, frames, dek: new Uint8Array(16) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "DEK_LENGTH_INVALID")).toBe(true);
  });

  test("rejects an empty frame sequence (no FINAL)", async () => {
    const { header, dek } = await buildBundle();
    const res = verifyFinalBundle({ header, frames: [], dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "FRAME_MISSING_FINAL")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tamper: ciphertext, AAD, header
// ---------------------------------------------------------------------------

function cloneFrames(frames: readonly EncryptedFrameV1[]): EncryptedFrameV1[] {
  return frames.map((f) => ({
    ordinal: f.ordinal,
    kind: f.kind,
    ciphertext: new Uint8Array(f.ciphertext),
    aad: new Uint8Array(f.aad),
  }));
}

describe("tamper rejection", () => {
  test("flipping a byte in a record frame ciphertext → AEAD_AUTH_FAILED", async () => {
    const { header, frames, dek } = await buildBundle();
    const tampered = cloneFrames(frames);
    tampered[0]!.ciphertext[0] = tampered[0]!.ciphertext[0]! ^ 0x01;
    const res = verifyFinalBundle({ header, frames: tampered, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "AEAD_AUTH_FAILED")).toBe(true);
  });

  test("flipping a byte in the terminal-manifest frame ciphertext → AEAD_AUTH_FAILED", async () => {
    const { header, frames, dek } = await buildBundle();
    const tampered = cloneFrames(frames);
    const terminal = tampered[tampered.length - 1]!;
    terminal.ciphertext[0] = terminal.ciphertext[0]! ^ 0x01;
    const res = verifyFinalBundle({ header, frames: tampered, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "AEAD_AUTH_FAILED")).toBe(true);
  });

  test("truncating a record frame ciphertext (lost tag) → AEAD_AUTH_FAILED", async () => {
    const { header, frames, dek } = await buildBundle();
    const tampered = cloneFrames(frames);
    const f = tampered[0]!;
    // Drop the last byte (part of the Poly1305 tag) — also changes AAD length binding.
    tampered[0] = { ...f, ciphertext: f.ciphertext.subarray(0, f.ciphertext.length - 1) };
    const res = verifyFinalBundle({ header, frames: tampered, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === "AEAD_AUTH_FAILED" || e.code === "FRAME_AAD_MISMATCH")).toBe(true);
    }
  });

  test("mutating the stored frame AAD → FRAME_AAD_MISMATCH", async () => {
    const { header, frames, dek } = await buildBundle();
    const tampered = cloneFrames(frames);
    const aad = new Uint8Array(tampered[0]!.aad);
    aad[0] = aad[0]! ^ 0x01;
    tampered[0] = { ...tampered[0]!, aad };
    const res = verifyFinalBundle({ header, frames: tampered, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "FRAME_AAD_MISMATCH")).toBe(true);
  });

  test("mutating the immutable header (bundleId) → AEAD/AAD failure (digest mismatch)", async () => {
    const { header, frames, dek } = await buildBundle();
    const res = verifyFinalBundle({ ...{ header, frames, dek }, header: { ...header, bundleId: "source-genie-999" } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === "FRAME_AAD_MISMATCH" || e.code === "AEAD_AUTH_FAILED")).toBe(true);
    }
  });

  test("mutating the wrapped DEK in the header → digest mismatch → frame AAD failure", async () => {
    const { header, frames, dek } = await buildBundle();
    const slot = header.keySlots[0]!;
    if (slot.kind !== "recovery") throw new Error("expected recovery slot");
    const tamperedWrapped = new Uint8Array(slot.wrappedDek);
    tamperedWrapped[0] = tamperedWrapped[0]! ^ 0x01;
    const tamperedHeader: ContainerHeaderV1 = {
      ...header,
      keySlots: [{ ...slot, wrappedDek: tamperedWrapped }],
    };
    const res = verifyFinalBundle({ header: tamperedHeader, frames, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === "FRAME_AAD_MISMATCH" || e.code === "AEAD_AUTH_FAILED")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Reorder / duplicate / gap
// ---------------------------------------------------------------------------

describe("reorder / duplicate / gap rejection", () => {
  test("swapping two record frame ordinals is rejected by frame-sequence checks", async () => {
    const { header, frames, dek } = await buildBundle();
    const swapped = cloneFrames(frames);
    const a = swapped[0]!;
    const b = swapped[1]!;
    swapped[0] = { ...b, ordinal: 0 };
    swapped[1] = { ...a, ordinal: 1 };
    const res = verifyFinalBundle({ header, frames: swapped, dek });
    // The ciphertext/AAD were bound to the original ordinals, so decryption
    // fails; the frame sequence itself still has contiguous ordinals, so the
    // failure surfaces as AEAD/AAD, which is the desired tamper signal.
    expect(res.ok).toBe(false);
  });

  test("duplicating an ordinal is rejected (FRAME_ORDINAL_DUPLICATE)", async () => {
    const { header, frames, dek } = await buildBundle();
    const dup = cloneFrames(frames);
    // Replace the last record frame with a copy of the first record frame's
    // ordinal but keep terminal at the end.
    dup[1] = { ...dup[0]!, ciphertext: new Uint8Array(dup[1]!.ciphertext), aad: new Uint8Array(dup[1]!.aad) };
    const res = verifyFinalBundle({ header, frames: dup, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "FRAME_ORDINAL_DUPLICATE")).toBe(true);
  });

  test("dropping a middle frame creates an ordinal gap (FRAME_ORDINAL_GAP)", async () => {
    const { header, frames, dek } = await buildBundle();
    const truncated = cloneFrames(frames);
    // Remove a middle record frame and leave a hole in the ordinal space.
    truncated.splice(1, 1);
    const res = verifyFinalBundle({ header, frames: truncated, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "FRAME_ORDINAL_GAP")).toBe(true);
  });

  test("moving the terminal-manifest frame off the highest ordinal is rejected", async () => {
    const { header, frames, dek } = await buildBundle();
    const moved = cloneFrames(frames);
    // Swap terminal (last) with a record frame so terminal is no longer the
    // highest ordinal (give terminal ordinal 0, the displaced record the high
    // ordinal). This breaks the FINAL-at-highest-ordinal invariant.
    const terminal = moved[moved.length - 1]!;
    const first = moved[0]!;
    moved[0] = { ...terminal, ordinal: 0 };
    moved[moved.length - 1] = { ...first, ordinal: moved.length - 1 };
    const res = verifyFinalBundle({ header, frames: moved, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.errors.some((e) => e.code === "FRAME_MISSING_FINAL" || e.code === "FRAME_MULTIPLE_FINAL"),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Truncation: drop the FINAL frame entirely
// ---------------------------------------------------------------------------

describe("truncation rejection", () => {
  test("dropping the terminal-manifest frame → FRAME_MISSING_FINAL", async () => {
    const { header, frames, dek } = await buildBundle();
    const withoutFinal = cloneFrames(frames).slice(0, frames.length - 1);
    const res = verifyFinalBundle({ header, frames: withoutFinal, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "FRAME_MISSING_FINAL")).toBe(true);
  });

  test("dropping the terminal frame AND not renumbering leaves an ordinal gap", async () => {
    const { header, frames, dek } = await buildBundle();
    // Remove terminal (highest ordinal) — ordinals now 0..N-1 with a gap at N.
    const withoutFinal = cloneFrames(frames).slice(0, frames.length - 1);
    const res = verifyFinalBundle({ header, frames: withoutFinal, dek });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manifest-level integrity (FINAL verification internals)
// ---------------------------------------------------------------------------

describe("terminal-manifest FINAL verification internals", () => {
  test("a manifest with a wrong per-record hash → RECORD_HASH_MISMATCH", async () => {
    const { header, frames, dek } = await buildBundle();
    // Re-encrypt the terminal-manifest frame with a manifest whose record[0]
    // hash is wrong. The frame AEAD still authenticates (we sealed it with the
    // DEK), so the FINAL verification reaches the hash check and fails there.
    const digest = computeHeaderDigest(header);
    const terminalOrdinal = frames.length - 1;
    const wrongManifest = await buildTamperedManifest(header, frames, dek, (m) => {
      const recs = m.records.map((r, i) => (i === 0 ? { ...r, sha256: "0".repeat(64) } : r));
      return { ...m, records: recs };
    });
    const tampered = cloneFrames(frames);
    const aad = computeFrameAad({ headerDigest: digest, ordinal: terminalOrdinal, kind: "terminal-manifest", plaintextLength: wrongManifest.length });
    const nonce = deriveFrameNonce(digest, terminalOrdinal);
    // Re-seal the tampered manifest with the DEK.
    const { xchacha20poly1305 } = await import("@noble/ciphers/chacha");
    const ct = xchacha20poly1305(dek, nonce, aad).encrypt(wrongManifest);
    tampered[terminalOrdinal] = { ordinal: terminalOrdinal, kind: "terminal-manifest", ciphertext: ct, aad };
    const res = verifyFinalBundle({ header, frames: tampered, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "RECORD_HASH_MISMATCH")).toBe(true);
  });

  test("a manifest with a wrong semantic root → SEMANTIC_ROOT_MISMATCH", async () => {
    const { header, frames, dek } = await buildBundle();
    const res = await resealWithManifestMutation(header, frames, dek, (m) => ({ ...m, semanticRoot: "0".repeat(64) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "SEMANTIC_ROOT_MISMATCH")).toBe(true);
  });

  test("a manifest with a wrong frameCount → MANIFEST_FRAME_COUNT_MISMATCH", async () => {
    const { header, frames, dek } = await buildBundle();
    const res = await resealWithManifestMutation(header, frames, dek, (m) => ({ ...m, frameCount: m.frameCount + 1 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "MANIFEST_FRAME_COUNT_MISMATCH")).toBe(true);
  });

  test("a manifest with a wrong totalPayloadBytes → MANIFEST_PAYLOAD_BYTES_MISMATCH", async () => {
    const { header, frames, dek } = await buildBundle();
    const res = await resealWithManifestMutation(header, frames, dek, (m) => ({ ...m, totalPayloadBytes: m.totalPayloadBytes + 1 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "MANIFEST_PAYLOAD_BYTES_MISMATCH")).toBe(true);
  });

  test("a manifest with a wrong frameOrdinal mapping → MANIFEST_FRAME_ORDINAL_INVALID", async () => {
    const { header, frames, dek } = await buildBundle();
    const res = await resealWithManifestMutation(header, frames, dek, (m) => {
      const recs = m.records.map((r, i) => (i === 0 ? { ...r, frameOrdinal: 99 } : r));
      return { ...m, records: recs };
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "MANIFEST_FRAME_ORDINAL_INVALID")).toBe(true);
  });

  test("a manifest with a wrong recordKind → MANIFEST_RECORD_KIND_UNKNOWN", async () => {
    const { header, frames, dek } = await buildBundle();
    const res = await resealWithManifestMutation(header, frames, dek, (m) => {
      const recs = m.records.map((r, i) => (i === 0 ? { ...r, recordKind: "bogus" } : r));
      return { ...m, records: recs };
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "MANIFEST_RECORD_KIND_UNKNOWN")).toBe(true);
  });
});

// Helper: decrypt the existing terminal manifest, apply a mutation, re-seal it.
async function decryptManifest(frames: readonly EncryptedFrameV1[], dek: Uint8Array, digest: string): Promise<Uint8Array> {
  const terminal = frames[frames.length - 1]!;
  const nonce = deriveFrameNonce(digest, terminal.ordinal);
  const aad = computeFrameAad({
    headerDigest: digest,
    ordinal: terminal.ordinal,
    kind: "terminal-manifest",
    plaintextLength: terminal.ciphertext.length - 16,
  });
  const { xchacha20poly1305 } = await import("@noble/ciphers/chacha");
  return xchacha20poly1305(dek, nonce, aad).decrypt(terminal.ciphertext);
}

async function buildTamperedManifest(
  header: ContainerHeaderV1,
  frames: readonly EncryptedFrameV1[],
  dek: Uint8Array,
  mutate: (m: TerminalManifestLike) => TerminalManifestLike,
): Promise<Uint8Array> {
  const digest = computeHeaderDigest(header);
  const plain = await decryptManifest(frames, dek, digest);
  const manifest = JSON.parse(new TextDecoder().decode(plain)) as TerminalManifestLike;
  const mutated = mutate(manifest);
  return new TextEncoder().encode(JSON.stringify(mutated));
}

async function resealWithManifestMutation(
  header: ContainerHeaderV1,
  frames: readonly EncryptedFrameV1[],
  dek: Uint8Array,
  mutate: (m: TerminalManifestLike) => TerminalManifestLike,
): Promise<{ ok: true } | { ok: false; errors: { code: string }[] }> {
  const digest = computeHeaderDigest(header);
  const mutatedPlain = await buildTamperedManifest(header, frames, dek, mutate);
  const terminalOrdinal = frames.length - 1;
  const aad = computeFrameAad({ headerDigest: digest, ordinal: terminalOrdinal, kind: "terminal-manifest", plaintextLength: mutatedPlain.length });
  const nonce = deriveFrameNonce(digest, terminalOrdinal);
  const { xchacha20poly1305 } = await import("@noble/ciphers/chacha");
  const ct = xchacha20poly1305(dek, nonce, aad).encrypt(mutatedPlain);
  const tampered = cloneFrames(frames);
  tampered[terminalOrdinal] = { ordinal: terminalOrdinal, kind: "terminal-manifest", ciphertext: ct, aad };
  const res = verifyFinalBundle({ header, frames: tampered, dek });
  if (res.ok) return { ok: true };
  return { ok: false, errors: res.errors as { code: string }[] };
}

type TerminalManifestLike = {
  semanticRoot: string;
  records: { recordKind: string; frameOrdinal: number; sha256: string; bytes: number }[];
  frameCount: number;
  totalPayloadBytes: number;
};

// ---------------------------------------------------------------------------
// encryptBundle producer-side guards
// ---------------------------------------------------------------------------

describe("encryptBundle producer guards", () => {
  test("rejects when header.frameCount does not match records+1", async () => {
    const dek = generateDek();
    const salt = randomSalt();
    const slot = await wrapDekWithRecoverySlot({ dek, passphrase: PASSPHRASE, salt, kdfParams: KDF_PARAMS, slotId: 0, argon2id: testArgon2id });
    const header: ContainerHeaderV1 = {
      containerVersion: 1,
      semanticVersion: { major: 1, minor: 0 },
      bundleId: "source-genie-001",
      payloadCodec: "genie-live-records",
      protectionSuite: "xchacha20poly1305-framed-v1",
      chunkSize: 64 * 1024,
      keySlots: [slot],
      frameCount: 999,
      totalPayloadBytes: 0,
    };
    const res = encryptBundle({ header, records, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "MANIFEST_FRAME_COUNT_MISMATCH")).toBe(true);
  });

  test("rejects when header.totalPayloadBytes does not match the sum of record bytes", async () => {
    const dek = generateDek();
    const salt = randomSalt();
    const slot = await wrapDekWithRecoverySlot({ dek, passphrase: PASSPHRASE, salt, kdfParams: KDF_PARAMS, slotId: 0, argon2id: testArgon2id });
    const header: ContainerHeaderV1 = {
      containerVersion: 1,
      semanticVersion: { major: 1, minor: 0 },
      bundleId: "source-genie-001",
      payloadCodec: "genie-live-records",
      protectionSuite: "xchacha20poly1305-framed-v1",
      chunkSize: 64 * 1024,
      keySlots: [slot],
      frameCount: records.length + 1,
      totalPayloadBytes: 12345,
    };
    const res = encryptBundle({ header, records, dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "MANIFEST_PAYLOAD_BYTES_MISMATCH")).toBe(true);
  });

  test("rejects a record whose canonical plaintext exceeds chunkSize (FRAME_PLAINTEXT_OVERSIZED)", async () => {
    const dek = generateDek();
    const salt = randomSalt();
    const slot = await wrapDekWithRecoverySlot({ dek, passphrase: PASSPHRASE, salt, kdfParams: KDF_PARAMS, slotId: 0, argon2id: testArgon2id });
    const bigRecord = { recordKind: "memory", scope: "private" as const, content: "x".repeat(200), createdAt: null };
    const header: ContainerHeaderV1 = {
      containerVersion: 1,
      semanticVersion: { major: 1, minor: 0 },
      bundleId: "source-genie-001",
      payloadCodec: "genie-live-records",
      protectionSuite: "xchacha20poly1305-framed-v1",
      chunkSize: 64, // tiny on purpose
      keySlots: [slot],
      frameCount: 2,
      totalPayloadBytes: canonicalJsonBytes(bigRecord).length,
    };
    const res = encryptBundle({ header, records: [bigRecord], dek });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "FRAME_PLAINTEXT_OVERSIZED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wave 3 — artifact-byte chunk frame validators + frame-domain regression
// ---------------------------------------------------------------------------

import {
  validateArtifactChunkFrame,
  validateArtifactTerminalFrame,
  validateArtifactChunkSequence,
  validateArtifactStreamManifest,
} from "../../src/container/validate";

describe("Wave 3 artifact chunk frame validators", () => {
  const ENTRY = "media/artifacts/artifact-001.bin";
  function chunk(overrides: Partial<{ ordinal: number; final: boolean; entryPath: string }> = {}): unknown {
    return {
      frameType: "artifact-chunk",
      mediaVersion: 2,
      entryPath: overrides.entryPath ?? ENTRY,
      ordinal: overrides.ordinal ?? 0,
      final: overrides.final ?? true,
      plaintextLength: 8,
      nonce: new Uint8Array(24),
      aad: new Uint8Array(64),
      ciphertext: new Uint8Array(24),
    };
  }

  test("validateArtifactChunkFrame accepts a well-formed frame", () => {
    expect(validateArtifactChunkFrame(chunk()).ok).toBe(true);
  });

  test("validateArtifactChunkSequence rejects an ordinal gap and a duplicate", () => {
    const gap = [chunk({ ordinal: 0, final: false }), chunk({ ordinal: 2, final: true })];
    expect(validateArtifactChunkSequence(gap).ok).toBe(false);
    const dup = [chunk({ ordinal: 0, final: false }), chunk({ ordinal: 0, final: true })];
    const r = validateArtifactChunkSequence(dup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "FRAME_ORDINAL_DUPLICATE")).toBe(true);
  });

  test("validateArtifactTerminalFrame rejects final=false", () => {
    const f = { frameType: "artifact-manifest", mediaVersion: 2, ordinal: 0, final: false, plaintextLength: 1, nonce: new Uint8Array(24), aad: new Uint8Array(8), ciphertext: new Uint8Array(17) };
    expect(validateArtifactTerminalFrame(f).ok).toBe(false);
  });

  test("validateArtifactStreamManifest rejects a duplicate entry path", () => {
    const m = {
      mediaVersion: 2,
      entries: [
        { entryPath: ENTRY, size: 1, sha256: "0".repeat(64), chunkCount: 1 },
        { entryPath: ENTRY, size: 1, sha256: "0".repeat(64), chunkCount: 1 },
      ],
    };
    const r = validateArtifactStreamManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "ARTIFACT_MEDIA_DUPLICATE")).toBe(true);
  });
});

describe("record-frame nonce/AAD domains remain disjoint (Wave 3 regression guard)", () => {
  test("record-frame nonces stay unique per ordinal across many ordinals", () => {
    const d = "0".repeat(64);
    const nonces = new Set<string>();
    for (let i = 0; i < 500; i++) {
      nonces.add(Buffer.from(deriveFrameNonce(d, i)).toString("hex"));
    }
    expect(nonces.size).toBe(500);
  });

  test("record-frame and wrap nonce domains stay disjoint", () => {
    const d = "0".repeat(64);
    const frame = deriveFrameNonce(d, 0);
    const wrap = deriveWrapNonce(new TextEncoder().encode(d).subarray(0, 16), 0);
    expect(equalBytes(frame, wrap)).toBe(false);
  });

  test("record-frame AAD is tamper-sensitive across every bound element", () => {
    const d = "a".repeat(64);
    const base = computeFrameAad({ headerDigest: d, ordinal: 3, kind: "record", plaintextLength: 42 });
    expect(equalBytes(base, computeFrameAad({ headerDigest: "b".repeat(64), ordinal: 3, kind: "record", plaintextLength: 42 }))).toBe(false);
    expect(equalBytes(base, computeFrameAad({ headerDigest: d, ordinal: 4, kind: "record", plaintextLength: 42 }))).toBe(false);
    expect(equalBytes(base, computeFrameAad({ headerDigest: d, ordinal: 3, kind: "terminal-manifest", plaintextLength: 42 }))).toBe(false);
    expect(equalBytes(base, computeFrameAad({ headerDigest: d, ordinal: 3, kind: "record", plaintextLength: 43 }))).toBe(false);
  });
});
