import { describe, expect, test } from "bun:test";

import { LatticeCrypto } from "../../src/crypto/index.ts";
import {
  NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION,
  NAMESPACE_AGENT_GRANT_V1_MAX_NAMESPACES,
  NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_BYTES,
  NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES,
  NAMESPACE_AGENT_GRANT_V1_PURPOSE,
  NAMESPACE_AGENT_GRANT_V1_SCHEME,
  createNamespaceAgentGrantPlanV1,
  destroyNamespaceAgentGrantV1,
  mintNamespaceAgentGrantV1,
  namespaceAgentGrantSigningBytesV1,
  parseNamespaceAgentGrantPlanV1,
  parseNamespaceAgentGrantV1,
  serializeNamespaceAgentGrantPlanV1,
  serializeNamespaceAgentGrantV1,
  withOpenedNamespaceAgentGrantV1,
  type NamespaceAgentGrantAuthorityEntryV1,
  type NamespaceAgentGrantCurrentAuthorityV1,
  type NamespaceAgentGrantSecretEntryV1,
  type NamespaceAgentGrantV1,
} from "../../src/format/namespace-agent-grant-v1.ts";
import {
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  grantId,
  humanId,
  namespaceGeneration,
  namespaceId,
} from "../../src/v2-types/ids.ts";
import { seededRng } from "../../src/crypto/index.ts";

const NOW = 1_800_000_000_000;
const OPERATION = "operation_m290_grant";
const POLICY_REVISION = 3;
const HOST_AUTHORIZATION_REVISION = authorizationRevision(7);
const SECRET_BYTE_CEILING = 16_384;
const SESSION = "10000000-0000-4000-8000-000000000290";
const ROOM = "20000000-0000-4000-8000-000000000290";
const HUMAN = humanId("human_m290_grant");
const DEVICE = cryptoDeviceId("device_m290_grant");
const AGENT = agentId("agent_m290_grant");
const RECIPIENT_KEY = "recipient_m290_grant";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function authority(): readonly NamespaceAgentGrantAuthorityEntryV1[] {
  return Object.freeze([
    Object.freeze({
      namespaceId: namespaceId("namespace_a_m290"),
      keyClass: "ai" as const,
      firstRetainedGeneration: namespaceGeneration(1),
      currentGeneration: namespaceGeneration(2),
      retainedGenerations: Object.freeze([1, 2].map((generation) =>
        Object.freeze({
          generation: namespaceGeneration(generation),
          accessRevision: accessRevision(3),
          headDigest: bytes(0x11),
          publicationDigest: bytes(0x31),
          publicationSetDigest: bytes(0x41),
          audienceFingerprint: bytes(0x21),
        })
      )),
      agentAuthorizationRevision: authorizationRevision(4),
    }),
    Object.freeze({
      namespaceId: namespaceId("namespace_b_m290"),
      keyClass: "ai" as const,
      firstRetainedGeneration: namespaceGeneration(7),
      currentGeneration: namespaceGeneration(7),
      retainedGenerations: Object.freeze([Object.freeze({
        generation: namespaceGeneration(7),
        accessRevision: accessRevision(5),
        headDigest: bytes(0x12),
        publicationDigest: bytes(0x32),
        publicationSetDigest: bytes(0x42),
        audienceFingerprint: bytes(0x22),
      })]),
      agentAuthorizationRevision: authorizationRevision(6),
    }),
  ]);
}

function secretEntries(): readonly NamespaceAgentGrantSecretEntryV1[] {
  return Object.freeze([
    Object.freeze({
      namespaceId: namespaceId("namespace_a_m290"),
      keyClass: "ai" as const,
      accessRevision: accessRevision(3),
      generation: namespaceGeneration(1),
      generationKey: bytes(0x31),
      audienceFingerprint: bytes(0x21),
      headDigest: bytes(0x11),
    }),
    Object.freeze({
      namespaceId: namespaceId("namespace_a_m290"),
      keyClass: "ai" as const,
      accessRevision: accessRevision(3),
      generation: namespaceGeneration(2),
      generationKey: bytes(0x32),
      audienceFingerprint: bytes(0x21),
      headDigest: bytes(0x11),
    }),
    Object.freeze({
      namespaceId: namespaceId("namespace_b_m290"),
      keyClass: "ai" as const,
      accessRevision: accessRevision(5),
      generation: namespaceGeneration(7),
      generationKey: bytes(0x37),
      audienceFingerprint: bytes(0x22),
      headDigest: bytes(0x12),
    }),
  ]);
}

function plan(crypto: LatticeCrypto) {
  return createNamespaceAgentGrantPlanV1(crypto, {
    operationId: OPERATION,
    policyRevision: POLICY_REVISION,
    sessionId: SESSION,
    roomId: ROOM,
    subjectHumanId: HUMAN,
    issuingDeviceId: DEVICE,
    issuingDeviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: HOST_AUTHORIZATION_REVISION,
    recipientAgentId: AGENT,
    recipientKeyId: RECIPIENT_KEY,
    operations: Object.freeze(["decrypt", "encrypt"]),
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
    maximumSecretBytes: SECRET_BYTE_CEILING,
    authority: authority(),
  });
}

function current(
  signingPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
  currentAuthority = authority(),
): NamespaceAgentGrantCurrentAuthorityV1 {
  return Object.freeze({
    operationId: OPERATION,
    policyRevision: POLICY_REVISION,
    sessionId: SESSION,
    roomId: ROOM,
    subjectHumanId: HUMAN,
    issuingDeviceId: DEVICE,
    issuingDeviceSigningKeyGeneration: 2,
    issuingDeviceSigningPublicKey: signingPublicKey,
    issuingDeviceActive: true,
    hostAuthorizationRevision: HOST_AUTHORIZATION_REVISION,
    recipientAgentId: AGENT,
    recipientKeyId: RECIPIENT_KEY,
    recipientEncryptionPrivateKey: recipientPrivateKey,
    agentAuthorized: true,
    hostAllowsOperation: true,
    operation: "decrypt",
    authority: currentAuthority,
  });
}

describe("Namespace-enumerating Agent Grant v1", () => {
  test("pins canonical content-free plan and public Grant bytes", () => {
    const crypto = new LatticeCrypto(seededRng(290_001));
    const grantPlan = plan(crypto);
    const planBytes = serializeNamespaceAgentGrantPlanV1(grantPlan);
    const signing = crypto.generateSigningKeyPair();
    const encryptedSecret = new Uint8Array(97).fill(0x51);
    const unsigned = Object.freeze({
      formatVersion: NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION,
      purpose: NAMESPACE_AGENT_GRANT_V1_PURPOSE,
      scheme: NAMESPACE_AGENT_GRANT_V1_SCHEME,
      id: grantId("grant_m290_vector"),
      planBytes,
      planDigest: crypto.hash(planBytes),
      secretEntryCount: 3,
      secretDigest: bytes(0x61),
      encryptedSecret,
      encryptedSecretDigest: crypto.hash(encryptedSecret),
    });
    const signingBytes = namespaceAgentGrantSigningBytesV1(unsigned);
    const value: NamespaceAgentGrantV1 = Object.freeze({
      ...unsigned,
      signature: crypto.sign(signing.privateKey, signingBytes),
    });
    const grantBytes = serializeNamespaceAgentGrantV1(value);
    try {
      expect(Buffer.from(crypto.hash(planBytes)).toString("hex")).toBe(
        "e761fb7fef7790661f094f361f3f50b1e0fbf5620b6317b31eb4567ade8b38c5",
      );
      expect(Buffer.from(crypto.hash(grantBytes)).toString("hex")).toBe(
        "2fbdb1d5afa764c1a406d34af2ab9425028f4cb23e8d826d73e7e3ef797ace41",
      );
      const decodedPlan = parseNamespaceAgentGrantPlanV1(planBytes);
      expect(decodedPlan?.policyRevision).toBe(POLICY_REVISION);
      expect(decodedPlan?.hostAuthorizationRevision).toBe(
        HOST_AUTHORIZATION_REVISION,
      );
      expect(decodedPlan?.namespaceCount).toBe(2);
      expect(decodedPlan?.secretEntryCount).toBe(3);
      const decoded = parseNamespaceAgentGrantV1(grantBytes);
      expect(decoded?.secretEntryCount).toBe(3);
      if (decoded !== null) destroyNamespaceAgentGrantV1(decoded);
    } finally {
      planBytes.fill(0);
      signingBytes.fill(0);
      grantBytes.fill(0);
      signing.publicKey.fill(0);
      signing.privateKey.fill(0);
      grantPlan.authoritySetDigest.fill(0);
      grantPlan.authority.forEach((entry) => {
        entry.retainedGenerations.forEach((retained) => {
          retained.headDigest.fill(0);
          retained.publicationDigest.fill(0);
          retained.publicationSetDigest.fill(0);
          retained.audienceFingerprint.fill(0);
        });
      });
    }
  });

  test("mints, authenticates, opens, and wipes the exact ordered AI generation set", async () => {
    const crypto = new LatticeCrypto(seededRng(290_002));
    const signing = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    const grantPlan = plan(crypto);
    const grant = await mintNamespaceAgentGrantV1(crypto, {
      grantId: grantId("grant_m290_round_trip"),
      plan: grantPlan,
      entries: secretEntries(),
      issuingDeviceSigningPrivateKey: signing.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });
    const grantBytes = serializeNamespaceAgentGrantV1(grant);
    let callbackKey: Uint8Array | undefined;
    try {
      const opened = await withOpenedNamespaceAgentGrantV1(crypto, {
        grantBytes,
        now: NOW + 1,
        current: current(signing.publicKey, recipient.privateKey),
        operation: (entries) => {
          callbackKey = entries[0]!.generationKey;
          expect(entries.map((entry) =>
            `${entry.namespaceId}:${String(entry.generation)}`
          )).toEqual([
            "namespace_a_m290:1",
            "namespace_a_m290:2",
            "namespace_b_m290:7",
          ]);
          return entries[2]!.generationKey[0];
        },
      });
      expect(opened).toEqual({ status: "opened", value: 0x37 });
      expect(callbackKey).toEqual(new Uint8Array(32));
      let thrownKey: Uint8Array | undefined;
      let thrown: unknown;
      try {
        await withOpenedNamespaceAgentGrantV1(crypto, {
          grantBytes,
          now: NOW + 1,
          current: current(signing.publicKey, recipient.privateKey),
          operation: (entries) => {
            thrownKey = entries[1]!.generationKey;
            throw new Error("callback failed");
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("callback failed");
      expect(thrownKey).toEqual(new Uint8Array(32));
    } finally {
      grantBytes.fill(0);
      destroyNamespaceAgentGrantV1(grant);
      signing.publicKey.fill(0);
      signing.privateKey.fill(0);
      recipient.publicKey.fill(0);
      recipient.privateKey.fill(0);
    }
  });

  test("rejects omitted, additional, reordered, duplicate, and Human key material", async () => {
    const crypto = new LatticeCrypto(seededRng(290_003));
    const signing = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    const grantPlan = plan(crypto);
    const canonical = secretEntries();
    const changed: readonly (readonly NamespaceAgentGrantSecretEntryV1[])[] = [
      canonical.slice(1),
      [...canonical, Object.freeze({
        ...canonical[2]!,
        namespaceId: namespaceId("namespace_c_m290"),
      })],
      [canonical[1]!, canonical[0]!, canonical[2]!],
      [canonical[0]!, canonical[0]!, canonical[2]!],
      [Object.freeze({
        ...canonical[0]!,
        keyClass: "human",
      }) as unknown as NamespaceAgentGrantSecretEntryV1, canonical[1]!, canonical[2]!],
    ];
    try {
      for (const entries of changed) {
        expect(mintNamespaceAgentGrantV1(crypto, {
          grantId: grantId("grant_m290_rejected_set"),
          plan: grantPlan,
          entries,
          issuingDeviceSigningPrivateKey: signing.privateKey,
          recipientEncryptionPublicKey: recipient.publicKey,
        })).rejects.toThrow();
      }
    } finally {
      signing.publicKey.fill(0);
      signing.privateKey.fill(0);
      recipient.publicKey.fill(0);
      recipient.privateKey.fill(0);
    }
  });

  test("rejects noncanonical, truncated, and over-bound public structures", async () => {
    const crypto = new LatticeCrypto(seededRng(290_005));
    const grantPlan = plan(crypto);
    const planBytes = serializeNamespaceAgentGrantPlanV1(grantPlan);
    try {
      expect(parseNamespaceAgentGrantPlanV1(planBytes.slice(0, -1))).toBeNull();
      expect(parseNamespaceAgentGrantPlanV1(
        Uint8Array.from([...planBytes, 0]),
      )).toBeNull();
      expect(() => serializeNamespaceAgentGrantPlanV1(Object.freeze({
        ...grantPlan,
        maximumSecretBytes: NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_BYTES + 1,
      }))).toThrow("byte bound is invalid");
      expect(() => serializeNamespaceAgentGrantPlanV1(Object.freeze({
        ...grantPlan,
        secretEntryCount: grantPlan.secretEntryCount - 1,
      }))).toThrow("plan counts disagree");
      expect(() => createNamespaceAgentGrantPlanV1(crypto, {
        operationId: OPERATION,
        policyRevision: POLICY_REVISION,
        sessionId: SESSION,
        roomId: ROOM,
        subjectHumanId: HUMAN,
        issuingDeviceId: DEVICE,
        issuingDeviceSigningKeyGeneration: 2,
        hostAuthorizationRevision: HOST_AUTHORIZATION_REVISION,
        recipientAgentId: AGENT,
        recipientKeyId: RECIPIENT_KEY,
        operations: Object.freeze(["decrypt"]),
        issuedAt: NOW,
        deadlineAt: NOW + 1,
        maximumSecretBytes: SECRET_BYTE_CEILING,
        authority: Object.freeze(Array.from(
          { length: NAMESPACE_AGENT_GRANT_V1_MAX_NAMESPACES + 1 },
          (_, index) => Object.freeze({
            ...authority()[0]!,
            namespaceId: namespaceId(`namespace_${String(index).padStart(3, "0")}`),
          }),
        )),
      })).toThrow("authority count");
      expect(() => createNamespaceAgentGrantPlanV1(crypto, {
        operationId: OPERATION,
        policyRevision: POLICY_REVISION,
        sessionId: SESSION,
        roomId: ROOM,
        subjectHumanId: HUMAN,
        issuingDeviceId: DEVICE,
        issuingDeviceSigningKeyGeneration: 2,
        hostAuthorizationRevision: HOST_AUTHORIZATION_REVISION,
        recipientAgentId: AGENT,
        recipientKeyId: RECIPIENT_KEY,
        operations: Object.freeze(["decrypt"]),
        issuedAt: NOW,
        deadlineAt: NOW + 1,
        maximumSecretBytes: SECRET_BYTE_CEILING,
        authority: Object.freeze([Object.freeze({
          ...authority()[0]!,
          firstRetainedGeneration: namespaceGeneration(0),
          currentGeneration: namespaceGeneration(
            NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES,
          ),
        })]),
      })).toThrow("retained inventory disagrees");
      const signing = crypto.generateSigningKeyPair();
      const recipient = await crypto.generateEncryptionKeyPair();
      try {
        expect(mintNamespaceAgentGrantV1(crypto, {
          grantId: grantId("grant_m290_tiny_byte_ceiling"),
          plan: Object.freeze({
            ...grantPlan,
            maximumSecretBytes: 1,
          }),
          entries: secretEntries(),
          issuingDeviceSigningPrivateKey: signing.privateKey,
          recipientEncryptionPublicKey: recipient.publicKey,
        })).rejects.toThrow("secret exceeds its plan bound");
        expect(mintNamespaceAgentGrantV1(crypto, {
          grantId: grantId("grant_m290_digest_substitution"),
          plan: Object.freeze({
            ...grantPlan,
            authoritySetDigest: bytes(0xff),
          }),
          entries: secretEntries(),
          issuingDeviceSigningPrivateKey: signing.privateKey,
          recipientEncryptionPublicKey: recipient.publicKey,
        })).rejects.toThrow("authority digest disagrees");
      } finally {
        signing.publicKey.fill(0);
        signing.privateKey.fill(0);
        recipient.publicKey.fill(0);
        recipient.privateKey.fill(0);
      }
    } finally {
      planBytes.fill(0);
    }
  });

  test("fails closed for stale authority, expiry, mutation, and wrong recipient", async () => {
    const crypto = new LatticeCrypto(seededRng(290_004));
    const signing = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    const wrongRecipient = await crypto.generateEncryptionKeyPair();
    const grantPlan = plan(crypto);
    const grant = await mintNamespaceAgentGrantV1(crypto, {
      grantId: grantId("grant_m290_current_authority"),
      plan: grantPlan,
      entries: secretEntries(),
      issuingDeviceSigningPrivateKey: signing.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });
    const grantBytes = serializeNamespaceAgentGrantV1(grant);
    const staleAuthority = authority().map((entry, index) => index === 0
      ? Object.freeze({
          ...entry,
          retainedGenerations: entry.retainedGenerations.map((retained) =>
            Object.freeze({
              ...retained,
              accessRevision: accessRevision(4),
            })
          ),
        })
      : entry);
    const mutation = grantBytes.slice();
    const mutationIndex = Math.floor(mutation.length / 2);
    mutation[mutationIndex] = mutation[mutationIndex]! ^ 1;
    try {
      expect(await withOpenedNamespaceAgentGrantV1(crypto, {
        grantBytes,
        now: NOW + 1,
        current: current(
          signing.publicKey,
          recipient.privateKey,
          staleAuthority,
        ),
        operation: () => undefined,
      })).toEqual({ status: "unavailable", reason: "authority_stale" });
      const canonicalCurrent = current(signing.publicKey, recipient.privateKey);
      const staleCoordinates: readonly NamespaceAgentGrantCurrentAuthorityV1[] = [
        Object.freeze({ ...canonicalCurrent, operationId: "operation_other" }),
        Object.freeze({ ...canonicalCurrent, policyRevision: 4 }),
        Object.freeze({ ...canonicalCurrent, sessionId: "session_other" }),
        Object.freeze({ ...canonicalCurrent, roomId: "room_other" }),
        Object.freeze({
          ...canonicalCurrent,
          subjectHumanId: humanId("human_other"),
        }),
        Object.freeze({
          ...canonicalCurrent,
          issuingDeviceId: cryptoDeviceId("device_other"),
        }),
        Object.freeze({
          ...canonicalCurrent,
          issuingDeviceSigningKeyGeneration: 3,
        }),
        Object.freeze({
          ...canonicalCurrent,
          hostAuthorizationRevision: authorizationRevision(8),
        }),
        Object.freeze({
          ...canonicalCurrent,
          recipientAgentId: agentId("agent_other"),
        }),
        Object.freeze({ ...canonicalCurrent, recipientKeyId: "recipient_other" }),
        Object.freeze({ ...canonicalCurrent, issuingDeviceActive: false }),
        Object.freeze({ ...canonicalCurrent, agentAuthorized: false }),
        Object.freeze({
          ...canonicalCurrent,
          authority: authority().map((entry, index) => index === 0
            ? Object.freeze({
                ...entry,
                retainedGenerations: entry.retainedGenerations.map(
                  (retained, retainedIndex) => retainedIndex === 0
                    ? Object.freeze({
                        ...retained,
                        publicationDigest: bytes(0xf1),
                      })
                    : retained,
                ),
              })
            : entry),
        }),
        Object.freeze({
          ...canonicalCurrent,
          authority: authority().map((entry, index) => index === 0
            ? Object.freeze({
                ...entry,
                retainedGenerations: entry.retainedGenerations.map(
                  (retained, retainedIndex) => retainedIndex === 0
                    ? Object.freeze({
                        ...retained,
                        publicationSetDigest: bytes(0xf2),
                      })
                    : retained,
                ),
              })
            : entry),
        }),
        Object.freeze({
          ...canonicalCurrent,
          authority: authority().map((entry, index) => index === 0
            ? Object.freeze({
                ...entry,
                agentAuthorizationRevision: authorizationRevision(5),
              })
            : entry),
        }),
      ];
      for (const stale of staleCoordinates) {
        expect(await withOpenedNamespaceAgentGrantV1(crypto, {
          grantBytes,
          now: NOW + 1,
          current: stale,
          operation: () => undefined,
        })).toEqual({ status: "unavailable", reason: "authority_stale" });
      }
      expect(await withOpenedNamespaceAgentGrantV1(crypto, {
        grantBytes,
        now: NOW + 1,
        current: Object.freeze({
          ...canonicalCurrent,
          hostAllowsOperation: false,
        }),
        operation: () => undefined,
      })).toEqual({ status: "unavailable", reason: "operation_denied" });
      expect(await withOpenedNamespaceAgentGrantV1(crypto, {
        grantBytes,
        now: NOW + 30_000,
        current: current(signing.publicKey, recipient.privateKey),
        operation: () => undefined,
      })).toEqual({ status: "unavailable", reason: "expired" });
      expect(await withOpenedNamespaceAgentGrantV1(crypto, {
        grantBytes: mutation,
        now: NOW + 1,
        current: current(signing.publicKey, recipient.privateKey),
        operation: () => undefined,
      })).toEqual({ status: "unavailable", reason: "invalid" });
      expect(await withOpenedNamespaceAgentGrantV1(crypto, {
        grantBytes,
        now: NOW + 1,
        current: current(signing.publicKey, wrongRecipient.privateKey),
        operation: () => undefined,
      })).toEqual({ status: "unavailable", reason: "secret_unavailable" });
    } finally {
      mutation.fill(0);
      grantBytes.fill(0);
      destroyNamespaceAgentGrantV1(grant);
      signing.publicKey.fill(0);
      signing.privateKey.fill(0);
      recipient.publicKey.fill(0);
      recipient.privateKey.fill(0);
      wrongRecipient.publicKey.fill(0);
      wrongRecipient.privateKey.fill(0);
    }
  });
});
