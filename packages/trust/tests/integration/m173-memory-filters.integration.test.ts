/**
 * M173 — memory access GET filters, semantic pin (live Postgres).
 *
 * The route's set-math (membership-gate 404, intersection, scope→400) is unit-
 * tested in `server/.../memory-access-routes.test.ts`. This proves the
 * SUBSET-RULE semantics those filters stand on, against real rows:
 *
 *   ?room=<R>  → namespaceIds = findReadableNamespacesForSubset(H(R))
 *                ("memories visible FROM this room" — narrows as the room widens)
 *   ?person=<P> → namespaceIds = subset([P]) ∩ subset([requester])
 *                ("what P can see AND I can see" — never leaks P's private rows)
 *
 * Fixture: humans R (requester), X, Y; private rooms R-priv {R}, X-priv {X};
 * a shared room Fam {R,X,Y}. Memories: memFam (in Fam) + memXpriv (in X-priv).
 * No embeddings needed — `memories.embedding` is nullable (mirrors the m044 pin).
 */
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  rooms,
  namespaces,
  memories,
  memoryNamespaces,
  inArray,
  eq,
  sql,
} from "@nautilo/db";
import { findReadableNamespacesForSubset } from "../../src/queries";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

let db: ReturnType<typeof createDirectDb>;
const ids = {
  rUser: "",
  xUser: "",
  yUser: "",
  rActor: "",
  xActor: "",
  yActor: "",
  rPrivNs: "",
  xPrivNs: "",
  famNs: "",
  rPrivRoom: "",
  xPrivRoom: "",
  famRoom: "",
  memFam: "",
  memXpriv: "",
};

async function seedUser(tag: string, ts: string): Promise<{ userId: string; actorId: string }> {
  const [u] = await db
    .insert(users)
    .values({
      name: `m173-${tag}`,
      email: `m173-${tag}-${ts}@test.local`,
      handle: `m173${tag}${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error(`user ${tag}`);
  const [a] = await db
    .insert(actors)
    .values({ ownerId: u.id, displayName: `M173 ${tag}`, trustState: "verified", kind: "user" })
    .returning({ id: actors.id });
  if (!a) throw new Error(`actor ${tag}`);
  return { userId: u.id, actorId: a.id };
}

async function seedRoom(
  ownerUserId: string,
  humanActorIds: string[],
  label: string,
): Promise<{ roomId: string; nsId: string }> {
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error(`ns ${label}`);
  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: ownerUserId,
    type: "private",
    label,
    graphThreadId: `room:${roomId}`,
    namespaceId: ns.id,
    humanActorIds: [...humanActorIds].sort(),
    kind: "private",
  });
  return { roomId, nsId: ns.id };
}

async function seedMemory(nsId: string, content: string): Promise<string> {
  const [mem] = await db
    .insert(memories)
    .values({ type: "fact", content })
    .returning({ id: memories.id });
  if (!mem) throw new Error("memory");
  await db.insert(memoryNamespaces).values({ memoryId: mem.id, namespaceId: nsId });
  return mem.id;
}

/** The route's listMemories step reduces to "memory_namespaces ∩ readable". */
async function memoriesVisibleIn(namespaceIds: string[]): Promise<Set<string>> {
  if (namespaceIds.length === 0) return new Set();
  const rows = await db
    .select({ memoryId: memoryNamespaces.memoryId })
    .from(memoryNamespaces)
    .where(inArray(memoryNamespaces.namespaceId, namespaceIds));
  return new Set(rows.map((r) => r.memoryId));
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const r = await seedUser("r", ts);
  const x = await seedUser("x", ts);
  const y = await seedUser("y", ts);
  ids.rUser = r.userId; ids.rActor = r.actorId;
  ids.xUser = x.userId; ids.xActor = x.actorId;
  ids.yUser = y.userId; ids.yActor = y.actorId;

  ({ roomId: ids.rPrivRoom, nsId: ids.rPrivNs } = await seedRoom(r.userId, [r.actorId], `m173-rpriv-${ts}`));
  ({ roomId: ids.xPrivRoom, nsId: ids.xPrivNs } = await seedRoom(x.userId, [x.actorId], `m173-xpriv-${ts}`));
  ({ roomId: ids.famRoom, nsId: ids.famNs } = await seedRoom(
    r.userId,
    [r.actorId, x.actorId, y.actorId],
    `m173-fam-${ts}`,
  ));

  ids.memFam = await seedMemory(ids.famNs, `m173-fam-secret-${ts}`);
  ids.memXpriv = await seedMemory(ids.xPrivNs, `m173-xpriv-secret-${ts}`);
});

afterAll(async () => {
  if (!db) return;
  try {
    for (const m of [ids.memFam, ids.memXpriv]) {
      if (m) await db.execute(sql`DELETE FROM memories WHERE id = ${m}::uuid`);
    }
    for (const room of [ids.rPrivRoom, ids.xPrivRoom, ids.famRoom]) {
      if (room) await db.delete(rooms).where(eq(rooms.id, room));
    }
    for (const ns of [ids.rPrivNs, ids.xPrivNs, ids.famNs]) {
      if (ns) await db.delete(namespaces).where(eq(namespaces.id, ns));
    }
    for (const u of [ids.rUser, ids.xUser, ids.yUser]) {
      if (u) {
        await db.delete(actors).where(eq(actors.ownerId, u));
        await db.delete(users).where(eq(users.id, u));
      }
    }
  } finally {
    await db.end();
  }
});

describe("M173 memory GET filters — subset-rule semantics", () => {
  test("?room=Fam → only memories visible from the {R,X,Y} room (X's private excluded)", async () => {
    const fam = await db
      .select({ humanActorIds: rooms.humanActorIds })
      .from(rooms)
      .where(eq(rooms.id, ids.famRoom))
      .limit(1);
    const readable = await findReadableNamespacesForSubset(fam[0]!.humanActorIds);
    // Fam ns is reachable; X-priv (humans {X} ⊉ {R,X,Y}) is NOT.
    expect(readable).toContain(ids.famNs);
    expect(readable).not.toContain(ids.xPrivNs);
    expect(readable).not.toContain(ids.rPrivNs);

    const visible = await memoriesVisibleIn(readable);
    expect(visible.has(ids.memFam)).toBe(true);
    expect(visible.has(ids.memXpriv)).toBe(false);
  });

  test("?person=X → intersection(subset[X], subset[R]); X's private row is NOT leaked to R", async () => {
    const personReadable = await findReadableNamespacesForSubset([ids.xActor]);
    const requesterReadable = await findReadableNamespacesForSubset([ids.rActor]);

    // X alone CAN see their own private row (proves intersection is what excludes it).
    const personVisible = await memoriesVisibleIn(personReadable);
    expect(personVisible.has(ids.memXpriv)).toBe(true);
    expect(personVisible.has(ids.memFam)).toBe(true);

    const reqSet = new Set(requesterReadable);
    const effective = personReadable.filter((ns) => reqSet.has(ns));
    // Intersection is exactly the shared room — R's private and X's private drop out.
    expect(effective).toContain(ids.famNs);
    expect(effective).not.toContain(ids.xPrivNs);
    expect(effective).not.toContain(ids.rPrivNs);

    const visible = await memoriesVisibleIn(effective);
    expect(visible.has(ids.memFam)).toBe(true);
    // The leak guard: R must NOT learn about X's private memory via ?person=X.
    expect(visible.has(ids.memXpriv)).toBe(false);
  });

  test("requester's full read set (default room {R}) sees Fam but never X's private", async () => {
    const requesterReadable = await findReadableNamespacesForSubset([ids.rActor]);
    expect(requesterReadable).toContain(ids.rPrivNs);
    expect(requesterReadable).toContain(ids.famNs);
    expect(requesterReadable).not.toContain(ids.xPrivNs);
  });
});
