import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  PROCESSOR_OBJECT_SIGNER_DOMAIN_V1,
  PROCESSOR_OBJECT_SIGNER_FORMAT_VERSION_V1,
  PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1,
  createProcessorObjectSignerPublicV1,
  normalizeProcessorObjectSignerPrincipalV1,
  processorObjectSignerKeyIdV1,
  processorObjectSignerSigningBytesV1,
  signProcessorObjectBytesV1,
  verifyProcessorObjectBytesV1,
} from "../../src/background/processor-object-signer-v1.ts";

function hash(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

class CapturingSignerCrypto extends LatticeCrypto {
  hashedInput: Uint8Array | undefined;
  signInputs: readonly Uint8Array[] | undefined;
  verifyInputs: readonly Uint8Array[] | undefined;

  override hash(data: Uint8Array): Uint8Array {
    this.hashedInput = data;
    return super.hash(data);
  }

  override sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
    this.signInputs = [privateKey, message];
    return super.sign(privateKey, message);
  }

  override verify(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): boolean {
    this.verifyInputs = [publicKey, message, signature];
    return super.verify(publicKey, message, signature);
  }
}

describe("processor invocation object signer v1", () => {
  test("locks its public domain, format, and deterministic key id", () => {
    const crypto = new LatticeCrypto(seededRng(2_409));
    const signer = crypto.generateSigningKeyPair();
    const keyId = processorObjectSignerKeyIdV1(crypto, signer.publicKey);

    expect(PROCESSOR_OBJECT_SIGNER_DOMAIN_V1).toBe(
      "nautilo/lattice-crypto/processor-object-signer/v1",
    );
    expect(PROCESSOR_OBJECT_SIGNER_FORMAT_VERSION_V1).toBe(1);
    expect(keyId).toMatch(
      /^processor_invocation_signer_[0-9a-f]{64}$/u,
    );
    expect(processorObjectSignerKeyIdV1(crypto, signer.publicKey))
      .toBe(keyId);
    expect(() => processorObjectSignerKeyIdV1(
      crypto,
      new Uint8Array(31),
    )).toThrow("exactly 32 bytes");
    expect(() => processorObjectSignerKeyIdV1(
      crypto,
      null as never,
    )).toThrow("exactly 32 bytes");
  });

  test("creates a distinct Stenographer principal and signs only its exact work", () => {
    const crypto = new LatticeCrypto(seededRng(2_410));
    const signer = crypto.generateSigningKeyPair();
    const identity = createProcessorObjectSignerPublicV1(crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: "processor-signer-auth-1",
      workDescriptorHash: hash(0x11),
      signerPrivateKey: signer.privateKey,
    });
    const message = new TextEncoder().encode("encrypted journal manifest");
    const signature = signProcessorObjectBytesV1(crypto, {
      principal: identity.principal,
      signerPrivateKey: signer.privateKey,
      message,
    });

    expect(identity.publicKey).toEqual(signer.publicKey);
    expect(identity.principal.kind).toBe("processor_invocation");
    expect(identity.principal.signerKeyId)
      .toStartWith(PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.principal)).toBe(true);
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: identity.principal,
      signerPublicKey: identity.publicKey,
      message,
      signature,
    })).toBe(true);
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: {
        ...identity.principal,
        workDescriptorHash: hash(0x12),
      },
      signerPublicKey: identity.publicKey,
      message,
      signature,
    })).toBe(false);
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: identity.principal,
      signerPublicKey: identity.publicKey,
      message: new TextEncoder().encode("other journal manifest"),
      signature,
    })).toBe(false);
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: {
        ...identity.principal,
        signerAuthorizationId: "processor-signer-auth-other",
      },
      signerPublicKey: identity.publicKey,
      message,
      signature,
    })).toBe(false);
  });

  test("rejects Agent-shaped, malformed, and substituted identities", () => {
    const crypto = new LatticeCrypto(seededRng(2_411));
    const signer = crypto.generateSigningKeyPair();
    const identity = createProcessorObjectSignerPublicV1(crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: "processor-signer-auth-2",
      workDescriptorHash: hash(0x21),
      signerPrivateKey: signer.privateKey,
    });
    const message = new Uint8Array([1, 2, 3]);

    expect(() =>
      normalizeProcessorObjectSignerPrincipalV1({
        ...identity.principal,
        kind: "agent_runtime" as never,
      })
    ).toThrow("kind");
    expect(() =>
      normalizeProcessorObjectSignerPrincipalV1({
        ...identity.principal,
        processorKind: "generic" as never,
      })
    ).toThrow("processor");
    expect(() =>
      normalizeProcessorObjectSignerPrincipalV1({
        ...identity.principal,
        processorVersion: 2 as never,
      })
    ).toThrow("processor");
    expect(() =>
      normalizeProcessorObjectSignerPrincipalV1({
        ...identity.principal,
        extra: true,
      } as never)
    ).toThrow("field");
    const { signerKeyId: _, ...missingKeyId } = identity.principal;
    expect(() =>
      normalizeProcessorObjectSignerPrincipalV1(missingKeyId as never)
    ).toThrow("field set");
    expect(() => normalizeProcessorObjectSignerPrincipalV1({
      ...missingKeyId,
      substitutedSignerKeyId: identity.principal.signerKeyId,
    } as never)).toThrow("field set");
    for (const value of [null, [], "principal"]) {
      expect(() => normalizeProcessorObjectSignerPrincipalV1(value as never))
        .toThrow("must be an object");
    }
    expect(() => normalizeProcessorObjectSignerPrincipalV1({
      ...identity.principal,
      signerAuthorizationId: "",
    })).toThrow();
    expect(() => normalizeProcessorObjectSignerPrincipalV1({
      ...identity.principal,
      workDescriptorHash: new Uint8Array(31),
    })).toThrow("exactly 32 bytes");
    for (const signerKeyId of [
      `x${PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1}${"a".repeat(64)}`,
      `${PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1}${"a".repeat(63)}`,
      `${PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1}${"a".repeat(65)}`,
      `${PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1}${"A".repeat(64)}`,
      `${PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1}${"g".repeat(64)}`,
    ]) {
      expect(() => normalizeProcessorObjectSignerPrincipalV1({
        ...identity.principal,
        signerKeyId,
      })).toThrow("key id is invalid");
    }
    expect(() =>
      createProcessorObjectSignerPublicV1(crypto, {
        processorKind: "stenographer",
        processorVersion: 1,
        signerAuthorizationId: "processor-signer-auth-2",
        workDescriptorHash: hash(0x21),
        signerPrivateKey: new Uint8Array(31),
      })
    ).toThrow("32");

    expect(() =>
      signProcessorObjectBytesV1(crypto, {
        principal: identity.principal,
        signerPrivateKey: crypto.generateSigningKeyPair().privateKey,
        message,
      })
    ).toThrow("key id");
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: identity.principal,
      signerPublicKey: new Uint8Array(32).fill(0xff),
      message,
      signature: new Uint8Array(64),
    })).toBe(false);
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: identity.principal,
      signerPublicKey: new Uint8Array(31),
      message,
      signature: new Uint8Array(64),
    })).toBe(false);
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: identity.principal,
      signerPublicKey: identity.publicKey,
      message,
      signature: new Uint8Array(63),
    })).toBe(false);
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: null as never,
      signerPublicKey: identity.publicKey,
      message,
      signature: new Uint8Array(64),
    })).toBe(false);
    const { workDescriptorHash: _hash, ...missingHash } = identity.principal;
    expect(() => normalizeProcessorObjectSignerPrincipalV1(
      missingHash as never,
    )).toThrow("field set");

    const otherSigner = crypto.generateSigningKeyPair();
    const signingBytes = processorObjectSignerSigningBytesV1(
      identity.principal,
      message,
    );
    const otherSignature = crypto.sign(
      otherSigner.privateKey,
      signingBytes,
    );
    signingBytes.fill(0);
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: identity.principal,
      signerPublicKey: otherSigner.publicKey,
      message,
      signature: otherSignature,
    })).toBe(false);
  });

  test("binds every principal coordinate and owns signing inputs", () => {
    const crypto = new LatticeCrypto(seededRng(2_413));
    const signer = crypto.generateSigningKeyPair();
    const identity = createProcessorObjectSignerPublicV1(crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: "processor-signer-auth-4",
      workDescriptorHash: hash(0x41),
      signerPrivateKey: signer.privateKey,
    });
    const message = new Uint8Array([4, 5, 6]);
    const signingBytes = processorObjectSignerSigningBytesV1(
      identity.principal,
      message,
    );
    const baseline = signingBytes.slice();
    message.fill(0xff);
    identity.principal.workDescriptorHash.fill(0xff);
    expect(signingBytes).toEqual(baseline);

    const freshIdentity = createProcessorObjectSignerPublicV1(crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: "processor-signer-auth-4",
      workDescriptorHash: hash(0x41),
      signerPrivateKey: signer.privateKey,
    });
    const exactMessage = new Uint8Array([4, 5, 6]);
    const signature = signProcessorObjectBytesV1(crypto, {
      principal: freshIdentity.principal,
      signerPrivateKey: signer.privateKey,
      message: exactMessage,
    });
    expect(signature).toHaveLength(64);
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: freshIdentity.principal,
      signerPublicKey: freshIdentity.publicKey,
      message: exactMessage,
      signature,
    })).toBe(true);
  });

  test("owns inputs and leaves caller key/message buffers unchanged", () => {
    const crypto = new LatticeCrypto(seededRng(2_412));
    const signer = crypto.generateSigningKeyPair();
    const privateBefore = signer.privateKey.slice();
    const message = new Uint8Array([8, 9, 10]);
    const messageBefore = message.slice();
    const identity = createProcessorObjectSignerPublicV1(crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: "processor-signer-auth-3",
      workDescriptorHash: hash(0x31),
      signerPrivateKey: signer.privateKey,
    });

    signProcessorObjectBytesV1(crypto, {
      principal: identity.principal,
      signerPrivateKey: signer.privateKey,
      message,
    });
    expect(signer.privateKey).toEqual(privateBefore);
    expect(message).toEqual(messageBefore);
  });

  test("wipes every owned buffer lent to the crypto boundary", () => {
    const crypto = new CapturingSignerCrypto(seededRng(2_414));
    const signer = crypto.generateSigningKeyPair();
    const identity = createProcessorObjectSignerPublicV1(crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: "processor-signer-auth-5",
      workDescriptorHash: hash(0x51),
      signerPrivateKey: signer.privateKey,
    });
    processorObjectSignerKeyIdV1(crypto, signer.publicKey);
    expect(crypto.hashedInput).toEqual(
      new Uint8Array(crypto.hashedInput!.length),
    );

    const message = new Uint8Array([5, 1]);
    const signature = signProcessorObjectBytesV1(crypto, {
      principal: identity.principal,
      signerPrivateKey: signer.privateKey,
      message,
    });
    expect(crypto.signInputs!.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBeTrue();
    expect(verifyProcessorObjectBytesV1(crypto, {
      principal: identity.principal,
      signerPublicKey: identity.publicKey,
      message,
      signature,
    })).toBeTrue();
    expect(crypto.verifyInputs!.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBeTrue();
  });
});
