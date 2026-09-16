import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  prepareHumanMemoryReadAcknowledgementV1,
  verifyHumanMemoryReadAcknowledgementV1,
} from "../../src/memory/human-memory-read-acknowledgement.ts";
import { createObservedHumanMemoryDeviceContent } from
  "../../src/client/memory/observed-human-memory-device-content.ts";

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";

describe("Human Memory read observation acknowledgement", () => {
  test("returns authenticated content before transport and settles every page observation", async () => {
    const crypto = new LatticeCrypto();
    const signer = crypto.generateSigningKeyPair();
    let resolveTransport!: () => void;
    const transport = new Promise<void>((resolve) => { resolveTransport = resolve; });
    let resolveObserved!: () => void;
    const observed = new Promise<void>((resolve) => { resolveObserved = resolve; });
    let signingAuthorityOpen = false;
    let observedAfterAuthorityClosed = false;
    let observationCount = 0;
    const dto = {
      dtoVersion: 1 as const,
      projection: { memoryId: MEMORY_ID, contentRevision: 3,
        cryptoAccessRevision: 1, importance: 0.5, tier: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:01.000Z", namespaceIds: [],
        requiredNamespaceIds: [], readAuthorities: [] },
      protectedPayload: { status: "encrypted" as const,
        cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:3`, payloadVersion: 1 as const,
        encryptedPayloadBytesBase64url: "YWJj", accessManifestBytesBase64url: "ZGVm",
        accessSignerEvidence: [], namespaceEnvelopes: [] },
      readObservationAdmission: { tokenBase64url: "A".repeat(43),
        policyRevision: 2, issuedAt: 1, expiresAt: 2 },
    };
    const content = createObservedHumanMemoryDeviceContent({ crypto,
      content: {
        prepareAccessReadiness: async () => undefined,
        openExact: async () => new TextEncoder().encode("opened"),
        prepareCreate: async () => { throw new Error("unused"); },
        prepareUpdate: async () => { throw new Error("unused"); },
        prepareAccess: async () => { throw new Error("unused"); },
      },
      async withSigningAuthority(_dto, use) {
        signingAuthorityOpen = true;
        try { return await use({ subjectHumanId: "human:1", readerDeviceId: "device:1",
          readerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: 1,
          signingPrivateKey: signer.privateKey, signingPublicKey: signer.publicKey }); }
        finally { signingAuthorityOpen = false; }
      },
      async observe() {
        observationCount += 1;
        observedAfterAuthorityClosed = !signingAuthorityOpen;
        resolveObserved();
        await transport;
      },
    });
    const undecoded = content.beginObservationScope();
    expect(new TextDecoder().decode(await undecoded.content.openExact(dto))).toBe("opened");
    await undecoded.settle();
    expect(observationCount).toBe(0);

    const scope = content.beginObservationScope();
    expect(new TextDecoder().decode(await scope.content.openExact(dto))).toBe("opened");
    scope.verified(dto);
    expect(new TextDecoder().decode(await scope.content.openExact(dto))).toBe("opened");
    scope.verified(dto);
    await observed;
    expect(observedAfterAuthorityClosed).toBe(true);
    let settled = false;
    void scope.settle().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveTransport();
    await scope.settle();
    expect(observationCount).toBe(2);
    expect(settled).toBe(true);
  });

  test("binds the exact read coordinates and rejects tampering", () => {
    const crypto = new LatticeCrypto({
      bytes: (length) => new Uint8Array(length).fill(7),
    });
    const signer = crypto.generateSigningKeyPair();
    const bytes = prepareHumanMemoryReadAcknowledgementV1(crypto, {
      formatVersion: 1,
      purpose: "memory.read_acknowledgement",
      observationToken: new Uint8Array(32).fill(3),
      policyRevision: 9,
      subjectHumanId: "human:1",
      readerDeviceId: "device:1",
      readerDeviceSigningKeyGeneration: 2,
      hostAuthorizationRevision: 4,
      memoryId: MEMORY_ID,
      cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:3`,
      contentRevision: 3,
      cryptoAccessRevision: 5,
      outcome: "verified",
      reason: "none",
      issuedAt: 1_000,
      deadlineAt: 2_000,
      signingPrivateKey: signer.privateKey,
      signingPublicKey: signer.publicKey,
    });
    const verified = verifyHumanMemoryReadAcknowledgementV1(crypto, {
      bytes,
      now: 1_500,
      resolveSigningPublicKey: () => signer.publicKey.slice(),
    });
    expect(verified).toMatchObject({ policyRevision: 9, memoryId: MEMORY_ID,
      contentRevision: 3, cryptoAccessRevision: 5, outcome: "verified" });

    const raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown[];
    raw[11] = 4;
    const tampered = new TextEncoder().encode(JSON.stringify(raw));
    expect(() => verifyHumanMemoryReadAcknowledgementV1(crypto, {
      bytes: tampered,
      now: 1_500,
      resolveSigningPublicKey: () => signer.publicKey.slice(),
    })).toThrow();
  });

  test("rejects an acknowledgement lifetime beyond the established read bound", () => {
    const crypto = new LatticeCrypto();
    const signer = crypto.generateSigningKeyPair();
    expect(() => prepareHumanMemoryReadAcknowledgementV1(crypto, {
      formatVersion: 1, purpose: "memory.read_acknowledgement",
      observationToken: new Uint8Array(32), policyRevision: 1,
      subjectHumanId: "human:1", readerDeviceId: "device:1",
      readerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: 0,
      memoryId: MEMORY_ID, cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:1`,
      contentRevision: 1, cryptoAccessRevision: 0,
      outcome: "failed", reason: "integrity_failure",
      issuedAt: 1, deadlineAt: 120_002,
      signingPrivateKey: signer.privateKey, signingPublicKey: signer.publicKey,
    })).toThrow("invalid");
  });

  test("accepts only the existing read-unavailable vocabulary", () => {
    const crypto = new LatticeCrypto();
    const signer = crypto.generateSigningKeyPair();
    for (const reason of ["client_crypto_unavailable",
      "current_read_authority_unavailable",
      "retained_key_material_unavailable"] as const) {
      const acknowledgement = prepareHumanMemoryReadAcknowledgementV1(crypto, {
        formatVersion: 1, purpose: "memory.read_acknowledgement",
        observationToken: new Uint8Array(32), policyRevision: 1,
        subjectHumanId: "human:1", readerDeviceId: "device:1",
        readerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: 0,
        memoryId: MEMORY_ID,
        cryptoObjectId: `nautilo-memory-v1:${MEMORY_ID}:1`,
        contentRevision: 1, cryptoAccessRevision: 0,
        outcome: "unavailable", reason, issuedAt: 1, deadlineAt: 2,
        signingPrivateKey: signer.privateKey, signingPublicKey: signer.publicKey,
      });
      expect(verifyHumanMemoryReadAcknowledgementV1(crypto, {
        bytes: acknowledgement, now: 1,
        resolveSigningPublicKey: () => signer.publicKey.slice(),
      }).reason).toBe(reason);
    }
  });

});
