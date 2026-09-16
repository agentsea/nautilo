import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { encryptionTransitionPolicy, groupMembers, roomMembers, rooms, type SQL } from "@nautilo/db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { HumanMemoryPublicationBoundary, PostgresHumanMemoryAuthorityResolver } from "@nautilo/lattice-bridge/server";
import { createHumanMemoryPublicationAuthority } from "../../src/routes/human-memory-publication-authority";

const envelope: MemoryAccessEnvelope = {
  ownerId: "user", actorId: "actor", agentId: "context-agent", roomId: "room",
  readableNamespaces: ["namespace"], mutableNamespaces: ["namespace"],
  writableNamespaces: ["namespace"], toolPolicy: {},
};
const authority = { userId: "user", mutableNamespaceIds: ["namespace"], writableNamespaceIds: ["namespace"] };
type Transaction = Parameters<HumanMemoryPublicationBoundary["fence"]>[0]["transaction"];
function fixture(revision = 5) {
  const events: string[] = [];
  const dialect = new PgDialect();
  const tx = {
    execute: async (statement: SQL) => { events.push(dialect.sqlToQuery(statement).sql); return []; },
    select: () => ({ from: (table: unknown) => {
      events.push(table === encryptionTransitionPolicy ? "policy" : "product");
      const rows = table === encryptionTransitionPolicy ? [{ mode: "encrypted_only", revision }]
        : table === rooms ? [{ id: "room", namespaceId: "namespace", archivedAt: null, humanActorIds: [] }]
        : table === roomMembers ? [{ actorId: "actor", kind: "user", ownerId: "user", agentId: null }]
        : table === groupMembers ? [{ slug: "read_memories" }, { slug: "manage_memories" }]
        : [{ publicRoomId: null }];
      const query = {
        where: () => query, orderBy: () => query, innerJoin: () => query, leftJoin: () => query,
        for: () => Promise.resolve(rows),
        then: <A = typeof rows, B = never>(yes?: ((value: typeof rows) => A | PromiseLike<A>) | null,
          no?: ((error: unknown) => B | PromiseLike<B>) | null) => Promise.resolve(rows).then(yes, no),
      };
      return query;
    } }),
  };
  return { transaction: tx as unknown as Transaction, events };
}
const policy = { mode: "encrypted_only", shadowBehavior: "strict", revision: 5 } as const;
const unusedCrypto: Pick<PostgresHumanMemoryAuthorityResolver,
  "withCurrentWriteAuthority" | "withCurrentOrdinaryWriteAuthority"> = {
  withCurrentWriteAuthority: async () => { throw new Error("No crypto lock expected"); },
  withCurrentOrdinaryWriteAuthority: async () => { throw new Error("No ordinary device lock expected"); },
};

describe("Human Memory canonical publication policy", () => {
  test("preserves Full/Shadow representation without requiring an Agent in the Human's room", async () => {
    const { transaction, events } = fixture();
    const boundary = createHumanMemoryPublicationAuthority({ envelope, policy, cryptoAuthority: unusedCrypto });
    expect(boundary.representation).toBe("protected_only");
    await boundary.fence({ transaction, authority, mutation: true });
    expect(events[0]).toContain("pg_advisory_xact_lock_shared");
    expect(events[1]).toBe("policy");
    expect(events[2]).toContain("FOR UPDATE");
    expect(createHumanMemoryPublicationAuthority({ envelope,
      policy: { ...policy, mode: "shadow_encryption" }, cryptoAuthority: unusedCrypto,
    }).representation).toBe("ordinary_and_protected");
  });
  test("rejects substituted Human or Namespace authority before storage; stale policy before product locks", async () => {
    const boundary = createHumanMemoryPublicationAuthority({ envelope, policy, cryptoAuthority: unusedCrypto });
    for (const changed of [{ ...authority, userId: "other" },
      { ...authority, mutableNamespaceIds: ["other"] }, { ...authority, writableNamespaceIds: ["other"] }]) {
      const { transaction, events } = fixture();
      expect(await boundary.fence({ transaction, authority: changed, mutation: true })
        .catch((error: unknown) => error)).toMatchObject({ reason: "memory_unavailable" });
      expect(events).toEqual([]);
    }
    const { transaction, events } = fixture(6);
    const failure = await boundary.fence({ transaction, authority, mutation: true })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("revision 5 is stale");
    expect(events).toHaveLength(2);
  });
  test("does not activate crypto publication for Plaintext or deferred scopes", () => {
    expect(() => createHumanMemoryPublicationAuthority({ envelope,
      policy: { ...policy, mode: "plaintext_only" }, cryptoAuthority: unusedCrypto,
    })).toThrow("ordinary publication path");
    expect(() => createHumanMemoryPublicationAuthority({
      envelope: { memoryMode: "scope", ownerId: "user", actorId: "actor", agentId: "context-agent",
        roomId: "room", scopeId: "scope", toolPolicy: {} }, policy, cryptoAuthority: unusedCrypto,
    })).toThrow("memory_unavailable");
  });
  test("ordinary publication fallback is allowed only by Fallback Shadow", () => {
    for (const selected of [
      { mode: "shadow_encryption", shadowBehavior: "fallback", expected: true },
      { mode: "shadow_encryption", shadowBehavior: "strict", expected: false },
      { mode: "encrypted_only", shadowBehavior: "fallback", expected: false },
    ] as const) {
      const boundary = createHumanMemoryPublicationAuthority({ envelope,
        policy: { mode: selected.mode, shadowBehavior: selected.shadowBehavior,
          revision: policy.revision }, cryptoAuthority: unusedCrypto });
      expect(boundary.allowOrdinaryFallback).toBe(selected.expected);
    }
  });
  test("signed ordinary publication rejects Full, Strict, changed policy and substituted authority before device locks", async () => {
    const signed = { subjectHumanId: "human", committerDeviceId: "device",
      committerDeviceSigningKeyGeneration: 2, hostAuthorizationRevision: 3,
      policyRevision: 5 };
    for (const selected of [
      { mode: "encrypted_only", shadowBehavior: "fallback", revision: 5 },
      { mode: "shadow_encryption", shadowBehavior: "strict", revision: 5 },
      { mode: "shadow_encryption", shadowBehavior: "fallback", revision: 6 },
    ] as const) {
      const boundary = createHumanMemoryPublicationAuthority({ envelope,
        policy: selected, cryptoAuthority: unusedCrypto });
      expect(await boundary.withOrdinaryLocks({ authority,
        authenticatedAuthority: signed }, async () => "must not publish")
        .catch((error: unknown) => error)).toMatchObject({ reason: "memory_unavailable" });
    }
    const boundary = createHumanMemoryPublicationAuthority({ envelope,
      policy: { mode: "shadow_encryption", shadowBehavior: "fallback", revision: 5 },
      cryptoAuthority: unusedCrypto });
    expect(await boundary.withOrdinaryLocks({ authority: { ...authority, userId: "other" },
      authenticatedAuthority: signed }, async () => "must not publish")
      .catch((error: unknown) => error)).toMatchObject({ reason: "memory_unavailable" });
  });
  test("ordinary publication delegates exact device coordinates and keeps lazy lock order", async () => {
    const events: string[] = [];
    const signed = { subjectHumanId: "human", committerDeviceId: "device",
      committerDeviceSigningKeyGeneration: 2, hostAuthorizationRevision: 3,
      policyRevision: 5 };
    const boundary = createHumanMemoryPublicationAuthority({ envelope,
      policy: { mode: "shadow_encryption", shadowBehavior: "fallback", revision: 5 },
      cryptoAuthority: { ...unusedCrypto,
        async withCurrentOrdinaryWriteAuthority(input, publish) {
          expect(input).toEqual({ subjectUserId: "user", humanActorId: "actor", context: signed });
          events.push("authority transaction");
          const result = await publish(async () => { events.push("device lock"); });
          events.push("authority released");
          return result;
        },
      } });
    expect(await boundary.withOrdinaryLocks({ authority, authenticatedAuthority: signed },
      async (lockDeviceAuthority) => {
        events.push("policy fence");
        await lockDeviceAuthority();
        events.push("product commit");
        return "saved";
      })).toBe("saved");
    expect(events).toEqual(["authority transaction", "policy fence", "device lock",
      "product commit", "authority released"]);
  });
});
