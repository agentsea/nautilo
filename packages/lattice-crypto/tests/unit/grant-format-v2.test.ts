import { describe, expect, test } from "bun:test";
import {
  GRANT_V2_FORMAT_VERSION,
  GRANT_V2_SCHEME,
  grantV2SigningBytes,
  parseGrantSecretV2,
  parseGrantV2,
  serializeGrantSecretV2,
  serializeGrantV2,
  type GrantV2,
} from "../../src/format/grant-v2.ts";
import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import { toHex } from "../../src/util/bytes.ts";

const SIGNING_FIXTURE_HEX =
  "0000001f6e617574696c6f2f6c6174746963652d63727970746f2f6772616e742f7632"
  + "00000002000000076772616e742d310000000e6465766963652d616c6963652d31"
  + "0000000b6167656e742d67656e696500000010696e766f636174696f6e2d6b65792d31"
  + "0000000200000005616c69636500000003626f62000000020000000764656372797074"
  + "00000007656e637279707400000000000003e800000000000007d000000002"
  + "00000009646f6d61696e2d616200000000000000030000000000000007"
  + "0000000a646f6d61696e2d61626300000000000000040000000000000008"
  + "00000003aabbcc00000015646f6d61696e2d656e756d65726174696f6e2d7632"
  + "0000000101";
const WIRE_FIXTURE_HEX =
  `${SIGNING_FIXTURE_HEX}00000040${"5a".repeat(64)}`;
const SECRET_FIXTURE_HEX =
  "000000266e617574696c6f2f6c6174746963652d63727970746f2f6772616e742d"
  + "7365637265742f7632000000020000000200000009646f6d61696e2d616200000020"
  + "1111111111111111111111111111111111111111111111111111111111111111"
  + "0000000a646f6d61696e2d61626300000020"
  + "2222222222222222222222222222222222222222222222222222222222222222";

function grant(): GrantV2 {
  return {
    formatVersion: GRANT_V2_FORMAT_VERSION,
    id: grantId("grant-1"),
    issuingDeviceId: cryptoDeviceId("device-alice-1"),
    recipientAgentId: agentId("agent-genie"),
    recipientKeyId: "invocation-key-1",
    scope: [humanId("alice"), humanId("bob")],
    operations: ["decrypt", "encrypt"],
    issuedAt: 1_000,
    expiresAt: 2_000,
    coveredDomains: [
      {
        domainId: cryptoDomainId("domain-ab"),
        domainEpoch: domainEpoch(3),
        agentAuthorizationRevision: authorizationRevision(7),
      },
      {
        domainId: cryptoDomainId("domain-abc"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(8),
      },
    ],
    encryptedSecret: new Uint8Array([0xaa, 0xbb, 0xcc]),
    scheme: GRANT_V2_SCHEME,
    signature: new Uint8Array(64).fill(0x5a),
    singleUse: true,
    consumed: false,
  };
}

describe("GrantV2 canonical wire format", () => {
  test("round-trips every signed field and excludes mutable consumption state", () => {
    const original = grant();
    const wire = serializeGrantV2(original);
    const parsed = parseGrantV2(wire);

    expect(parsed).toEqual(original);
    expect(parsed?.consumed).toBe(false);
    expect(serializeGrantV2({ ...original, consumed: true })).toEqual(wire);
  });

  test("locks exact domain-separated signing and wire fixtures", () => {
    const original = grant();
    expect(toHex(grantV2SigningBytes(original))).toBe(
      SIGNING_FIXTURE_HEX,
    );
    expect(toHex(serializeGrantV2(original))).toBe(
      WIRE_FIXTURE_HEX,
    );
  });

  test("rejects noncanonical sets, covered Domains, timestamps, and signatures", () => {
    expect(() =>
      serializeGrantV2({
        ...grant(),
        scope: [humanId("bob"), humanId("alice")],
      })
    ).toThrow("canonical");
    expect(() =>
      serializeGrantV2({
        ...grant(),
        operations: ["encrypt", "decrypt"],
      })
    ).toThrow("canonical");
    expect(() =>
      serializeGrantV2({
        ...grant(),
        coveredDomains: [...grant().coveredDomains].reverse(),
      })
    ).toThrow("canonical");
    expect(() =>
      serializeGrantV2({
        ...grant(),
        expiresAt: 1_000,
      })
    ).toThrow("timestamps");
    expect(() =>
      serializeGrantV2({
        ...grant(),
        signature: new Uint8Array(63),
      })
    ).toThrow("signature");
  });

  test("strict parsing rejects truncation, trailing bytes, old domains, and noncanonical bytes", () => {
    const wire = serializeGrantV2(grant());
    expect(parseGrantV2(wire.slice(0, -1))).toBeNull();
    expect(parseGrantV2(new Uint8Array([...wire, 0]))).toBeNull();
    expect(parseGrantV2(
      new Uint8Array(V2_LIMITS.agentGrantWireBytes + 1),
    )).toBeNull();

    const oldDomain = wire.slice();
    const domainNeedle = new TextEncoder().encode(
      "nautilo/lattice-crypto/grant/v2",
    );
    const domainOffset = oldDomain.findIndex(
      (_, index) =>
        domainNeedle.every((byte, inner) => oldDomain[index + inner] === byte),
    );
    expect(domainOffset).toBeGreaterThanOrEqual(0);
    oldDomain[domainOffset + domainNeedle.length - 1] = 0x31;
    expect(parseGrantV2(oldDomain)).toBeNull();

    const signing = grantV2SigningBytes(grant());
    expect(signing).not.toEqual(
      grantV2SigningBytes({ ...grant(), recipientAgentId: agentId("agent-other") }),
    );
    expect(signing).not.toEqual(
      grantV2SigningBytes({ ...grant(), recipientKeyId: "invocation-key-2" }),
    );
  });

  test("locks every signing-field boundary and scalar discriminator", () => {
    const invalid: Array<readonly [Partial<GrantV2>, string]> = [
      [{ formatVersion: 1 as 2 }, "format version"],
      [{ scope: [] }, "Grant Human scope"],
      [{ scope: [humanId("alice"), humanId("alice")] }, "duplicate"],
      [{ recipientKeyId: "not portable" }, "Recipient invocation key id"],
      [{ operations: [] }, "Grant operations"],
      [{ operations: ["bogus" as "decrypt"] }, "unsupported"],
      [{ operations: ["decrypt", "decrypt"] }, "canonical and unique"],
      [{ issuedAt: Number.NaN }, "timestamps"],
      [{ expiresAt: Number.POSITIVE_INFINITY }, "timestamps"],
      [{ issuedAt: -1 }, "timestamps"],
      [{ issuedAt: 1_000, expiresAt: 1_000 }, "timestamps"],
      [{
        issuedAt: 1_000,
        expiresAt: 1_000 + V2_LIMITS.grantTtlMs + 1,
      }, "timestamps"],
      [{ coveredDomains: [] }, "Grant covered Domains"],
      [{
        coveredDomains: [{
          ...grant().coveredDomains[0]!,
          domainId: "not portable" as ReturnType<typeof cryptoDomainId>,
        }],
      }, "Crypto Domain id"],
      [{
        coveredDomains: [{
          ...grant().coveredDomains[0]!,
          domainEpoch: -1 as ReturnType<typeof domainEpoch>,
        }],
      }, "Domain epoch"],
      [{
        coveredDomains: [{
          ...grant().coveredDomains[0]!,
          agentAuthorizationRevision:
            -1 as ReturnType<typeof authorizationRevision>,
        }],
      }, "Authorization revision"],
      [{
        coveredDomains: [
          grant().coveredDomains[0]!,
          grant().coveredDomains[0]!,
        ],
      }, "duplicate"],
      [{ encryptedSecret: new Uint8Array() }, "encrypted secret"],
      [{
        encryptedSecret:
          new Uint8Array(V2_LIMITS.agentGrantSecretBytes + 1),
      }, "encrypted secret"],
      [{ scheme: "wrong" as typeof GRANT_V2_SCHEME }, "scheme"],
      [{ singleUse: 1 as unknown as boolean }, "single-use flag"],
    ];
    for (const [change, message] of invalid) {
      expect(() => serializeGrantV2({ ...grant(), ...change }))
        .toThrow(message);
    }

    const epochStart = {
      ...grant(),
      issuedAt: 0,
      expiresAt: 1,
      scope: [humanId("alice")],
      operations: ["decrypt"] as const,
      coveredDomains: [grant().coveredDomains[0]!],
      encryptedSecret: new Uint8Array([1]),
      singleUse: false,
    };
    expect(parseGrantV2(serializeGrantV2(epochStart))).toEqual(epochStart);
    const exactTtl = {
      ...epochStart,
      issuedAt: 1_000,
      expiresAt: 1_000 + V2_LIMITS.grantTtlMs,
    };
    expect(parseGrantV2(serializeGrantV2(exactTtl))).toEqual(exactTtl);
    const maximumSecret = {
      ...exactTtl,
      encryptedSecret: new Uint8Array(V2_LIMITS.agentGrantSecretBytes),
    };
    expect(parseGrantV2(serializeGrantV2(maximumSecret)))
      .toEqual(maximumSecret);
    expect(parseGrantV2("not-bytes" as unknown as Uint8Array)).toBeNull();
  });
});

describe("GrantSecretV2 AI Domain-root map", () => {
  test("round-trips one root per canonical Domain and locks an exact fixture", () => {
    const entries = [
      {
        domainId: cryptoDomainId("domain-ab"),
        aiRoot: new Uint8Array(32).fill(0x11),
      },
      {
        domainId: cryptoDomainId("domain-abc"),
        aiRoot: new Uint8Array(32).fill(0x22),
      },
    ];
    const bytes = serializeGrantSecretV2(entries);

    expect(parseGrantSecretV2(bytes)).toEqual(entries);
    expect(toHex(bytes)).toBe(SECRET_FIXTURE_HEX);
  });

  test("rejects duplicate, noncanonical, wrong-length, trailing, and oversized roots", () => {
    const entry = {
      domainId: cryptoDomainId("domain-ab"),
      aiRoot: new Uint8Array(32),
    };
    expect(() =>
      serializeGrantSecretV2([entry, entry])
    ).toThrow("duplicate");
    expect(() =>
      serializeGrantSecretV2([
        { ...entry, domainId: cryptoDomainId("domain-z") },
        { ...entry, domainId: cryptoDomainId("domain-a") },
      ])
    ).toThrow("canonical");
    expect(() =>
      serializeGrantSecretV2([{ ...entry, aiRoot: new Uint8Array(31) }])
    ).toThrow("32");

    const valid = serializeGrantSecretV2([entry]);
    expect(parseGrantSecretV2(new Uint8Array([...valid, 0]))).toBeNull();
    expect(parseGrantSecretV2(valid.slice(0, -1))).toBeNull();
    expect(parseGrantSecretV2("not-bytes" as unknown as Uint8Array))
      .toBeNull();
    expect(() => serializeGrantSecretV2([]))
      .toThrow("Grant secret Domain roots");
  });
});
