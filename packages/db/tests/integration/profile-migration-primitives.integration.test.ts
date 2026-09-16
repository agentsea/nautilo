/**
 * D425 Wave 1A — integration coverage for the transaction-aware profile /
 * identity primitives in `profile-migration-primitives.ts`.
 *
 * Exercises the real Postgres transaction handle that `createDirectDb()`
 * hands to `db.transaction(async (tx) => …)` and asserts:
 *   - `renameAgentProfileIdentityInTx` single-sources the name + syncs the
 *     actor cache + auto-derives / freezes the handle, all on the caller's tx.
 *   - `setAgentHandleInTx` enforces uniqueness across Agents AND local Humans.
 *   - `applyProfileIdentityInTx` customized intent: succeeds on a free handle
 *     (freezes it) and FAILS CLOSED on collision (no auto-suffix), rolling the
 *     name/actor writes back with the caller's transaction.
 *   - `applyProfileIdentityInTx` auto intent: REGENERATES the derived handle
 *     from the portable name and never replays the source's allocated string.
 *   - `computeTargetStateDigestInTx` is a stable 64-hex digest that changes
 *     when the target identity surface moves (stale-plan detection).
 *
 * Run against a named instance, e.g.:
 *   NAUTILO_INSTANCE_ID=qa-source bun test packages/db/tests/integration/profile-migration-primitives.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  and,
  createDirectDb,
  eq,
  profiles,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";
import {
  applyProfileIdentityInTx,
  applyWave1AProfileFieldsInTx,
  computeTargetStateDigestInTx,
  HandleCollisionError,
  renameAgentProfileIdentityInTx,
  setAgentHandleInTx,
  type ProfileMigrationTx,
  type Wave1AProfilePayload,
} from "../../src/utils/profile-migration-primitives";

let db: DirectDatabase;

const ts = Date.now().toString(36);
const OWNER_HANDLE = `d425o${ts}`.slice(0, 28);
let ownerUserId = "";

const createdAgentIds = new Set<string>();
const createdActorIds = new Set<string>();
const createdUserIds = new Set<string>();

function rand(): string {
  return Math.random().toString(36).slice(2, 7).replace(/[^a-z]/g, "x") || "abc";
}

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
  // Reuse the db-package integration convention: bootstrap + ensureDatabase
  // so the scratch DB is migrated before we touch it.
  const { ensureDatabase } = await import("@nautilo/db");
  await ensureDatabase();
  db = createDirectDb(1);

  const [owner] = await db
    .insert(users)
    .values({
      name: "D425 owner",
      email: `d425-owner-${ts}@test.local`,
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

describe("D425 renameAgentProfileIdentityInTx (caller-owned transaction)", () => {
  test("auto-derives handle + syncs profile.name and actor cache, committed by the caller's tx", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const tag = rand();
    const name = `Nova ${tag}`;
    const expectedSlug = `nova_${tag}`;

    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      renameAgentProfileIdentityInTx(tx, { ownerUserId, agentId, name }),
    );

    expect(res.name).toBe(name);
    expect(res.handle).toBe(expectedSlug);
    // Writes are visible after the caller's transaction commits.
    expect((await readAgentRow(agentId))?.handle).toBe(expectedSlug);
    expect((await readAgentRow(agentId))?.handleCustomized).toBe(false);
    expect(await readActorName(agentId)).toBe(name);
    expect(await readProfileName(agentId)).toBe(name);
  });

  test("frozen customized handle: name + actor update, handle unchanged", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const custom = `mybot${rand()}`;

    const set = await db.transaction(async (tx: ProfileMigrationTx) =>
      setAgentHandleInTx(tx, agentId, custom),
    );
    expect(set.ok).toBe(true);
    expect((await readAgentRow(agentId))?.handleCustomized).toBe(true);

    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      renameAgentProfileIdentityInTx(tx, { ownerUserId, agentId, name: "Renamed Bot" }),
    );

    expect(res.handle).toBe(custom);
    expect((await readAgentRow(agentId))?.handle).toBe(custom);
    expect(await readActorName(agentId)).toBe("Renamed Bot");
    expect(await readProfileName(agentId)).toBe("Renamed Bot");
  });

  test("rolls back atomically when the agent-kind actor mirror is missing", async () => {
    // Agent with a pre-existing profile but NO actor mirror.
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
      await db.transaction(async (tx: ProfileMigrationTx) =>
        renameAgentProfileIdentityInTx(tx, { ownerUserId, agentId: agent.id, name: "After" }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // The profile-name write rolled back with the failed actor sync.
    expect(await readProfileName(agent.id)).toBe("Before");
  });
});

describe("D425 setAgentHandleInTx — uniqueness across Agents AND local Humans", () => {
  test("free handle → ok and freezes", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const handle = `freebot${rand()}`;
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      setAgentHandleInTx(tx, agentId, handle),
    );
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

    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      setAgentHandleInTx(tx, agentId, taken),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("handle_taken");
    const after = await readAgentRow(agentId);
    expect(after?.handle).toBe(before?.handle);
    expect(after?.handleCustomized).toBe(false);
  });

  test("handle taken by a local Human (users.server IS NULL) → handle_taken", async () => {
    const humanHandle = `human${rand()}`;
    const [u] = await db
      .insert(users)
      .values({
        name: "D425 collider",
        email: `d425-collide-${rand()}@test.local`,
        handle: humanHandle,
      })
      .returning({ id: users.id });
    if (!u) throw new Error("collider user insert failed");
    createdUserIds.add(u.id);

    const { agentId } = await makeAgent(`seed_${rand()}`);
    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      setAgentHandleInTx(tx, agentId, humanHandle),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("handle_taken");
    expect((await readAgentRow(agentId))?.handleCustomized).toBe(false);
  });
});

describe("D425 applyProfileIdentityInTx — customized handle fail-closed + auto regeneration", () => {
  test("customized intent on a FREE handle → applied and frozen", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const custom = `jeannie${rand()}`;

    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      applyProfileIdentityInTx(tx, {
        ownerUserId,
        agentId,
        name: "Jeannie",
        handleIntent: { kind: "customized", handle: custom },
      }),
    );

    expect(res.name).toBe("Jeannie");
    expect(res.handle).toBe(custom);
    expect(res.handleCustomized).toBe(true);
    expect((await readAgentRow(agentId))?.handle).toBe(custom);
    expect((await readAgentRow(agentId))?.handleCustomized).toBe(true);
    expect(await readProfileName(agentId)).toBe("Jeannie");
    expect(await readActorName(agentId)).toBe("Jeannie");
  });

  test("customized intent on a COLLIDING handle → HandleCollisionError, target unchanged", async () => {
    const collide = `collide${rand()}`;
    await makeBareAgent(collide); // occupy the handle
    const { agentId } = await makeAgent(`seed_${rand()}`);
    // Give the target a known prior identity to prove rollback.
    await db
      .insert(profiles)
      .values({ userId: ownerUserId, agentId, name: "Before" });

    let caught: HandleCollisionError | null = null;
    try {
      await db.transaction(async (tx: ProfileMigrationTx) =>
        applyProfileIdentityInTx(tx, {
          ownerUserId,
          agentId,
          name: "Jeannie",
          handleIntent: { kind: "customized", handle: collide },
        }),
      );
    } catch (err) {
      if (err instanceof HandleCollisionError) caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("handle_collision");
    expect(caught?.handle).toBe(collide);
    // Fail closed: no auto-suffix was allocated.
    expect((await readAgentRow(agentId))?.handleCustomized).toBe(false);
    // The caller's transaction rolled back: profile.name is unchanged.
    expect(await readProfileName(agentId)).toBe("Before");
  });

  test("customized intent with an invalid handle → throws (no write)", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    let threw = false;
    try {
      await db.transaction(async (tx: ProfileMigrationTx) =>
        applyProfileIdentityInTx(tx, {
          ownerUserId,
          agentId,
          name: "Jeannie",
          handleIntent: { kind: "customized", handle: "1bad" },
        }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await readProfileName(agentId)).toBeNull();
  });

  test("auto intent regenerates the derived handle from the name (never replays the source string)", async () => {
    const { agentId } = await makeAgent(`source_alloc_${rand()}`);
    // Pretend the source had an auto-derived handle the target must NOT copy.
    const tag = rand();
    const name = `Nova ${tag}`;
    const expectedSlug = `nova_${tag}`;

    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      applyProfileIdentityInTx(tx, {
        ownerUserId,
        agentId,
        name,
        handleIntent: { kind: "auto" },
      }),
    );

    expect(res.handle).toBe(expectedSlug);
    expect(res.handleCustomized).toBe(false);
    expect((await readAgentRow(agentId))?.handle).toBe(expectedSlug);
  });

  test("auto intent falls back to slug_<ownerHandle> when the bare slug is taken", async () => {
    const base = `zen${rand()}`;
    await makeBareAgent(base); // occupy the bare slug
    const { agentId } = await makeAgent(`seed_${rand()}`);

    const res = await db.transaction(async (tx: ProfileMigrationTx) =>
      applyProfileIdentityInTx(tx, {
        ownerUserId,
        agentId,
        name: base,
        handleIntent: { kind: "auto" },
      }),
    );

    expect(res.handle).toBe(`${base}_${OWNER_HANDLE}`);
    expect(res.handleCustomized).toBe(false);
  });
});

describe("D425 computeTargetStateDigestInTx — stale-plan detection", () => {
  test("returns a 64-char hex digest", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const d = await db.transaction(async (tx: ProfileMigrationTx) =>
      computeTargetStateDigestInTx(tx, agentId),
    );
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  test("digest is stable across reads in the same state, changes after an identity mutation", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    const before = await db.transaction(async (tx: ProfileMigrationTx) =>
      computeTargetStateDigestInTx(tx, agentId),
    );
    const reread = await db.transaction(async (tx: ProfileMigrationTx) =>
      computeTargetStateDigestInTx(tx, agentId),
    );
    expect(reread).toBe(before);

    // Mutate the identity surface.
    await db.transaction(async (tx: ProfileMigrationTx) =>
      applyProfileIdentityInTx(tx, {
        ownerUserId,
        agentId,
        name: `Renamed ${rand()}`,
        handleIntent: { kind: "auto" },
      }),
    );

    const after = await db.transaction(async (tx: ProfileMigrationTx) =>
      computeTargetStateDigestInTx(tx, agentId),
    );
    expect(after).not.toBe(before);
  });
});

describe("D425 applyWave1AProfileFieldsInTx — frozen allowlist fields on the caller's tx", () => {
  async function readProfileRow(agentId: string) {
    const [row] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.agentId, agentId))
      .limit(1);
    return row;
  }

  test("applies the allowed Wave 1A fields (sparse) without touching `name`", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    // Create the profiles row + sync the actor cache via the identity primitive,
    // exactly as the importer does (identity first, then fields).
    await db.transaction(async (tx: ProfileMigrationTx) =>
      applyProfileIdentityInTx(tx, {
        ownerUserId,
        agentId,
        name: "Source Name",
        handleIntent: { kind: "auto" },
      }),
    );

    const payload: Wave1AProfilePayload = {
      soulFile: "imported soul",
      personalityPrompt: "warm and dry",
      personalityTone: "concise",
      motherAnswer: "the sea",
      language: "es",
      voices: { default: { voiceId: "v1", voiceName: "Lucia" } },
      voiceName: "Lucia",
      voiceId: "v1",
      defaultModel: "anthropic:claude-sonnet-4-6",
      fallbackEnabled: true,
      fallbackChain: ["anthropic:claude-haiku-4-5"],
      privacySpectrum: 2,
      workLifeMode: "both",
      // name + every undefined field must be left untouched.
    };

    await db.transaction(async (tx: ProfileMigrationTx) =>
      applyWave1AProfileFieldsInTx(tx, agentId, payload),
    );

    const row = await readProfileRow(agentId);
    expect(row).toBeDefined();
    expect(row?.name).toBe("Source Name"); // identity-owned, NOT overwritten
    expect(row?.soulFile).toBe("imported soul");
    expect(row?.personalityPrompt).toBe("warm and dry");
    expect(row?.personalityTone).toBe("concise");
    expect(row?.motherAnswer).toBe("the sea");
    expect(row?.language).toBe("es");
    expect(row?.voices).toEqual({ default: { voiceId: "v1", voiceName: "Lucia" } });
    expect(row?.voiceName).toBe("Lucia");
    expect(row?.voiceId).toBe("v1");
    expect(row?.defaultModel).toBe("anthropic:claude-sonnet-4-6");
    expect(row?.fallbackEnabled).toBe(true);
    expect(row?.fallbackChain).toEqual(["anthropic:claude-haiku-4-5"]);
    expect(row?.privacySpectrum).toBe(2);
    expect(row?.workLifeMode).toBe("both");
    expect(row?.avatarRef).toBeNull();
  });

  test("sparse: undefined payload fields leave the target column untouched", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    await db.transaction(async (tx: ProfileMigrationTx) =>
      applyProfileIdentityInTx(tx, {
        ownerUserId,
        agentId,
        name: "Keeper",
        handleIntent: { kind: "auto" },
      }),
    );
    // Seed a couple of fields with known values, then apply a payload that
    // omits them and asserts they survive.
    await db
      .update(profiles)
      .set({ soulFile: "keep-me", language: "fr" })
      .where(eq(profiles.agentId, agentId));

    await db.transaction(async (tx: ProfileMigrationTx) =>
      applyWave1AProfileFieldsInTx(tx, agentId, {
        personalityPrompt: "new prompt",
        // soulFile + language deliberately undefined
      }),
    );

    const row = await readProfileRow(agentId);
    expect(row?.personalityPrompt).toBe("new prompt");
    expect(row?.soulFile).toBe("keep-me"); // untouched
    expect(row?.language).toBe("fr"); // untouched
  });

  test("rolls back atomically when no profiles row exists for the agent", async () => {
    const { agentId } = await makeAgent(`seed_${rand()}`);
    // No profile row exists (identity primitive not run). The fields writer
    // must throw, and a sibling write in the SAME tx must roll back with it.
    let threw = false;
    try {
      await db.transaction(async (tx: ProfileMigrationTx) => {
        // sibling write that should roll back if the fields writer throws
        await tx
          .update(agents)
          .set({ handle: `sibling_${rand()}` })
          .where(eq(agents.id, agentId));
        await applyWave1AProfileFieldsInTx(tx, agentId, { soulFile: "x" });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // The sibling agents.handle update rolled back with the failed fields write.
    const row = await readAgentRow(agentId);
    expect(row?.handle).not.toMatch(/^sibling_/);
  });
});
