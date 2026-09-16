/**
 * D168 P2 (Stack 11.5) — Path C RLS seven-scenario integration test.
 *
 * Verifies the row-level security policies added by migration
 * `0050_d168_p2_rls_path_c.sql` against a real Postgres. Test fixture
 * seeds two Humans (A, B), two private Rooms + Namespaces (one per
 * Human), one family Room + Namespace (both Humans), and one
 * multi-Agent Room (Human A + two Agents). Then connects as the
 * `nautilo_agent` role and exercises the seven scenarios below.
 *
 * The seven scenarios:
 *
 *   1. No GUCs set                  → all RLS-protected tables return 0 rows
 *   2. userId=A only (auth shape)   → credentials/recovery_codes return A's
 *                                      rows; namespace-scoped tables visible
 *                                      via A's room memberships (agentId-NULL
 *                                      branch of the policy)
 *   3. userId=A + agentId=AgentA,
 *      private-Room context         → A sees memories in N_A_private; CANNOT
 *                                      see memories in N_B_private
 *   4. userId=A + agentId=AgentA,
 *      family-Room context          → A sees family memories; STILL CANNOT
 *                                      see B's private memories (the headline
 *                                      "Alice can't read dad's stuff" assertion)
 *   5. Multi-Agent same Room        → agentA + agentB in R_multi; each Agent
 *                                      sees only its own agent_id-scoped rows
 *   6. Speaker-owned scope          → userId=A reading agent_scopes for AgentA
 *                                      returns A's scopes only; B's scopes NOT
 *                                      visible to A
 *   7. Credentials per-row          → userId=A reading credentials returns A's
 *                                      rows only; queries omitting userId GUC
 *                                      return 0 rows
 *
 * Test provisions grants for the nautilo_agent role inline via
 * `createDirectDb()` (superuser path, bypasses RLS by default).
 * Connects as nautilo_agent via `resolveDirectAgentDatabaseConnectionString()`
 * (same credential as runtime `agentDb`). Setup must NOT rotate an existing
 * role password — shared dev-stack DBs rely on the operator-configured secret.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  ensureDatabase,
  createDirectDb,
  resolveDirectAgentDatabaseConnectionString,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const AGENT_ROLE = "nautilo_agent";

/** Password used only when CREATE ROLE runs (role absent). Never ALTER on existing role. */
function resolveAgentPasswordForProvisioning(): string {
  const password = new URL(
    resolveDirectAgentDatabaseConnectionString(),
  ).password;
  if (!password) {
    throw new Error(
      "RLS integration test: set DB_AGENT_DIRECT_CONNECTION or NAUTILO_AGENT_DB_PASSWORD for nautilo_agent",
    );
  }
  return decodeURIComponent(password);
}

async function provisionAgentRoleAndPolicies(
  db: ReturnType<typeof createDirectDb>,
): Promise<void> {
  // Idempotent grants; CREATE ROLE only when missing. Never ALTER … PASSWORD on
  // an existing role — that would clobber shared dev-stack credentials.
  const agentPassword = resolveAgentPasswordForProvisioning().replace(
    /'/g,
    "''",
  );
  await db.execute(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AGENT_ROLE}') THEN
        EXECUTE format('CREATE ROLE ${AGENT_ROLE} LOGIN PASSWORD %L', '${agentPassword}');
      END IF;
    END $$;
  `);
  await db.execute(`GRANT CONNECT ON DATABASE nautilo TO ${AGENT_ROLE}`);
  await db.execute(`GRANT USAGE ON SCHEMA public TO ${AGENT_ROLE}`);
  await db.execute(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${AGENT_ROLE};
  `);
  await db.execute(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${AGENT_ROLE};
  `);
  // RLS forces enforcement on the table OWNER (nautilo) too; without
  // FORCE the owner bypasses the policy. For this test we want to
  // exercise the policy AS the nautilo_agent role; the nautilo
  // superuser doing the fixture inserts uses BYPASSRLS implicitly.
  // We don't FORCE here because the migration also doesn't FORCE
  // (DEFERRED until D168 P3 lands the credentials chokepoint).
}

interface Fixture {
  userA: string;
  userB: string;
  actorA: string;
  actorB: string;
  agentA: string;
  agentB: string;
  agentActorA: string;
  agentActorB: string;
  nsAPrivate: string;
  nsBPrivate: string;
  nsFamily: string;
  nsMulti: string;
  roomAPrivate: string;
  roomBPrivate: string;
  roomFamily: string;
  roomMulti: string;
  memoryAPrivate: string;
  memoryBPrivate: string;
  memoryFamily: string;
  memoryAgentAInMulti: string;
  memoryAgentBInMulti: string;
  scopeASpeaker: string;
  scopeBSpeaker: string;
  credAId: string;
  credBId: string;
}

async function seedFixture(
  db: ReturnType<typeof createDirectDb>,
): Promise<Fixture> {
  // Wipe any leftover test rows from a previous run. Tag rows by an
  // email prefix so we can clean up surgically.
  const TAG = "d168p2-rls-test-";
  await db.execute(`DELETE FROM memory_namespaces WHERE memory_id IN (SELECT id FROM memories WHERE content LIKE '${TAG}%')`);
  await db.execute(`DELETE FROM memories WHERE content LIKE '${TAG}%'`);
  await db.execute(`DELETE FROM agent_scopes WHERE name LIKE '${TAG}%'`);
  await db.execute(`DELETE FROM credentials WHERE value LIKE '${TAG}%'`);
  await db.execute(`DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE namespace_id IN (SELECT id FROM namespaces WHERE label LIKE '${TAG}%'))`);
  await db.execute(`DELETE FROM rooms WHERE namespace_id IN (SELECT id FROM namespaces WHERE label LIKE '${TAG}%')`);
  await db.execute(`DELETE FROM namespaces WHERE label LIKE '${TAG}%'`);
  await db.execute(`DELETE FROM actors WHERE display_name LIKE '${TAG}%'`);
  await db.execute(`DELETE FROM agents WHERE handle LIKE '${TAG}%'`);
  await db.execute(`DELETE FROM users WHERE email LIKE '${TAG}%' OR name LIKE '${TAG}%'`);

  // Seed Users
  const ts = Date.now();
  const userA = await db.execute(
    `INSERT INTO users (name, email) VALUES ('${TAG}alice', '${TAG}alice-${ts}@x.test') RETURNING id`,
  );
  const userB = await db.execute(
    `INSERT INTO users (name, email) VALUES ('${TAG}bob', '${TAG}bob-${ts}@x.test') RETURNING id`,
  );
  const uA = (userA as unknown as Array<{ id: string }>)[0]!.id;
  const uB = (userB as unknown as Array<{ id: string }>)[0]!.id;

  // Seed Agents. The display name is single-sourced on profiles.name; this
  // fixture only needs agent ids plus actor mirrors.
  const agentA = await db.execute(
    `INSERT INTO agents (handle) VALUES ('${TAG}agentA-${ts}') RETURNING id`,
  );
  const agentB = await db.execute(
    `INSERT INTO agents (handle) VALUES ('${TAG}agentB-${ts}') RETURNING id`,
  );
  const aA = (agentA as unknown as Array<{ id: string }>)[0]!.id;
  const aB = (agentB as unknown as Array<{ id: string }>)[0]!.id;

  // Seed user-kind Actor rows (one per user)
  const actA = await db.execute(
    `INSERT INTO actors (owner_id, display_name, kind) VALUES ('${uA}', '${TAG}alice-actor', 'user') RETURNING id`,
  );
  const actB = await db.execute(
    `INSERT INTO actors (owner_id, display_name, kind) VALUES ('${uB}', '${TAG}bob-actor', 'user') RETURNING id`,
  );
  const acA = (actA as unknown as Array<{ id: string }>)[0]!.id;
  const acB = (actB as unknown as Array<{ id: string }>)[0]!.id;

  // Seed agent-kind Actor rows (one per agent). owner_id can point at either user; for test purposes use userA as the creator.
  const aActA = await db.execute(
    `INSERT INTO actors (owner_id, display_name, kind, agent_id) VALUES ('${uA}', '${TAG}agentA-mirror', 'agent', '${aA}') RETURNING id`,
  );
  const aActB = await db.execute(
    `INSERT INTO actors (owner_id, display_name, kind, agent_id) VALUES ('${uA}', '${TAG}agentB-mirror', 'agent', '${aB}') RETURNING id`,
  );
  const agAA = (aActA as unknown as Array<{ id: string }>)[0]!.id;
  const agAB = (aActB as unknown as Array<{ id: string }>)[0]!.id;

  // Seed Namespaces
  const mkNs = async (label: string): Promise<string> => {
    const r = await db.execute(
      `INSERT INTO namespaces (scope, label) VALUES ('private', '${TAG}${label}') RETURNING id`,
    );
    return (r as unknown as Array<{ id: string }>)[0]!.id;
  };
  const nsAPrivate = await mkNs("ns-A-private");
  const nsBPrivate = await mkNs("ns-B-private");
  const nsFamily = await mkNs("ns-family");
  const nsMulti = await mkNs("ns-multi");

  // Seed Rooms (one per namespace; REL-NSP-RMS 1:1).
  // NOT NULL columns: owner_id (users.id), type, label, graph_thread_id,
  // namespace_id, human_actor_ids (default '{}').
  const mkRoom = async (
    nsId: string,
    ownerId: string,
    label: string,
  ): Promise<string> => {
    const r = await db.execute(
      `INSERT INTO rooms (namespace_id, owner_id, type, label, graph_thread_id) VALUES ('${nsId}', '${ownerId}', 'private', '${TAG}${label}', 'thread-${TAG}${label}-${ts}') RETURNING id`,
    );
    return (r as unknown as Array<{ id: string }>)[0]!.id;
  };
  const roomAPrivate = await mkRoom(nsAPrivate, uA, "room-A-private");
  const roomBPrivate = await mkRoom(nsBPrivate, uB, "room-B-private");
  const roomFamily = await mkRoom(nsFamily, uA, "room-family");
  const roomMulti = await mkRoom(nsMulti, uA, "room-multi");

  // Seed room_members
  const addMember = async (roomId: string, actorId: string): Promise<void> => {
    await db.execute(
      `INSERT INTO room_members (room_id, actor_id) VALUES ('${roomId}', '${actorId}')`,
    );
  };
  // Room A private: Alice + AgentA
  await addMember(roomAPrivate, acA);
  await addMember(roomAPrivate, agAA);
  // Room B private: Bob + AgentA
  await addMember(roomBPrivate, acB);
  await addMember(roomBPrivate, agAA);
  // Family: Alice + Bob + AgentA
  await addMember(roomFamily, acA);
  await addMember(roomFamily, acB);
  await addMember(roomFamily, agAA);
  // Multi-agent: Alice + AgentA + AgentB
  await addMember(roomMulti, acA);
  await addMember(roomMulti, agAA);
  await addMember(roomMulti, agAB);

  // Seed Memories — one per namespace. M127 dropped memories.agent_id;
  // Namespace membership (via the memory_namespaces junction) is now
  // the only content-scope axis, so memory rows carry no agent_id.
  const mkMemory = async (
    nsId: string,
    contentTag: string,
  ): Promise<string> => {
    const m = await db.execute(
      `INSERT INTO memories (content) VALUES ('${TAG}${contentTag}') RETURNING id`,
    );
    const mId = (m as unknown as Array<{ id: string }>)[0]!.id;
    await db.execute(
      `INSERT INTO memory_namespaces (memory_id, namespace_id) VALUES ('${mId}', '${nsId}')`,
    );
    return mId;
  };
  const memoryAPrivate = await mkMemory(nsAPrivate, "memo-A-private");
  const memoryBPrivate = await mkMemory(nsBPrivate, "memo-B-private");
  const memoryFamily = await mkMemory(nsFamily, "memo-family");
  const memoryAgentAInMulti = await mkMemory(nsMulti, "memo-agentA-multi");
  const memoryAgentBInMulti = await mkMemory(nsMulti, "memo-agentB-multi");

  // Seed agent_scopes (speaker-owned)
  const mkScope = async (speakerId: string, parentAgentId: string, name: string): Promise<string> => {
    const r = await db.execute(
      `INSERT INTO agent_scopes (speaker_user_id, parent_agent_id, name) VALUES ('${speakerId}', '${parentAgentId}', '${TAG}${name}') RETURNING id`,
    );
    return (r as unknown as Array<{ id: string }>)[0]!.id;
  };
  const scopeASpeaker = await mkScope(uA, aA, "scope-A-on-agentA");
  const scopeBSpeaker = await mkScope(uB, aA, "scope-B-on-agentA");

  // Seed Credentials (PIN-shape)
  const mkCred = async (userId: string, tag: string): Promise<string> => {
    const r = await db.execute(
      `INSERT INTO credentials (user_id, type, value) VALUES ('${userId}', 'pin', '${TAG}${tag}') RETURNING id`,
    );
    return (r as unknown as Array<{ id: string }>)[0]!.id;
  };
  const credAId = await mkCred(uA, "credA");
  const credBId = await mkCred(uB, "credB");

  return {
    userA: uA,
    userB: uB,
    actorA: acA,
    actorB: acB,
    agentA: aA,
    agentB: aB,
    agentActorA: agAA,
    agentActorB: agAB,
    nsAPrivate,
    nsBPrivate,
    nsFamily,
    nsMulti,
    roomAPrivate,
    roomBPrivate,
    roomFamily,
    roomMulti,
    memoryAPrivate,
    memoryBPrivate,
    memoryFamily,
    memoryAgentAInMulti,
    memoryAgentBInMulti,
    scopeASpeaker,
    scopeBSpeaker,
    credAId,
    credBId,
  };
}

describe("D168 P2 — Path C RLS (7-scenario integration test)", () => {
  let supDb: ReturnType<typeof createDirectDb>;
  let agentSql: ReturnType<typeof postgres>;
  let f: Fixture;

  beforeAll(async () => {
    bootstrapTestDbInstance();
    await ensureDatabase();
    supDb = createDirectDb(1);
    await provisionAgentRoleAndPolicies(supDb);
    f = await seedFixture(supDb);
    agentSql = postgres(resolveDirectAgentDatabaseConnectionString(), {
      max: 1,
    });
  });

  afterAll(async () => {
    // Clean up fixture rows so reruns + other tests aren't polluted.
    const TAG = "d168p2-rls-test-";
    await supDb.execute(`DELETE FROM memory_namespaces WHERE memory_id IN (SELECT id FROM memories WHERE content LIKE '${TAG}%')`);
    await supDb.execute(`DELETE FROM memories WHERE content LIKE '${TAG}%'`);
    await supDb.execute(`DELETE FROM agent_scopes WHERE name LIKE '${TAG}%'`);
    await supDb.execute(`DELETE FROM credentials WHERE value LIKE '${TAG}%'`);
    await supDb.execute(`DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE namespace_id IN (SELECT id FROM namespaces WHERE label LIKE '${TAG}%'))`);
    await supDb.execute(`DELETE FROM rooms WHERE namespace_id IN (SELECT id FROM namespaces WHERE label LIKE '${TAG}%')`);
    await supDb.execute(`DELETE FROM namespaces WHERE label LIKE '${TAG}%'`);
    await supDb.execute(`DELETE FROM actors WHERE display_name LIKE '${TAG}%'`);
    await supDb.execute(`DELETE FROM agents WHERE handle LIKE '${TAG}%'`);
    await supDb.execute(`DELETE FROM users WHERE email LIKE '${TAG}%' OR name LIKE '${TAG}%'`);
    // Guard both handles: if beforeAll threw mid-setup, one of these may
    // be undefined and an unguarded .end() would mask the real failure.
    if (agentSql) await agentSql.end({ timeout: 1 });
    if (supDb) await supDb.end();
  });

  test("scenario 1: no GUCs set → all RLS-protected tables return 0 rows", async () => {
    await agentSql`RESET app.current_user_id`.catch(() => undefined);
    await agentSql`RESET app.current_agent_id`.catch(() => undefined);
    const mem = await agentSql`SELECT id FROM memories WHERE id = ${f.memoryAPrivate}`;
    expect(mem.length).toBe(0);
    const cred = await agentSql`SELECT id FROM credentials WHERE id = ${f.credAId}`;
    expect(cred.length).toBe(0);
    const scope = await agentSql`SELECT id FROM agent_scopes WHERE id = ${f.scopeASpeaker}`;
    expect(scope.length).toBe(0);
  });

  test("scenario 2: userId=A only → credentials return A's rows; memories visible via room memberships (agentId-NULL branch)", async () => {
    await agentSql.begin(async (sql) => {
      await sql`SELECT set_config('app.current_user_id', ${f.userA}, true)`;
      const cred = await sql`SELECT id FROM credentials WHERE id = ${f.credAId}`;
      expect(cred.length).toBe(1);
      const credB = await sql`SELECT id FROM credentials WHERE id = ${f.credBId}`;
      expect(credB.length).toBe(0);
      // A's private memory visible via her private Room membership
      const memA = await sql`SELECT id FROM memories WHERE id = ${f.memoryAPrivate}`;
      expect(memA.length).toBe(1);
      // B's private memory NOT visible — A is not in B's private room
      const memB = await sql`SELECT id FROM memories WHERE id = ${f.memoryBPrivate}`;
      expect(memB.length).toBe(0);
    });
  });

  test("scenario 3: userId=A + agentId=AgentA, A's-private-Room context → sees A's memories; NOT B's", async () => {
    await agentSql.begin(async (sql) => {
      await sql`SELECT set_config('app.current_user_id', ${f.userA}, true)`;
      await sql`SELECT set_config('app.current_agent_id', ${f.agentA}, true)`;
      const memA = await sql`SELECT id FROM memories WHERE id = ${f.memoryAPrivate}`;
      expect(memA.length).toBe(1);
      const memB = await sql`SELECT id FROM memories WHERE id = ${f.memoryBPrivate}`;
      expect(memB.length).toBe(0);
    });
  });

  test("scenario 4: userId=A in family-Room context → sees family memories; STILL CANNOT see B's private memories", async () => {
    // This is the headline "Alice can't read dad's private memories"
    // assertion. The Path C policy uses direct Room-membership; A is
    // a member of family Room but NOT B's private Room, so B's
    // private memories are not accessible regardless of which Room A
    // is "in" right now.
    await agentSql.begin(async (sql) => {
      await sql`SELECT set_config('app.current_user_id', ${f.userA}, true)`;
      await sql`SELECT set_config('app.current_agent_id', ${f.agentA}, true)`;
      const memFamily = await sql`SELECT id FROM memories WHERE id = ${f.memoryFamily}`;
      expect(memFamily.length).toBe(1);
      const memB = await sql`SELECT id FROM memories WHERE id = ${f.memoryBPrivate}`;
      expect(memB.length).toBe(0);
    });
  });

  test("scenario 5: multi-Agent same Room → M127 namespace-only: co-hosted memories are mutually visible (agent GUC does NOT narrow)", async () => {
    // Pre-M127 each Agent saw only its own agent_id-scoped rows, so two
    // Agents in the same Room could not read each other's memories. M127
    // retired memories.agent_id and the agent-narrowing trailer on the
    // Path C policy (0060_m127_drop_agent_id_from_path_c.sql): Namespace
    // membership is now the ONLY DB-enforced boundary. Both memories live
    // in nsMulti, which Alice (a member of R_multi) can read — so BOTH are
    // visible regardless of which agent_id GUC is set.
    await agentSql.begin(async (sql) => {
      await sql`SELECT set_config('app.current_user_id', ${f.userA}, true)`;
      await sql`SELECT set_config('app.current_agent_id', ${f.agentA}, true)`;
      const memAA = await sql`SELECT id FROM memories WHERE id = ${f.memoryAgentAInMulti}`;
      expect(memAA.length).toBe(1);
      const memAB = await sql`SELECT id FROM memories WHERE id = ${f.memoryAgentBInMulti}`;
      expect(memAB.length).toBe(1);
    });
    // Switching the agent GUC does not change visibility — the axis is gone.
    await agentSql.begin(async (sql) => {
      await sql`SELECT set_config('app.current_user_id', ${f.userA}, true)`;
      await sql`SELECT set_config('app.current_agent_id', ${f.agentB}, true)`;
      const memAA = await sql`SELECT id FROM memories WHERE id = ${f.memoryAgentAInMulti}`;
      expect(memAA.length).toBe(1);
      const memAB = await sql`SELECT id FROM memories WHERE id = ${f.memoryAgentBInMulti}`;
      expect(memAB.length).toBe(1);
    });
  });

  test("scenario 6: speaker-owned scope → A sees A's scopes; B's scopes invisible to A", async () => {
    await agentSql.begin(async (sql) => {
      await sql`SELECT set_config('app.current_user_id', ${f.userA}, true)`;
      const scopeA = await sql`SELECT id FROM agent_scopes WHERE id = ${f.scopeASpeaker}`;
      expect(scopeA.length).toBe(1);
      const scopeB = await sql`SELECT id FROM agent_scopes WHERE id = ${f.scopeBSpeaker}`;
      expect(scopeB.length).toBe(0);
    });
  });

  test("scenario 7: credentials per-row → userId=A returns A's row only; no GUC returns 0 rows", async () => {
    await agentSql.begin(async (sql) => {
      await sql`SELECT set_config('app.current_user_id', ${f.userA}, true)`;
      const credA = await sql`SELECT id FROM credentials WHERE id = ${f.credAId}`;
      expect(credA.length).toBe(1);
      const credB = await sql`SELECT id FROM credentials WHERE id = ${f.credBId}`;
      expect(credB.length).toBe(0);
    });
    // Without setting the GUC, BOTH credentials are invisible
    await agentSql`RESET app.current_user_id`.catch(() => undefined);
    const credAll = await agentSql`SELECT id FROM credentials WHERE id IN (${f.credAId}, ${f.credBId})`;
    expect(credAll.length).toBe(0);
  });
});
