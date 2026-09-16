import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  AGENT_RUNTIME_OBJECT_SIGNER_DERIVATION_DOMAIN_V1,
  AGENT_RUNTIME_OBJECT_SIGNER_KEY_ID_PREFIX_V1,
  agentRuntimeObjectSignerKeyIdV1,
  deriveAgentRuntimeObjectSignerPublicV1,
  normalizeAgentRuntimeObjectSignerPrincipalV1,
  signAgentRuntimeObjectBytesV1,
} from "../../src/agent-runtime/object-signer-v1.ts";
import type {
  AgentRuntimeGenerationV2,
} from "../../src/agent-runtime/types.ts";
import {
  agentId,
  agentRuntimeGeneration,
} from "../../src/v2-types/ids.ts";

function runtime(
  id = "agent_alpha",
  generation = 7,
  marker = 0x41,
): AgentRuntimeGenerationV2 {
  return {
    agentId: agentId(id),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(generation),
    key: new Uint8Array(32).fill(marker),
  };
}

function hex(value: Uint8Array): string {
  return Array.from(
    value,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function recordZeroFills(): {
  readonly snapshots: Uint8Array[];
  readonly restore: () => void;
} {
  const snapshots: Uint8Array[] = [];
  const originalFill = Uint8Array.prototype.fill;
  Uint8Array.prototype.fill = function (
    ...args: Parameters<Uint8Array["fill"]>
  ): Uint8Array {
    if (args[0] === 0) snapshots.push(Uint8Array.from(this));
    return originalFill.apply(this, args);
  };
  return {
    snapshots,
    restore: () => {
      Uint8Array.prototype.fill = originalFill;
    },
  };
}

function includesSnapshot(
  snapshots: readonly Uint8Array[],
  expected: Uint8Array,
): boolean {
  return snapshots.some((snapshot) =>
    snapshot.length === expected.length
    && snapshot.every((byte, index) => byte === expected[index])
  );
}

describe("Agent Runtime object signer v1", () => {
  test("derives a deterministic public identity without mutating the Runtime key", () => {
    const crypto = new LatticeCrypto(seededRng(701));
    const source = runtime();
    const keySnapshot = source.key.slice();

    const first = deriveAgentRuntimeObjectSignerPublicV1(crypto, source);
    const second = deriveAgentRuntimeObjectSignerPublicV1(crypto, source);

    expect(source.key).toEqual(keySnapshot);
    expect(first).toEqual(second);
    expect(first.principal).toEqual({
      kind: "agent_runtime",
      agentId: agentId("agent_alpha"),
      runtimeGeneration: agentRuntimeGeneration(7),
      signerKeyId: first.principal.signerKeyId,
    });
    expect(first.principal.signerKeyId.startsWith(
      AGENT_RUNTIME_OBJECT_SIGNER_KEY_ID_PREFIX_V1,
    )).toBe(true);
    expect(first.principal.signerKeyId).toHaveLength(85);
    expect(first.publicKey).toHaveLength(32);
    expect(agentRuntimeObjectSignerKeyIdV1(crypto, first.publicKey))
      .toBe(first.principal.signerKeyId);
    expect(AGENT_RUNTIME_OBJECT_SIGNER_DERIVATION_DOMAIN_V1)
      .toBe(
        "nautilo/lattice-crypto/agent-runtime-object-signer-seed/v1",
      );
    expect(hex(first.publicKey)).toBe(
      "ab607192f776da697fd9cd3b580dcb61e675e1315857f0e845c685fa1164a2c9",
    );
  });

  test("canonical framing domain-separates Agent identity and Runtime generation", () => {
    const crypto = new LatticeCrypto(seededRng(702));
    const identities = [
      deriveAgentRuntimeObjectSignerPublicV1(
        crypto,
        runtime("agent_a", 12),
      ),
      deriveAgentRuntimeObjectSignerPublicV1(
        crypto,
        runtime("agent_a1", 2),
      ),
      deriveAgentRuntimeObjectSignerPublicV1(
        crypto,
        runtime("agent_a", 13),
      ),
      deriveAgentRuntimeObjectSignerPublicV1(
        crypto,
        runtime("agent_b", 12),
      ),
    ];

    expect(new Set(identities.map((value) => hex(value.publicKey))).size)
      .toBe(identities.length);
    expect(new Set(
      identities.map((value) => value.principal.signerKeyId),
    ).size).toBe(identities.length);
  });

  test("signs only for an exactly matching Runtime principal and wipes the derived seed", () => {
    const crypto = new LatticeCrypto(seededRng(703));
    const source = runtime();
    const identity = deriveAgentRuntimeObjectSignerPublicV1(crypto, source);
    const message = new TextEncoder().encode("agent object manifest");
    const messageSnapshot = message.slice();
    const keySnapshot = source.key.slice();
    const originalSign = crypto.sign.bind(crypto);
    let observedSeed: Uint8Array | undefined;
    crypto.sign = (seed, bytes) => {
      observedSeed = seed;
      return originalSign(seed, bytes);
    };

    const signature = signAgentRuntimeObjectBytesV1(crypto, {
      runtime: source,
      signer: identity.principal,
      message,
    });

    expect(signature).toHaveLength(64);
    expect(crypto.verify(identity.publicKey, message, signature)).toBe(true);
    expect(source.key).toEqual(keySnapshot);
    expect(message).toEqual(messageSnapshot);
    expect(observedSeed).toBeDefined();
    expect(observedSeed).toEqual(new Uint8Array(32));

    expect(() =>
      signAgentRuntimeObjectBytesV1(crypto, {
        runtime: source,
        signer: {
          ...identity.principal,
          agentId: agentId("agent_other"),
        },
        message,
      })
    ).toThrow("signer Agent does not match");
    expect(() =>
      signAgentRuntimeObjectBytesV1(crypto, {
        runtime: source,
        signer: {
          ...identity.principal,
          runtimeGeneration: agentRuntimeGeneration(8),
        },
        message,
      })
    ).toThrow("signer Runtime generation does not match");
    expect(() =>
      signAgentRuntimeObjectBytesV1(crypto, {
        runtime: source,
        signer: {
          ...identity.principal,
          signerKeyId: `${AGENT_RUNTIME_OBJECT_SIGNER_KEY_ID_PREFIX_V1}${
            "0".repeat(64)
          }`,
        },
        message,
      })
    ).toThrow("signer key id does not match");
  });

  test("returns detached public keys, key ids, and signatures and rejects malformed inputs", () => {
    const crypto = new LatticeCrypto(seededRng(704));
    const source = runtime();
    const identity = deriveAgentRuntimeObjectSignerPublicV1(crypto, source);
    const publicSnapshot = identity.publicKey.slice();
    source.key.fill(0);
    expect(identity.publicKey).toEqual(publicSnapshot);

    const providerSignature = new Uint8Array(64).fill(0xa5);
    crypto.sign = () => providerSignature;
    const signature = signAgentRuntimeObjectBytesV1(crypto, {
      runtime: runtime(),
      signer: identity.principal,
      message: new Uint8Array([1, 2, 3]),
    });
    providerSignature.fill(0);
    expect(signature).toEqual(new Uint8Array(64).fill(0xa5));

    expect(() =>
      agentRuntimeObjectSignerKeyIdV1(crypto, new Uint8Array(31))
    ).toThrow("public key must be exactly 32 bytes");
    expect(() =>
      deriveAgentRuntimeObjectSignerPublicV1(crypto, {
        ...runtime(),
        key: new Uint8Array(31),
      })
    ).toThrow("Agent Runtime key must contain exactly 32 bytes");
    expect(() =>
      signAgentRuntimeObjectBytesV1(crypto, {
        runtime: runtime(),
        signer: {
          ...identity.principal,
          extra: true,
        } as never,
        message: new Uint8Array(),
      })
    ).toThrow("signer principal contains unknown field extra");
  });

  test("normalizes only the exact Runtime signer principal grammar", () => {
    const crypto = new LatticeCrypto(seededRng(705));
    const principal = deriveAgentRuntimeObjectSignerPublicV1(
      crypto,
      runtime(),
    ).principal;

    expect(normalizeAgentRuntimeObjectSignerPrincipalV1(principal)).toEqual(
      principal,
    );
    for (const value of [null, undefined, "principal", 7]) {
      expect(() => normalizeAgentRuntimeObjectSignerPrincipalV1(value as never))
        .toThrow("Agent Runtime signer principal must be an object");
    }
    expect(() => normalizeAgentRuntimeObjectSignerPrincipalV1({
      ...principal,
      kind: "runtime" as never,
    })).toThrow("Agent Runtime signer principal kind is invalid");
    expect(() => normalizeAgentRuntimeObjectSignerPrincipalV1({
      ...principal,
      signerKeyId: "",
    })).toThrow(
      "Agent Runtime signer key id must be 1-128 ASCII bytes using the portable identifier grammar",
    );
    for (
      const signerKeyId of [
        `x${principal.signerKeyId}`,
        `${principal.signerKeyId}x`,
        principal.signerKeyId.toUpperCase(),
      ]
    ) {
      expect(() => normalizeAgentRuntimeObjectSignerPrincipalV1({
        ...principal,
        signerKeyId,
      })).toThrow("Agent Runtime signer key id is invalid");
    }
  });

  test("wipes owned key-id and signing buffers at every custody boundary", () => {
    const crypto = new LatticeCrypto(seededRng(706));
    const source = runtime();
    const identity = deriveAgentRuntimeObjectSignerPublicV1(crypto, source);
    const expectedDigest = crypto.hash(identity.publicKey);
    const keyIdFills = recordZeroFills();
    try {
      agentRuntimeObjectSignerKeyIdV1(crypto, identity.publicKey);
    } finally {
      keyIdFills.restore();
    }
    expect(includesSnapshot(keyIdFills.snapshots, identity.publicKey)).toBe(
      true,
    );
    expect(includesSnapshot(keyIdFills.snapshots, expectedDigest)).toBe(true);

    const message = new TextEncoder().encode("owned signer message");
    const signingFills = recordZeroFills();
    try {
      signAgentRuntimeObjectBytesV1(crypto, {
        runtime: source,
        signer: identity.principal,
        message,
      });
    } finally {
      signingFills.restore();
    }
    expect(signingFills.snapshots.filter((snapshot) =>
      snapshot.length === identity.publicKey.length
      && snapshot.every((byte, index) => byte === identity.publicKey[index])
    )).toHaveLength(2);
    expect(includesSnapshot(signingFills.snapshots, message)).toBe(true);
    expectedDigest.fill(0);
  });

  test("reports exact provider-output size failures", () => {
    const shortHash = new LatticeCrypto(seededRng(707));
    shortHash.hash = () => new Uint8Array(31);
    expect(() =>
      agentRuntimeObjectSignerKeyIdV1(shortHash, new Uint8Array(32))
    ).toThrow(
      "Agent Runtime object signer public key digest must be exactly 32 bytes",
    );

    const shortSignature = new LatticeCrypto(seededRng(708));
    const source = runtime();
    const identity = deriveAgentRuntimeObjectSignerPublicV1(
      shortSignature,
      source,
    );
    shortSignature.sign = () => new Uint8Array(63);
    expect(() => signAgentRuntimeObjectBytesV1(shortSignature, {
      runtime: source,
      signer: identity.principal,
      message: new Uint8Array([1]),
    })).toThrow(
      "Agent Runtime object signature must be exactly 64 bytes",
    );
  });
});
