/**
 * M156 — integration coverage for single-sourcing the Agent name on
 * `profiles.name` and the auto-derived / user-editable handle.
 *
 * Exercises the real Postgres transaction in
 * `renameAgentProfileIdentity` + `setAgentHandle` (`@nautilo/db`) and the
 * name readers `findAgentById` / `findPersonalAgentsForUser`
 * (`@nautilo/trust`). Maps to ISSUE-M156 §5 (Integration) + Blast-radius
 * scenarios S2 (auto-derive + collision fallbacks), S3 (uniqueness +
 * freeze-on-customize), S4 (pre-claim "Genie" fallback), and S6 (atomic
 * sync — rollback on a missing actor cache).
 *
 * The shared test bootstrap defaults to the disposable `test-cruft` database:
 *   bun test packages/trust/tests/integration/m156-agent-identity.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  and,
  createDirectDb,
  ensureDatabase,
  eq,
  profiles,
  renameAgentProfileIdentity,
  setAgentHandle,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { findAgentById, findPersonalAgentsForUser } from "@nautilo/trust";

let db: ReturnType<typeof createDirectDb>;

const ts = Date.now().toString(36);
const OWNER_HANDLE = `m156o${ts}`.slice(0, 28);
let ownerUserId = "";

// Tracked for cleanup.
const createdAgentIds = new Set<string>();
const createdActorIds = new Set<string>();
const createdUserIds = new Set<string>();

function rand(): string {
  return Math.random().toString(36).slice(2, 7).replace(/[^a-z]/g, "x") || "abc";
}

/** Insert an agent (no profile yet) + its agent-kind actor mirror. */
async function makeAgent(handle: string): Promise<{ agentId: string; actorId: string }> {
  const [agent] = await db.insert(agents).values({ handle }).returning({ id: agents.id });
  if (!agent) throw new Error("agent insert failed");
  createdAgentIds.add(agent.id);
  const [actor] = await db
    .insert(actors)
    .values({ ownerId: ownerUserId, displayName: "Genie", kind: "agent", agentId: agent.id })
    .returning({ id: actors.id });
  if (!actor) throw new Error("actor insert failed");
  createdActorIds.add(actor.id);
  return { agentId: agent.id, actorId: actor.id };
}

/** Insert a bare agent row with a fixed handle (a collision target). */
async function makeBareAgent(handle: string): Promise<string> {
  const [agent] = await db.insert(agents).values({ handle }).returning({ id: agents.id });
  if (!agent) throw new Error("bare agent insert failed");
  createdAgentIds.add(agent.id);
  return agent.id;
}

async function readAgentRow(agentId: string) {
  const [row] = await db
    .select({ handle: agents.handle, handleCustomized: agents.handleCustomized })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row;
}

async function readActorName(agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ displayName: actors.displayName })
    .from(actors)
    .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
    .limit(1);
  return row?.displayName ?? null;
}

async function readProfileName(agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: profiles.name })
    .from(profiles)
    .where(eq(profiles.agentId, agentId))
    .limit(1);
  return row?.name ?? null;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [owner] = await db
    .insert(users)
    .values({
      name: "M156 owner",
      email: `m156-owner-${ts}@test.local`,
      handle: OWNER_HANDLE,
    })
    .returning({ id: users.id });
  if (!owner) throw new Error("owner user insert failed");
  ownerUserId = owner.id;
  createdUserIds.add(owner.id);
});

afterAll(async () => {
  if (!db) return;
  for (const agentId of createdAgentIds) {
    await db.delete(profiles).where(eq(profiles.agentId, agentId));
  }
  for (const actorId of createdActorIds) {
    await db.delete(actors).where(eq(actors.id, actorId));
  }
  for (const agentId of createdAgentIds) {
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
  await db.end();
});

describe("M156 renameAgentProfileIdentity — auto-derive (S2)", () => {
  test("not customized + free base → handle becomes the slug of the name; actor + profile synced", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const base = `nova${rand()}`;
    const name = `Nova ${base.slice(4)}`; // slug → `nova${tag}` (space collapses)
    const expectedSlug = `nova_${base.slice(4)}`;

    const res = await renameAgentProfileIdentity({ ownerUserId, agentId, name });

    expect(res.name).toBe(name);
    expect(res.handle).toBe(expectedSlug);
    const row = await readAgentRow(agentId);
    expect(row?.handle).toBe(expectedSlug);
    expect(row?.handleCustomized).toBe(false);
    expect(await readActorName(agentId)).toBe(name);
    expect(await readProfileName(agentId)).toBe(name);
  });

  test("not customized + base taken by another agent → handle falls back to base_<ownerHandle>", async () => {
    const base = `zin${rand()}`;
    await makeBareAgent(base); // occupy the bare slug
    const { agentId } = await makeAgent(`seed_${rand()}`);

    const res = await renameAgentProfileIdentity({ ownerUserId, agentId, name: base });

    expect(res.handle).toBe(`${base}_${OWNER_HANDLE}`);
    expect((await readAgentRow(agentId))?.handle).toBe(`${base}_${OWNER_HANDLE}`);
  });

  test("base AND base_<ownerHandle> taken → handle falls back to base_<digits>", async () => {
    const base = `qux${rand()}`;
    await makeBareAgent(base);
    await makeBareAgent(`${base}_${OWNER_HANDLE}`);
    const { agentId } = await makeAgent(`seed_${rand()}`);

    const res = await renameAgentProfileIdentity({ ownerUserId, agentId, name: base });

    expect(res.handle).toMatch(new RegExp(`^${base}_\\d{3,4}$`));
    expect((await readAgentRow(agentId))?.handle).toBe(res.handle);
  });

  test("renaming to the same name is idempotent (no handle churn)", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const name = `Echo ${rand()}`;
    const first = await renameAgentProfileIdentity({ ownerUserId, agentId, name });
    const second = await renameAgentProfileIdentity({ ownerUserId, agentId, name });
    expect(second.handle).toBe(first.handle);
  });
});

describe("M156 renameAgentProfileIdentity — customized handle is frozen (S3)", () => {
  test("handle_customized = true → handle unchanged, but actor + profile name still update", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const custom = `mybot${rand()}`;
    const set = await setAgentHandle(agentId, custom);
    expect(set.ok).toBe(true);
    expect((await readAgentRow(agentId))?.handleCustomized).toBe(true);

    const res = await renameAgentProfileIdentity({ ownerUserId, agentId, name: "Renamed Bot" });

    expect(res.handle).toBe(custom); // frozen
    expect((await readAgentRow(agentId))?.handle).toBe(custom);
    expect(await readActorName(agentId)).toBe("Renamed Bot");
    expect(await readProfileName(agentId)).toBe("Renamed Bot");
  });
});

describe("M156 renameAgentProfileIdentity — atomic sync (S6)", () => {
  test("missing agent-kind actor → throws and rolls back; profiles.name is NOT changed", async () => {
    // Agent with a PRE-EXISTING profile but NO actor mirror.
    const [agent] = await db
      .insert(agents)
      .values({ handle: `noactor_${rand()}` })
      .returning({ id: agents.id });
    if (!agent) throw new Error("agent insert failed");
    createdAgentIds.add(agent.id);
    await db
      .insert(profiles)
      .values({ userId: ownerUserId, agentId: agent.id, name: "Before" });

    let threw = false;
    try {
      await renameAgentProfileIdentity({ ownerUserId, agentId: agent.id, name: "After" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The profile-name write must have rolled back with the failed actor step.
    expect(await readProfileName(agent.id)).toBe("Before");
  });
});

describe("M156 setAgentHandle — uniqueness across Agents AND local Humans (S3/D6)", () => {
  test("free handle → ok and handle_customized flips true", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const handle = `freebot${rand()}`;
    const res = await setAgentHandle(agentId, handle);
    expect(res.ok).toBe(true);
    const row = await readAgentRow(agentId);
    expect(row?.handle).toBe(handle);
    expect(row?.handleCustomized).toBe(true);
  });

  test("handle taken by another Agent → handle_taken, no write", async () => {
    const taken = `takenbot${rand()}`;
    await makeBareAgent(taken);
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const before = await readAgentRow(agentId);

    const res = await setAgentHandle(agentId, taken);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("handle_taken");
    const after = await readAgentRow(agentId);
    expect(after?.handle).toBe(before?.handle);
    expect(after?.handleCustomized).toBe(false);
  });

  test("handle taken by a local Human (users.server IS NULL) → handle_taken, no write", async () => {
    const humanHandle = `human${rand()}`;
    const [u] = await db
      .insert(users)
      .values({
        name: "M156 collider",
        email: `m156-collide-${rand()}@test.local`,
        handle: humanHandle,
      })
      .returning({ id: users.id });
    if (!u) throw new Error("collider user insert failed");
    createdUserIds.add(u.id);

    const { agentId } = await makeAgent(`seed_${rand()}`);
    const res = await setAgentHandle(agentId, humanHandle);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("handle_taken");
    expect((await readAgentRow(agentId))?.handleCustomized).toBe(false);
  });
});

describe("M156 name readers — profiles.name with 'Genie' fallback (S1/S4)", () => {
  test("agent WITH a profile → findAgentById.displayName === profiles.name", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const name = `Lumen ${rand()}`;
    await renameAgentProfileIdentity({ ownerUserId, agentId, name });

    const found = await findAgentById(agentId);
    expect(found?.displayName).toBe(name);

    const personal = await findPersonalAgentsForUser(ownerUserId);
    const mine = personal.find((a) => a.agentId === agentId);
    expect(mine?.displayName).toBe(name);
  });

  test("agent WITHOUT a profile (pre-claim seed) → displayName falls back to 'Genie'", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);

    const found = await findAgentById(agentId);
    expect(found?.displayName).toBe("Genie");

    const personal = await findPersonalAgentsForUser(ownerUserId);
    const mine = personal.find((a) => a.agentId === agentId);
    expect(mine?.displayName).toBe("Genie");
  });
});
