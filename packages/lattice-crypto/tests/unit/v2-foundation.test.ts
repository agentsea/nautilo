import { describe, expect, test } from "bun:test";
import {
  canonicalizeParticipants,
  participantDigest,
  participantDigestInput,
} from "../../src/domain/participants.ts";
import {
  AI_DOMAIN_ROOT_EXPORTER_LABEL,
  DOMAIN_ROOT_BYTES,
  HUMAN_DOMAIN_ROOT_EXPORTER_LABEL,
  domainRootExporterContext,
  exportDomainRoot,
} from "../../src/domain/roots.ts";
import {
  V2_LIMITS,
  V2LimitError,
  assertV2Limit,
  assertV2Range,
} from "../../src/v2-types/limits.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceId,
  namespaceGeneration,
  objectId,
  portableIdIsValid,
  unixTimestamp,
  V2ValidationError,
} from "../../src/v2-types/ids.ts";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

describe("v2 opaque vocabulary and portable identifiers", () => {
  test("accepts only the retained ASCII grammar within the byte ceiling", () => {
    expect(String(cryptoDomainId("domain_AB-1/@home"))).toBe(
      "domain_AB-1/@home",
    );
    expect(portableIdIsValid("a")).toBe(true);
    expect(portableIdIsValid(`a${"x".repeat(V2_LIMITS.idBytes - 1)}`)).toBe(
      true,
    );

    for (const value of [
      "",
      "-leading-punctuation",
      "contains space",
      "álïçé",
      "nul\u0000byte",
      `a${"x".repeat(V2_LIMITS.idBytes)}`,
    ]) {
      expect(portableIdIsValid(value)).toBe(false);
      expect(() => humanId(value)).toThrow("portable identifier");
    }
    for (const value of [null, undefined, 0, {}, new Uint8Array([1])]) {
      expect(portableIdIsValid(value)).toBe(false);
      expect(() => humanId(value)).toThrow("portable identifier");
    }
  });

  test("validates every nominal identifier constructor", () => {
    const constructors = [
      [humanId, "Human id"],
      [cryptoDeviceId, "Crypto device id"],
      [cryptoDomainId, "Crypto Domain id"],
      [namespaceId, "Namespace id"],
      [objectId, "Object id"],
      [grantId, "Grant id"],
      [agentId, "Agent id"],
    ] as const;
    for (const [construct, label] of constructors) {
      expect(String(construct("portable_1"))).toBe("portable_1");
      expect(() => construct("")).toThrow(
        new RegExp(`^${label} must be`),
      );
    }
    expect(new V2ValidationError("invalid").name).toBe("V2ValidationError");
  });

  test("u64-backed counters accept only non-negative safe integers", () => {
    expect(Number(domainEpoch(0))).toBe(0);
    expect(Number(namespaceGeneration(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(Number(accessRevision(17))).toBe(17);

    for (const value of [
      null,
      undefined,
      "1",
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => domainEpoch(value)).toThrow("non-negative safe integer");
    }
  });

  test("validates every nominal counter constructor", () => {
    const constructors = [
      [domainEpoch, "Domain epoch"],
      [namespaceGeneration, "Namespace generation"],
      [accessRevision, "Access revision"],
      [authorizationRevision, "Authorization revision"],
      [agentRuntimeGeneration, "Agent Runtime generation"],
      [unixTimestamp, "Timestamp"],
    ] as const;
    for (const [construct, label] of constructors) {
      expect(Number(construct(7))).toBe(7);
      expect(() => construct(-1)).toThrow(
        new RegExp(`^${label} must be`),
      );
    }
  });
});

describe("v2 participant canonicalization", () => {
  test("uses unsigned UTF-8 byte order, not locale collation", () => {
    const canonical = canonicalizeParticipants([
      humanId("a_"),
      humanId("a-"),
      humanId("a@"),
      humanId("a:"),
      humanId("a/"),
      humanId("a."),
      humanId("aa"),
      humanId("a"),
    ]);

    expect(canonical.map(String)).toEqual([
      "a",
      "a-",
      "a.",
      "a/",
      "a:",
      "a@",
      "a_",
      "aa",
    ]);
    expect(Object.isFrozen(canonical)).toBe(true);
  });

  test("rejects empty and duplicate sets without a product-size ceiling", () => {
    expect(() => canonicalizeParticipants([])).toThrow(
      "Human participant set must not be empty",
    );
    expect(() =>
      canonicalizeParticipants([humanId("alice"), humanId("alice")])
    ).toThrow("duplicate");
    expect(canonicalizeParticipants(
      Array.from(
        { length: V2_LIMITS.humanParticipantsPerDomain + 1 },
        (_, index) => humanId(`human_${index}`),
      ),
    )).toHaveLength(V2_LIMITS.humanParticipantsPerDomain + 1);
  });

  test("locks the exact participant digest framing and SHA-256 fixture", () => {
    const participants = canonicalizeParticipants([
      humanId("bob"),
      humanId("alice"),
    ]);

    expect(hex(participantDigestInput(participants))).toBe(
      "000000346e617574696c6f2f6c6174746963652d63727970746f2f63727970746f2d646f6d61696e2d7061727469636970616e74732f7632" +
        "00000002" +
        "00000005616c696365" +
        "00000003626f62",
    );
    expect(hex(participantDigest(participants))).toBe(
      "a55c72ba6b551b33d48199e832572776652f9dd3ba8c46a345f3156310293cee",
    );
  });
});

describe("v2 Domain exporter requests", () => {
  test("locks the two RFC 9420 labels and canonical Domain context", () => {
    expect(HUMAN_DOMAIN_ROOT_EXPORTER_LABEL).toBe(
      "nautilo/lattice-crypto/human-domain-root/v2",
    );
    expect(AI_DOMAIN_ROOT_EXPORTER_LABEL).toBe(
      "nautilo/lattice-crypto/ai-domain-root/v2",
    );
    expect(
      hex(domainRootExporterContext(cryptoDomainId("domain_ab"), domainEpoch(258))),
    ).toBe("00000009646f6d61696e5f61620000000000000102");
    expect(() =>
      domainRootExporterContext("" as never, domainEpoch(0))
    ).toThrow("Crypto Domain id must be");
    expect(() =>
      domainRootExporterContext(
        cryptoDomainId("domain_ab"),
        -1 as never,
      )
    ).toThrow("Domain epoch must be");
  });

  test("calls the exporter directly for exactly 32 bytes", async () => {
    const calls: Array<{
      label: string;
      context: Uint8Array;
      length: number;
    }> = [];
    const expected = Buffer.alloc(DOMAIN_ROOT_BYTES, 0xa5);

    const root = await exportDomainRoot(
      "human",
      cryptoDomainId("domain_ab"),
      domainEpoch(258),
      async (label, context, length) => {
        calls.push({ label, context, length });
        return expected;
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.label).toBe(HUMAN_DOMAIN_ROOT_EXPORTER_LABEL);
    expect(calls[0]?.length).toBe(DOMAIN_ROOT_BYTES);
    expect(hex(calls[0]!.context)).toBe(
      "00000009646f6d61696e5f61620000000000000102",
    );
    expect(root).toEqual(new Uint8Array(DOMAIN_ROOT_BYTES).fill(0xa5));
    expect(root).not.toBe(expected);
    expect(Buffer.isBuffer(root)).toBeFalse();
    expect(expected).toEqual(Buffer.alloc(DOMAIN_ROOT_BYTES));
    expect(root).toEqual(new Uint8Array(DOMAIN_ROOT_BYTES).fill(0xa5));
  });

  test("fails closed when a provider returns a non-root length", async () => {
    expect(
      exportDomainRoot(
        "ai",
        cryptoDomainId("domain_ab"),
        domainEpoch(0),
        async () => new Uint8Array(DOMAIN_ROOT_BYTES - 1),
      ),
    ).rejects.toThrow("32 bytes");
  });

  test("preserves the domain-export diagnostic for a non-byte result", async () => {
    const result = exportDomainRoot(
      "ai",
      cryptoDomainId("domain_ab"),
      domainEpoch(0),
      async () => null as never,
    );
    expect(result).rejects.toBeInstanceOf(RangeError);
    expect(result).rejects.toThrow(
      "Domain exporter must return exactly 32 bytes",
    );
  });

  test("fails closed on an unknown root class before exporter work", async () => {
    let exporterCalls = 0;
    expect(
      exportDomainRoot(
        "management" as never,
        cryptoDomainId("domain_ab"),
        domainEpoch(0),
        async () => {
          exporterCalls++;
          return new Uint8Array(DOMAIN_ROOT_BYTES);
        },
      ),
    ).rejects.toThrow("unsupported");
    expect(exporterCalls).toBe(0);
  });
});

describe("v2 ceilings", () => {
  test("locks the Wave 2 structural limits", () => {
    expect(V2_LIMITS).toMatchObject({
      idBytes: 128,
      humanParticipantsPerDomain: 64,
      deviceLeavesPerDomain: 256,
      grantScopeHumans: 32,
      agentGrantDomains: 16_384,
      agentGrantNamespaces: 16_384,
      agentGrantPlanBytes: 8 * 1024 * 1024,
      agentGrantSecretBytes: 8 * 1024 * 1024,
      agentGrantWireBytes: 16 * 1024 * 1024,
      distinctDomainsPerGrant: 256,
      bindingsPerBatch: 256,
      namespacesPerDomainTransition: 256,
      namespaceKeyringBytes: 256 * 1024,
      namespaceEnvelopesPerManifest: 256,
      manifestEnvelopeBytes: 1024 * 1024,
      proofEntriesPerSegment: 256,
      retainedNamespaceGenerations: 4_096,
      recoveryPackages: 4_096,
      recoveryArchiveBytes: 64 * 1024 * 1024,
      authorizedDomainsPerAgent: 256,
      runtimeEnvelopesPerAgent: 256,
      retainedAgentGenerations: 4_096,
      batchItems: 256,
      plaintextBytes: 1024 * 1024,
      ciphertextBytes: 1024 * 1024 + 40,
      wrappedDekBytes: 4 * 1024,
      grantSecretBytes: 1024 * 1024,
      grantWireBytes: 2 * 1024 * 1024,
      grantTtlMs: 24 * 60 * 60 * 1000,
      schemeIdBytes: 64,
      hpkePublicKeyBytes: 65,
      hpkePrivateKeyBytes: 32,
      signingPublicKeyBytes: 32,
      signingPrivateKeyBytes: 32,
      signatureBytes: 64,
    });
    expect(Object.isFrozen(V2_LIMITS)).toBe(true);
  });

  test("generic guards accept the boundary and reject before over-limit work", () => {
    expect(new V2LimitError("invalid").name).toBe("V2LimitError");
    expect(assertV2Limit("participant count", 64, 64)).toBe(64);
    expect(() => assertV2Limit("participant count", 65, 64)).toThrow(
      V2LimitError,
    );
    expect(() => assertV2Limit("participant count", -1, 64)).toThrow(
      "non-negative safe integer",
    );
    expect(assertV2Limit("empty", 0, 0)).toBe(0);
    for (const invalidMaximum of [-1, 0.5, Number.NaN]) {
      expect(() => assertV2Limit("invalid maximum", 0, invalidMaximum))
        .toThrow(
          "v2 limit maximum must be a non-negative safe integer",
        );
    }
    for (const invalidValue of [0.5, Number.NaN]) {
      expect(() => assertV2Limit("invalid value", invalidValue, 64))
        .toThrow(V2LimitError);
    }
    expect(assertV2Range("range", 0, 0, 0)).toBe(0);
    expect(assertV2Range("range", 4, 4, 4)).toBe(4);
    expect(() => assertV2Range("range", 3, 4, 5)).toThrow(
      "between 4 and 5",
    );
    for (const invalidMinimum of [-1, 0.5, Number.NaN]) {
      expect(() => assertV2Range("range", 0, invalidMinimum, 5))
        .toThrow("v2 range minimum is invalid");
    }
    expect(() => assertV2Range("range", 0, 6, 5)).toThrow(TypeError);
  });
});
