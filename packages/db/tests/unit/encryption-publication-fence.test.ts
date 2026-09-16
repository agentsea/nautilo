import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  acquireEncryptionPublicationFence,
  acquireEncryptionConsumptionFence,
  acquireOrdinaryEncryptionPublicationFence,
  EncryptionPublicationPolicyError,
  EncryptionTransitionPolicyConflictError,
  UnsupportedEncryptionTransitionStateError,
} from "../../src/utils/encryption-transition-queries";

function fixture(mode: string, revision = 7, shadowBehavior = "fallback") {
  const calls: string[] = [];
  const tx = {
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      calls.push(new PgDialect().sqlToQuery(query).sql);
      return [];
    },
    select: () => {
      calls.push("select-policy");
      return { from: () => ({ where: async () => [{ mode, revision, shadowBehavior }] }) };
    },
  } as unknown as Parameters<typeof acquireEncryptionPublicationFence>[0];
  return { tx, calls };
}

describe("encryption publication transaction fence", () => {
  test("holds the shared policy lock before exposing the exact consumption policy", async () => {
    const { tx, calls } = fixture("shadow_encryption", 9, "strict");
    expect(await acquireEncryptionConsumptionFence(tx)).toEqual({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      revision: 9,
    });
    expect(calls).toEqual([
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('nautilo:encryption-transition-policy:v1', 0))",
      "select-policy",
    ]);
  });
  test("takes the shared transaction lock before reading current policy", async () => {
    const { tx, calls } = fixture("encrypted_only");
    await acquireEncryptionPublicationFence(tx, {
      expectedRevision: 7, representation: "protected_only",
    });
    expect(calls).toEqual([
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('nautilo:encryption-transition-policy:v1', 0))",
      "select-policy",
    ]);
  });

  test("current-policy ordinary gate allows plaintext/Shadow and rejects Full", async () => {
    for (const mode of ["plaintext_only", "shadow_encryption"]) {
      const { tx, calls } = fixture(mode);
      await acquireOrdinaryEncryptionPublicationFence(tx);
      expect(calls).toHaveLength(2);
    }
    const rejection = await acquireOrdinaryEncryptionPublicationFence(
      fixture("encrypted_only").tx,
    ).then(() => undefined, (error: unknown) => error);
    expect(rejection).toEqual(
      new EncryptionPublicationPolicyError("ordinary_forbidden"),
    );
  });

  test("Full rejects any publication retaining ordinary content", async () => {
    for (const representation of ["ordinary", "ordinary_and_protected"] as const) {
      expect(acquireEncryptionPublicationFence(fixture("encrypted_only").tx, {
        expectedRevision: 7, representation,
      })).rejects.toEqual(new EncryptionPublicationPolicyError("ordinary_forbidden"));
    }
  });

  test("Plaintext forbids protected publications; Shadow admits either representation", async () => {
    for (const representation of ["protected_only", "ordinary_and_protected"] as const) {
      expect(acquireEncryptionPublicationFence(fixture("plaintext_only").tx, {
        expectedRevision: 7, representation,
      })).rejects.toEqual(new EncryptionPublicationPolicyError("crypto_forbidden"));
    }
    for (const representation of ["ordinary", "protected_only", "ordinary_and_protected"] as const) {
      await acquireEncryptionPublicationFence(fixture("shadow_encryption").tx, {
        expectedRevision: 7, representation,
      });
    }
    await acquireEncryptionPublicationFence(fixture("plaintext_only").tx, {
      expectedRevision: 7, representation: "ordinary",
    });
  });

  test("a stale preparation cannot publish even when its representation remains permitted", async () => {
    expect(acquireEncryptionPublicationFence(fixture("encrypted_only", 8).tx, {
      expectedRevision: 7, representation: "protected_only",
    })).rejects.toEqual(new EncryptionTransitionPolicyConflictError(7, 8));
  });

  test("unknown policy and malformed revision fail closed", async () => {
    expect(acquireEncryptionPublicationFence(fixture("corrupt").tx, {
      expectedRevision: 7, representation: "protected_only",
    })).rejects.toBeInstanceOf(UnsupportedEncryptionTransitionStateError);
    for (const expectedRevision of [-1, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const { tx, calls } = fixture("encrypted_only");
      expect(acquireEncryptionPublicationFence(tx, {
        expectedRevision, representation: "protected_only",
      })).rejects.toBeInstanceOf(TypeError);
      expect(calls).toEqual([]);
    }
  });
});
