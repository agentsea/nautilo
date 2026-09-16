/**
 * D425 Wave 3 — integration coverage for the transaction-aware
 * private-artifact migration primitives in
 * `profile-migration-artifact-primitives.ts`.
 *
 * Exercises the real Postgres transaction handle and asserts:
 *   - `isArtifactEligibleForPrivateExportInTx` accepts own-private-namespace
 *     edges and rejects shared / foreign / no-room / no-edge artifacts.
 *   - `insertPrivateArtifactInTx` writes the target artifact row + its
 *     artifact_namespaces junction on the caller's tx, with no dedup / no
 *     update.
 *   - A failure during a LATER insert rolls the whole caller transaction
 *     back: no inserted rows, no junctions.
 *
 * Run against a named instance, e.g.:
 *   NAUTILO_INSTANCE_ID=qa-source bun test packages/db/tests/integration/profile-migration-artifact-primitives.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  artifacts,
  artifactNamespaces,
  count,
  createDirectDb,
  eq,
  namespaces,
  rooms,
  actors,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";
import {
  insertPrivateArtifactInTx,
  isArtifactEligibleForPrivateExportInTx,
  type ProfileMigrationTx,
} from "../../src/utils/profile-migration-artifact-primitives";

let db: DirectDatabase;

const ts = Date.now().toString(36);
const OWNER_HANDLE = `w3ao${ts}`.slice(0, 28);

let ownerUserId = "";
let ownerHumanActorId = "";
let privateNamespaceId = "";
let sharedNamespaceId = "";

const createdArtifactIds = new Set<string>();
const createdNamespaceIds = new Set<string>();
const createdRoomIds = new Set<string>();
const createdUserIds = new Set<string>();
const createdActorIds = new Set<string>();

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

async function makeArtifact(path: string): Promise<string> {
  const [a] = await db
    .insert(artifacts)
    .values({
      artifactId: `ext-${rand()}`,
      path,
      storageUri: `file:///tmp/${rand()}.bin`,
    })
    .returning({ id: artifacts.id });
  if (!a) throw new Error("artifact insert failed");
  createdArtifactIds.add(a.id);
  return a.id;
}

async function attachNamespace(artifactInternalId: string, namespaceId: string): Promise<void> {
  await db
    .insert(artifactNamespaces)
    .values({ artifactId: artifactInternalId, namespaceId })
    .onConflictDoNothing();
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  const { ensureDatabase } = await import("@nautilo/db");
  await ensureDatabase();
  db = createDirectDb(3);

  ownerUserId = await makeUser(OWNER_HANDLE, "Wave3 owner");
  ownerHumanActorId = await makeHumanActor(ownerUserId, "Wave3 owner");

  privateNamespaceId = await makeNamespace("private", "Owner private");
  await makeRoom(ownerUserId, privateNamespaceId, [ownerHumanActorId], ownerHumanActorId);

  const otherUserId = await makeUser(`w3bx${ts}`.slice(0, 28), "Other human");
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
  // artifacts cascade to artifact_namespaces (onDelete cascade).
  for (const id of createdArtifactIds) {
    await db.delete(artifacts).where(eq(artifacts.id, id));
  }
  for (const id of createdRoomIds) {
    await db.delete(rooms).where(eq(rooms.id, id));
  }
  for (const id of createdNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, id));
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  await db.end();
});

describe("D425 isArtifactEligibleForPrivateExportInTx — own private edges accept", () => {
  test("own private namespace edge → eligible", async () => {
    const aId = await makeArtifact(`own-ns-${rand()}.md`);
    await attachNamespace(aId, privateNamespaceId);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isArtifactEligibleForPrivateExportInTx(tx, {
        artifactInternalId: aId,
        ownerUserId,
      }),
    );
    expect(res.eligible).toBe(true);
    expect(res.namespaceEdgeCount).toBe(1);
  });

  test("multiple own-private-namespace edges → eligible", async () => {
    const aId = await makeArtifact(`own-multi-${rand()}.md`);
    await attachNamespace(aId, privateNamespaceId);
    await attachNamespace(aId, privateNamespaceId);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isArtifactEligibleForPrivateExportInTx(tx, {
        artifactInternalId: aId,
        ownerUserId,
      }),
    );
    expect(res.eligible).toBe(true);
    expect(res.namespaceEdgeCount).toBeGreaterThanOrEqual(1);
  });
});

describe("D425 isArtifactEligibleForPrivateExportInTx — shared / foreign / no-edge reject", () => {
  test("a shared-room namespace edge (two humans) → rejected", async () => {
    const aId = await makeArtifact(`shared-ns-${rand()}.md`);
    await attachNamespace(aId, sharedNamespaceId);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isArtifactEligibleForPrivateExportInTx(tx, {
        artifactInternalId: aId,
        ownerUserId,
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("one shared namespace edge rejects even alongside an own-private namespace edge", async () => {
    const aId = await makeArtifact(`mixed-ns-${rand()}.md`);
    await attachNamespace(aId, privateNamespaceId);
    await attachNamespace(aId, sharedNamespaceId);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isArtifactEligibleForPrivateExportInTx(tx, {
        artifactInternalId: aId,
        ownerUserId,
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("namespace_shared_or_foreign");
  });

  test("an artifact with no edges → rejected (not provably private)", async () => {
    const aId = await makeArtifact(`no-edges-${rand()}.md`);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      isArtifactEligibleForPrivateExportInTx(tx, {
        artifactInternalId: aId,
        ownerUserId,
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("no_edges");
  });
});

describe("D425 insertPrivateArtifactInTx — caller-owned transaction", () => {
  test("inserts a fresh artifact + namespace junction", async () => {
    const externalId = `ins-ext-${rand()}`;
    const path = `ins-commit/${rand()}.md`;
    const storageUri = `file:///tmp/ins-${rand()}.bin`;
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      insertPrivateArtifactInTx(tx, {
        artifactId: externalId,
        path,
        mimeType: "text/markdown",
        size: 128,
        storageUri,
        targetNamespaceId: privateNamespaceId,
      }),
    );
    createdArtifactIds.add(res.artifactInternalId);

    expect(res.artifactId).toBe(externalId);
    expect(res.namespaceId).toBe(privateNamespaceId);

    const [row] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, res.artifactInternalId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.artifactId).toBe(externalId);
    expect(row?.path).toBe(path);
    expect(row?.mimeType).toBe("text/markdown");
    expect(row?.size).toBe(128);
    expect(row?.storageUri).toBe(storageUri);
    expect(row?.revision).toBe(1);

    const [junction] = await db
      .select()
      .from(artifactNamespaces)
      .where(
        and(
          eq(artifactNamespaces.artifactId, res.artifactInternalId),
          eq(artifactNamespaces.namespaceId, privateNamespaceId),
        ),
      )
      .limit(1);
    expect(junction).toBeDefined();
  });

  test("does NOT dedup: same path twice creates two distinct rows", async () => {
    const path = `ins-dedup/${rand()}.md`;
    const a = await db.transaction(async (tx: ProfileMigrationTx) =>
      insertPrivateArtifactInTx(tx, {
        artifactId: `dup-a-${rand()}`,
        path,
        mimeType: "text/markdown",
        size: 1,
        storageUri: `file:///tmp/dup-a-${rand()}.bin`,
        targetNamespaceId: privateNamespaceId,
      }),
    );
    const b = await db.transaction(async (tx: ProfileMigrationTx) =>
      insertPrivateArtifactInTx(tx, {
        artifactId: `dup-b-${rand()}`,
        path,
        mimeType: "text/markdown",
        size: 1,
        storageUri: `file:///tmp/dup-b-${rand()}.bin`,
        targetNamespaceId: privateNamespaceId,
      }),
    );
    createdArtifactIds.add(a.artifactInternalId);
    createdArtifactIds.add(b.artifactInternalId);

    expect(a.artifactInternalId).not.toBe(b.artifactInternalId);
    const rows = await db
      .select({ c: count() })
      .from(artifacts)
      .where(eq(artifacts.path, path));
    expect(Number(rows[0]?.c ?? 0)).toBe(2);
  });

  test("rejects an invalid path before touching the DB", async () => {
    let threw = false;
    try {
      await db.transaction(async (tx: ProfileMigrationTx) =>
        insertPrivateArtifactInTx(tx, {
          artifactId: `bad-path-${rand()}`,
          path: "../etc/secret",
          mimeType: "text/markdown",
          size: 1,
          storageUri: `file:///tmp/bad-${rand()}.bin`,
          targetNamespaceId: privateNamespaceId,
        }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("D425 insertPrivateArtifactInTx — transaction rollback", () => {
  test("a failure during a LATER insert rolls back ALL earlier inserts + junctions", async () => {
    const pathA = `rb-early-${rand()}.md`;
    const pathB = `rb-late-${rand()}.md`;
    const bogusNamespaceId = "00000000-0000-0000-0000-000000000000";

    let threw = false;
    try {
      await db.transaction(async (tx: ProfileMigrationTx) => {
        const a = await insertPrivateArtifactInTx(tx, {
          artifactId: `rb-a-${rand()}`,
          path: pathA,
          mimeType: "text/markdown",
          size: 1,
          storageUri: `file:///tmp/rb-a-${rand()}.bin`,
          targetNamespaceId: privateNamespaceId,
        });
        createdArtifactIds.add(a.artifactInternalId);

        // Junction FK RESTRICT on a non-existent namespace throws and aborts.
        await insertPrivateArtifactInTx(tx, {
          artifactId: `rb-b-${rand()}`,
          path: pathB,
          mimeType: "text/markdown",
          size: 1,
          storageUri: `file:///tmp/rb-b-${rand()}.bin`,
          targetNamespaceId: bogusNamespaceId,
        });
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);

    const rowsA = await db
      .select({ c: count() })
      .from(artifacts)
      .where(eq(artifacts.path, pathA));
    expect(Number(rowsA[0]?.c ?? 0)).toBe(0);

    const rowsB = await db
      .select({ c: count() })
      .from(artifacts)
      .where(eq(artifacts.path, pathB));
    expect(Number(rowsB[0]?.c ?? 0)).toBe(0);
  });
});
