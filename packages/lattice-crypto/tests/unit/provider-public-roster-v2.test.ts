import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "../../src/crypto/index.ts";
import {
  decodeProviderRosterV2,
  providerPublicTransitionDigestV2,
  redactProviderWelcomeV2,
  validateProviderPublicTransitionV2,
} from "../../src/transition/provider-candidate.ts";

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  output.set(u32(bytes.length));
  output.set(bytes, 4);
  return output;
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function roster(
  domain: string,
  entries: readonly {
    readonly leafIndex: number;
    readonly humanId: string;
    readonly deviceId: string;
  }[],
): Uint8Array {
  return concat([
    text(domain),
    u32(entries.length),
    ...entries.flatMap((entry) => [
      u32(entry.leafIndex),
      text(entry.humanId),
      text(entry.deviceId),
    ]),
  ]);
}

const ENTRIES = Object.freeze([
  Object.freeze({
    leafIndex: 0,
    humanId: "human_alice",
    deviceId: "device_alice_desktop",
  }),
  Object.freeze({
    leafIndex: 3,
    humanId: "human_alice",
    deviceId: "device_alice_phone",
  }),
]);

describe("provider public roster wire decoder", () => {
  for (const [providerId, domain] of [
    [
      "ts-mls-v2",
      "nautilo/lattice-crypto/ts-mls-roster/v2",
    ],
    [
      "openmls-v2",
      "nautilo/lattice-crypto/openmls-roster/v2",
    ],
  ] as const) {
    test(`strictly decodes the canonical ${providerId} roster`, () => {
      const decoded = decodeProviderRosterV2(
        providerId,
        roster(domain, ENTRIES),
      );
      expect(decoded as unknown).toEqual(ENTRIES);
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(decoded.every(Object.isFrozen)).toBe(true);
    });
  }

  test("rejects unknown and test-only provider formats", () => {
    expect(() =>
      decodeProviderRosterV2(
        "dummy-v2",
        new Uint8Array([0, 0, 0, 0]),
      )
    ).toThrow("not supported");
    expect(() =>
      decodeProviderRosterV2(
        "unknown-provider",
        new Uint8Array([0, 0, 0, 0]),
      )
    ).toThrow("not supported");
  });

  test("rejects a wrong domain, duplicate device, duplicate leaf, and order drift", () => {
    expect(() =>
      decodeProviderRosterV2(
        "ts-mls-v2",
        roster(
          "nautilo/lattice-crypto/openmls-roster/v2",
          ENTRIES,
        ),
      )
    ).toThrow("domain");
    expect(() =>
      decodeProviderRosterV2(
        "ts-mls-v2",
        roster(
          "nautilo/lattice-crypto/ts-mls-roster/v2",
          [
            ENTRIES[0]!,
            { ...ENTRIES[1]!, deviceId: ENTRIES[0]!.deviceId },
          ],
        ),
      )
    ).toThrow("duplicate");
    expect(() =>
      decodeProviderRosterV2(
        "ts-mls-v2",
        roster(
          "nautilo/lattice-crypto/ts-mls-roster/v2",
          [
            ENTRIES[0]!,
            { ...ENTRIES[1]!, leafIndex: ENTRIES[0]!.leafIndex },
          ],
        ),
      )
    ).toThrow("duplicate");
    expect(() =>
      decodeProviderRosterV2(
        "ts-mls-v2",
        roster(
          "nautilo/lattice-crypto/ts-mls-roster/v2",
          [ENTRIES[1]!, ENTRIES[0]!],
        ),
      )
    ).toThrow("canonical leaf order");
  });

  test("rejects trailing bytes and an out-of-range leaf", () => {
    const canonical = roster(
      "nautilo/lattice-crypto/ts-mls-roster/v2",
      ENTRIES,
    );
    expect(() =>
      decodeProviderRosterV2(
        "ts-mls-v2",
        concat([canonical, new Uint8Array([0])]),
      )
    ).toThrow();
    expect(() =>
      decodeProviderRosterV2(
        "ts-mls-v2",
        roster(
          "nautilo/lattice-crypto/ts-mls-roster/v2",
          [{ ...ENTRIES[0]!, leafIndex: 256 }],
        ),
      )
    ).toThrow("leaf index");
  });
});

describe("provider public transition wire validation", () => {
  const crypto = new LatticeCrypto();
  const rosterBytes = roster(
    "nautilo/lattice-crypto/openmls-roster/v2",
    ENTRIES,
  );
  const transition = {
    formatVersion: 2,
    providerId: "openmls-v2",
    domainId: "domain_alice_bob",
    operation: "add",
    targetHumanId: "human_alice",
    targetDeviceId: "device_alice_phone",
    expectedHead: {
      providerId: "openmls-v2",
      domainId: "domain_alice_bob",
      epoch: 4,
      stateHash: new Uint8Array(32).fill(0x41),
    },
    nextHead: {
      providerId: "openmls-v2",
      domainId: "domain_alice_bob",
      epoch: 5,
      stateHash: new Uint8Array(32).fill(0x42),
    },
    commitBytes: new Uint8Array([0x51]),
    welcomeHash: crypto.hash(new Uint8Array([0x52])),
    welcomeBytes: new Uint8Array([0x52]),
    rosterBytes,
  } as const;

  test("returns an owned exact transition and binds every byte in its digest", () => {
    const validated = validateProviderPublicTransitionV2(transition);
    expect(validated as unknown).toEqual(transition);
    expect(validated).not.toBe(transition);
    expect(validated.expectedHead).not.toBe(transition.expectedHead);
    expect(validated.commitBytes).not.toBe(transition.commitBytes);
    expect(Object.isFrozen(validated)).toBe(true);

    const digest = providerPublicTransitionDigestV2(crypto, validated);
    const redacted = redactProviderWelcomeV2(validated);
    expect(redacted.welcomeBytes).toHaveLength(0);
    expect(redacted.welcomeHash).toEqual(validated.welcomeHash);
    expect(
      providerPublicTransitionDigestV2(crypto, redacted),
    ).toEqual(digest);
    const altered = validateProviderPublicTransitionV2({
      ...transition,
      rosterBytes: roster(
        "nautilo/lattice-crypto/openmls-roster/v2",
        [ENTRIES[0]!],
      ),
    });
    expect(
      providerPublicTransitionDigestV2(crypto, altered),
    ).not.toEqual(digest);
  });

  test("rejects extra fields and coordinate, epoch, or payload drift", () => {
    expect(() =>
      validateProviderPublicTransitionV2({
        ...transition,
        serverTrusted: true,
      })
    ).toThrow("fields");
    expect(() =>
      validateProviderPublicTransitionV2({
        ...transition,
        expectedHead: {
          ...transition.expectedHead,
          providerId: "ts-mls-v2",
        },
      })
    ).toThrow("coordinates");
    expect(() =>
      validateProviderPublicTransitionV2({
        ...transition,
        nextHead: { ...transition.nextHead, epoch: 6 },
      })
    ).toThrow("epoch");
    expect(() =>
      validateProviderPublicTransitionV2({
        ...transition,
        commitBytes: new Uint8Array(),
      })
    ).toThrow("commit");
  });
});
