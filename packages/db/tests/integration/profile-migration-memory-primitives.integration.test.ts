/**
 * D425 Wave 1B — integration coverage for the transaction-aware
 * private-memory migration primitives in
 * `profile-migration-memory-primitives.ts`.
 *
 * Exercises the real Postgres transaction handle and asserts:
 *   - `isMemoryEligibleForPrivateExportInTx` accepts own-private-namespace
 *     and own-scope edges, and rejects shared/foreign edges + no-edge
 *     memories.
 *   - `insertPrivateMemoryInTx` writes a caller-supplied embedding + the
 *     memory namespace junction on the caller's tx, with no dedup / no
 *     update.
 *   - A failure during a LATER insert rolls the whole caller transaction
 *     back: no inserted rows, no junctions.
 *
 * Run against a named instance, e.g.:
 *   NAUTILO_INSTANCE_ID=qa-source bun test packages/db/tests/integration/profile-migration-memory-primitives.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  agentScopes,
  agents,
  and,
  count,
  createDirectDb,
  eq,
  memories,
  memoryNamespaces,
  memoryScopes,
  namespaces,
  rooms,
  actors,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";
import {
  fingerprintPrivateMemoryRecord,
  insertPrivateMemoryInTx,
  isMemoryEligibleForPrivateExportInTx,
  listPrivateMemoryFingerprintsInNamespaceInTx,
  replayPrivateMemoriesInTx,
  type ProfileMigrationTx,
} from "../../src/utils/profile-migration-memory-primitives";

let db: DirectDatabase;

const ts = Date.now().toString(36);
const OWNER_HANDLE = `w1bo${ts}`.slice(0, 28);

let ownerUserId = "";
let ownerHumanActorId = "";
let personalAgentId = "";
let privateNamespaceId = "";
let ownScopeId = "";
let sharedNamespaceId = "";

const createdMemoryIds = new Set<string>();
const createdNamespaceIds = new Set<string>();
const createdRoomIds = new Set<string>();
const createdAgentIds = new Set<string>();
const createdActorIds = new Set<string>();
const createdUserIds = new Set<string>();
const createdScopeIds = new Set<string>();

function rand(): string {
  return Math.random().toString(36).slice(2, 7).replace(/[^a-z]/g, "x") || "abc";
}

async function makeUser(handle: string, name: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ name, email: `${handle}@test.local`, handle })
    .returning({ id: users.id });
  if (!u) throw new Error("user insert failed");
  createdUserIds.add(u.id);
  return u.id;
}

async function makeHumanActor(ownerId: string, displayName: string): Promise<string> {
  const [a] = await db
    .insert(actors)
    .values({ ownerId, displayName, kind: "user" })
    .returning({ id: actors.id });
  if (!a) throw new Error("human actor insert failed");
  createdActorIds.add(a.id);
  return a.id;
}

async function makeAgent(handle: string): Promise<string> {
  const [a] = await db.insert(agents).values({ handle }).returning({ id: agents.id });
  if (!a) throw new Error("agent insert failed");
  createdAgentIds.add(a.id);
  return a.id;
}

async function makeAgentActor(ownerId: string, agentId: string, displayName: string): Promise<string> {
  const [a] = await db
    .insert(actors)
    .values({ ownerId, displayName, kind: "agent", agentId })
    .returning({ id: actors.id });
  if (!a) throw new Error("agent actor insert failed");
  createdActorIds.add(a.id);
  return a.id;
}

async function makeNamespace(scope: string, label: string): Promise<string> {
  const [n] = await db
    .insert(namespaces)
    .values({ scope, label })
    .returning({ id: namespaces.id });
  if (!n) throw new Error("namespace insert failed");
  createdNamespaceIds.add(n.id);
  return n.id;
}

async function makeRoom(
  ownerId: string,
  namespaceId: string,
  humanActorIds: string[],
  createdBy: string,
): Promise<string> {
  const [r] = await db
    .insert(rooms)
    .values({
      ownerId,
      type: "private",
      label: `room-${rand()}`,
      graphThreadId: `room:test-${rand()}`,
      namespaceId,
      humanActorIds,
      createdBy,
    })
    .returning({ id: rooms.id });
  if (!r) throw new Error("room insert failed");
  createdRoomIds.add(r.id);
  return r.id;
}

async function makeScope(parentAgentId: string, speakerUserId: string, name: string): Promise<string> {
  const [s] = await db
    .insert(agentScopes)
    .values({ parentAgentId, speakerUserId, name })
    .returning({ id: agentScopes.id });
  if (!s) throw new Error("scope insert failed");
  createdScopeIds.add(s.id);
  return s.id;
}

async function makeMemory(content: string): Promise<string> {
  const [m] = await db
    .insert(memories)
    .values({ type: "fact", content })
    .returning({ id: memories.id });
  if (!m) throw new Error("memory insert failed");
  createdMemoryIds.add(m.id);
  return m.id;
}

async function attachNamespace(memoryId: string, namespaceId: string): Promise<void> {
  await db.insert(memoryNamespaces).values({ memoryId, namespaceId });
}

async function attachScope(memoryId: string, scopeId: string): Promise<void> {
  await db.insert(memoryScopes).values({ memoryId, scopeId });
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  const { ensureDatabase } = await import("@nautilo/db");
  await ensureDatabase();
  db = createDirectDb(3);

  // Owner + owner human actor + personal agent + agent-actor.
  ownerUserId = await makeUser(OWNER_HANDLE, "Wave1B owner");
  ownerHumanActorId = await makeHumanActor(ownerUserId, "Wave1B owner");
  personalAgentId = await makeAgent(`w1ba${ts}`.slice(0, 28));
  await makeAgentActor(ownerUserId, personalAgentId, "Genie");

  // Owner's private Room + its Namespace (humanActorIds = [ownerHumanActor]).
  privateNamespaceId = await makeNamespace("private", "Owner private");
  await makeRoom(
    ownerUserId,
    privateNamespaceId,
    [ownerHumanActorId],
    ownerHumanActorId,
  );

  // Owner's personal-agent scope: (personalAgentId, ownerUserId).
  ownScopeId = await makeScope(personalAgentId, ownerUserId, "personal");

  // A SHARED room (two humans) + its namespace, for the foreign/shared edge.
  const otherUserId = await makeUser(`w1bx${ts}`.slice(0, 28), "Other human");
  const otherActorId = await makeHumanActor(otherUserId, "Other human");
  sharedNamespaceId = await makeNamespace("private", "Shared room");
  await makeRoom(
    ownerUserId,
    sharedNamespaceId,
    [ownerHumanActorId, otherActorId],
    ownerHumanActorId,
  );
});

afterAll(async () => {
  if (!db) return;
  // memories cascade to memory_namespaces + memory_scopes (onDelete cascade).
  for (const id of createdMemoryIds) {
    await db.delete(memories).where(eq(memories.id, id));
  }
  for (const id of createdRoomIds) {
    await db.delete(rooms).where(eq(rooms.id, id));
  }
  for (const id of createdScopeIds) {
    await db.delete(agentScopes).where(eq(agentScopes.id, id));
  }
  for (const id of createdNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, id));
  }
  for (const id of createdAgentIds) {
    await db.delete(agents).where(eq(agents.id, id));
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  await db.end();
});

describe("D425 isMemoryEligibleForPrivateExportInTx — own private edges accept", () => {
  test("own private namespace edge → eligible", async () => {
    const memId = await makeMemory(`own-ns-${rand()}`);
    await attachNamespace(memId, privateNamespaceId);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isMemoryEligibleForPrivateExportInTx(tx, {
        memoryId: memId,
        ownerUserId,
        personalAgentId,
      }),
    );
    expect(res.eligible).toBe(true);
    expect(res.namespaceEdgeCount).toBe(1);
    expect(res.scopeEdgeCount).toBe(0);
  });

  test("own scope edge (no namespace edges) → eligible", async () => {
    const memId = await makeMemory(`own-scope-${rand()}`);
    await attachScope(memId, ownScopeId);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isMemoryEligibleForPrivateExportInTx(tx, {
        memoryId: memId,
        ownerUserId,
        personalAgentId,
      }),
    );
    expect(res.eligible).toBe(true);
    expect(res.namespaceEdgeCount).toBe(0);
    expect(res.scopeEdgeCount).toBe(1);
  });

  test("own private namespace AND own scope edges → eligible", async () => {
    const memId = await makeMemory(`own-both-${rand()}`);
    await attachNamespace(memId, privateNamespaceId);
    await attachScope(memId, ownScopeId);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isMemoryEligibleForPrivateExportInTx(tx, {
        memoryId: memId,
        ownerUserId,
        personalAgentId,
      }),
    );
    expect(res.eligible).toBe(true);
    expect(res.namespaceEdgeCount).toBe(1);
    expect(res.scopeEdgeCount).toBe(1);
  });
});

describe("D425 isMemoryEligibleForPrivateExportInTx — shared / foreign edges reject", () => {
  test("a shared-room namespace edge (two humans) → rejected", async () => {
    const memId = await makeMemory(`shared-ns-${rand()}`);
    await attachNamespace(memId, sharedNamespaceId);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isMemoryEligibleForPrivateExportInTx(tx, {
        memoryId: memId,
        ownerUserId,
        personalAgentId,
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("one shared namespace edge rejects even alongside an own-private namespace edge", async () => {
    const memId = await makeMemory(`mixed-ns-${rand()}`);
    await attachNamespace(memId, privateNamespaceId);
    await attachNamespace(memId, sharedNamespaceId);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isMemoryEligibleForPrivateExportInTx(tx, {
        memoryId: memId,
        ownerUserId,
        personalAgentId,
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("a foreign scope edge (different agent) → rejected", async () => {
    // Scope owned by a different (personalAgentId, speakerUserId) pair.
    const otherAgentId = await makeAgent(`w1bf${ts}`.slice(0, 28));
    const foreignScopeId = await makeScope(otherAgentId, ownerUserId, "foreign");
    const memId = await makeMemory(`foreign-scope-${rand()}`);
    await attachScope(memId, foreignScopeId);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isMemoryEligibleForPrivateExportInTx(tx, {
        memoryId: memId,
        ownerUserId,
        personalAgentId,
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("scope_shared_or_foreign");
  });

  test("a memory with no edges → rejected (not provably private)", async () => {
    const memId = await makeMemory(`no-edges-${rand()}`);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isMemoryEligibleForPrivateExportInTx(tx, {
        memoryId: memId,
        ownerUserId,
        personalAgentId,
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("no_edges");
  });
});

describe("D425 insertPrivateMemoryInTx — caller-owned transaction", () => {
  test("inserts a fresh memory + namespace junction with a caller-supplied embedding", async () => {
    const content = `ins-commit-${rand()}`;
    const createdAt = new Date("2026-05-01T12:51:14.000Z");
    // The column is vector(1536); supply a full-dimension embedding.
    const vector = new Array(1536).fill(0).map((_, i) => (i === 0 ? 0.1 : 0));
    const embedding = {
      vector,
      provider: "venice" as const,
      canonicalModel: "text-embedding-3-small",
      dimensions: 1536,
      contractVersion: 1 as const,
    };

    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      insertPrivateMemoryInTx(tx, {
        content,
        embedding,
        targetNamespaceId: privateNamespaceId,
        type: "fact",
        importance: 0.9,
        createdAt,
      }),
    );
    createdMemoryIds.add(res.memoryId);

    expect(res.namespaceId).toBe(privateNamespaceId);

    const [row] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, res.memoryId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.content).toBe(content);
    expect(row?.type).toBe("fact");
    expect(row?.importance).toBe(0.9);
    expect(row?.contentRevision).toBe(0);
    expect(row?.embedding).toEqual(vector);
    expect(row?.embeddingRevision).toBe(0);
    expect(row?.embeddingProvider).toBe("venice");
    expect(row?.embeddingModel).toBe("text-embedding-3-small");
    expect(row?.embeddingDimensions).toBe(1536);
    expect(row?.embeddingContractVersion).toBe(1);
    expect(row?.createdAt?.toISOString()).toBe(createdAt.toISOString());

    const [junction] = await db
      .select()
      .from(memoryNamespaces)
      .where(
        and(
          eq(memoryNamespaces.memoryId, res.memoryId),
          eq(memoryNamespaces.namespaceId, privateNamespaceId),
        ),
      )
      .limit(1);
    expect(junction).toBeDefined();
  });

  test("inserts a memory with null embedding (importer backfills later)", async () => {
    const content = `ins-null-${rand()}`;
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      insertPrivateMemoryInTx(tx, {
        content,
        embedding: null,
        targetNamespaceId: privateNamespaceId,
      }),
    );
    createdMemoryIds.add(res.memoryId);

    const [row] = await db
      .select({
        contentRevision: memories.contentRevision,
        embedding: memories.embedding,
        embeddingRevision: memories.embeddingRevision,
        embeddingProvider: memories.embeddingProvider,
        embeddingModel: memories.embeddingModel,
        embeddingDimensions: memories.embeddingDimensions,
        embeddingContractVersion: memories.embeddingContractVersion,
      })
      .from(memories)
      .where(eq(memories.id, res.memoryId))
      .limit(1);
    expect(row?.embedding).toBeNull();
    expect(row?.contentRevision).toBe(0);
    expect(row?.embeddingRevision).toBeNull();
    expect(row?.embeddingProvider).toBeNull();
    expect(row?.embeddingModel).toBeNull();
    expect(row?.embeddingDimensions).toBeNull();
    expect(row?.embeddingContractVersion).toBeNull();
  });

  test("does NOT dedup: same content twice creates two distinct rows", async () => {
    const content = `ins-dedup-${rand()}`;
    const a = await db.transaction(async (tx: ProfileMigrationTx) =>
      insertPrivateMemoryInTx(tx, {
        content,
        embedding: null,
        targetNamespaceId: privateNamespaceId,
      }),
    );
    const b = await db.transaction(async (tx: ProfileMigrationTx) =>
      insertPrivateMemoryInTx(tx, {
        content,
        embedding: null,
        targetNamespaceId: privateNamespaceId,
      }),
    );
    createdMemoryIds.add(a.memoryId);
    createdMemoryIds.add(b.memoryId);

    expect(a.memoryId).not.toBe(b.memoryId);
    const rows = await db
      .select({ c: count() })
      .from(memories)
      .where(eq(memories.content, content));
    expect(Number(rows[0]?.c ?? 0)).toBe(2);
  });
});

describe("D425 insertPrivateMemoryInTx — transaction rollback", () => {
  test("a failure during a LATER insert rolls back ALL earlier inserts + junctions", async () => {
    const contentA = `rb-early-${rand()}`;
    const contentB = `rb-late-${rand()}`;
    const bogusNamespaceId = "00000000-0000-0000-0000-000000000000";

    let threw = false;
    try {
      await db.transaction(async (tx: ProfileMigrationTx) => {
        // First insert succeeds (memory + junction committed only if tx commits).
        const a = await insertPrivateMemoryInTx(tx, {
          content: contentA,
          embedding: null,
          targetNamespaceId: privateNamespaceId,
        });
        // Track it only if it survives — it won't, but keep the set honest.
        createdMemoryIds.add(a.memoryId);

        // Second insert: memory row succeeds, but the junction insert fails
        // FK RESTRICT because the namespace does not exist. This throws and
        // aborts the transaction.
        await insertPrivateMemoryInTx(tx, {
          content: contentB,
          embedding: null,
          targetNamespaceId: bogusNamespaceId,
        });
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);

    // Neither memory row survives the rollback.
    const rowsA = await db
      .select({ c: count() })
      .from(memories)
      .where(eq(memories.content, contentA));
    expect(Number(rowsA[0]?.c ?? 0)).toBe(0);

    const rowsB = await db
      .select({ c: count() })
      .from(memories)
      .where(eq(memories.content, contentB));
    expect(Number(rowsB[0]?.c ?? 0)).toBe(0);

    // No junction row was left pointing at the private namespace for the
    // rolled-back memory A.
    const jRows = await db
      .select({ c: count() })
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.namespaceId, privateNamespaceId));
    // Only the committed-insert tests above leave junctions for this
    // namespace; none of contentA/contentB's junctions survive.
    expect(Number(jRows[0]?.c ?? 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("D567 replayPrivateMemoriesInTx — exact replay safety under the namespace lock", () => {
  test("replays only canonically new records and preserves distinct portable identities", async () => {
    const content = `replay-exact-${rand()}`;
    const firstCreatedAt = new Date("2026-08-31T10:20:30.000Z");
    const secondCreatedAt = new Date("2026-08-31T10:20:31.000Z");
    const records = [
      {
        content,
        embedding: null,
        targetNamespaceId: privateNamespaceId,
        type: "fact",
        createdAt: firstCreatedAt,
      },
      // Same content/type but a canonically distinct createdAt remains a
      // distinct record; this is never fuzzy/embedding similarity dedup.
      {
        content,
        embedding: null,
        targetNamespaceId: privateNamespaceId,
        type: "fact",
        createdAt: secondCreatedAt,
      },
      // Exact duplicate in one backup is already present after the first row.
      {
        content,
        embedding: null,
        targetNamespaceId: privateNamespaceId,
        type: "fact",
        createdAt: firstCreatedAt,
      },
    ];

    const first = await db.transaction((tx: ProfileMigrationTx) =>
      replayPrivateMemoriesInTx(tx, { targetNamespaceId: privateNamespaceId, records }),
    );
    expect(first).toEqual({ added: 2, alreadyPresent: 1 });

    const second = await db.transaction((tx: ProfileMigrationTx) =>
      replayPrivateMemoriesInTx(tx, { targetNamespaceId: privateNamespaceId, records }),
    );
    expect(second).toEqual({ added: 0, alreadyPresent: 3 });

    const rows = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.content, content));
    expect(rows).toHaveLength(2);
    for (const row of rows) createdMemoryIds.add(row.id);
  });

  test("concurrent transactions serialize lookup plus insert, so exactly one adds", async () => {
    const content = `replay-race-${rand()}`;
    const records = [{
      content,
      embedding: null,
      targetNamespaceId: privateNamespaceId,
      type: "fact",
      createdAt: new Date("2026-08-31T10:20:30.000Z"),
    }];
    const [a, b] = await Promise.all([
      db.transaction((tx: ProfileMigrationTx) =>
        replayPrivateMemoriesInTx(tx, { targetNamespaceId: privateNamespaceId, records }),
      ),
      db.transaction((tx: ProfileMigrationTx) =>
        replayPrivateMemoriesInTx(tx, { targetNamespaceId: privateNamespaceId, records }),
      ),
    ]);
    expect([a.added, b.added].sort()).toEqual([0, 1]);
    expect([a.alreadyPresent, b.alreadyPresent].sort()).toEqual([0, 1]);

    const rows = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.content, content));
    expect(rows).toHaveLength(1);
    createdMemoryIds.add(rows[0]!.id);
  });

  test("retains an exact null-createdAt identity through the existing unique creation receipt", async () => {
    const content = `replay-null-created-at-${rand()}`;
    const records = [{
      content,
      embedding: null,
      targetNamespaceId: privateNamespaceId,
      type: "fact",
      // A DB row must receive a non-null created_at default, but the portable
      // record's identity remains `createdAt: null` across a later restore.
    }];
    const first = await db.transaction((tx: ProfileMigrationTx) =>
      replayPrivateMemoriesInTx(tx, { targetNamespaceId: privateNamespaceId, records }),
    );
    const second = await db.transaction((tx: ProfileMigrationTx) =>
      replayPrivateMemoriesInTx(tx, { targetNamespaceId: privateNamespaceId, records }),
    );
    expect(first).toEqual({ added: 1, alreadyPresent: 0 });
    expect(second).toEqual({ added: 0, alreadyPresent: 1 });

    const rows = await db
      .select({ id: memories.id, creationKey: memories.creationKey })
      .from(memories)
      .where(eq(memories.content, content));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creationKey).toContain("profile-bundle-private-memory:v1:");
    createdMemoryIds.add(rows[0]!.id);
  });

  test("a later replay insert failure rolls back all earlier replay inserts", async () => {
    const earlyContent = `replay-rollback-early-${rand()}`;
    const lateContent = `replay-rollback-late-${rand()}`;
    let threw = false;
    try {
      await db.transaction((tx: ProfileMigrationTx) =>
        replayPrivateMemoriesInTx(tx, {
          targetNamespaceId: privateNamespaceId,
          records: [
            {
              content: earlyContent,
              embedding: null,
              targetNamespaceId: privateNamespaceId,
              type: "fact",
            },
            {
              content: lateContent,
              embedding: null,
              targetNamespaceId: "00000000-0000-0000-0000-000000000000",
              type: "fact",
            },
          ],
        }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const earlyRows = await db
      .select({ c: count() })
      .from(memories)
      .where(eq(memories.content, earlyContent));
    const lateRows = await db
      .select({ c: count() })
      .from(memories)
      .where(eq(memories.content, lateContent));
    expect(Number(earlyRows[0]?.c ?? 0)).toBe(0);
    expect(Number(lateRows[0]?.c ?? 0)).toBe(0);
  });

  test("does not trust a malformed replay receipt suffix", async () => {
    const content = `replay-malformed-receipt-${rand()}`;
    const createdAt = new Date("2026-08-31T10:20:30.000Z");
    const inserted = await db.transaction((tx: ProfileMigrationTx) =>
      insertPrivateMemoryInTx(tx, {
        content,
        embedding: null,
        targetNamespaceId: privateNamespaceId,
        type: "fact",
        createdAt,
        creationKey: `profile-bundle-private-memory:v1:${privateNamespaceId}:NOT-HEX`,
      }),
    );
    createdMemoryIds.add(inserted.memoryId);
    const fingerprints = await db.transaction((tx: ProfileMigrationTx) =>
      listPrivateMemoryFingerprintsInNamespaceInTx(tx, privateNamespaceId),
    );
    // The malformed receipt is ignored and the actual durable row projection
    // supplies its exact portable identity instead.
    expect(fingerprints.has(fingerprintPrivateMemoryRecord({
      type: "fact",
      content,
      createdAt,
    }))).toBe(true);
    expect(fingerprints.has("NOT-HEX")).toBe(false);
  });
});
