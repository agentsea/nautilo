/**
 * M180 — findRecentRevision provenance-aware lookup.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  eq,
  sql,
  users,
  agents,
  fileRevisions,
  FILE_REVISION_AUTHOR,
  FILE_REVISION_KIND,
  FILE_REVISION_OPERATION,
  findRecentRevision,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

type Db = ReturnType<typeof createDirectDb>;

let db: Db;
let ownerId: string;
let humanUserId: string;
let agentId: string;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(5);

  const ts = Date.now();
  const [owner] = await db
    .insert(users)
    .values({
      name: "fr-recent-owner",
      email: `fr-recent-owner-${ts}@test.local`,
    })
    .returning({ id: users.id });
  if (!owner) throw new Error("owner");
  ownerId = owner.id;

  const [human] = await db
    .insert(users)
    .values({
      name: "fr-recent-human",
      email: `fr-recent-human-${ts}@test.local`,
    })
    .returning({ id: users.id });
  if (!human) throw new Error("human");
  humanUserId = human.id;

  const [agent] = await db
    .insert(agents)
    .values({ handle: `fr-recent-${ts}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("agent");
  agentId = agent.id;
});

afterAll(async () => {
  if (db && agentId) {
    await db.execute(sql`DELETE FROM agents WHERE id = ${agentId}`);
  }
  if (db && ownerId) {
    await db.delete(users).where(eq(users.id, ownerId));
  }
  if (db && humanUserId) {
    await db.delete(users).where(eq(users.id, humanUserId));
  }
  await db?.end();
});

async function insertRevision(
  absolutePath: string,
  authoredBy: typeof FILE_REVISION_AUTHOR.AGENT | typeof FILE_REVISION_AUTHOR.USER,
  userId: string | null,
  createdAt?: Date,
): Promise<string> {
  const [row] = await db
    .insert(fileRevisions)
    .values({
      ownerId,
      agentId,
      turnId: `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      absolutePath,
      preSha256: "a".repeat(64),
      preSize: 10,
      kind: FILE_REVISION_KIND.DIFF,
      diffText: "diff",
      operation: FILE_REVISION_OPERATION.WRITE,
      authoredBy,
      ...(userId ? { userId } : {}),
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: fileRevisions.id });
  if (!row) throw new Error("insertRevision");
  return row.id;
}

describe("findRecentRevision (M180)", () => {
  test("returns newest matching user checkpoint and ignores agent rows", async () => {
    const path = `/tmp/fr-recent-${Date.now()}.md`;
    const older = new Date(Date.now() - 5_000);
    const newer = new Date(Date.now() - 1_000);

    const agentOldId = await insertRevision(
      path,
      FILE_REVISION_AUTHOR.AGENT,
      null,
      older,
    );
    const userOldId = await insertRevision(
      path,
      FILE_REVISION_AUTHOR.USER,
      humanUserId,
      older,
    );
    const agentNewId = await insertRevision(
      path,
      FILE_REVISION_AUTHOR.AGENT,
      null,
      newer,
    );
    const userNewId = await insertRevision(
      path,
      FILE_REVISION_AUTHOR.USER,
      humanUserId,
      newer,
    );

    const found = await findRecentRevision(db, {
      agentId,
      absolutePath: path,
      authoredBy: FILE_REVISION_AUTHOR.USER,
      userId: humanUserId,
    });

    expect(found?.id).toBe(userNewId);
    expect(found?.id).not.toBe(agentNewId);
    expect(found?.id).not.toBe(agentOldId);
    expect(found?.id).not.toBe(userOldId);
  });

  test("null userId matches only rows with null user_id", async () => {
    const path = `/tmp/fr-recent-null-${Date.now()}.md`;
    const withUser = await insertRevision(
      path,
      FILE_REVISION_AUTHOR.USER,
      humanUserId,
    );
    const agentOnly = await insertRevision(
      path,
      FILE_REVISION_AUTHOR.AGENT,
      null,
    );

    const found = await findRecentRevision(db, {
      agentId,
      absolutePath: path,
      authoredBy: FILE_REVISION_AUTHOR.AGENT,
      userId: null,
    });

    expect(found?.id).toBe(agentOnly);
    expect(found?.id).not.toBe(withUser);
  });
});
