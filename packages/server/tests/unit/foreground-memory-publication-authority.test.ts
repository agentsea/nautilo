import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { encryptionTransitionPolicy, groupMembers, roomMembers, rooms, type SQL } from "@nautilo/db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { AgentMemoryPublicationBoundary } from "@nautilo/lattice-bridge/server";
import { createForegroundMemoryPublicationAuthority } from "../../src/routes/foreground-memory-publication-authority";

const envelope: MemoryAccessEnvelope = {
  ownerId: "human", actorId: "human-actor", agentId: "agent", roomId: "room",
  readableNamespaces: ["namespace"], mutableNamespaces: ["namespace"],
  writableNamespaces: ["namespace"], toolPolicy: {},
};
const authority = {
  mode: "namespace" as const, subjectUserId: "human", agentId: "agent",
  readableNamespaceIds: ["namespace"], mutableNamespaceIds: ["namespace"],
  writableNamespaceId: "namespace",
};
type Transaction = Parameters<AgentMemoryPublicationBoundary["beforeLocks"]>[0]["transaction"];
function fixture(options: { mode?: string; revision?: number; denied?: boolean } = {}) {
  const events: string[] = [];
  const dialect = new PgDialect();
  const tx = {
    execute: async (statement: SQL) => {
      events.push(dialect.sqlToQuery(statement).sql);
      return [];
    },
    select: () => ({ from: (table: unknown) => {
      events.push(table === encryptionTransitionPolicy ? "policy" : "product-read");
      const rows = table === encryptionTransitionPolicy ? [{ mode: options.mode ?? "encrypted_only", revision: options.revision ?? 7 }]
        : table === rooms ? [{ id: "room", namespaceId: "namespace", archivedAt: null, humanActorIds: [] }]
        : table === roomMembers ? [
          { actorId: "human-actor", kind: "user", ownerId: "human", agentId: null },
          { actorId: "agent-actor", kind: "agent", ownerId: "human", agentId: "agent" },
        ]
        : table === groupMembers ? [{ slug: "read_memories" }, ...(options.denied ? [] : [{ slug: "manage_memories" }])]
        : [{ publicRoomId: null }];
      const query = {
        where: () => query, orderBy: () => query, innerJoin: () => query, leftJoin: () => query,
        for: () => Promise.resolve(rows),
        then: <TResult1 = typeof rows, TResult2 = never>(resolve?: ((value: typeof rows) => TResult1 | PromiseLike<TResult1>) | null, reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) => Promise.resolve(rows).then(resolve, reject),
      };
      return query;
    } }),
  };
  return { transaction: tx as unknown as Transaction, events };
}
const policy = { mode: "encrypted_only", shadowBehavior: "strict", revision: 7 } as const;

describe("foreground Memory publication authority", () => {
  test("uses canonical Shadow/Full selection and refuses plaintext/scope activation", () => {
    expect(createForegroundMemoryPublicationAuthority({ envelope, policy }).representation).toBe("protected_only");
    for (const shadowBehavior of ["fallback", "strict"] as const) {
      const boundary = createForegroundMemoryPublicationAuthority({ envelope,
        policy: { ...policy, mode: "shadow_encryption", shadowBehavior },
      });
      expect(boundary.representation).toBe("ordinary_and_protected");
      expect(boundary.allowOrdinaryFallback).toBe(shadowBehavior === "fallback");
    }
    expect(createForegroundMemoryPublicationAuthority({ envelope,
      policy: { ...policy, shadowBehavior: "fallback" },
    }).allowOrdinaryFallback).toBe(false);
    expect(() => createForegroundMemoryPublicationAuthority({ envelope,
      policy: { ...policy, mode: "plaintext_only", shadowBehavior: "fallback" },
    })).toThrow("ordinary publication path");
    expect(() => createForegroundMemoryPublicationAuthority({
      envelope: { memoryMode: "scope", ownerId: "human", actorId: "human-actor",
        agentId: "agent", roomId: "room", scopeId: "scope", toolPolicy: {} }, policy,
    })).toThrow("memory_unavailable");
  });
  test("fences policy before Room and membership locks in the exact caller transaction", async () => {
    const { transaction, events } = fixture();
    await createForegroundMemoryPublicationAuthority({ envelope, policy }).beforeLocks({
      transaction, authority, mutation: true,
    });
    expect(events[0]).toContain("pg_advisory_xact_lock_shared");
    expect(events[1]).toBe("policy");
    expect(events[2]).toContain("FOR UPDATE");
    expect(events[3]).toBe("product-read");
  });
  test("policy change rejects before any Room read or mutation", async () => {
    const { transaction, events } = fixture({ revision: 8 });
    expect(createForegroundMemoryPublicationAuthority({ envelope, policy }).beforeLocks({
      transaction, authority, mutation: true,
    })).rejects.toThrow("revision 7 is stale");
    expect(events).toHaveLength(2);
    expect(events).not.toContain("product-read");
  });
  test("rechecks management permission; reads do not manufacture mutation authority", async () => {
    const guard = createForegroundMemoryPublicationAuthority({ envelope, policy });
    await guard.beforeLocks({ transaction: fixture({ denied: true }).transaction, authority, mutation: false });
    expect(guard.beforeLocks({ transaction: fixture({ denied: true }).transaction, authority, mutation: true }))
      .rejects.toThrow("memory_unavailable");
  });
  test("rejects a substituted subject or Namespace set before database use", async () => {
    const guard = createForegroundMemoryPublicationAuthority({ envelope, policy });
    for (const substituted of [
      { ...authority, subjectUserId: "other" },
      { ...authority, agentId: "other" },
      { ...authority, readableNamespaceIds: ["other"] },
      { ...authority, mutableNamespaceIds: ["other"] },
      { ...authority, writableNamespaceId: "other" },
    ]) {
      const { transaction, events } = fixture();
      expect(guard.beforeLocks({ transaction, authority: substituted, mutation: true }))
        .rejects.toThrow("memory_unavailable");
      expect(events).toEqual([]);
    }
  });
});
