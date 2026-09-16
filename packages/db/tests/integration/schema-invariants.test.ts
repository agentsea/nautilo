import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  and,
  count,
  eq,
  inArray,
  isNull,
  sql,
  users,
  actors,
  agents,
  relayTokens,
  fileRevisions,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  jobs,
  profiles,
  invites,
  groups,
  FILE_REVISION_KIND,
  FILE_REVISION_OPERATION,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

type Db = ReturnType<typeof createDirectDb>;

let db: Db;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(5);
});

afterAll(async () => {
  await db.end();
});

async function createUser(name: string): Promise<string> {
  const ts = Date.now();
  const [u] = await db
    .insert(users)
    .values({
      name,
      email: `${name}-${ts}@m067a.test`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("createUser");
  return u.id;
}

async function createAgent(label: string): Promise<string> {
  const [a] = await db
    .insert(agents)
    .values({
      handle: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
    .returning({ id: agents.id });
  if (!a) throw new Error("createAgent");
  return a.id;
}

async function createHumanActor(ownerId: string, label: string): Promise<string> {
  const [a] = await db
    .insert(actors)
    .values({
      ownerId,
      displayName: label,
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!a) throw new Error("createHumanActor");
  return a.id;
}

function expectPgError(
  fn: () => PromiseLike<unknown>,
  pattern: RegExp,
): Promise<void> {
  return expect(Promise.resolve(fn())).rejects.toThrow(
    pattern,
  ) as unknown as Promise<void>;
}

async function expectNamedCheckViolation(
  fn: () => PromiseLike<unknown>,
  constraint: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const chain: unknown[] = [];
    let current: unknown = err;
    while (current && typeof current === "object") {
      chain.push(current);
      current = (current as { cause?: unknown }).cause;
    }
    const codes = chain.map(
      (entry) => (entry as { code?: unknown }).code,
    );
    const constraints = chain.map(
      (entry) => (entry as { constraint_name?: unknown; constraint?: unknown })
        .constraint_name ??
        (entry as { constraint?: unknown }).constraint,
    );
    const messages = chain.map((entry) => String(entry));
    expect(codes).toContain("23514");
    expect(
      constraints.includes(constraint) ||
        messages.some((message) => message.includes(constraint)),
    ).toBe(true);
    return;
  }
  throw new Error(`expected CHECK violation for ${constraint}`);
}

describe("CHECK and partial unique constraints (live Postgres)", () => {
  test("users.external_id partial unique allows many NULLs", async () => {
    const a = await createUser("ext-null-a");
    const b = await createUser("ext-null-b");
    await db.delete(users).where(eq(users.id, a));
    await db.delete(users).where(eq(users.id, b));
  });

  test("users.external_id partial unique rejects duplicate non-NULL", async () => {
    const userA = await createUser("ext-dup-a");
    const userB = await createUser("ext-dup-b");
    const shared = `logto-sub-shared-${Date.now()}`;
    await db.update(users).set({ externalId: shared }).where(eq(users.id, userA));
    await expectPgError(
      async () => {
        await db.update(users).set({ externalId: shared }).where(eq(users.id, userB));
      },
      /external_id|unique/i,
    );
    await db.delete(users).where(eq(users.id, userA));
    await db.delete(users).where(eq(users.id, userB));
  });

  test("relay_tokens.token_hash is globally unique", async () => {
    const u1 = await createUser("relay-u1");
    const u2 = await createUser("relay-u2");
    const a1 = await createHumanActor(u1, "a1");
    const a2 = await createHumanActor(u2, "a2");
    const hash = `deadbeef${Date.now()}`;
    await db.insert(relayTokens).values({
      userId: u1,
      actorId: a1,
      tokenHash: hash,
      label: "d1",
    });
    await expectPgError(
      async () => {
        await db.insert(relayTokens).values({
          userId: u2,
          actorId: a2,
          tokenHash: hash,
          label: "d2",
        });
      },
      /token_hash|unique/i,
    );
    await db.delete(relayTokens).where(eq(relayTokens.tokenHash, hash));
    await db.delete(actors).where(eq(actors.id, a1));
    await db.delete(actors).where(eq(actors.id, a2));
    await db.delete(users).where(eq(users.id, u1));
    await db.delete(users).where(eq(users.id, u2));
  });

  test("invites.kind must be claim|server|agent|room", async () => {
    const u = await createUser("invite-kind");
    await expectPgError(
      async () => {
        await db.insert(invites).values({
          tokenHash: `th-${Date.now()}-a`,
          kind: "bogus",
          createdBy: u,
        });
      },
      /invites_kind_chk|check|constraint|23514|Failed query/i,
    );
    await db.delete(users).where(eq(users.id, u));
  });

  test("invites token_hash unique", async () => {
    const u = await createUser("invite-hash");
    const [membersGroup] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, "members"))
      .limit(1);
    if (!membersGroup) throw new Error("members group not seeded");
    const th = `tokhash-${Date.now()}`;
    // Post-0063 (M128 unify-server-invites): kind ∈ {claim, server} and a
    // `server` invite MUST carry a non-NULL target_group_id
    // (invites_group_kind_chk). Both inserts therefore use the valid
    // shape; only the duplicate token_hash should trip the unique index.
    await db.insert(invites).values({
      tokenHash: th,
      kind: "server",
      createdBy: u,
      targetGroupId: membersGroup.id,
    });
    await expectPgError(
      async () => {
        await db.insert(invites).values({
          tokenHash: th,
          kind: "server",
          createdBy: u,
          targetGroupId: membersGroup.id,
        });
      },
      /token_hash|unique/i,
    );
    await db.delete(invites).where(eq(invites.tokenHash, th));
    await db.delete(users).where(eq(users.id, u));
  });

  test("partial unique uq_invites_claim_unredeemed (one active claim)", async () => {
    const [existing] = await db
      .select({ n: count() })
      .from(invites)
      .where(
        and(
          eq(invites.kind, "claim"),
          eq(invites.usedCount, 0),
          isNull(invites.revokedAt),
        ),
      );
    if ((existing?.n ?? 0) > 0) {
      console.warn(
        "[schema-invariants] skip partial-unique claim test: DB already has an unredeemed `claim` invite (global partial unique allows only one).",
      );
      return;
    }

    const ts = Date.now();
    const thA = `m067a-clm-${ts}-a`;
    const thB = `m067a-clm-${ts}-b`;
    await db.insert(invites).values({
      tokenHash: thA,
      kind: "claim",
      usedCount: 0,
      revokedAt: null,
    });
    await expectPgError(
      async () => {
        await db.insert(invites).values({
          tokenHash: thB,
          kind: "claim",
          usedCount: 0,
          revokedAt: null,
        });
      },
      /uq_invites_claim_unredeemed|unique|23505|Failed query/i,
    );
    await db.delete(invites).where(eq(invites.tokenHash, thA));
  });

  test("profiles.user_id is NOT NULL at the database", async () => {
    await expectPgError(
      async () => {
        await db.execute(
          sql`INSERT INTO profiles (id, user_id, name) VALUES (gen_random_uuid(), NULL, 'x')`,
        );
      },
      /null|not null|violates/i,
    );
  });
});

describe("FK ON DELETE behaviour we rely on", () => {
  test("delete user cascades relay_tokens", async () => {
    const u = await createUser("cascade-relay");
    const a = await createHumanActor(u, "relay-owner");
    const hash = `cascade-${Date.now()}`;
    await db.insert(relayTokens).values({
      userId: u,
      actorId: a,
      tokenHash: hash,
      label: "dev",
    });
    await db.delete(users).where(eq(users.id, u));
    const left = await db.select().from(relayTokens).where(eq(relayTokens.tokenHash, hash));
    expect(left.length).toBe(0);
  });

  test("delete user cascades rooms (and namespace survives — no FK from room to user on namespace)", async () => {
    const u = await createUser("cascade-room");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "ns" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: u,
        type: "private",
        label: "r",
        graphThreadId: `gt-${Date.now()}`,
        namespaceId: ns.id,
        humanActorIds: [],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    await db.delete(users).where(eq(users.id, u));
    const roomsLeft = await db.select().from(rooms).where(eq(rooms.id, room.id));
    expect(roomsLeft.length).toBe(0);
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
  });

  test("delete user cascades file_revisions via owner_id", async () => {
    const u = await createUser("cascade-fr");
    const [agent] = await db
      .insert(agents)
      .values({ handle: `h-${Date.now()}` })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent");
    const [rev] = await db
      .insert(fileRevisions)
      .values({
        ownerId: u,
        agentId: agent.id,
        turnId: "t1",
        absolutePath: "/tmp/x",
        preSha256: "abc",
        preSize: 0,
        kind: FILE_REVISION_KIND.DIFF,
        diffText: "",
        operation: FILE_REVISION_OPERATION.WRITE,
      })
      .returning({ id: fileRevisions.id });
    if (!rev) throw new Error("rev");
    await db.delete(users).where(eq(users.id, u));
    const left = await db.select().from(fileRevisions).where(eq(fileRevisions.id, rev.id));
    expect(left.length).toBe(0);
    await db.delete(agents).where(eq(agents.id, agent.id));
  });

  test("delete room cascades room_members", async () => {
    const u = await createUser("cascade-rm");
    const actor = await createHumanActor(u, "member");
    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "ns2" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("ns");
    const [room] = await db
      .insert(rooms)
      .values({
        ownerId: u,
        type: "private",
        label: "r2",
        graphThreadId: `gt2-${Date.now()}`,
        namespaceId: ns.id,
        humanActorIds: [actor],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    await db.insert(roomMembers).values({ roomId: room.id, actorId: actor });
    await db.delete(rooms).where(eq(rooms.id, room.id));
    const rm = await db.select().from(roomMembers).where(eq(roomMembers.roomId, room.id));
    expect(rm.length).toBe(0);
    await db.delete(actors).where(eq(actors.id, actor));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(users).where(eq(users.id, u));
  });

  test("delete user is blocked while a job row references owner_id (NO ACTION)", async () => {
    const u = await createUser("job-fk");
    await db.insert(jobs).values({
      ownerId: u,
      requestorId: u,
      type: "test",
      status: "queued",
    });
    await expectPgError(
      async () => {
        await db.delete(users).where(eq(users.id, u));
      },
      /foreign key|violates|23503|Failed query/i,
    );
    await db.delete(jobs).where(eq(jobs.ownerId, u));
    await db.delete(users).where(eq(users.id, u));
  });

  test("delete user is blocked while profile exists (NO ACTION on profiles.user_id)", async () => {
    const u = await createUser("prof-fk");
    const ag = await createAgent("prof-fk-agent");
    await db.insert(profiles).values({ userId: u, agentId: ag, name: "P" });
    await expectPgError(
      async () => {
        await db.delete(users).where(eq(users.id, u));
      },
      /foreign key|violates|23503|Failed query/i,
    );
    await db.delete(profiles).where(eq(profiles.userId, u));
    await db.delete(users).where(eq(users.id, u));
    await db.delete(agents).where(eq(agents.id, ag));
  });
});

// D418 — relay_tokens.installation_id stable desktop pairing identity.
// Requires a live Postgres with migration 0099 applied.
describe("D418 — relay_tokens.installation_id partial unique (live Postgres)", () => {
  test("two active rows for the same (user, installation) are rejected", async () => {
    const u = await createUser("d418-dup");
    const a = await createHumanActor(u, "d418-dup-actor");
    const installId = "11111111-2222-3333-4444-555555555555";
    await db.insert(relayTokens).values({
      userId: u,
      actorId: a,
      tokenHash: `d418-dup-${Date.now()}-a`,
      label: "d1",
      installationId: installId,
    });
    await expectPgError(
      async () => {
        await db.insert(relayTokens).values({
          userId: u,
          actorId: a,
          tokenHash: `d418-dup-${Date.now()}-b`,
          label: "d2",
          installationId: installId,
        });
      },
      /uq_relay_tokens_user_installation_active|unique|23505|Failed query/i,
    );
    await db.delete(relayTokens).where(eq(relayTokens.userId, u));
    await db.delete(actors).where(eq(actors.id, a));
    await db.delete(users).where(eq(users.id, u));
  });

  test("two active rows with NULL installation_id are allowed (legacy dup)", async () => {
    const u = await createUser("d418-legacy");
    const a = await createHumanActor(u, "d418-legacy-actor");
    await db.insert(relayTokens).values({
      userId: u,
      actorId: a,
      tokenHash: `d418-leg-${Date.now()}-a`,
      label: "l1",
    });
    await db.insert(relayTokens).values({
      userId: u,
      actorId: a,
      tokenHash: `d418-leg-${Date.now()}-b`,
      label: "l2",
    });
    const active = await db
      .select()
      .from(relayTokens)
      .where(and(eq(relayTokens.userId, u), isNull(relayTokens.revokedAt)));
    expect(active.length).toBe(2);
    await db.delete(relayTokens).where(eq(relayTokens.userId, u));
    await db.delete(actors).where(eq(actors.id, a));
    await db.delete(users).where(eq(users.id, u));
  });

  test("revoking the active row frees the (user, installation) slot for a new pair", async () => {
    const u = await createUser("d418-repair");
    const a = await createHumanActor(u, "d418-repair-actor");
    const installId = "22222222-3333-4444-5555-666666666666";
    await db.insert(relayTokens).values({
      userId: u,
      actorId: a,
      tokenHash: `d418-rep-${Date.now()}-a`,
      label: "old",
      installationId: installId,
    });
    await db
      .update(relayTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(relayTokens.userId, u),
          eq(relayTokens.installationId, installId),
          isNull(relayTokens.revokedAt),
        ),
      );
    // Now a fresh active row for the same (user, installation) is allowed.
    await db.insert(relayTokens).values({
      userId: u,
      actorId: a,
      tokenHash: `d418-rep-${Date.now()}-b`,
      label: "new",
      installationId: installId,
    });
    const active = await db
      .select()
      .from(relayTokens)
      .where(and(eq(relayTokens.userId, u), isNull(relayTokens.revokedAt)));
    expect(active.length).toBe(1);
    expect(active[0]?.label).toBe("new");
    await db.delete(relayTokens).where(eq(relayTokens.userId, u));
    await db.delete(actors).where(eq(actors.id, a));
    await db.delete(users).where(eq(users.id, u));
  });

  test("installation_id is scoped per user (same install id, different users, both active)", async () => {
    const u1 = await createUser("d418-scope-a");
    const u2 = await createUser("d418-scope-b");
    const a1 = await createHumanActor(u1, "d418-scope-a-actor");
    const a2 = await createHumanActor(u2, "d418-scope-b-actor");
    const installId = "33333333-4444-5555-6666-777777777777";
    await db.insert(relayTokens).values({
      userId: u1,
      actorId: a1,
      tokenHash: `d418-sc-${Date.now()}-a`,
      label: "u1",
      installationId: installId,
    });
    await db.insert(relayTokens).values({
      userId: u2,
      actorId: a2,
      tokenHash: `d418-sc-${Date.now()}-b`,
      label: "u2",
      installationId: installId,
    });
    const active = await db
      .select()
      .from(relayTokens)
      .where(and(isNull(relayTokens.revokedAt), eq(relayTokens.installationId, installId)));
    expect(active.length).toBe(2);
    await db.delete(relayTokens).where(eq(relayTokens.userId, u1));
    await db.delete(relayTokens).where(eq(relayTokens.userId, u2));
    await db.delete(actors).where(eq(actors.id, a1));
    await db.delete(actors).where(eq(actors.id, a2));
    await db.delete(users).where(eq(users.id, u1));
    await db.delete(users).where(eq(users.id, u2));
  });
});

// M132 — Profile↔Agent 1:1 invariants.
describe("M132 — profiles.agent_id 1:1 (live Postgres)", () => {
  test("insert profile with agent_id reads back", async () => {
    const u = await createUser("m132-rt");
    const ag = await createAgent("m132-rt-agent");
    const [row] = await db
      .insert(profiles)
      .values({ userId: u, agentId: ag, name: "Genie" })
      .returning({ id: profiles.id, agentId: profiles.agentId });
    expect(row?.agentId).toBe(ag);
    await db.delete(profiles).where(eq(profiles.userId, u));
    await db.delete(users).where(eq(users.id, u));
    await db.delete(agents).where(eq(agents.id, ag));
  });

  test("second profile with same agent_id violates uq_profiles_agent_id", async () => {
    const u1 = await createUser("m132-dup1");
    const u2 = await createUser("m132-dup2");
    const ag = await createAgent("m132-dup-agent");
    await db.insert(profiles).values({ userId: u1, agentId: ag, name: "A" });
    await expectPgError(
      async () => {
        await db.insert(profiles).values({ userId: u2, agentId: ag, name: "B" });
      },
      /duplicate key|unique|23505|Failed query/i,
    );
    await db.delete(profiles).where(eq(profiles.agentId, ag));
    await db.delete(users).where(eq(users.id, u1));
    await db.delete(users).where(eq(users.id, u2));
    await db.delete(agents).where(eq(agents.id, ag));
  });

  test("two profiles same user_id but different agent_id now succeed (multi-Agent readiness)", async () => {
    const u = await createUser("m132-multi");
    const ag1 = await createAgent("m132-multi-a1");
    const ag2 = await createAgent("m132-multi-a2");
    await db.insert(profiles).values({ userId: u, agentId: ag1, name: "A1" });
    await db.insert(profiles).values({ userId: u, agentId: ag2, name: "A2" });
    const rows = await db.select().from(profiles).where(eq(profiles.userId, u));
    expect(rows.length).toBe(2);
    await db.delete(profiles).where(eq(profiles.userId, u));
    await db.delete(users).where(eq(users.id, u));
    await db.delete(agents).where(eq(agents.id, ag1));
    await db.delete(agents).where(eq(agents.id, ag2));
  });

  test("insert profile with NULL agent_id fails NOT NULL", async () => {
    const u = await createUser("m132-null");
    await expectPgError(
      async () => {
        // @ts-expect-error — intentionally omitting the required agentId.
        await db.insert(profiles).values({ userId: u, name: "N" });
      },
      /not-null|null value|23502|Failed query/i,
    );
    await db.delete(users).where(eq(users.id, u));
  });

  test("idx_profiles_user_id is non-unique; uq_profiles_agent_id is unique", async () => {
    const idx = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'profiles'
        AND indexname IN ('idx_profiles_user_id', 'uq_profiles_agent_id')
    `);
    const rows = idx as unknown as { indexname: string; indexdef: string }[];
    const userIdx = rows.find((r) => r.indexname === "idx_profiles_user_id");
    const agentIdx = rows.find((r) => r.indexname === "uq_profiles_agent_id");
    expect(userIdx).toBeDefined();
    expect(userIdx?.indexdef.includes("UNIQUE")).toBe(false);
    expect(agentIdx).toBeDefined();
    expect(agentIdx?.indexdef.includes("UNIQUE")).toBe(true);
  });
});

describe("D111 / migration 0046 — subthread substrate columns", () => {
  test("rooms and session_messages expose expected D111 columns", async () => {
    const roomCols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'rooms'
        AND column_name IN ('kind','parent_room_id','thread_root_message_id')
    `);
    const roomNames = new Set(
      (roomCols as unknown as { column_name: string }[]).map((r) => r.column_name),
    );
    expect(roomNames.has("kind")).toBe(true);
    expect(roomNames.has("parent_room_id")).toBe(true);
    expect(roomNames.has("thread_root_message_id")).toBe(true);

    const smCols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_messages'
        AND column_name IN ('subthread_room_id','reply_count','last_reply_at','summary_revision')
    `);
    const smNames = new Set(
      (smCols as unknown as { column_name: string }[]).map((r) => r.column_name),
    );
    expect(smNames.has("subthread_room_id")).toBe(true);
    expect(smNames.has("reply_count")).toBe(true);
    expect(smNames.has("last_reply_at")).toBe(true);
    expect(smNames.has("summary_revision")).toBe(true);
  });

  test("D426 — session_messages.summary_revision defaults to 0 and is NOT NULL", async () => {
    const u = await createUser("d426-sumrev");
    const [ag] = await db
      .insert(agents)
      .values({ handle: `d426-ag-${Date.now()}` })
      .returning({ id: agents.id });
    if (!ag) throw new Error("agent");
    const [sess] = await db
      .insert(sessions)
      .values({
        threadId: `d426-sumrev-${Date.now()}`,
        ownerId: u,
        agentId: ag.id,
        personaId: "owner",
        channel: "tui",
      })
      .returning({ id: sessions.id });
    if (!sess) throw new Error("sess");
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId: sess.id, role: "user", content: "root" })
      .returning({
        id: sessionMessages.id,
        replyCount: sessionMessages.replyCount,
        lastReplyAt: sessionMessages.lastReplyAt,
        summaryRevision: sessionMessages.summaryRevision,
      });
    if (!msg) throw new Error("msg");
    expect(msg.replyCount).toBe(0);
    expect(msg.lastReplyAt).toBeNull();
    expect(msg.summaryRevision).toBe(0);

    await db.delete(sessionMessages).where(eq(sessionMessages.id, msg.id));
    await db.delete(sessions).where(eq(sessions.id, sess.id));
    await db.delete(agents).where(eq(agents.id, ag.id));
    await db.delete(users).where(eq(users.id, u));
  });
});

// D418 Wave 2 / Stack 193 — system-managed Group discriminator (migration 0100).
// Requires a live Postgres with migration 0100 applied.
describe("D418 — groups.is_system + groups_system_owner_check (live Postgres)", () => {
  test("groups.is_system column exists and is NOT NULL DEFAULT false", async () => {
    const cols = await db.execute(sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'groups' AND column_name = 'is_system'
    `);
    const row = (cols as unknown as { is_nullable: string; column_default: string | null }[])[0];
    expect(row).toBeDefined();
    expect(row?.is_nullable).toBe("NO");
    expect(row?.column_default).toBe("false");
  });

  test("groups.owner_id is nullable after migration 0100", async () => {
    const cols = await db.execute(sql`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'groups' AND column_name = 'owner_id'
    `);
    const row = (cols as unknown as { is_nullable: string }[])[0];
    expect(row?.is_nullable).toBe("YES");
  });

  test("CHECK rejects is_system=true with a non-NULL owner_id", async () => {
    const u = await createUser("d418-sys-owner");
    await expectNamedCheckViolation(
      async () => {
        await db.execute(
          sql`INSERT INTO "groups" (owner_id, type, label, trust_preset, is_system) VALUES (${u}, 'd418-sys-bad', 'bad', 'personal', true)`,
        );
      },
      "groups_system_owner_check",
    );
    await db.delete(users).where(eq(users.id, u));
  });

  test("CHECK rejects is_system=false with a NULL owner_id", async () => {
    await expectNamedCheckViolation(
      async () => {
        await db.execute(
          sql`INSERT INTO "groups" (owner_id, type, label, trust_preset, is_system) VALUES (NULL, 'd418-user-bad', 'bad', 'personal', false)`,
        );
      },
      "groups_system_owner_check",
    );
  });

  test("CHECK accepts is_system=true with NULL owner_id (system-managed Group)", async () => {
    const type = `d418-sys-ok-${Date.now().toString(36)}`;
    await db.execute(
      sql`INSERT INTO "groups" (owner_id, type, label, trust_preset, is_system) VALUES (NULL, ${type}, 'sys-ok', 'personal', true)`,
    );
    const [row] = await db
      .select({ id: groups.id, isSystem: groups.isSystem, ownerId: groups.ownerId })
      .from(groups)
      .where(eq(groups.type, type))
      .limit(1);
    expect(row?.isSystem).toBe(true);
    expect(row?.ownerId).toBeNull();
    await db.delete(groups).where(eq(groups.id, row!.id));
  });

  test("CHECK accepts is_system=false with a non-NULL owner_id (user-managed Group)", async () => {
    const u = await createUser("d418-user-owner");
    const type = `d418-user-ok-${Date.now().toString(36)}`;
    await db.execute(
      sql`INSERT INTO "groups" (owner_id, type, label, trust_preset, is_system) VALUES (${u}, ${type}, 'user-ok', 'personal', false)`,
    );
    const [row] = await db
      .select({ id: groups.id, isSystem: groups.isSystem, ownerId: groups.ownerId })
      .from(groups)
      .where(eq(groups.type, type))
      .limit(1);
    expect(row?.isSystem).toBe(false);
    expect(row?.ownerId).toBe(u);
    await db.delete(groups).where(eq(groups.id, row!.id));
    await db.delete(users).where(eq(users.id, u));
  });

  test("the six canonical ladder Groups are system-managed (is_system=true, owner_id NULL)", async () => {
    const rows = await db
      .select({ type: groups.type, isSystem: groups.isSystem, ownerId: groups.ownerId })
      .from(groups)
      .where(
        inArray(groups.type, [
          "owners",
          "admins",
          "superusers",
          "members",
          "contributors",
          "guests",
        ]),
      );
    expect(rows.length).toBe(6);
    for (const r of rows) {
      expect(r.isSystem).toBe(true);
      expect(r.ownerId).toBeNull();
    }
  });

  test("deleting a Human does not cascade-delete a system-managed Group", async () => {
    // System-managed Group carries owner_id NULL, so the
    // groups_owner_id_users_id_fk ON DELETE CASCADE cannot fire.
    const type = `d418-cascade-${Date.now().toString(36)}`;
    await db.execute(
      sql`INSERT INTO "groups" (owner_id, type, label, trust_preset, is_system) VALUES (NULL, ${type}, 'cascade-sys', 'personal', true)`,
    );
    const [group] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, type))
      .limit(1);
    expect(group).toBeDefined();
    const u = await createUser("d418-cascade-user");
    await db.delete(users).where(eq(users.id, u));
    // Group survives the user delete (no Human owner to cascade).
    const left = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, group!.id));
    expect(left.length).toBe(1);
    await db.delete(groups).where(eq(groups.id, group!.id));
  });
});
