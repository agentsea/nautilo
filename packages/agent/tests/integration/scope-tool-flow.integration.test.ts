/**
 * M080 — scope tools + attach path (live Postgres).
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  actors,
  agents,
  namespaces,
  rooms,
  roomMembers,
  memories,
  memoryNamespaces,
  agentScopes,
  sessions,
  sessionMessages,
  eq,
  or,
  inArray,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  closeScope,
  createScope,
  findScopes,
  resolveSpeakerUserId,
} from "@nautilo/trust";
import { createCreateScopeTool } from "../../src/tools/memory/create-scope";
import { createFindScopeTool } from "../../src/tools/memory/find-scope";
import { createAddMemoryToScopeTool } from "../../src/tools/memory/add-memory-to-scope";
import { createCloseScopeTool } from "../../src/tools/memory/close-scope";


let db: ReturnType<typeof createDirectDb>;

let ownerUserId: string;
let partnerUserId: string;
let ownerHumanActorId: string;
let partnerHumanActorId: string;
let agentId: string;
let agentActorId: string;
let ghostAgentId: string;

let privateNsId: string;
let familyNsId: string;
let privateRoomId: string;
let familyRoomId: string;

function envForOwnerPrivate(): MemoryAccessEnvelope {
  return {
    ownerId: ownerUserId,
    actorId: ownerHumanActorId,
    agentId,
    roomId: privateRoomId,
    readableNamespaces: [privateNsId, familyNsId],
    mutableNamespaces: [privateNsId, familyNsId],
    writableNamespaces: [privateNsId],
    toolPolicy: {},
  };
}

function envForPartnerFamily(): MemoryAccessEnvelope {
  return {
    ownerId: ownerUserId,
    actorId: partnerHumanActorId,
    agentId,
    roomId: familyRoomId,
    readableNamespaces: [familyNsId],
    mutableNamespaces: [familyNsId],
    writableNamespaces: [familyNsId],
    toolPolicy: {},
  };
}

/** Ghost agent envelope with shared-room namespace overlap (for cross-agent attach). */
function envGhostFamilyReadable(): MemoryAccessEnvelope {
  return {
    ownerId: ownerUserId,
    actorId: ownerHumanActorId,
    agentId: ghostAgentId,
    roomId: familyRoomId,
    readableNamespaces: [familyNsId],
    mutableNamespaces: [familyNsId],
    writableNamespaces: [familyNsId],
    toolPolicy: {},
  };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [owner] = await db
    .insert(users)
    .values({
      name: "m080-owner",
      email: `m080o-${ts}@test.local`,
      handle: `m080o${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  const [partner] = await db
    .insert(users)
    .values({
      name: "m080-partner",
      email: `m080p-${ts}@test.local`,
      handle: `m080p${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!owner || !partner) throw new Error("users");
  ownerUserId = owner.id;
  partnerUserId = partner.id;

  const [ownerHuman] = await db
    .insert(actors)
    .values({
      ownerId: ownerUserId,
      displayName: "Owner",
      kind: "user",
    })
    .returning({ id: actors.id });
  const [partnerHuman] = await db
    .insert(actors)
    .values({
      ownerId: partnerUserId,
      displayName: "Partner",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!ownerHuman || !partnerHuman) throw new Error("actors");
  ownerHumanActorId = ownerHuman.id;
  partnerHumanActorId = partnerHuman.id;

  const [ag] = await db
    .insert(agents)
    .values({ handle: `m080-ag-${ts}` })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent");
  agentId = ag.id;

  const [ghost] = await db
    .insert(agents)
    .values({ handle: `m080-ghost-${ts}` })
    .returning({ id: agents.id });
  if (!ghost) throw new Error("ghost");
  ghostAgentId = ghost.id;

  const [agentAct] = await db
    .insert(actors)
    .values({
      ownerId: ownerUserId,
      displayName: "Agent mirror",
      kind: "agent",
      agentId,
    })
    .returning({ id: actors.id });
  if (!agentAct) throw new Error("agent actor");
  agentActorId = agentAct.id;

  const [nsP] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m080-priv-${ts}` })
    .returning({ id: namespaces.id });
  const [nsF] = await db
    .insert(namespaces)
    .values({ scope: "shared", label: `m080-fam-${ts}` })
    .returning({ id: namespaces.id });
  if (!nsP || !nsF) throw new Error("ns");
  privateNsId = nsP.id;
  familyNsId = nsF.id;

  privateRoomId = randomUUID();
  await db.insert(rooms).values({
    id: privateRoomId,
    ownerId: ownerUserId,
    type: "private",
    label: "owner private",
    graphThreadId: `room:${privateRoomId}`,
    namespaceId: privateNsId,
    humanActorIds: [ownerHumanActorId],
  });
  await db.insert(roomMembers).values([
    { roomId: privateRoomId, actorId: ownerHumanActorId, roomRole: "member" },
    { roomId: privateRoomId, actorId: agentActorId, roomRole: "member" },
  ]);

  familyRoomId = randomUUID();
  const sortedHumans = [ownerHumanActorId, partnerHumanActorId].sort();
  await db.insert(rooms).values({
    id: familyRoomId,
    ownerId: ownerUserId,
    type: "shared",
    label: "family",
    graphThreadId: `room:${familyRoomId}`,
    namespaceId: familyNsId,
    humanActorIds: sortedHumans,
  });
  await db.insert(roomMembers).values([
    { roomId: familyRoomId, actorId: ownerHumanActorId, roomRole: "member" },
    { roomId: familyRoomId, actorId: partnerHumanActorId, roomRole: "member" },
    { roomId: familyRoomId, actorId: agentActorId, roomRole: "member" },
  ]);
});

afterAll(async () => {
  if (!db) return;
  await db.delete(agentScopes).where(
    or(eq(agentScopes.parentAgentId, agentId), eq(agentScopes.parentAgentId, ghostAgentId)),
  );
  // M127: memories.agent_id is gone. Teardown reaps by Namespace
  // membership via memory_namespaces, then orphans the rest.
  await db
    .delete(memories)
    .where(
      inArray(
        memories.id,
        db
          .select({ id: memoryNamespaces.memoryId })
          .from(memoryNamespaces)
          .where(inArray(memoryNamespaces.namespaceId, [privateNsId, familyNsId])),
      ),
    );

  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(or(eq(sessions.ownerId, ownerUserId), eq(sessions.ownerId, partnerUserId)));
  const sessionIds = sessionRows.map((s) => s.id);
  if (sessionIds.length > 0) {
    await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    await db.delete(sessions).where(inArray(sessions.id, sessionIds));
  }

  await db.delete(roomMembers).where(eq(roomMembers.roomId, privateRoomId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, familyRoomId));
  await db.delete(rooms).where(eq(rooms.id, privateRoomId));
  await db.delete(rooms).where(eq(rooms.id, familyRoomId));
  await db.delete(namespaces).where(eq(namespaces.id, privateNsId));
  await db.delete(namespaces).where(eq(namespaces.id, familyNsId));

  await db.delete(actors).where(eq(actors.id, agentActorId));
  await db.delete(actors).where(eq(actors.id, ownerHumanActorId));
  await db.delete(actors).where(eq(actors.id, partnerHumanActorId));
  await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(agents).where(eq(agents.id, ghostAgentId));
  await db.delete(users).where(eq(users.id, ownerUserId));
  await db.delete(users).where(eq(users.id, partnerUserId));
  await db.end();
});

describe("M080 scope tool flow (integration)", () => {
  test("resolveSpeakerUserId returns users.id for user-kind actor", async () => {
    const sid = await resolveSpeakerUserId({ actorId: ownerHumanActorId });
    expect(sid).toBe(ownerUserId);
    const nullAgent = await resolveSpeakerUserId({ actorId: agentActorId });
    expect(nullAgent).toBeNull();
  });

  test("happy path: create → attach → find → close; memory_namespaces survives", async () => {
    const [m] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m080-happy-${Date.now()}`,
      })
      .returning({ id: memories.id });
    if (!m) throw new Error("mem");
    await db.insert(memoryNamespaces).values({
      memoryId: m.id,
      namespaceId: familyNsId,
    });

    const scopeRes = await createScope({
      parentAgentId: agentId,
      speakerUserId: ownerUserId,
      name: `scope-${Date.now()}`,
    });
    if ("error" in scopeRes) throw new Error("create");
    const addTool = createAddMemoryToScopeTool({
      memoryAccessEnvelope: envForOwnerPrivate(),
    });
    const msg = await addTool.invoke({ memory_id: m.id, scope_id: scopeRes.scopeId });
    expect(msg).toContain("Attached memory");

    const rows = await findScopes({
      parentAgentId: agentId,
      speakerUserId: ownerUserId,
    });
    expect(rows.some((r) => r.scopeId === scopeRes.scopeId && r.memoryCount === 1)).toBe(
      true,
    );

    const junctionBefore = await db
      .select()
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, m.id));

    const closeT = createCloseScopeTool({ memoryAccessEnvelope: envForOwnerPrivate() });
    const closeMsg = await closeT.invoke({ scope_id: scopeRes.scopeId });
    const closed = JSON.parse(closeMsg) as { closed?: boolean; promoted_memory_count?: number };
    expect(closed.closed).toBe(true);
    expect(typeof closed.promoted_memory_count).toBe("number");

    const junctionAfter = await db
      .select()
      .from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, m.id));
    expect(junctionAfter.length).toBe(junctionBefore.length);

    await db.delete(memories).where(eq(memories.id, m.id));
  });

  test("duplicate scope name returns catalog error string", async () => {
    const name = `dup-${Date.now()}`;
    const tool = createCreateScopeTool({ memoryAccessEnvelope: envForOwnerPrivate() });
    const first = await tool.invoke({ name, purpose: "a" });
    expect(first).toContain("scope_id");
    const second = await tool.invoke({ name, purpose: "b" });
    expect(second).toMatch(/already exists/i);
    const { scope_id } = JSON.parse(first) as { scope_id: string; name: string };
    await closeScope({
      scopeId: scope_id,
      parentAgentId: agentId,
      speakerUserId: ownerUserId,
    });
  });

  test("partner cannot see owner's scopes via find_scope", async () => {
    const name = `iso-${Date.now()}`;
    const created = await createScope({
      parentAgentId: agentId,
      speakerUserId: ownerUserId,
      name,
    });
    if ("error" in created) throw new Error("create");

    const partnerFind = createFindScopeTool({
      memoryAccessEnvelope: envForPartnerFamily(),
    });
    const out = await partnerFind.invoke({});
    expect(out).toContain("no open scopes");

    await closeScope({
      scopeId: created.scopeId,
      parentAgentId: agentId,
      speakerUserId: ownerUserId,
    });
  });

  test("namespace visibility: partner can attach shared memory, not owner-private-only", async () => {
    const [mPrivate] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m080-priv-m-${Date.now()}`,
      })
      .returning({ id: memories.id });
    const [mShared] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m080-shared-m-${Date.now()}`,
      })
      .returning({ id: memories.id });
    if (!mPrivate || !mShared) throw new Error("mem");
    await db.insert(memoryNamespaces).values({
      memoryId: mPrivate.id,
      namespaceId: privateNsId,
    });
    await db.insert(memoryNamespaces).values({
      memoryId: mShared.id,
      namespaceId: familyNsId,
    });

    const scope = await createScope({
      parentAgentId: agentId,
      speakerUserId: partnerUserId,
      name: `p-scope-${Date.now()}`,
    });
    if ("error" in scope) throw new Error("scope");

    const addPartner = createAddMemoryToScopeTool({
      memoryAccessEnvelope: envForPartnerFamily(),
    });
    const bad = await addPartner.invoke({
      memory_id: mPrivate.id,
      scope_id: scope.scopeId,
    });
    expect(bad).toMatch(/don't have access|not found/i);

    const good = await addPartner.invoke({
      memory_id: mShared.id,
      scope_id: scope.scopeId,
    });
    expect(good).toContain("Attached memory");

    await closeScope({
      scopeId: scope.scopeId,
      parentAgentId: agentId,
      speakerUserId: partnerUserId,
    });
    await db.delete(memories).where(eq(memories.id, mPrivate.id));
    await db.delete(memories).where(eq(memories.id, mShared.id));
  });

  test("M127: memory in a readable namespace is attachable regardless of agent (namespaces ⊥ agents)", async () => {
    const [m] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m080-xagent-${Date.now()}`,
      })
      .returning({ id: memories.id });
    if (!m) throw new Error("mem");
    await db.insert(memoryNamespaces).values({
      memoryId: m.id,
      namespaceId: familyNsId,
    });

    const sc = await createScope({
      parentAgentId: ghostAgentId,
      speakerUserId: ownerUserId,
      name: `gattach-${Date.now()}`,
    });
    if ("error" in sc) throw new Error("scope");

    const add = createAddMemoryToScopeTool({
      memoryAccessEnvelope: envGhostFamilyReadable(),
    });
    const out = await add.invoke({ memory_id: m.id, scope_id: sc.scopeId });
    // M127 — Namespace is the ONLY content-scope axis; memories no longer
    // carry agent_id and the Path C policy no longer narrows by
    // app.current_agent_id. The memory lives in familyNs, the ghost
    // agent's envelope can read familyNs, so the attach succeeds even
    // though the scope's parent agent differs from the memory's original
    // author. (Pre-M127 this returned "not found" via the agent-narrowing
    // trailer that has since been removed.)
    expect(out).toContain("Attached memory");

    await closeScope({
      scopeId: sc.scopeId,
      parentAgentId: ghostAgentId,
      speakerUserId: ownerUserId,
    });
    await db.delete(memories).where(eq(memories.id, m.id));
  });

  test("partner can attach legacy null-agent_id memory in shared namespace (namespace overlap, not author)", async () => {
    const [m] = await db
      .insert(memories)
      .values({
        type: "fact",
        content: `m080-null-agent-${Date.now()}`,
      })
      .returning({ id: memories.id });
    if (!m) throw new Error("mem");
    await db.insert(memoryNamespaces).values({
      memoryId: m.id,
      namespaceId: familyNsId,
    });

    const sc = await createScope({
      parentAgentId: agentId,
      speakerUserId: partnerUserId,
      name: `nullag-${Date.now()}`,
    });
    if ("error" in sc) throw new Error("scope");

    const add = createAddMemoryToScopeTool({
      memoryAccessEnvelope: envForPartnerFamily(),
    });
    const out = await add.invoke({ memory_id: m.id, scope_id: sc.scopeId });
    expect(out).toContain("Attached memory");

    await closeScope({
      scopeId: sc.scopeId,
      parentAgentId: agentId,
      speakerUserId: partnerUserId,
    });
    await db.delete(memories).where(eq(memories.id, m.id));
  });

  test("cross-agent: scope not visible for different parent_agent_id", async () => {
    const name = `ghost-${Date.now()}`;
    const created = await createScope({
      parentAgentId: agentId,
      speakerUserId: ownerUserId,
      name,
    });
    if ("error" in created) throw new Error("create");

    const ghostEnv: MemoryAccessEnvelope = {
      ...envForOwnerPrivate(),
      agentId: ghostAgentId,
    };
    const findGhost = createFindScopeTool({ memoryAccessEnvelope: ghostEnv });
    const out = await findGhost.invoke({});
    expect(out).toContain("no open scopes");

    await closeScope({
      scopeId: created.scopeId,
      parentAgentId: agentId,
      speakerUserId: ownerUserId,
    });
  });
});
