import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  RECOVERY_KIT_DOCUMENT_HEADER,
  RecoveryKitFormatError,
  createRecoveryMnemonicCredential,
  decodeRecoveryMnemonic,
  deriveRecoveryCredentialFromMnemonic,
  encodeRecoveryMnemonic,
} from "../../src/recovery/recovery-kit.ts";

const ZERO_ENTROPY = new Uint8Array(32);
const ZERO_MNEMONIC = [
  ...Array<string>(23).fill("abandon"),
  "art",
].join(" ");

describe("Nautilo Recovery Kit v1", () => {
  test("uses the standard 256-bit BIP-39 English known-answer vector", () => {
    const entropy = ZERO_ENTROPY.slice();

    expect(encodeRecoveryMnemonic(entropy)).toBe(ZERO_MNEMONIC);
    expect(entropy).toEqual(ZERO_ENTROPY);
    expect(decodeRecoveryMnemonic(ZERO_MNEMONIC)).toEqual(ZERO_ENTROPY);
    expect(RECOVERY_KIT_DOCUMENT_HEADER).toBe("Nautilo Recovery Kit v1");
  });

  test("requires exactly 24 valid checksummed English words", () => {
    for (const candidate of [
      ZERO_MNEMONIC.split(" ").slice(0, 23).join(" "),
      ZERO_MNEMONIC.replace(/ art$/, "zoo"),
      ZERO_MNEMONIC.replace(/^abandon/, "not-a-bip39-word"),
    ]) {
      expect(() => decodeRecoveryMnemonic(candidate)).toThrow(
        RecoveryKitFormatError,
      );
    }
  });

  test("normalizes surrounding and repeated whitespace without logging input", () => {
    const spaced = ` \n ${ZERO_MNEMONIC.replaceAll(" ", "  \t")} \n`;

    expect(decodeRecoveryMnemonic(spaced)).toEqual(ZERO_ENTROPY);
    try {
      decodeRecoveryMnemonic(`${ZERO_MNEMONIC} definitely-secret`);
      throw new Error("expected recovery phrase rejection");
    } catch (error) {
      expect(String(error)).not.toContain("definitely-secret");
      expect(String(error)).not.toContain("abandon");
    }
  });

  test("round-trips the phrase to the exact core recovery credential", async () => {
    const crypto = new LatticeCrypto({
      bytes: (length) => new Uint8Array(length),
    });
    const generated = await createRecoveryMnemonicCredential(crypto);
    const opened = await deriveRecoveryCredentialFromMnemonic(
      generated.mnemonic,
      crypto,
    );

    expect(generated.mnemonic).toBe(ZERO_MNEMONIC);
    expect(opened.keyId).toBe(generated.keyId);
    expect(opened.publicKey).toEqual(generated.publicKey);
    expect(opened.privateKey).toHaveLength(32);
    opened.privateKey.fill(0);
  });

  test("wipes temporary entropy after generation and recovery derivation", async () => {
    const generatedSecret = new Uint8Array(32).fill(0x31);
    let derivedEntropy: Uint8Array | undefined;
    const crypto = {
      async createRecoveryKit() {
        return {
          formatVersion: 1 as const,
          secret: generatedSecret,
          publicKey: new Uint8Array(65).fill(0x41),
          keyId: `recovery_${"71".repeat(16)}`,
        };
      },
      async deriveEncryptionKeyPair(entropy: Uint8Array) {
        derivedEntropy = entropy;
        return {
          publicKey: new Uint8Array(65).fill(0x51),
          privateKey: new Uint8Array(32).fill(0x61),
        };
      },
      hash() {
        return new Uint8Array(32).fill(0x71);
      },
    };

    await createRecoveryMnemonicCredential(crypto);
    expect(generatedSecret.every((byte) => byte === 0)).toBe(true);
    const opened = await deriveRecoveryCredentialFromMnemonic(
      encodeRecoveryMnemonic(new Uint8Array(32).fill(0x31)),
      crypto,
    );
    expect(derivedEntropy?.every((byte) => byte === 0)).toBe(true);
    opened.privateKey.fill(0);
  });
});
