import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { agents } from "../schema/agents";
import { rooms, roomMembers } from "../schema/rooms";
import {
  actors,
  channelIdentities,
  credentials,
  namespaces,
} from "../schema/trust";
import { users } from "../schema/users";
import type { DirectDatabase } from "@nautilo/db";
import {
  createRoomJournalStateInTx,
  reconcileRoomJournalMembershipInTx,
} from "../queries/room-journal-state";

type Db = DirectDatabase;
export type InviteSeedTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Post-M128 the per-(Agent, Role) group families (`agent_ownership`,
 * `agent_household`, `agent_teammate`, `agent_guest`) are retired and
 * Groups are server-wide canonical slugs (`owners` / `admins` /
 * `superusers` / `members` / `contributors` / `guests`). The invitee's
 * seat on the Server comes from the invite's `target_group_id` —
 * `redeemInviteAtomically` adds the invitee to that Group separately
 * from the agent flow below.
 */

export interface SeedPersonalAgentResult {
  readonly agentId: string;
  readonly agentActorId: string;
  /**
   * D140 disambiguator preserved post-M128: `"insert"` for a fresh
   * agent INSERT, `"claim-seed"` when `claimBootstrapSeedAgentInTx`
   * retargeted the pre-existing bootstrap-seed agent row in place.
   * Callers (redeem-invite.ts) use this to decide whether to mint a
   * fresh "Personal" room or reuse the pre-claim `seedDefaultRoom`
   * row.
   */
  readonly source: "insert" | "claim-seed";
}

export interface ClaimBootstrapSeedUserResult {
  readonly userId: string;
  readonly userActorId: string;
  readonly source: "claim-seed";
}

/**
 * M128 — mints a personal Agent (resource) for an invitee. Inserts
 * exactly two rows:
 *   1. `agents` — the agent itself.
 *   2. `actors` — the agent-actor mirror so room_members can FK cleanly
 *      across humans + agents.
 *
 * No group writes. Post-M128 there is no per-Agent permission surface;
 * the invitee's seat on the Server is established by the invite's
 * `target_group_id` membership in `redeemInviteAtomically`.
 */
export async function seedPersonalAgentForInviteeInTx(
  tx: InviteSeedTx,
  args: {
    inviteeUserId: string;
    inviteeActorId: string;
    handleSeed: string;
    displayName: string;
  },
): Promise<SeedPersonalAgentResult> {
  void args.displayName;
  const base = `genie_${args.handleSeed}`.slice(0, 20);
  let handle = base;
  for (let attempt = 0; attempt < 50; attempt++) {
    const suffix = attempt === 0 ? "" : `_${attempt}`;
    handle = `${base}${suffix}`.slice(0, 32);
    const [collision] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.handle, handle))
      .limit(1);
    if (!collision) break;
    if (attempt === 49) {
      throw new Error("seedPersonalAgentForInviteeInTx: could not allocate handle");
    }
  }

  const [agent] = await tx
    .insert(agents)
    .values({
      handle,
    })
    .returning({ id: agents.id });
  if (!agent) throw new Error("seedPersonalAgentForInviteeInTx: agent insert failed");

  const [agentActor] = await tx
    .insert(actors)
    .values({
      ownerId: args.inviteeUserId,
      displayName: "Genie",
      trustState: "verified",
      kind: "agent",
      agentId: agent.id,
    })
    .returning({ id: actors.id });
  if (!agentActor) {
    throw new Error("seedPersonalAgentForInviteeInTx: agent actor insert failed");
  }

  return {
    agentId: agent.id,
    agentActorId: agentActor.id,
    source: "insert",
  };
}

/**
 * D140 — claim-handoff path. Re-targets the **bootstrap-seed** Agent
 * (the one minted by `seedDefaultAgent` at server boot, before any
 * claim happens) to the new owner instead of INSERTing a parallel
 * personal Agent. Same agent id, same actor id, same FK relationships
 * preserved — every pre-claim `room_members.actor_id`, etc., continues
 * to resolve correctly after claim.
 *
 * Predicate: the bootstrap-seed agent is **the agent owned by the
 * just-claimed user via its mirror actor's `owner_id` link**. This is
 * reachable because `claimBootstrapSeedUserInTx` UPDATEs the dummy
 * user in place (same `users.id`, new identity fields) and runs
 * BEFORE this function in the redeem dispatcher.
 *
 * Post-M128: no group writes. The invitee's seat on the Server is
 * added by `redeemInviteAtomically` via the invite's
 * `target_group_id` (canonical server-wide Group).
 */
export async function claimBootstrapSeedAgentInTx(
  tx: InviteSeedTx,
  args: {
    inviteeUserId: string;
    inviteeActorId: string;
    handleSeed: string;
    displayName: string;
  },
): Promise<SeedPersonalAgentResult | null> {
  void args.displayName;
  void args.inviteeActorId;
  const [seedActorRow] = await tx
    .select({ id: actors.id, agentId: actors.agentId })
    .from(actors)
    .where(
      and(eq(actors.ownerId, args.inviteeUserId), eq(actors.kind, "agent")),
    )
    .orderBy(actors.createdAt)
    .limit(1);
  if (!seedActorRow || !seedActorRow.agentId) return null;
  const seed = { id: seedActorRow.agentId };

  const base = `genie_${args.handleSeed}`.slice(0, 20);
  let handle = base;
  for (let attempt = 0; attempt < 50; attempt++) {
    const suffix = attempt === 0 ? "" : `_${attempt}`;
    handle = `${base}${suffix}`.slice(0, 32);
    const [collision] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.handle, handle), ne(agents.id, seed.id)))
      .limit(1);
    if (!collision) break;
    if (attempt === 49) {
      throw new Error("claimBootstrapSeedAgentInTx: could not allocate handle");
    }
  }

  const now = new Date();

  await tx
    .update(agents)
    .set({ handle, updatedAt: now })
    .where(eq(agents.id, seed.id));

  const seedActor = { id: seedActorRow.id };
  await tx
    .update(actors)
    .set({ displayName: "Genie", updatedAt: now })
    .where(eq(actors.id, seedActor.id));

  return {
    agentId: seed.id,
    agentActorId: seedActor.id,
    source: "claim-seed",
  };
}

/**
 * D140 — user-side claim-handoff path. Mirror of
 * `claimBootstrapSeedAgentInTx` for the user identity. Re-targets the
 * bootstrap-seed `users` row (the one minted by `seedDefaultOwner`
 * with `name = "user"`, `email = "owner@example.com"`, and NO
 * `credentials` row) to the new owner instead of INSERTing a parallel
 * user. Same user id, same user-actor id, same FK relationships
 * preserved — every pre-claim `room_members.actor_id`,
 * `rooms.owner_id`, etc. continues to resolve correctly after claim.
 *
 * Predicate (M100-aligned): the bootstrap-seed user is the row with
 * **no `credentials` rows AND no `external_id`**. After the first
 * claim, the (now-retargeted) row has a credentials row and this
 * predicate returns null; subsequent invitee redeems correctly fall
 * back to INSERT.
 */
export async function claimBootstrapSeedUserInTx(
  tx: InviteSeedTx,
  args: {
    name: string;
    /**
     * Nullable post-M107: local-install users sign up without email
     * (`users.email` is now nullable; bind-logto-user passes `null`).
     */
    email: string | null;
    /**
     * Final handle to stamp on the seed row. Pass `null` for M105's
     * browser-mediated half-redeem path, where the handle is chosen
     * later in `completeInviteProfile`. Post-M107 the bind path passes
     * the user-chosen handle directly here.
     */
    handle: string | null;
    externalId: string | null;
    /**
     * PIN + boot-channel + federated-id side-effects. Pass `null` for
     * M105's half-redeem path; `completeInviteProfile` will enroll PIN
     * and recovery codes through the trust layer instead.
     */
    pin: {
      /** Pre-hashed PIN; caller has already run `hashPin`. */
      hashedPin: string;
      ownerBootChannels: readonly string[];
      federatedId: string;
    } | null;
  },
): Promise<ClaimBootstrapSeedUserResult | null> {
  const [seed] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        sql`NOT EXISTS (
          SELECT 1 FROM ${credentials}
            WHERE ${credentials.userId} = ${users.id}
        )`,
        isNull(users.externalId),
      ),
    )
    .orderBy(users.createdAt)
    .limit(1);
  if (!seed) return null;

  const now = new Date();
  const trimmedName = args.name.trim();

  const [updatedUser] = await tx
    .update(users)
    .set({
      name: trimmedName,
      email: args.email,
      handle: args.handle,
      externalId: args.externalId,
      server: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(users.id, seed.id),
        isNull(users.externalId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${credentials}
            WHERE ${credentials.userId} = ${users.id}
        )`,
      ),
    )
    .returning({ id: users.id });
  if (!updatedUser) {
    return null;
  }

  const [existingActor] = await tx
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, seed.id), eq(actors.kind, "user")))
    .limit(1);

  let userActorId: string;
  if (existingActor) {
    await tx
      .update(actors)
      .set({ displayName: trimmedName, updatedAt: now })
      .where(eq(actors.id, existingActor.id));
    userActorId = existingActor.id;
  } else {
    const [insertedActor] = await tx
      .insert(actors)
      .values({
        ownerId: seed.id,
        displayName: trimmedName,
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!insertedActor) {
      throw new Error(
        "claimBootstrapSeedUserInTx: user-actor INSERT failed (post-seed-defense)",
      );
    }
    userActorId = insertedActor.id;
  }

  if (args.pin) {
    for (const channel of args.pin.ownerBootChannels) {
      await tx
        .delete(channelIdentities)
        .where(
          and(
            eq(channelIdentities.userId, seed.id),
            eq(channelIdentities.channel, channel),
          ),
        );
      await tx.insert(channelIdentities).values({
        channel,
        externalId: args.pin.federatedId,
        userId: seed.id,
        verifiedAt: now,
      });
    }

    await tx.insert(credentials).values({
      userId: seed.id,
      type: "pin",
      value: args.pin.hashedPin,
    });
  }

  return {
    userId: seed.id,
    userActorId,
    source: "claim-seed",
  };
}

/**
 * Private 1:1 room between a user-actor and an agent (graphThreadId =
 * `room:<id>`).
 */
export async function seedPersonalPrivateRoomInTx(
  tx: InviteSeedTx,
  args: {
    ownerUserId: string;
    ownerActorId: string;
    agentId: string;
    label: string;
  },
): Promise<{ roomId: string }> {
  const [agentActor] = await tx
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, args.agentId), eq(actors.kind, "agent")))
    .limit(1);
  if (!agentActor) {
    throw new Error("seedPersonalPrivateRoomInTx: missing agent actor");
  }

  const roomId = randomUUID();
  const graphThreadId = `room:${roomId}`;

  const [nsRow] = await tx
    .insert(namespaces)
    .values({ scope: "private", label: args.label })
    .returning({ id: namespaces.id });
  if (!nsRow) throw new Error("seedPersonalPrivateRoomInTx: namespace insert failed");

  await tx.insert(rooms).values({
    id: roomId,
    ownerId: args.ownerUserId,
    type: "private",
    label: args.label,
    graphThreadId,
    namespaceId: nsRow.id,
    humanActorIds: [args.ownerActorId],
    createdBy: args.ownerActorId,
  });
  await createRoomJournalStateInTx(tx, roomId);

  await tx.insert(roomMembers).values([
    { roomId, actorId: args.ownerActorId, roomRole: "admin" },
    { roomId, actorId: agentActor.id, roomRole: "member" },
  ]);
  await reconcileRoomJournalMembershipInTx(tx, [roomId]);

  return { roomId };
}

// M128 D2 (2026-05-28): `seedInviterAgentPrivateRoomInTx` removed.
// Pre-M128 invitees got a 1:1 DM room with the inviter's agent on
// `kind=agent` redeem. Post-M128 every invitee redeems with a Personal
// Agent + Personal Room of their own (seeded via
// `seedPersonalAgentForInviteeInTx` + `seedPersonalPrivateRoomInTx`)
// and cross-Human chat happens in shared Rooms (M042B). The
// inviter-DM room was unreachable from any production redeem path
// after the first-pass commit `78056a7b` (only the unit-isolated
// test mock referenced it). See ISSUE-M128 §10 D2.
