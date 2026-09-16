import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  publishHumanDeviceOrdinaryRepairV2,
} from "../../src/server/message/human-device-ordinary-repair-attestation.ts";
import { prepareHumanDeviceOrdinaryRepairAttestationV2 } from
  "../../src/message/human-device-ordinary-repair-attestation-v2.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const ROOM_ID = "33333333-3333-4333-8333-333333333333";
const NAMESPACE_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";

describe("Human device ordinary repair attestation V2", () => {
  test("holds current device authority through the exact Human repair CAS", async () => {
    const crypto = new LatticeCrypto();
    const signing = crypto.generateSigningKeyPair();
    let locked = false;
    let publishedWhileLocked = false;
    let captured: unknown;
    let lockStatement = "";
    const restricted = {
      query: async () => [],
      transaction: async () => { throw new Error("unexpected retrying transaction"); },
      transactionOnce: async (callback: (tx: { query: () => Promise<unknown[]> }) => Promise<unknown>) => {
        locked = true;
        try {
          return await callback({ query: async (statement?: string) => {
            lockStatement = statement ?? "";
            return [{ signing_public_key: signing.publicKey }];
          } });
        } finally {
          locked = false;
        }
      },
    };
    const payload = Object.freeze({ role: "user" as const, content: "opened only on device" });
    const attestation = prepareHumanDeviceOrdinaryRepairAttestationV2(crypto, {
      operationId: "history:1",
      policyRevision: 7,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: "browser:device-1",
      readerDeviceSigningKeyGeneration: 3,
      hostAuthorizationRevision: 9,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 4,
      namespaceKeyGeneration: 6,
      sessionId: SESSION_ID,
      messageId: 12,
      editRevision: 0,
      cryptoObjectId: "message:12:0",
      authorRole: "user",
      createdAt: 1_700_000_000_000,
      issuedAt: 1_700_000_000_000,
      deadlineAt: 1_700_000_060_000,
      payload,
      signingPrivateKey: signing.privateKey,
    });
    const result = await publishHumanDeviceOrdinaryRepairV2({
      crypto,
      restricted: restricted as never,
      product: {
        restoreOrdinaryExistingRepresentation: async (input) => {
          publishedWhileLocked = locked;
          captured = input;
          return "applied";
        },
      },
      authority: { userId: USER_ID, humanActorId: HUMAN_ID },
      attestation,
      payload,
      now: 1_700_000_001_000,
    });
    expect(result).toBe("applied");
    expect(publishedWhileLocked).toBe(true);
    expect(lockStatement.toLowerCase()).toContain("for share of");
    expect(lockStatement).toContain("human_crypto_devices");
    expect(lockStatement).toContain("human_crypto_custodies");
    expect(captured).toMatchObject({
      expectedKeyClass: "human",
      content: "opened only on device",
      publisher: { kind: "device_attested", id: "browser:device-1" },
      publicationPolicy: { expectedRevision: 7, representation: "ordinary_and_protected" },
    });
  });

  test("rejects plaintext, coordinate, signature, stale-time, and missing-current-authority substitutions", async () => {
    const crypto = new LatticeCrypto();
    const signing = crypto.generateSigningKeyPair();
    const base = {
      operationId: "history:1", policyRevision: 7, subjectHumanId: HUMAN_ID,
      readerDeviceId: "browser:device-1", readerDeviceSigningKeyGeneration: 3,
      hostAuthorizationRevision: 9, roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 4, namespaceKeyGeneration: 6, sessionId: SESSION_ID,
      messageId: 12, editRevision: 0, cryptoObjectId: "message:12:0",
      authorRole: "user" as const, createdAt: 1_700_000_000_000,
      issuedAt: 1_700_000_000_000, deadlineAt: 1_700_000_060_000,
      payload: { role: "user" as const, content: "opened" },
      signingPrivateKey: signing.privateKey,
    };
    const attestation = prepareHumanDeviceOrdinaryRepairAttestationV2(crypto, base);
    let calls = 0;
    const invoke = (patch: Partial<typeof attestation> = {}, content = "opened", key = signing.publicKey) =>
      publishHumanDeviceOrdinaryRepairV2({
        crypto,
        restricted: {
          query: async () => [], transaction: async () => null,
          transactionOnce: async (callback: (tx: { query: () => Promise<unknown[]> }) => Promise<unknown>) =>
            callback({ query: async () => key.length === 0 ? [] : [{ signing_public_key: key }] }),
        } as never,
        product: { restoreOrdinaryExistingRepresentation: async () => { calls++; return "applied"; } },
        authority: { userId: USER_ID, humanActorId: HUMAN_ID },
        attestation: Object.freeze({ ...attestation, ...patch }),
        payload: { role: "user", content },
        now: 1_700_000_001_000,
      });
    expect(await invoke({}, "substituted")).toBe("unauthorized");
    expect(await invoke({ messageId: 13 })).toBe("unauthorized");
    expect(await invoke({ signature: new Uint8Array(attestation.signature.length) })).toBe("unauthorized");
    expect(await invoke({ deadlineAt: 1_700_000_000_500 })).toBe("unauthorized");
    expect(await invoke({ namespaceKeyGeneration: Number.MAX_SAFE_INTEGER + 1 })).toBe("unauthorized");
    expect(await invoke({ policyRevision: 0 })).toBe("unauthorized");
    expect(await invoke({}, "opened", new Uint8Array())).toBe("unauthorized");
    expect(calls).toBe(0);
  });
});

describe("class-bound Human device ordinary repair V3", () => {
  test.each(["human", "ai"] as const)("restores every canonical role and rejects class substitution: %s", async (keyClass) => {
    const { prepareHumanDeviceOrdinaryRepairAttestationV3 } = await import(
      "../../src/message/human-device-ordinary-repair-attestation-v2.ts");
    const crypto = new LatticeCrypto();
    const signing = crypto.generateSigningKeyPair();
    for (const role of ["user", "assistant", "tool", "system"] as const) {
      const payload = { role, content: "authenticated body", ...(role === "system"
        ? { sensitiveMetadata: { reason: "context compaction" } } : {}) };
      const attestation = prepareHumanDeviceOrdinaryRepairAttestationV3(crypto, {
        keyClass, operationId: "history:1", policyRevision: 7, subjectHumanId: HUMAN_ID,
        readerDeviceId: "browser:device-1", readerDeviceSigningKeyGeneration: 3,
        hostAuthorizationRevision: 9, roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
        namespaceAccessRevision: 4, namespaceKeyGeneration: 6, sessionId: SESSION_ID,
        messageId: 12, editRevision: 0, cryptoObjectId: "message:12:0", authorRole: role,
        createdAt: 1_700_000_000_000, issuedAt: 1_700_000_000_000,
        deadlineAt: 1_700_000_060_000, payload, signingPrivateKey: signing.privateKey,
      });
      let captured: unknown;
      const invoke = (value = attestation) => publishHumanDeviceOrdinaryRepairV2({
        crypto, restricted: {
          transactionOnce: (use: (tx: unknown) => Promise<unknown>) => use({
            query: async () => [{ signing_public_key: signing.publicKey }],
          }),
        } as never,
        product: { restoreOrdinaryExistingRepresentation: async (input) => {
          captured = input; return "applied";
        } }, authority: { userId: USER_ID, humanActorId: HUMAN_ID },
        attestation: value, payload, now: 1_700_000_001_000,
        currentNamespaceAccessRevision: 10,
      });
      expect(await invoke()).toBe("applied");
      expect(captured).toMatchObject({ expectedKeyClass: keyClass,
        expectedNamespaceAccessRevision: 4, currentNamespaceAccessRevision: 10,
        expectedNamespaceKeyGeneration: 6, expectedAuthorRole: role,
        toolCalls: role === "system" ? JSON.stringify(payload.sensitiveMetadata) : null });
      captured = undefined;
      expect(await invoke({ ...attestation, keyClass: keyClass === "human" ? "ai" : "human" })).toBe("unauthorized");
      expect(captured).toBeUndefined();
    }
  });
});
