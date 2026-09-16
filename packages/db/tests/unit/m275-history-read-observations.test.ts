import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  consumeServerUnavailableEncryptionTransitionHistoryReadAdmission,
  consumeIneligibleEncryptionTransitionHistoryReadAdmission,
  consumeSignedEncryptionTransitionHistoryReadAcknowledgement,
  issueEncryptionTransitionHistoryReadAdmission,
} from "../../src/utils/encryption-transition-observations";

const SOURCE = readFileSync(new URL(
  "../../src/utils/encryption-transition-observations.ts",
  import.meta.url,
), "utf8");

const PLAN = {
  clientRequestKey: "request-alpha",
  subjectHumanId: "human-alpha",
  readerDeviceId: "device-alpha",
  readerDeviceSigningKeyGeneration: 2,
  hostAuthorizationRevision: 4,
  roomId: "22222222-2222-4222-8222-222222222222",
  selectedCoordinateDigest: new Uint8Array(32).fill(1),
  selectedCount: 4,
  eligibleCount: 2,
  issuedAt: new Date("2026-08-23T12:00:00.000Z"),
  expiresAt: new Date("2026-08-23T12:01:00.000Z"),
} as const;

describe("M275 history-read admission workflow", () => {
  test("admits both protected epochs without promoting Full authentication to parity", () => {
    const policyGuard = SOURCE.slice(
      SOURCE.indexOf("async function loadLockedProtectedEpochPolicy"),
      SOURCE.indexOf("async function recordObservationInTransaction"),
    );
    expect(policyGuard).toContain('mode !== "shadow_encryption" && mode !== "encrypted_only"');
    expect(policyGuard).toContain("policy.shadowEncryptionStartedAt === null");

    const historyProjection = SOURCE.slice(
      SOURCE.indexOf("async function projectHistoryReadCountsInTransaction"),
      SOURCE.indexOf("export async function issueEncryptionTransitionHistoryReadAdmission"),
    );
    expect(historyProjection).toContain(
      '{ count: input.counts.verified, outcome: "verified", reason: "none" }',
    );
    expect(historyProjection).not.toContain("client_authenticated");
    expect(historyProjection).not.toContain("server_authenticated");
  });

  test("requires nullable planned device authority coordinates to move together", async () => {
    let transactions = 0;
    const db = { transaction: () => { transactions += 1; } } as never;
    expect(issueEncryptionTransitionHistoryReadAdmission(db, {
      ...PLAN,
      readerDeviceId: null,
    })).rejects.toThrow("coordinates are incomplete");
    expect(transactions).toBe(0);
    expect(issueEncryptionTransitionHistoryReadAdmission(db, {
      ...PLAN,
      readerDeviceId: null,
      readerDeviceSigningKeyGeneration: null,
      hostAuthorizationRevision: null,
    })).resolves.toBeUndefined();
    // The complete all-null shape passed local validation and reached the fake DB.
    expect(transactions).toBe(1);
  });

  test("rejects signed count non-closure before PostgreSQL", async () => {
    let transactions = 0;
    const db = { transaction: () => { transactions += 1; } } as never;
    expect(consumeSignedEncryptionTransitionHistoryReadAcknowledgement(
      db,
      {
        token: new Uint8Array(32),
        operationId: "operation-alpha",
        clientRequestKey: PLAN.clientRequestKey,
        policyRevision: 9,
        subjectHumanId: PLAN.subjectHumanId,
        readerDeviceId: PLAN.readerDeviceId,
        readerDeviceSigningKeyGeneration: 2,
        hostAuthorizationRevision: 4,
        roomId: PLAN.roomId,
        selectedCoordinateDigest: PLAN.selectedCoordinateDigest,
        selectedCount: PLAN.selectedCount,
        eligibleCount: 2,
        counts: {
          verified: 1,
          clientCryptoUnavailable: 0,
          clientCustodyUnavailable: 0,
          currentReadAuthorityUnavailable: 0,
          retainedKeyMaterialUnavailable: 0,
          signerEvidenceUnavailable: 0,
          liveShadowLifecycleUnavailable: 0,
          integrityFailure: 0,
          parityMismatch: 0,
        },
        acknowledgementDigest: new Uint8Array(32),
        orderedResultSetDigest: new Uint8Array(32),
        issuedAt: PLAN.issuedAt,
        deadlineAt: PLAN.expiresAt,
        observedAt: new Date("2026-08-23T12:00:30.000Z"),
      },
    )).rejects.toThrow("do not close");
    expect(transactions).toBe(0);
  });

  test("server direct consumption has a closed unavailable-only allowlist", async () => {
    let transactions = 0;
    const db = { transaction: () => { transactions += 1; } } as never;
    expect(() => consumeServerUnavailableEncryptionTransitionHistoryReadAdmission(
      db, {
        token: new Uint8Array(32),
        operationId: "operation-alpha",
        clientRequestKey: PLAN.clientRequestKey,
        policyRevision: 9,
        subjectHumanId: PLAN.subjectHumanId,
        readerDeviceId: null,
        readerDeviceSigningKeyGeneration: null,
        hostAuthorizationRevision: null,
        roomId: PLAN.roomId,
        selectedCoordinateDigest: PLAN.selectedCoordinateDigest,
        selectedCount: PLAN.selectedCount,
        eligibleCount: 2,
        issuedAt: PLAN.issuedAt,
        deadlineAt: PLAN.expiresAt,
        observedAt: new Date("2026-08-23T12:00:30.000Z"),
        reason: "parity_mismatch",
      } as never,
    )).toThrow("reason is invalid");
    expect(transactions).toBe(0);
  });

  test("records a selected page with zero eligible protected siblings", async () => {
    let transactions = 0;
    const db = { transaction: () => { transactions += 1; } } as never;
    expect(consumeIneligibleEncryptionTransitionHistoryReadAdmission(db, {
      token: new Uint8Array(32),
      operationId: "operation-ineligible",
      clientRequestKey: PLAN.clientRequestKey,
      policyRevision: 9,
      subjectHumanId: PLAN.subjectHumanId,
      readerDeviceId: null,
      readerDeviceSigningKeyGeneration: null,
      hostAuthorizationRevision: null,
      roomId: PLAN.roomId,
      selectedCoordinateDigest: PLAN.selectedCoordinateDigest,
      selectedCount: PLAN.selectedCount,
      eligibleCount: 0,
      issuedAt: PLAN.issuedAt,
      deadlineAt: PLAN.expiresAt,
      observedAt: new Date("2026-08-23T12:00:30.000Z"),
    })).resolves.toBeUndefined();
    expect(transactions).toBe(1);
  });

  test("rotates only a planned token and never returns a fabricated terminal token", () => {
    const terminal = SOURCE.slice(
      SOURCE.indexOf('if (existing.state !== "planned"'),
      SOURCE.indexOf("await tx.update(encryptionTransitionHistoryReadAdmissions)",
        SOURCE.indexOf('if (existing.state !== "planned"')),
    );
    expect(terminal).toContain("token.fill(0)");
    expect(terminal).toContain('status: "terminal"');
    expect(terminal).not.toContain("token,");
    expect(SOURCE).toContain('status: "planned" as const');
    expect(SOURCE).toContain("tokenDigest,");
  });

  test("terminalizes before aggregate projection and recognizes exact replay first", () => {
    const consume = SOURCE.slice(
      SOURCE.indexOf("async function consumeHistoryReadAdmission"),
      SOURCE.indexOf("export function consumeSignedEncryptionTransitionHistoryReadAcknowledgement"),
    );
    const replay = consume.indexOf("terminalReplayMatches");
    const terminalUpdate = consume.indexOf(
      "tx.update(encryptionTransitionHistoryReadAdmissions)",
    );
    const projection = consume.indexOf("projectHistoryReadCountsInTransaction");
    expect(replay).toBeGreaterThan(-1);
    expect(replay).toBeLessThan(terminalUpdate);
    expect(terminalUpdate).toBeLessThan(projection);
    expect(consume).toContain('? { status: "replayed" as const }');
    expect(consume).toContain('eq(encryptionTransitionHistoryReadAdmissions.state, "planned")');
  });
});
