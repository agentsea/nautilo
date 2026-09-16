import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
  type Rng,
} from "../../src/crypto/index.ts";
import {
  AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN,
  agentRuntimeDomainEnvelopeAad,
  agentRuntimeDomainEnvelopeSigningBytes,
  assertAgentRuntimeDomainEnvelope,
  assertAgentRuntimeGeneration,
  decodeAgentRuntimeGeneration,
  encodeAgentRuntimeGeneration,
  parseAgentRuntimeDomainEnvelope,
  serializeAgentRuntimeDomainEnvelope,
} from "../../src/format/agent-runtime-v2.ts";
import {
  createAgentRuntimeGeneration,
  deduplicateAgentRuntimeDomains,
  openAgentRuntimeFromDomain,
  sealAgentRuntimeToDomain,
} from "../../src/agent-runtime/domain-envelope.ts";
import type {
  AgentRuntimeDomainEnvelopeV1,
  AgentRuntimeGenerationV2,
} from "../../src/agent-runtime/types.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import { CanonicalDecodingError } from "../../src/format/v2-primitives.ts";

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function expectExactThrow(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected exact error: ${message}`);
}

function fixtureEnvelope(): AgentRuntimeDomainEnvelopeV1 {
  return {
    formatVersion: 1,
    agentId: agentId("agent_genie"),
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(2),
    agentAuthorizationRevision: authorizationRevision(3),
    runtimeGeneration: agentRuntimeGeneration(4),
    ciphertext: bytes(0xdd, 40),
    committerDeviceId: cryptoDeviceId("device_alice"),
    signature: bytes(0xee, 64),
  };
}

function setup() {
  const crypto = new LatticeCrypto(seededRng(0x225));
  const signing = crypto.generateSigningKeyPair();
  const runtime = createAgentRuntimeGeneration({
    crypto,
    agentId: agentId("agent_genie"),
    generation: agentRuntimeGeneration(7),
  });
  const context = {
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(5),
    agentAuthorizationRevision: authorizationRevision(11),
    committerDeviceId: cryptoDeviceId("device_alice"),
  };
  const domainRoot = bytes(0x31);
  const envelope = sealAgentRuntimeToDomain({
    crypto,
    domainRoot,
    runtime,
    context,
    committerSigningPrivateKey: signing.privateKey,
    currentCommitterAuthorized: () => true,
  });
  return { crypto, signing, runtime, context, domainRoot, envelope };
}

describe("Agent Runtime Domain envelope canonical format", () => {
  test("locks the exact v1 domain, AAD, signing bytes, and wire fixture", () => {
    expect(AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN).toBe(
      "nautilo/lattice-crypto/agent-runtime-domain-envelope/v1",
    );
    const envelope = fixtureEnvelope();
    const aad = agentRuntimeDomainEnvelopeAad(envelope);
    expect(hex(aad)).toBe(
      "000000376e617574696c6f2f6c6174746963652d63727970746f2f6167656e742d72756e74696d652d646f6d61696e2d656e76656c6f70652f7631" +
        "0000001d6167656e742d72756e74696d652d646f6d61696e2d656e76656c6f7065" +
        "00000001" +
        "0000000b6167656e745f67656e6965" +
        "00000009646f6d61696e5f6162" +
        "0000000000000002" +
        "0000000000000003" +
        "0000000000000004" +
        "0000000c6465766963655f616c696365",
    );
    const signing = agentRuntimeDomainEnvelopeSigningBytes(envelope);
    expect(hex(signing.slice(0, aad.length))).toBe(hex(aad));
    expect(hex(signing.slice(aad.length))).toBe(
      `00000020${hex(new LatticeCrypto(seededRng(1)).hash(envelope.ciphertext))}`,
    );
    const wire = serializeAgentRuntimeDomainEnvelope(envelope);
    expect(hex(wire)).toBe(
      `${hex(aad)}00000028${"dd".repeat(40)}00000040${"ee".repeat(64)}`,
    );
    expect(parseAgentRuntimeDomainEnvelope(wire)).toEqual(envelope);
  });

  test("locks the plaintext to Agent ID, Runtime generation, and a 32-byte Runtime key", () => {
    const runtime: AgentRuntimeGenerationV2 = {
      agentId: agentId("agent_genie"),
      keyClass: "runtime",
      generation: agentRuntimeGeneration(4),
      key: bytes(0xaa),
    };
    const encoded = encodeAgentRuntimeGeneration(runtime);
    expect(hex(encoded)).toBe(
      "000000376e617574696c6f2f6c6174746963652d63727970746f2f6167656e742d72756e74696d652d646f6d61696e2d656e76656c6f70652f7631" +
        "000000186167656e742d72756e74696d652d67656e65726174696f6e" +
        "00000001" +
        "0000000b6167656e745f67656e6965" +
        "0000000000000004" +
        `00000020${"aa".repeat(32)}`,
    );
    expect(decodeAgentRuntimeGeneration(encoded)).toEqual(runtime);
  });

  test("rejects every invalid Runtime generation shape and key width", () => {
    const runtime: AgentRuntimeGenerationV2 = {
      agentId: agentId("agent_genie"),
      keyClass: "runtime",
      generation: agentRuntimeGeneration(4),
      key: bytes(0xaa),
    };

    expect(() => assertAgentRuntimeGeneration(null as never)).toThrow(
      "must be an object",
    );
    expect(() => assertAgentRuntimeGeneration("runtime" as never)).toThrow(
      "must be an object",
    );
    expect(() =>
      assertAgentRuntimeGeneration({
        ...runtime,
        key: Array.from(runtime.key) as never,
      })
    ).toThrow("exactly 32 bytes");
    expect(() =>
      assertAgentRuntimeGeneration({ ...runtime, key: bytes(0xaa, 31) })
    ).toThrow("exactly 32 bytes");
    expect(() =>
      assertAgentRuntimeGeneration({ ...runtime, key: bytes(0xaa, 33) })
    ).toThrow("exactly 32 bytes");
    expectExactThrow(
      () => assertAgentRuntimeGeneration({ ...runtime, unexpected: true } as never),
      "Agent Runtime generation contains unknown field unexpected",
    );
    expectExactThrow(
      () => assertAgentRuntimeGeneration({ ...runtime, key: bytes(0xaa, 31) }),
      "Agent Runtime key must contain exactly 32 bytes",
    );
  });

  test("rejects wrong canonical generation domain text and preserves its decoding error", () => {
    const encoded = encodeAgentRuntimeGeneration({
      agentId: agentId("agent_genie"),
      keyClass: "runtime",
      generation: agentRuntimeGeneration(4),
      key: bytes(0xaa),
    });
    encoded[4] = "x".charCodeAt(0);

    expect(() => decodeAgentRuntimeGeneration(encoded)).toThrow(
      CanonicalDecodingError,
    );
    expect(() => decodeAgentRuntimeGeneration(encoded)).toThrow("domain");

    const wrongPurpose = encodeAgentRuntimeGeneration({
      agentId: agentId("agent_genie"),
      keyClass: "runtime",
      generation: agentRuntimeGeneration(4),
      key: bytes(0xaa),
    });
    const purposeOffset = 4 + AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN.length + 4;
    wrongPurpose[purposeOffset] = "x".charCodeAt(0);
    expectExactThrow(
      () => decodeAgentRuntimeGeneration(wrongPurpose),
      "Agent Runtime generation purpose is unsupported",
    );
  });

  test("zeroizes framed and decoded Runtime-key temporaries", () => {
    const runtime: AgentRuntimeGenerationV2 = {
      agentId: agentId("agent_genie"),
      keyClass: "runtime",
      generation: agentRuntimeGeneration(4),
      key: bytes(0xaa),
    };
    const originalFill = Uint8Array.prototype.fill;
    const zeroFilled: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      ...args: Parameters<Uint8Array["fill"]>
    ): Uint8Array {
      const result = originalFill.apply(this, args);
      if (args[0] === 0) zeroFilled.push(this);
      return result;
    };
    try {
      const encoded = encodeAgentRuntimeGeneration(runtime);
      expect(decodeAgentRuntimeGeneration(encoded)).toEqual(runtime);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    expect(
      zeroFilled.some((value) =>
        value.length === 36 && value.every((byte) => byte === 0)
      ),
    ).toBe(true);
    expect(
      zeroFilled.some((value) =>
        value.length === 32 && value.every((byte) => byte === 0)
      ),
    ).toBe(true);
  });

  test("rejects invalid envelope object and ciphertext/signature boundaries", () => {
    const envelope = fixtureEnvelope();
    expect(() => assertAgentRuntimeDomainEnvelope(null as never)).toThrow(
      "must be an object",
    );
    expect(() => assertAgentRuntimeDomainEnvelope("envelope" as never)).toThrow(
      "must be an object",
    );
    expect(() =>
      assertAgentRuntimeDomainEnvelope({
        ...envelope,
        ciphertext: Array.from(envelope.ciphertext) as never,
      })
    ).toThrow("ciphertext");
    expect(() =>
      assertAgentRuntimeDomainEnvelope({
        ...envelope,
        ciphertext: bytes(1, 39),
      })
    ).toThrow("ciphertext");
    expect(() =>
      assertAgentRuntimeDomainEnvelope({
        ...envelope,
        ciphertext: bytes(1, V2_LIMITS.ciphertextBytes),
      })
    ).not.toThrow();
    expect(() =>
      assertAgentRuntimeDomainEnvelope({
        ...envelope,
        signature: bytes(1, 63),
      })
    ).toThrow("exactly 64 bytes");
    expectExactThrow(
      () =>
        assertAgentRuntimeDomainEnvelope({
          ...envelope,
          unexpected: true,
        } as never),
      "Agent Runtime Domain envelope contains unknown field unexpected",
    );
    expectExactThrow(
      () =>
        assertAgentRuntimeDomainEnvelope({
          ...envelope,
          signature: bytes(1, 63),
        }),
      "Agent Runtime Domain envelope signature must contain exactly 64 bytes",
    );
  });

  test("rejects malformed, unknown-version, oversized, and trailing bytes before crypto", () => {
    const envelope = fixtureEnvelope();
    expect(() =>
      serializeAgentRuntimeDomainEnvelope({
        ...envelope,
        formatVersion: 2 as never,
      })
    ).toThrow("version");
    expect(() =>
      serializeAgentRuntimeDomainEnvelope({
        ...envelope,
        unknown: true,
      } as AgentRuntimeDomainEnvelopeV1)
    ).toThrow("unknown field");
    expect(() =>
      serializeAgentRuntimeDomainEnvelope({
        ...envelope,
        ciphertext: bytes(1, V2_LIMITS.ciphertextBytes + 1),
      })
    ).toThrow("ciphertext");
    const wire = serializeAgentRuntimeDomainEnvelope(envelope);
    const wrongDomain = wire.slice();
    wrongDomain[4] = "x".charCodeAt(0);
    expectExactThrow(
      () => parseAgentRuntimeDomainEnvelope(wrongDomain),
      "Agent Runtime Domain envelope domain is unsupported",
    );
    const wrongPurpose = wire.slice();
    const purposeOffset = 4 + AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN.length + 4;
    wrongPurpose[purposeOffset] = "x".charCodeAt(0);
    expectExactThrow(
      () => parseAgentRuntimeDomainEnvelope(wrongPurpose),
      "Agent Runtime Domain envelope purpose is unsupported",
    );
    expect(() =>
      parseAgentRuntimeDomainEnvelope(new Uint8Array([...wire, 0]))
    ).toThrow("trailing bytes");
    const unknownVersion = wire.slice();
    const versionOffset =
      4 +
      AGENT_RUNTIME_DOMAIN_ENVELOPE_DOMAIN.length +
      4 +
      "agent-runtime-domain-envelope".length;
    unknownVersion[versionOffset + 3] = 2;
    expect(() => parseAgentRuntimeDomainEnvelope(unknownVersion)).toThrow(
      "unsupported version",
    );
    const belowWireCeiling = bytes(0, V2_LIMITS.ciphertextBytes + 512);
    expect(() => parseAgentRuntimeDomainEnvelope(belowWireCeiling)).toThrow(
      CanonicalDecodingError,
    );
    expect(() => parseAgentRuntimeDomainEnvelope(belowWireCeiling)).not.toThrow(
      "wire limit",
    );
    const atWireCeiling = bytes(0, V2_LIMITS.ciphertextBytes + 1024);
    expect(() => parseAgentRuntimeDomainEnvelope(atWireCeiling)).not.toThrow(
      "wire limit",
    );
    const aboveWireCeiling = bytes(0, V2_LIMITS.ciphertextBytes + 1025);
    expect(() => parseAgentRuntimeDomainEnvelope(aboveWireCeiling)).toThrow(
      "wire limit",
    );
  });

  test("detaches parsed ciphertext and signature from the input wire", () => {
    const envelope = fixtureEnvelope();
    const wire = serializeAgentRuntimeDomainEnvelope(envelope);
    const snapshot = wire.slice();
    const parsed = parseAgentRuntimeDomainEnvelope(wire);

    parsed.ciphertext[0] = parsed.ciphertext[0]! ^ 0xff;
    parsed.signature[0] = parsed.signature[0]! ^ 0xff;
    expect(wire).toEqual(snapshot);
  });
});

describe("Agent Runtime generation and Domain lifecycle", () => {
  test("creates independent random 32-byte Runtime generations with detached keys", () => {
    let calls = 0;
    const rng: Rng = {
      bytes(length) {
        calls++;
        return bytes(calls, length);
      },
    };
    const crypto = new LatticeCrypto(rng);
    const first = createAgentRuntimeGeneration({
      crypto,
      agentId: agentId("agent_genie"),
      generation: agentRuntimeGeneration(0),
    });
    const second = createAgentRuntimeGeneration({
      crypto,
      agentId: agentId("agent_genie"),
      generation: agentRuntimeGeneration(1),
    });

    expect(calls).toBe(2);
    expect(first.keyClass).toBe("runtime");
    expect(first.key).toHaveLength(32);
    expect(hex(first.key)).toBe("01".repeat(32));
    expect(hex(second.key)).toBe("02".repeat(32));
    expect(first.key).not.toBe(second.key);
  });

  test("rejects malformed random Runtime keys with the exact boundary diagnostic", () => {
    const crypto = new LatticeCrypto(seededRng(1));
    crypto.randomBytes = () =>
      ({ 0: 1, length: 1 }) as unknown as Uint8Array;
    let malformedKeyError: unknown;
    try {
      createAgentRuntimeGeneration({
        crypto,
        agentId: agentId("agent_genie"),
        generation: agentRuntimeGeneration(0),
      });
    } catch (error) {
      malformedKeyError = error;
    }
    expect(malformedKeyError).toBeInstanceOf(RangeError);
    expect(() =>
      createAgentRuntimeGeneration({
        crypto,
        agentId: agentId("agent_genie"),
        generation: agentRuntimeGeneration(0),
      })
    ).toThrow(
      new RangeError("Random Agent Runtime key must contain exactly 32 bytes"),
    );

    crypto.randomBytes = () => bytes(1, 31);
    expect(() =>
      createAgentRuntimeGeneration({
        crypto,
        agentId: agentId("agent_genie"),
        generation: agentRuntimeGeneration(0),
      })
    ).toThrow(
      new RangeError("Random Agent Runtime key must contain exactly 32 bytes"),
    );
  });

  test("detaches a newly created Runtime key and wipes the random temporary", () => {
    const generated = bytes(0x41);
    const crypto = new LatticeCrypto(seededRng(2));
    crypto.randomBytes = () => generated;
    const runtime = createAgentRuntimeGeneration({
      crypto,
      agentId: agentId("agent_genie"),
      generation: agentRuntimeGeneration(0),
    });

    expect(runtime.key).not.toBe(generated);
    expect(generated).toEqual(new Uint8Array(32));
    expect(runtime.key).toEqual(bytes(0x41));
  });

  test("deduplicates and unsigned-byte sorts one envelope target per distinct Domain", () => {
    const result = deduplicateAgentRuntimeDomains([
      {
        domainId: cryptoDomainId("domain_z"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(2),
      },
      {
        domainId: cryptoDomainId("domain_a"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(8),
      },
      {
        domainId: cryptoDomainId("domain_z"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(2),
      },
    ]);
    expect(result.map((entry) => String(entry.domainId))).toEqual([
      "domain_a",
      "domain_z",
    ]);
    expect(() =>
      deduplicateAgentRuntimeDomains([
        {
          domainId: cryptoDomainId("domain_a"),
          domainEpoch: domainEpoch(1),
          agentAuthorizationRevision: authorizationRevision(2),
        },
        {
          domainId: cryptoDomainId("domain_a"),
          domainEpoch: domainEpoch(2),
          agentAuthorizationRevision: authorizationRevision(2),
        },
      ])
    ).toThrow("conflicting");
  });

  test("validates the target collection, every coordinate, and duplicate revision", () => {
    expect(() =>
      deduplicateAgentRuntimeDomains(null as unknown as [])
    ).toThrow(
      new TypeError("Agent Runtime Domain candidates must be an array"),
    );
    expect(() =>
      deduplicateAgentRuntimeDomains([null as never])
    ).toThrow(
      new TypeError("Agent Runtime Domain target must be an object"),
    );
    expect(() =>
      deduplicateAgentRuntimeDomains(["domain_a" as never])
    ).toThrow(
      new TypeError("Agent Runtime Domain target must be an object"),
    );
    expect(() =>
      deduplicateAgentRuntimeDomains([{
        domainId: "" as never,
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
      }])
    ).toThrow("Crypto Domain id");
    expect(() =>
      deduplicateAgentRuntimeDomains([{
        domainId: cryptoDomainId("domain_a"),
        domainEpoch: -1 as never,
        agentAuthorizationRevision: authorizationRevision(1),
      }])
    ).toThrow("Domain epoch");
    expect(() =>
      deduplicateAgentRuntimeDomains([{
        domainId: cryptoDomainId("domain_a"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: -1 as never,
      }])
    ).toThrow("Authorization revision");
    expect(() =>
      deduplicateAgentRuntimeDomains([
        {
          domainId: cryptoDomainId("domain_a"),
          domainEpoch: domainEpoch(1),
          agentAuthorizationRevision: authorizationRevision(1),
        },
        {
          domainId: cryptoDomainId("domain_a"),
          domainEpoch: domainEpoch(1),
          agentAuthorizationRevision: authorizationRevision(2),
        },
      ])
    ).toThrow("conflicting context");
  });

  test("sorts a portable identifier before its longer prefix-sharing peer", () => {
    const result = deduplicateAgentRuntimeDomains([
      {
        domainId: cryptoDomainId("domain_aa"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
      },
      {
        domainId: cryptoDomainId("domain_a"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
      },
    ]);

    expect(result.map((target) => target.domainId)).toEqual([
      cryptoDomainId("domain_a"),
      cryptoDomainId("domain_aa"),
    ]);
  });

  test("checks the distinct-Domain limit before accepting another target", () => {
    const candidates = Array.from(
      { length: V2_LIMITS.agentGrantDomains + 1 },
      (_, index) => ({
        domainId: cryptoDomainId(`domain_${index}`),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
      }),
    );
    expect(() => deduplicateAgentRuntimeDomains(candidates)).toThrow(
      String(V2_LIMITS.agentGrantDomains),
    );
  });

  test("seals, authenticates, opens, and returns detached Runtime material", () => {
    const { crypto, signing, runtime, domainRoot, envelope } = setup();
    const parsed = parseAgentRuntimeDomainEnvelope(
      serializeAgentRuntimeDomainEnvelope(envelope),
    );
    const opened = openAgentRuntimeFromDomain({
      crypto,
      domainRoot,
      envelope: parsed,
      expected: {
        agentId: runtime.agentId,
        domainId: parsed.domainId,
        domainEpoch: parsed.domainEpoch,
        agentAuthorizationRevision: parsed.agentAuthorizationRevision,
        runtimeGeneration: runtime.generation,
        committerDeviceId: parsed.committerDeviceId,
      },
      resolveHistoricalCommitter: () => signing.publicKey,
    });

    expect(opened).toEqual(runtime);
    expect(opened).not.toBe(runtime);
    expect(opened.key).not.toBe(runtime.key);
    opened.key[0] = opened.key[0]! ^ 0xff;
    expect(runtime.key[0]).not.toBe(opened.key[0]);
  });

  test("passes the complete immutable committer context at seal and open", () => {
    const { crypto, signing, runtime, context, domainRoot } = setup();
    let sealContext: unknown;
    const envelope = sealAgentRuntimeToDomain({
      crypto,
      domainRoot,
      runtime,
      context,
      committerSigningPrivateKey: signing.privateKey,
      currentCommitterAuthorized: (candidate) => {
        sealContext = candidate;
        return true;
      },
    });
    let openContext: unknown;
    openAgentRuntimeFromDomain({
      crypto,
      domainRoot,
      envelope,
      expected: {
        agentId: runtime.agentId,
        domainId: context.domainId,
        domainEpoch: context.domainEpoch,
        agentAuthorizationRevision: context.agentAuthorizationRevision,
        runtimeGeneration: runtime.generation,
        committerDeviceId: context.committerDeviceId,
      },
      resolveHistoricalCommitter: (candidate) => {
        openContext = candidate;
        return signing.publicKey;
      },
    });
    const expectedContext = {
      purpose: "agent-runtime-domain-envelope",
      agentId: runtime.agentId,
      domainId: context.domainId,
      domainEpoch: context.domainEpoch,
      agentAuthorizationRevision: context.agentAuthorizationRevision,
      runtimeGeneration: runtime.generation,
      committerDeviceId: context.committerDeviceId,
    };

    expect(sealContext).toEqual(expectedContext);
    expect(openContext).toEqual(expectedContext);
    expect(Object.isFrozen(sealContext)).toBe(true);
    expect(Object.isFrozen(openContext)).toBe(true);
  });

  test("validates Domain roots and signing keys with exact diagnostics", () => {
    const { crypto, signing, runtime, context, domainRoot, envelope } = setup();
    const expected = {
      agentId: runtime.agentId,
      domainId: envelope.domainId,
      domainEpoch: envelope.domainEpoch,
      agentAuthorizationRevision: envelope.agentAuthorizationRevision,
      runtimeGeneration: runtime.generation,
      committerDeviceId: envelope.committerDeviceId,
    };
    const seal = (
      root: Uint8Array,
      privateKey: Uint8Array,
    ) => sealAgentRuntimeToDomain({
      crypto,
      domainRoot: root,
      runtime,
      context,
      committerSigningPrivateKey: privateKey,
      currentCommitterAuthorized: () => true,
    });

    expect(() => seal(bytes(1, 31), signing.privateKey)).toThrow(
      new RangeError("AI Domain root must contain exactly 32 bytes"),
    );
    expect(() => seal(domainRoot, bytes(1, 31))).toThrow(
      new RangeError(
        "Committer signing private key must contain exactly 32 bytes",
      ),
    );
    expect(() =>
      openAgentRuntimeFromDomain({
        crypto,
        domainRoot: bytes(1, 31),
        envelope,
        expected,
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow(
      new RangeError("AI Domain root must contain exactly 32 bytes"),
    );
    expect(() =>
      openAgentRuntimeFromDomain({
        crypto,
        domainRoot,
        envelope,
        expected,
        resolveHistoricalCommitter: () => bytes(1, 31),
      })
    ).toThrow(
      new RangeError(
        "Historical committer signing public key must contain exactly 32 bytes",
      ),
    );
  });

  test("validates the expected context object and all coordinates before crypto", () => {
    const { crypto, signing, runtime, domainRoot, envelope } = setup();
    const base = {
      agentId: runtime.agentId,
      domainId: envelope.domainId,
      domainEpoch: envelope.domainEpoch,
      agentAuthorizationRevision: envelope.agentAuthorizationRevision,
      runtimeGeneration: runtime.generation,
      committerDeviceId: envelope.committerDeviceId,
    };
    const open = (expected: typeof base) =>
      openAgentRuntimeFromDomain({
        crypto,
        domainRoot,
        envelope,
        expected,
        resolveHistoricalCommitter: () => signing.publicKey,
      });

    expect(() => open(null as never)).toThrow(
      new TypeError("Expected Agent Runtime Domain context must be an object"),
    );
    expect(() => open("context" as never)).toThrow(
      new TypeError("Expected Agent Runtime Domain context must be an object"),
    );
    expect(() => open({ ...base, agentId: "" as never })).toThrow("Agent id");
    expect(() => open({ ...base, domainId: "" as never })).toThrow(
      "Crypto Domain id",
    );
    expect(() => open({ ...base, domainEpoch: -1 as never })).toThrow(
      "Domain epoch",
    );
    expect(() =>
      open({ ...base, agentAuthorizationRevision: -1 as never })
    ).toThrow("Authorization revision");
    expect(() =>
      open({ ...base, runtimeGeneration: -1 as never })
    ).toThrow("Agent Runtime generation");
    expect(() => open({ ...base, committerDeviceId: "" as never })).toThrow(
      "Crypto device id",
    );
  });

  test("detaches ciphertext and signature returned by the crypto provider", () => {
    const { crypto, signing, runtime, context, domainRoot } = setup();
    const ciphertext = bytes(0xcc, 40);
    const signature = bytes(0xdd, 64);
    crypto.aeadSeal = () => ciphertext;
    crypto.sign = () => signature;

    const envelope = sealAgentRuntimeToDomain({
      crypto,
      domainRoot,
      runtime,
      context,
      committerSigningPrivateKey: signing.privateKey,
      currentCommitterAuthorized: () => true,
    });

    expect(envelope.ciphertext).not.toBe(ciphertext);
    expect(envelope.signature).not.toBe(signature);
    ciphertext.fill(0);
    signature.fill(0);
    expect(envelope.ciphertext).toEqual(bytes(0xcc, 40));
    expect(envelope.signature).toEqual(bytes(0xdd, 64));
  });

  test("zeroizes temporary Runtime plaintext after Domain seal and open", () => {
    const crypto = new LatticeCrypto(seededRng(0x226));
    const signing = crypto.generateSigningKeyPair();
    const runtime = createAgentRuntimeGeneration({
      crypto,
      agentId: agentId("agent_genie"),
      generation: agentRuntimeGeneration(7),
    });
    let sealedPlaintext: Uint8Array | null = null;
    const originalSeal = crypto.aeadSeal.bind(crypto);
    crypto.aeadSeal = (key, plaintext, aad) => {
      sealedPlaintext = plaintext;
      return originalSeal(key, plaintext, aad);
    };
    const envelope = sealAgentRuntimeToDomain({
      crypto,
      domainRoot: bytes(0x31),
      runtime,
      context: {
        domainId: cryptoDomainId("domain_ab"),
        domainEpoch: domainEpoch(5),
        agentAuthorizationRevision: authorizationRevision(11),
        committerDeviceId: cryptoDeviceId("device_alice"),
      },
      committerSigningPrivateKey: signing.privateKey,
      currentCommitterAuthorized: () => true,
    });
    expect(sealedPlaintext).not.toBeNull();
    expect(sealedPlaintext!.every((byte) => byte === 0)).toBe(true);

    let openedPlaintext: Uint8Array | null = null;
    const originalOpen = crypto.aeadOpen.bind(crypto);
    crypto.aeadOpen = (...args) => {
      openedPlaintext = originalOpen(...args);
      return openedPlaintext;
    };
    const originalFill = Uint8Array.prototype.fill;
    const wipedRuntimeKeys: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      ...args: Parameters<Uint8Array["fill"]>
    ): Uint8Array {
      if (
        args[0] === 0
        && this.length === runtime.key.length
        && this.every((byte, index) => byte === runtime.key[index])
      ) {
        wipedRuntimeKeys.push(Uint8Array.from(this));
      }
      const result = originalFill.apply(this, args);
      return result;
    };
    try {
      openAgentRuntimeFromDomain({
        crypto,
        domainRoot: bytes(0x31),
        envelope,
        expected: {
          agentId: runtime.agentId,
          domainId: envelope.domainId,
          domainEpoch: envelope.domainEpoch,
          agentAuthorizationRevision: envelope.agentAuthorizationRevision,
          runtimeGeneration: runtime.generation,
          committerDeviceId: envelope.committerDeviceId,
        },
        resolveHistoricalCommitter: () => signing.publicKey,
      });
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(openedPlaintext).not.toBeNull();
    expect(openedPlaintext!.every((byte) => byte === 0)).toBe(true);
    expect(wipedRuntimeKeys).toHaveLength(2);
  });

  test("preserves canonical decoding failures while wiping malformed plaintext", () => {
    const { crypto, signing, runtime, domainRoot, envelope } = setup();
    const malformedPlaintext = new Uint8Array([0xff]);
    crypto.aeadOpen = () => malformedPlaintext;

    expect(() =>
      openAgentRuntimeFromDomain({
        crypto,
        domainRoot,
        envelope,
        expected: {
          agentId: runtime.agentId,
          domainId: envelope.domainId,
          domainEpoch: envelope.domainEpoch,
          agentAuthorizationRevision: envelope.agentAuthorizationRevision,
          runtimeGeneration: runtime.generation,
          committerDeviceId: envelope.committerDeviceId,
        },
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow(CanonicalDecodingError);
    expect(malformedPlaintext).toEqual(new Uint8Array([0]));
  });

  test("binds agent, Domain, epoch, authorization revision, generation, and device", () => {
    const { crypto, signing, runtime, domainRoot, envelope } = setup();
    const baseExpected = {
      agentId: runtime.agentId,
      domainId: envelope.domainId,
      domainEpoch: envelope.domainEpoch,
      agentAuthorizationRevision: envelope.agentAuthorizationRevision,
      runtimeGeneration: runtime.generation,
      committerDeviceId: envelope.committerDeviceId,
    };
    const open = (expected: typeof baseExpected) =>
      openAgentRuntimeFromDomain({
        crypto,
        domainRoot,
        envelope,
        expected,
        resolveHistoricalCommitter: () => signing.publicKey,
      });

    expect(() =>
      open({ ...baseExpected, agentId: agentId("agent_other") })
    ).toThrow("context");
    expect(() =>
      open({ ...baseExpected, domainId: cryptoDomainId("domain_other") })
    ).toThrow("context");
    expect(() =>
      open({ ...baseExpected, domainEpoch: domainEpoch(6) })
    ).toThrow("context");
    expect(() =>
      open({
        ...baseExpected,
        agentAuthorizationRevision: authorizationRevision(12),
      })
    ).toThrow("context");
    expect(() =>
      open({
        ...baseExpected,
        runtimeGeneration: agentRuntimeGeneration(8),
      })
    ).toThrow("context");
    expect(() =>
      open({
        ...baseExpected,
        committerDeviceId: cryptoDeviceId("device_bob"),
      })
    ).toThrow("context");
  });

  test("rejects Runtime/Management substitution before consuming randomness", () => {
    let rngCalls = 0;
    const crypto = new LatticeCrypto({
      bytes(length) {
        rngCalls++;
        return bytes(0x44, length);
      },
    });
    const signing = new LatticeCrypto(seededRng(3)).generateSigningKeyPair();
    const management = {
      agentId: agentId("agent_genie"),
      keyClass: "management",
      generation: agentRuntimeGeneration(0),
      key: bytes(0x99),
    } as unknown as AgentRuntimeGenerationV2;

    expect(() =>
      sealAgentRuntimeToDomain({
        crypto,
        domainRoot: bytes(0x31),
        runtime: management,
        context: {
          domainId: cryptoDomainId("domain_ab"),
          domainEpoch: domainEpoch(1),
          agentAuthorizationRevision: authorizationRevision(1),
          committerDeviceId: cryptoDeviceId("device_alice"),
        },
        committerSigningPrivateKey: signing.privateKey,
        currentCommitterAuthorized: () => true,
      })
    ).toThrow("Runtime");
    expect(rngCalls).toBe(0);
  });

  test("rejects unauthorized devices, wrong keys, signature/ciphertext tampering, and inner substitution", () => {
    const { crypto, signing, runtime, domainRoot, envelope } = setup();
    const expected = {
      agentId: runtime.agentId,
      domainId: envelope.domainId,
      domainEpoch: envelope.domainEpoch,
      agentAuthorizationRevision: envelope.agentAuthorizationRevision,
      runtimeGeneration: runtime.generation,
      committerDeviceId: envelope.committerDeviceId,
    };
    expect(() =>
      sealAgentRuntimeToDomain({
        crypto,
        domainRoot,
        runtime,
        context: {
          domainId: envelope.domainId,
          domainEpoch: envelope.domainEpoch,
          agentAuthorizationRevision: envelope.agentAuthorizationRevision,
          committerDeviceId: envelope.committerDeviceId,
        },
        committerSigningPrivateKey: signing.privateKey,
        currentCommitterAuthorized: () => false,
      })
    ).toThrow("authorized");

    const open = (
      candidate: AgentRuntimeDomainEnvelopeV1,
      root = domainRoot,
      publicKey: Uint8Array | null = signing.publicKey,
    ) =>
      openAgentRuntimeFromDomain({
        crypto,
        domainRoot: root,
        envelope: candidate,
        expected,
        resolveHistoricalCommitter: () => publicKey,
      });
    expect(() => open(envelope, bytes(0x32))).toThrow("decrypt");
    expect(() => open(envelope, domainRoot, null)).toThrow("roster");
    expect(() => open(envelope, domainRoot, bytes(0x33))).toThrow("signature");
    const tamperedCiphertext = {
      ...envelope,
      ciphertext: envelope.ciphertext.slice(),
    };
    tamperedCiphertext.ciphertext[30] =
      tamperedCiphertext.ciphertext[30]! ^ 0xff;
    expect(() => open(tamperedCiphertext)).toThrow("signature");
    const tamperedSignature = {
      ...envelope,
      signature: envelope.signature.slice(),
    };
    tamperedSignature.signature[0] =
      tamperedSignature.signature[0]! ^ 0xff;
    expect(() => open(tamperedSignature)).toThrow("signature");

    const wrongInner = encodeAgentRuntimeGeneration({
      ...runtime,
      agentId: agentId("agent_other"),
    });
    const wrongInnerCiphertext = crypto.aeadSeal(
      domainRoot,
      wrongInner,
      agentRuntimeDomainEnvelopeAad(envelope),
    );
    const wrongInnerUnsigned = {
      ...envelope,
      ciphertext: wrongInnerCiphertext,
    };
    const wrongInnerEnvelope = {
      ...wrongInnerUnsigned,
      signature: crypto.sign(
        signing.privateKey,
        agentRuntimeDomainEnvelopeSigningBytes(wrongInnerUnsigned),
      ),
    };
    expect(() => open(wrongInnerEnvelope)).toThrow("inner and outer");

    const wrongGeneration = encodeAgentRuntimeGeneration({
      ...runtime,
      generation: agentRuntimeGeneration(runtime.generation + 1),
    });
    const wrongGenerationCiphertext = crypto.aeadSeal(
      domainRoot,
      wrongGeneration,
      agentRuntimeDomainEnvelopeAad(envelope),
    );
    const wrongGenerationUnsigned = {
      ...envelope,
      ciphertext: wrongGenerationCiphertext,
    };
    expect(() =>
      open({
        ...wrongGenerationUnsigned,
        signature: crypto.sign(
          signing.privateKey,
          agentRuntimeDomainEnvelopeSigningBytes(wrongGenerationUnsigned),
        ),
      })
    ).toThrow("inner and outer");
  });

  test("detaches caller buffers while sealing", () => {
    const { crypto, signing, runtime, context, domainRoot } = setup();
    const keySnapshot = runtime.key.slice();
    const rootSnapshot = domainRoot.slice();
    const envelope = sealAgentRuntimeToDomain({
      crypto,
      domainRoot,
      runtime,
      context,
      committerSigningPrivateKey: signing.privateKey,
      currentCommitterAuthorized: () => true,
    });
    const wire = serializeAgentRuntimeDomainEnvelope(envelope);

    runtime.key.fill(0);
    domainRoot.fill(0);
    expect(hex(serializeAgentRuntimeDomainEnvelope(envelope))).toBe(hex(wire));
    expect(hex(keySnapshot)).not.toBe(hex(runtime.key));
    expect(hex(rootSnapshot)).not.toBe(hex(domainRoot));
  });
});
