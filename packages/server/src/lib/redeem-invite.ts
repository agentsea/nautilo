import type { HumanMembershipEventProducer } from "../event-feed/membership-producer";
import { createHash } from "node:crypto";
// D168 P3 — this invite-redemption flow does inline PIN enrollment +
// credential lookup as part of a multi-table transaction (users +
// actors + channel_identities + credentials seeded atomically). The
// `credentials` schema export is allow-listed for this file in
// `eslint.config.mjs` because the work is genuinely transactional
// (PIN inserted alongside the user row that owns it). Both insert
// sites set the trust-context GUC via `setTrustContextOnTx(tx,
// { userId: user.id })` immediately before the credentials insert so
// the FORCE-RLS `credentials_self` policy from migration #48 lets
// the row through. A future refactor SHOULD move these inserts behind
// a `PinChallengeProvider.enrollInTx(tx, userId, pin)` helper so the
// credentials chokepoint owns the SQL; the runtime safety is already
// in place via the GUC set.
import {
  getSharedDirectDb,
  hasClaimedOwner,
  inviteRedemptions,
  invites,
  users,
  actors,
   
  credentials,
  channelIdentities,
  groupMembers,
  profiles,
  rooms,
  roomMembers,
  groups,
  groupRoles,
  roles,
  eq,
  ne,
  and,
  asc,
  isNull,
  markPasswordChangeRequired,
  PASSWORD_CHANGE_REASON,
  setTrustContextOnTx,
  type DirectDatabase,
} from "@nautilo/db";
import {
  claimBootstrapSeedAgentInTx,
  claimBootstrapSeedUserInTx,
  seedPersonalAgentForInviteeInTx,
  seedPersonalPrivateRoomInTx,
} from "@nautilo/db";
import {
  hashPin,
  generateRecoveryCodesInTx,
  findLocalUserByHandle,
  resolveInviteLandingRoomInTx,
  type LogtoAdminClient,
} from "@nautilo/trust";
import { composeFederatedId, getServerHostname, resolveInstance } from "@nautilo/config";
import { bootstrapDirForInstance, markBootstrapUsed } from "@nautilo/operator-secrets";
import { mintLogtoBearerSessionAfterTrustedAuth } from "./logto-bearer-session-after-trusted-auth";
import {
  setBootstrapOwnerId,
  setBootstrapOwnerBound,
  setBootstrapDefaultAgentId,
} from "@nautilo/trust";
import { HANDLE_RE } from "@nautilo/types";

const OWNER_BOOT_CHANNELS = ["tui", "electron", "workbench"] as const;

export type RedeemInput = {
  handle: string;
  displayName: string;
  password: string;
  pin: string;
  email?: string | undefined;
  /** Require rotation for a temporary credential; first-owner setup supplies a permanent password. */
  forcePasswordChange?: boolean | undefined;
};

export type RedeemLogtoSession = {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresIn: number;
  idToken?: string | undefined;
};

export type RedeemSuccess = {
  ok: true;
  recoveryCodes: string[];
  landingRoomId: string;
  newUserId: string;
  newActorId: string;
  logtoSub?: string | undefined;
  /**
   * Logto access bundle for loopback `kind=claim` redeem only (D112 Phase 6).
   * Lets the CLI skip device flow when PAT + token exchange succeeds.
   */
  logtoSession?: RedeemLogtoSession | undefined;
};

export type RedeemFailure = {
  ok: false;
  httpStatus: number;
  error: string;
  code?: string | undefined;
  /** Logto / IdP body or message when `code` is `logto_create_failed`. */
  message?: string | undefined;
};

export type RedeemResult = RedeemSuccess | RedeemFailure;

/**
 * M105 Phase C / M107 Phase 2c — pre-resolved Logto user details for
 * the browser-mediated bind path.
 *
 * M107 rename: `email` → `handle`. A local install identifies users by
 * the Logto username (= Nautilo handle), not email. The bind route now
 * pulls `handle` from the opaque `state` round-tripped through Logto
 * sign-up (packed by `prepare-logto-signup`, unpacked by
 * `bind-logto-user`), asserts it matches `LogtoAdminClient.getUser(sub)
 * .username`, and passes it here. Email is no longer needed at bind time.
 */
export interface BindLogtoUserArgs {
  /**
   * Lowercased handle the invitee chose in the wizard preview step.
   * Validated against `HANDLE_RE` (3–30 lowercase letters/digits/_,
   * letter-leading). Also written verbatim into `users.handle` and used
   * as the personal-agent / private-room seed slug.
   */
  handle: string;
  /** From `LogtoAdminClient.getUser(sub).name`; pass empty string if Logto has none. */
  displayName: string;
}

/**
 * M105 Phase C — input to {@link completeInviteProfile}.
 *
 * M107 Phase 2c: `handle` removed (it is now pinned at bind time, in
 * `redeemInviteWithLogtoSub`). The complete-profile route accepts the
 * field in its HTTP body for **one release** of back-compat: if the
 * field is present and equals the row's persisted handle, the route
 * tolerates it; if it differs, the route returns 409 `handle_mismatch`.
 * That back-compat lives at the route layer (`invites.ts`), not here.
 */
export interface CompleteInviteProfileArgs {
  displayName: string;
  pin: string;
}

/** M105 Phase C — slimmed deps for the split functions. */
export type RedeemInviteSplitDeps = Omit<
  RedeemInviteDeps,
  "logto" | "allowLogtoSessionMint" | "onLogtoTokenMintFailed"
> & {
  /**
   * Test/embedding seam for one exact target connection. Production omits it
   * and continues to use the shared direct runtime handle.
   */
  db?: DirectDatabase | undefined;
};

export type BindLogtoUserResult =
  | { ok: true; actorId: string; userId: string; logtoSub: string }
  | { ok: false; httpStatus: number; error: string; code: string };

export type CompleteInviteProfileResult =
  | {
      ok: true;
      recoveryCodes: string[];
      newUserId: string;
      newActorId: string;
      landingRoomId: string;
    }
  | { ok: false; httpStatus: number; error: string; code: string };

export interface RedeemInviteDeps {
  /** Passive observer, invoked only after completed existing-Room membership commits. */
  onHumanRoomJoined?: HumanMembershipEventProducer | undefined;
  logto: LogtoAdminClient | null;
  /** Synthetic email host when the invitee omits email (Logto). Default `nautilo.local`. */
  syntheticEmailHost?: string | undefined;
  /** Called when Logto `deleteUser` fails after a redeem-time error (M-2 audit). */
  onLogtoCleanupFailed?: ((sub: string, reason: string) => void) | undefined;
  /**
   * Loopback-only: after `kind=claim` redeem under Logto, mint first user tokens
   * via PAT + token exchange (D112 Phase 6).
   */
  allowLogtoSessionMint?: boolean | undefined;
  /** Fired once when claim handoff mint is attempted but PAT/exchange returns no session. */
  onLogtoTokenMintFailed?: ((logtoSub: string) => void) | undefined;
  /** Test doubles for `.bootstrap/.used` (Phase 5). */
  markBootstrapUsedFn?: ((dir: string) => void) | undefined;
  bootstrapDirFn?: (() => string) | undefined;
  // D120 A1.P1 retired the `onPromoteDefault*Failed` hooks: the old
  // promote helpers wrote to config.env (which could fail), and the
  // hooks let callers surface a doctor warning. The replacement is an
  // in-memory cache write inside the redeem tx tail — sync, can't
  // fail, no caller telemetry needed.
}

async function emitCompletedInviteMembership(
  deps: Pick<RedeemInviteDeps, "onHumanRoomJoined">,
  inviteId: string,
  roomId: string,
  userId: string,
  actorId: string,
): Promise<void> {
  try {
    await deps.onHumanRoomJoined?.({
      type: "room.member_joined", roomId,
      subjectUserId: userId, initiatorUserId: userId, initiatorActorId: actorId,
      membershipOccurrenceId: `invite-redemption:${inviteId}:${userId}`,
    });
  } catch {
    // A passive observer cannot undo completed signup or trigger IdP cleanup.
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

function validateRedeemInput(input: RedeemInput): string | null {
  const handle = normalizeHandle(input.handle);
  if (!HANDLE_RE.test(handle)) {
    return "invalid_handle";
  }
  if (input.displayName.trim().length < 1 || input.displayName.length > 200) {
    return "invalid_display_name";
  }
  if (!/^\d{6,8}$/.test(input.pin)) {
    return "invalid_pin";
  }
  if (input.email !== undefined && input.email.trim().length > 0) {
    const e = input.email.trim();
    if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return "invalid_email";
    }
  }
  return null;
}

function validateBindUserArgs(args: BindLogtoUserArgs): string | null {
  const handle = normalizeHandle(args.handle);
  if (!HANDLE_RE.test(handle)) {
    return "invalid_handle";
  }
  // displayName may be empty (Logto user has no `name`); we'll fall back later.
  if (args.displayName.length > 200) {
    return "invalid_display_name";
  }
  return null;
}

function validateCompleteProfileArgs(args: CompleteInviteProfileArgs): string | null {
  if (args.displayName.trim().length < 1 || args.displayName.length > 200) {
    return "invalid_display_name";
  }
  if (!/^\d{6,8}$/.test(args.pin)) return "invalid_pin";
  return null;
}

async function findCompletedLandingRoom(
  db: DirectDatabase,
  invite: { kind: string; targetRoomId: string | null },
  userId: string,
  actorId: string,
): Promise<string> {
  if (invite.targetRoomId) return invite.targetRoomId;

  const [room] = await db
    .select({ id: rooms.id })
    .from(rooms)
    .innerJoin(
      roomMembers,
      and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.actorId, actorId)),
    )
    .where(
      and(
        isNull(rooms.archivedAt),
        invite.kind === "claim" ? eq(rooms.ownerId, userId) : ne(rooms.ownerId, userId),
      ),
    )
    .orderBy(asc(rooms.createdAt), asc(rooms.id))
    .limit(1);
  return room?.id ?? "";
}

/**
 * Parses `inv_<token>` from a pasted URL or raw token string.
 */
export function extractInviteTokenFromInput(raw: string): string | null {
  const s = raw.trim();
  const m = s.match(/\/redeem\/([^/?#]+)/);
  const token = (m?.[1] ?? s).trim();
  if (!token.startsWith("inv_") || token.length < 10) return null;
  return token;
}

class RedeemAbort extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "RedeemAbort";
  }
}

function extractLogtoCreateUserMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const stripped = raw.replace(/^Logto createUser failed: \d+\s*/u, "").trim();
  return stripped.length > 0 ? stripped : raw;
}

export async function redeemInviteAtomically(
  plaintextToken: string,
  input: RedeemInput,
  deps: RedeemInviteDeps,
): Promise<RedeemResult> {
  let joinedExistingRoomId: string | undefined;
  const v = validateRedeemInput(input);
  if (v) {
    return { ok: false, httpStatus: 400, error: v, code: v };
  }

  const handle = normalizeHandle(input.handle);
  const tokenHash = sha256Hex(plaintextToken);

  const probeDb = getSharedDirectDb();
  let logtoSub: string | undefined;
  const [inviteRow] = await probeDb
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, tokenHash))
      .limit(1);

    if (!inviteRow) {
      return { ok: false, httpStatus: 404, error: "not_found", code: "not_found" };
    }
    if (inviteRow.kind === "claim" && await hasClaimedOwner(probeDb)) {
      return { ok: false, httpStatus: 410, error: "used_up", code: "used_up" };
    }
    if (inviteRow.revokedAt) {
      return { ok: false, httpStatus: 410, error: "revoked", code: "revoked" };
    }
    if (inviteRow.expiresAt && inviteRow.expiresAt.getTime() < Date.now()) {
      return { ok: false, httpStatus: 410, error: "expired", code: "expired" };
    }
    if (
      inviteRow.maxUses !== null &&
      inviteRow.usedCount >= inviteRow.maxUses
    ) {
      return { ok: false, httpStatus: 410, error: "used_up", code: "used_up" };
    }

    if (!deps.logto) {
      return {
        ok: false,
        httpStatus: 503,
        error: "logto_unconfigured",
        code: "logto_unconfigured",
      };
    }

    const existingHandleOwner = await findLocalUserByHandle(handle);
    if (existingHandleOwner) {
      return {
        ok: false,
        httpStatus: 409,
        error: "handle_taken",
        code: "handle_taken",
      };
    }

    const host = (deps.syntheticEmailHost ?? "nautilo.local").trim() || "nautilo.local";
    const emailOpt = input.email?.trim();
    const resolvedEmail =
      emailOpt && emailOpt.length > 0 ? emailOpt : `${handle}@${host}`;

    const existing = await deps.logto.findUserByEmailOrUsername(
      null,
      handle,
    );
    if (existing) {
      return {
        ok: false,
        httpStatus: 409,
        error: "handle_taken",
        code: "handle_taken",
      };
    }
    try {
      const created = await deps.logto.createUser({
        username: handle,
        primaryEmail: resolvedEmail,
        name: input.displayName.trim(),
        password: input.password,
      });
      logtoSub = created.id;
    } catch (e) {
      return {
        ok: false,
        httpStatus: 400,
        error: "logto_create_failed",
        code: "logto_create_failed",
        message: extractLogtoCreateUserMessage(e),
      };
    }

    const db = getSharedDirectDb();
    try {
      const outcome = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(invites)
          .where(eq(invites.tokenHash, tokenHash))
          .for("update")
          .limit(1);
        if (!locked) {
          throw new RedeemAbort(404, "not_found");
        }
        if (locked.revokedAt) {
          throw new RedeemAbort(410, "revoked");
        }
        if (locked.expiresAt && locked.expiresAt.getTime() < Date.now()) {
          throw new RedeemAbort(410, "expired");
        }
        if (locked.maxUses !== null && locked.usedCount >= locked.maxUses) {
          throw new RedeemAbort(410, "used_up");
        }

        // D140 — on `kind = "claim"`, re-target the bootstrap-seed
        // `users` row (the one minted by `seedDefaultOwner` with no
        // `credentials` row) in place instead of INSERTing a fresh
        // user. Same user id, same actor id, same FK relationships
        // preserved — every pre-claim `room_members.actor_id` and
        // `rooms.owner_id` continues to resolve correctly. The helper
        // owns the user/actor/channel_identities/credentials slice;
        // profile upsert + recovery codes + agent dispatch + room
        // resolution stay in this function so non-claim invites
        // (kind=agent / kind=room) keep their existing shape.
        //
        // Falls back to the INSERT path below if: (a) kind != "claim"
        // — a new invitee correctly gets a fresh user row; (b) the
        // seed user is missing (already-claimed instance, re-entrant
        // claim, or older pre-D120 instance where the seeder layout
        // was different). In the fallback case `userSource = "insert"`.
        const claimFederatedId = composeFederatedId(
          handle,
          getServerHostname(),
        );
        const hashedPinForClaim = await hashPin(input.pin);
        const claimSeedUser =
          locked.kind === "claim"
            ? await claimBootstrapSeedUserInTx(tx, {
                name: input.displayName.trim(),
                email: resolvedEmail,
                handle,
                externalId: logtoSub ?? null,
                pin: {
                  hashedPin: hashedPinForClaim,
                  ownerBootChannels: OWNER_BOOT_CHANNELS,
                  federatedId: claimFederatedId,
                },
              })
            : null;

        let user: { id: string };
        let actor: { id: string };
        let userSource: "insert" | "claim-seed";

        if (claimSeedUser) {
          user = { id: claimSeedUser.userId };
          actor = { id: claimSeedUser.userActorId };
          userSource = "claim-seed";
        } else {
          const [insertedUser] = await tx
            .insert(users)
            .values({
              name: input.displayName.trim(),
              email: resolvedEmail,
              handle,
              externalId: logtoSub ?? null,
              server: null,
            })
            .returning({ id: users.id });
          if (!insertedUser) throw new Error("user insert failed");
          user = insertedUser;

          const [insertedActor] = await tx
            .insert(actors)
            .values({
              ownerId: user.id,
              displayName: input.displayName.trim(),
              trustState: "verified",
              kind: "user",
            })
            .returning({ id: actors.id });
          if (!insertedActor) throw new Error("actor insert failed");
          actor = insertedActor;

          // D112 Phase 18 — seed `channel_identities` for the new user on
          // every owner-boot channel (tui / electron / workbench). Without
          // these rows, `personal-policy-resolver.findUserByChannelIdentity`
          // returns null for any subsequent bearer presented by this user
          // and the resolver falls through to the stranger envelope.
          // Idempotent against the unique `(channel, external_id)`
          // constraint — `onConflictDoNothing` so a re-run after a partial
          // failure heals.
          const claimNow = new Date();
          for (const channel of OWNER_BOOT_CHANNELS) {
            await tx
              .insert(channelIdentities)
              .values({
                channel,
                externalId: claimFederatedId,
                userId: user.id,
                verifiedAt: claimNow,
              })
              .onConflictDoNothing({
                target: [channelIdentities.channel, channelIdentities.externalId],
              });
          }

          // D168 P3 — establish trust context BEFORE INSERT so the
          // FORCE-RLS `credentials_self` policy lets the row through.
          await setTrustContextOnTx(tx, { userId: user.id });
          await tx.insert(credentials).values({
            userId: user.id,
            type: "pin",
            value: hashedPinForClaim,
          });

          userSource = "insert";
        }

        const recoveryCodes = await generateRecoveryCodesInTx(tx, user.id);

        // D140 — on kind=claim, try to UPDATE the bootstrap-seed agent
        // row (the one minted by `seedDefaultAgent` with no
        // `agent_ownership` group attached) in place. Same agent id,
        // same actor id, same FK relationships preserved. Non-claim
        // invites + seed-missing fallback take the existing INSERT
        // path.
        const claimSeedAgent =
          locked.kind === "claim"
            ? await claimBootstrapSeedAgentInTx(tx, {
                inviteeUserId: user.id,
                inviteeActorId: actor.id,
                handleSeed: handle,
                displayName: input.displayName.trim(),
              })
            : null;
        const personal =
          claimSeedAgent ??
          (await seedPersonalAgentForInviteeInTx(tx, {
            inviteeUserId: user.id,
            inviteeActorId: actor.id,
            handleSeed: handle,
            displayName: input.displayName.trim(),
          }));

        // M132 — the Profile is agent-keyed. INSERT must run AFTER the
        // personal Agent is resolved so we can supply `agent_id`, and
        // the `ON CONFLICT` target is now `profiles.agent_id` (the
        // `UNIQUE(user_id)` index was dropped).
        // ISSUE-D125 / Stack 6 follow-up: profiles.name is the AGENT
        // label rendered in the workbench (via /api/profile →
        // agent.name), NOT the user's own display name. Default to
        // "Genie" on first claim and preserve any existing customized
        // name on conflict (users rename via Settings → Profile).
        const profileNow = new Date();
        await tx
          .insert(profiles)
          .values({
            userId: user.id,
            agentId: personal.agentId,
            name: "Genie",
            onboardingCompleted: false,
            updatedAt: profileNow,
          })
          .onConflictDoUpdate({
            target: profiles.agentId,
            set: {
              onboardingCompleted: false,
              updatedAt: profileNow,
            },
          });

        // D140 — on the claim-seed-user path, the pre-claim
        // `seedDefaultRoom` row already has `room_members` wired to
        // this user-actor + the (now-retargeted) agent-actor. Re-use
        // it instead of INSERTing a parallel "Personal" room. On the
        // INSERT fallback or non-claim invites, seed a fresh private
        // room as before.
        let landingRoomId: string;
        if (userSource === "claim-seed") {
          const [reusedRoom] = await tx
            .select({ id: rooms.id })
            .from(rooms)
            .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
            .where(
              and(
                eq(rooms.ownerId, user.id),
                eq(rooms.type, "private"),
                eq(roomMembers.actorId, actor.id),
              ),
            )
            .limit(1);
          if (reusedRoom) {
            landingRoomId = reusedRoom.id;
          } else {
            // Defensive: claim-seed user resolved but no pre-claim
            // room exists (older instance where seedDefaultRoom never
            // ran). Fall through to INSERT so the claimer doesn't
            // land with a blank room.
            const { roomId: fallbackRoomId } = await seedPersonalPrivateRoomInTx(
              tx,
              {
                ownerUserId: user.id,
                ownerActorId: actor.id,
                agentId: personal.agentId,
                label: "Personal",
              },
            );
            landingRoomId = fallbackRoomId;
          }
        } else {
          const { roomId: personalRoomId } = await seedPersonalPrivateRoomInTx(
            tx,
            {
              ownerUserId: user.id,
              ownerActorId: actor.id,
              agentId: personal.agentId,
              label: "Personal",
            },
          );
          landingRoomId = personalRoomId;
        }
        // M128 unify (2026-05-28, migration 0063): the canonical post-M128
        // kind set is {claim, server}. Every `kind='server'` invite carries
        // `target_group_id` (CHECK invites_group_kind_chk); optionally also
        // carries `target_room_id` when the invitee should also land in a
        // specific Room. Pre-0063 `kind='group'`/`'room'` rows were
        // upgraded in-place by `0063_m128_unify_server_invites`.
        if (locked.kind === "server") {
          if (!locked.targetGroupId) {
            throw new Error("invite_target_invariant");
          }
          const targetRoles = await tx
            .select({ groupType: groups.type, roleSlug: roles.slug })
            .from(groups)
            .leftJoin(groupRoles, eq(groupRoles.groupId, groups.id))
            .leftJoin(roles, eq(roles.id, groupRoles.roleId))
            .where(eq(groups.id, locked.targetGroupId));
          if (targetRoles.some((row) => row.groupType === "communities" || row.roleSlug === "community")) {
            throw new RedeemAbort(409, "community_enrollment_unavailable");
          }
          await tx
            .insert(groupMembers)
            .values({
              groupId: locked.targetGroupId,
              userId: user.id,
              grantedBy: actor.id,
            })
            .onConflictDoNothing({
              target: [groupMembers.groupId, groupMembers.userId],
            });

          const resolvedLandingRoomId = await resolveInviteLandingRoomInTx(tx, {
            inviteeUserId: user.id,
            inviteeActorId: actor.id,
            targetRoomId: locked.targetRoomId,
          });
          if (!resolvedLandingRoomId) {
            throw new RedeemAbort(
              409,
              locked.targetRoomId ? "target_room_unavailable" : "landing_room_unavailable",
            );
          }
          landingRoomId = resolvedLandingRoomId.roomId;
          if (resolvedLandingRoomId.joinedExistingRoom) joinedExistingRoomId = resolvedLandingRoomId.roomId;
        }

        await tx
          .insert(inviteRedemptions)
          .values({
            inviteId: locked.id,
            userId: user.id,
            boundAt: profileNow,
            completedAt: profileNow,
          })
          .onConflictDoNothing({
            target: [inviteRedemptions.inviteId, inviteRedemptions.userId],
          });

        await tx
          .update(invites)
          .set({
            usedCount: locked.usedCount + 1,
          })
          .where(eq(invites.id, locked.id));

        if (input.forcePasswordChange === true && deps.logto) {
          await markPasswordChangeRequired(tx, {
            userId: user.id,
            reason: PASSWORD_CHANGE_REASON.SETUP_TEMP_PASSWORD,
          });
        }

        return {
          recoveryCodes,
          landingRoomId,
          newUserId: user.id,
          newActorId: actor.id,
          personalAgentId: personal.agentId,
        };
      });

      if (joinedExistingRoomId) {
        await emitCompletedInviteMembership(deps, inviteRow.id, joinedExistingRoomId, outcome.newUserId, outcome.newActorId);
      }

      // D120 A1.P1 — bootstrap-claim refresh of the in-process state
      // cache. Pre-D120, D112 Phases 18+19 wrote NAUTILO_DEFAULT_AGENT_ID
      // and NAUTILO_OWNER_ID to ~/.nautilo<inst>/config.env via
      // `promoteDefaultAgent` / `promoteDefaultOwner`, then relied on
      // `loadDotenv` re-reading them on the next boot. That whole
      // round-trip is gone — the DB is the persistent source of truth
      // (queried at boot via `findClaimedOwnerId` /
      // `findDefaultAgentForOwner`), and these two cache writes keep
      // the running process aligned without a restart. Cannot fail
      // (cache is in-memory, sync) — the old non-fatal `onPromote*`
      // hooks are no longer reachable.
      if (inviteRow.kind === "claim") {
        try {
          const dir =
            deps.bootstrapDirFn?.() ??
            bootstrapDirForInstance(resolveInstance().instanceId);
          (deps.markBootstrapUsedFn ?? markBootstrapUsed)(dir);
        } catch (e) {
          console.warn(
            `[redeem-invite] failed to mark bootstrap dir used: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
        // Only the Logto-mode branch above mints a new personal Agent
        // (returning `personalAgentId`). The local-bootstrap branch
        // reuses the seed Agent in place, which is already cached, so
        // there's no agent-id refresh needed there.
        const personalAgentId = outcome.personalAgentId;
        if (personalAgentId) {
          setBootstrapDefaultAgentId(personalAgentId);
        }

        // Companion to the agent refresh: re-point the cache's owner
        // id at the claimer's user id so PersonalPolicyResolver's
        // ownerId callback returns the real claimer (not the bootstrap
        // dummy users row) when it builds MemoryAccessEnvelopes for
        // this user. Without this, every `state.userId` the agent
        // runtime sees would be the dummy id, every user-scoped WS
        // event (approval.ask, prove_it.challenge, identity.challenge)
        // would route to a userId no socket has bound, and every
        // approval prompt would drop on the floor. Same applies on
        // the local-bootstrap branch — newUserId is the updated seed
        // user row, which IS the real owner after this commit.
        setBootstrapOwnerId(outcome.newUserId);
        setBootstrapOwnerBound(true);
      }

      let logtoSession: RedeemLogtoSession | undefined;
      const mintGuardAllow = deps.allowLogtoSessionMint === true;
      const mintGuardHasLogto = Boolean(deps.logto);
      const mintGuardKind = inviteRow.kind;
      const mintGuardHasSub = Boolean(logtoSub);
      const mintGuardAllPass =
        mintGuardAllow &&
        mintGuardHasLogto &&
        mintGuardKind === "claim" &&
        mintGuardHasSub;
      if (mintGuardAllPass) {
        const minted = await mintLogtoBearerSessionAfterTrustedAuth({
          logto: deps.logto,
          logtoSub: logtoSub,
        });
        if (minted) {
          logtoSession = {
            accessToken: minted.accessToken,
            expiresIn: minted.expiresIn,
            ...(minted.refreshToken !== undefined
              ? { refreshToken: minted.refreshToken }
              : {}),
            ...(minted.idToken !== undefined ? { idToken: minted.idToken } : {}),
          };
        } else {
          deps.onLogtoTokenMintFailed?.(logtoSub);
        }
      }

      return {
        ok: true,
        recoveryCodes: outcome.recoveryCodes,
        landingRoomId: outcome.landingRoomId,
        newUserId: outcome.newUserId,
        newActorId: outcome.newActorId,
        logtoSub,
        ...(logtoSession !== undefined ? { logtoSession } : {}),
      };
    } catch (err) {
      if (logtoSub && deps.logto) {
        try {
          await deps.logto.deleteUser(logtoSub);
        } catch (cleanupErr) {
          const reason =
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          deps.onLogtoCleanupFailed?.(logtoSub, reason);
        }
      }
      if (err instanceof RedeemAbort) {
        return {
          ok: false,
          httpStatus: err.status,
          error: err.code,
          code: err.code,
        };
      }
      throw err;
    }
}

/**
 * M105/M260 — browser-mediated invite redemption, bind step.
 *
 * Assumes the Logto user already exists (created by hosted sign-up). Validates
 * the invite, JIT-creates the local `users` row with `external_id = logtoSub`,
 * creates the Human's private personal graph, and writes an incomplete
 * `invite_redemptions` child. It deliberately does not publish target
 * Group/Room membership or bump `used_count`; completion owns both.
 *
 * Ordinary server Invites can bind any number of independent Humans. Claims
 * remain single-subject: a retry by that subject returns the same actor/user,
 * while another subject cannot take over the bootstrap claim.
 *
 * Called by `POST /api/bind-logto-user`. The route pre-resolves `email` and
 * `displayName` from `LogtoAdminClient.getUser(logtoSub)` so this function is
 * Logto-pure (no admin client in deps).
 */
export async function redeemInviteWithLogtoSub(
  plaintextToken: string,
  logtoSub: string,
  args: BindLogtoUserArgs,
  deps: RedeemInviteSplitDeps,
): Promise<BindLogtoUserResult> {
  // Bootstrap retirement belongs to complete-profile, not this resumable
  // half-bind. Keep the dependency shape shared with that tail for callers.
  void deps;
  const v = validateBindUserArgs(args);
  if (v) {
    return { ok: false, httpStatus: 400, error: v, code: v };
  }
  if (logtoSub.trim().length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      error: "invalid_logto_sub",
      code: "invalid_logto_sub",
    };
  }

  const tokenHash = sha256Hex(plaintextToken);

  // Probe phase (mirrors redeemInviteAtomically). Outside any tx so the early
  // 404/410 returns are cheap and don't take a lock.
  const probeDb = deps.db ?? getSharedDirectDb();
  const [inviteRow] = await probeDb
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, tokenHash))
    .limit(1);
  if (!inviteRow) {
    return { ok: false, httpStatus: 404, error: "not_found", code: "not_found" };
  }
  if (inviteRow.kind === "claim" && await hasClaimedOwner(probeDb)) {
    return { ok: false, httpStatus: 410, error: "used_up", code: "used_up" };
  }
  if (inviteRow.revokedAt) {
    return { ok: false, httpStatus: 410, error: "revoked", code: "revoked" };
  }
  if (inviteRow.expiresAt && inviteRow.expiresAt.getTime() < Date.now()) {
    return { ok: false, httpStatus: 410, error: "expired", code: "expired" };
  }
  if (inviteRow.maxUses !== null && inviteRow.usedCount >= inviteRow.maxUses) {
    return { ok: false, httpStatus: 410, error: "used_up", code: "used_up" };
  }

  // Seed phase. Real transaction with row lock on the invite.
  const db = deps.db ?? getSharedDirectDb();
  try {
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, tokenHash))
        .for("update")
        .limit(1);
      if (!locked) throw new RedeemAbort(404, "not_found");
      if (locked.revokedAt) throw new RedeemAbort(410, "revoked");
      if (locked.expiresAt && locked.expiresAt.getTime() < Date.now()) {
        throw new RedeemAbort(410, "expired");
      }
      if (locked.maxUses !== null && locked.usedCount >= locked.maxUses) {
        throw new RedeemAbort(410, "used_up");
      }

      // Bootstrap claims remain one-shot even before completion. Ordinary
      // server Invites intentionally have no singleton reservation.
      if (locked.kind === "claim") {
        const [reservedUser] = await tx
          .select({ id: users.id, externalId: users.externalId })
          .from(inviteRedemptions)
          .innerJoin(users, eq(users.id, inviteRedemptions.userId))
          .where(eq(inviteRedemptions.inviteId, locked.id))
          .limit(1);
        if (reservedUser && reservedUser.externalId !== logtoSub) {
          throw new RedeemAbort(409, "claim_reserved");
        }
        if (reservedUser) {
          const [reservedActor] = await tx
            .select({ id: actors.id })
            .from(actors)
            .where(and(eq(actors.ownerId, reservedUser.id), eq(actors.kind, "user")))
            .limit(1);
          if (!reservedActor) throw new RedeemAbort(500, "user_actor_invariant");
          return {
            actorId: reservedActor.id,
            userId: reservedUser.id,
            personalAgentId: null as string | null,
          };
        }
      }

      // Re-check idempotency inside the tx in case of concurrent bind.
      const [raceUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.externalId, logtoSub))
        .limit(1);
      if (raceUser) {
        const [binding] = await tx
          .select({ userId: inviteRedemptions.userId })
          .from(inviteRedemptions)
          .where(
            and(
              eq(inviteRedemptions.inviteId, locked.id),
              eq(inviteRedemptions.userId, raceUser.id),
            ),
          )
          .limit(1);
        if (!binding) {
          throw new RedeemAbort(409, "logto_subject_already_bound");
        }
        const [raceActor] = await tx
          .select({ id: actors.id })
          .from(actors)
          .where(and(eq(actors.ownerId, raceUser.id), eq(actors.kind, "user")))
          .limit(1);
        if (!raceActor) {
          throw new RedeemAbort(500, "user_actor_invariant");
        }
        return {
          actorId: raceActor.id,
          userId: raceUser.id,
          personalAgentId: null as string | null,
        };
      }

      // Resolve placeholder name + canonical handle for the users row.
      // M107 Phase 2c: handle is now pinned at bind time (was: NULL until
      // completeInviteProfile). `args.handle` was validated + lowercased
      // upstream by `validateBindUserArgs`. `args.displayName` may be
      // empty if the Logto user had no `name`; fall back to a clear
      // placeholder.
      const trimmedName = args.displayName.trim();
      const handle = normalizeHandle(args.handle);
      const userName = trimmedName.length > 0 ? trimmedName : "New user";

      // M107 Phase 2c: bind-time handle conflict — another local user
      // already owns this handle. Belt-and-suspenders alongside the
      // partial unique index in 0046_m107_users_handle_unique.sql, which
      // would also throw, but at the SQL layer with a less actionable
      // error. The pre-check returns a clean 409 to the workbench so the
      // wizard can prompt the user to re-pick.
      // Logto-sub idempotency above already ruled out "this user binding
      // twice", so any hit here is a different local user racing for the
      // same handle.
      const [existingHandleOwner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.handle, handle), isNull(users.server)))
        .limit(1);
      if (existingHandleOwner) {
        throw new RedeemAbort(409, "handle_taken");
      }

      // D140 user-side dispatch (Logto-claim path). On `kind=claim`,
      // UPDATE the bootstrap-seed users/actors rows in place rather
      // than INSERTing new ones. `pin: null` defers credentials +
      // boot-channels to completeInviteProfile (M105's half-redeem
      // contract). When the seed has already been claimed (e.g. by a
      // prior local-bootstrap path or this is a kind=agent/room
      // invite), the helper returns null and we fall back to the
      // existing INSERT path.
      //
      // M107 Phase 2c: handle is now set here (not null) and email
      // is null (no SMTP in local installs; email is an optional
      // contact channel, not an identity key).
      const claimSeedUser =
        locked.kind === "claim"
          ? await claimBootstrapSeedUserInTx(tx, {
              name: userName,
              email: null,
              handle,
              externalId: logtoSub,
              pin: null,
            })
          : null;

      let user: { id: string };
      let actor: { id: string };
      let userSource: "insert" | "claim-seed";

      if (claimSeedUser) {
        user = { id: claimSeedUser.userId };
        actor = { id: claimSeedUser.userActorId };
        userSource = "claim-seed";
      } else {
        const [insertedUser] = await tx
          .insert(users)
          .values({
            name: userName,
            email: null,
            handle,
            externalId: logtoSub,
            server: null,
          })
          .returning({ id: users.id });
        if (!insertedUser) throw new Error("user insert failed");
        user = { id: insertedUser.id };

        const [insertedActor] = await tx
          .insert(actors)
          .values({
            ownerId: user.id,
            displayName: userName,
            trustState: "verified",
            kind: "user",
          })
          .returning({ id: actors.id });
        if (!insertedActor) throw new Error("actor insert failed");
        actor = { id: insertedActor.id };
        userSource = "insert";
      }

      // We deliberately SKIP channel_identities / credentials / profiles /
      // recovery codes here — those land in completeInviteProfile alongside
      // the PIN.

      // We DO seed the personal agent + private room here; without them,
      // the post-bind UI has no landing surface.
      //
      // M107 Phase 2c: the handle was chosen by the user in the wizard
      // preview step (rather than being derived from an email local-part
      // post-hoc), so the personal agent / private room ship with the
      // user-chosen slug from the start. completeInviteProfile does NOT
      // rename the agent / room.
      const handleSeed = handle;

      // D140 agent-side dispatch. On the claim-seed branch, UPDATE the
      // bootstrap-seed agent in place (rename to user's handle).
      // Otherwise fall back to INSERTing a fresh personal agent.
      const claimSeedAgent =
        userSource === "claim-seed"
          ? await claimBootstrapSeedAgentInTx(tx, {
              inviteeUserId: user.id,
              inviteeActorId: actor.id,
              handleSeed,
              displayName: userName,
            })
          : null;
      const personal =
        claimSeedAgent ??
        (await seedPersonalAgentForInviteeInTx(tx, {
          inviteeUserId: user.id,
          inviteeActorId: actor.id,
          handleSeed,
          displayName: userName,
        }));

      // D140 room reuse. When the user/agent rows were UPDATEd in
      // place, the bootstrap-seed Personal room is already attached to
      // them (seedDefaultRoom). Reuse it rather than minting a second
      // private room (which would orphan the seed room and produce
      // the "Room not found" symptom this fix was written to kill).
      if (userSource === "claim-seed") {
        const [reusedRoom] = await tx
          .select({ id: rooms.id })
          .from(rooms)
          .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
          .where(
            and(
              eq(rooms.ownerId, user.id),
              eq(rooms.type, "private"),
              eq(roomMembers.actorId, actor.id),
            ),
          )
          .limit(1);
        if (!reusedRoom) {
          await seedPersonalPrivateRoomInTx(tx, {
            ownerUserId: user.id,
            ownerActorId: actor.id,
            agentId: personal.agentId,
            label: "Personal",
          });
        }
      } else {
        await seedPersonalPrivateRoomInTx(tx, {
          ownerUserId: user.id,
          ownerActorId: actor.id,
          agentId: personal.agentId,
          label: "Personal",
        });
      }
      await tx
        .insert(inviteRedemptions)
        .values({ inviteId: locked.id, userId: user.id })
        .onConflictDoNothing({
          target: [inviteRedemptions.inviteId, inviteRedemptions.userId],
        });

      return {
        actorId: actor.id,
        userId: user.id,
        personalAgentId: personal.agentId,
      };
    });

    // Do not retire bootstrap authority here. A Logto bind is intentionally
    // only half of first-owner setup; it has no PIN/profile yet and must
    // remain resumable if the browser is interrupted before complete-profile.

    return {
      ok: true,
      actorId: outcome.actorId,
      userId: outcome.userId,
      logtoSub,
    };
  } catch (err) {
    if (err instanceof RedeemAbort) {
      return {
        ok: false,
        httpStatus: err.status,
        error: err.code,
        code: err.code,
      };
    }
    throw err;
  }
}

/**
 * M105/M260 — browser-mediated invite redemption, completion step.
 *
 * Finishes the caller's bound redemption: updates Human/Actor display state,
 * enrolls the PIN, publishes Group/Room access, generates recovery codes,
 * increments `invites.used_count`, and completes the exact child row. The
 * Logto subject must resolve to that bound Human.
 *
 * Idempotent on retry: a completed child row returns `ok: true` and no new
 * recovery codes, even when the aggregate Invite was later revoked or filled.
 *
 * Returns 409 `not_bound` when called before bind-logto-user has run.
 *
 * Called by `POST /api/invites/:token/complete-profile`.
 */
export async function completeInviteProfile(
  plaintextToken: string,
  logtoSub: string,
  args: CompleteInviteProfileArgs,
  deps: RedeemInviteSplitDeps,
): Promise<CompleteInviteProfileResult> {
  let joinedExistingRoomId: string | undefined;
  const v = validateCompleteProfileArgs(args);
  if (v) {
    return { ok: false, httpStatus: 400, error: v, code: v };
  }

  const tokenHash = sha256Hex(plaintextToken);

  const probeDb = deps.db ?? getSharedDirectDb();
  const [inviteRow] = await probeDb
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, tokenHash))
    .limit(1);
  if (!inviteRow) {
    return { ok: false, httpStatus: 404, error: "not_found", code: "not_found" };
  }
  const [userRow] = await probeDb
    .select({
      id: users.id,
      handle: users.handle,
      externalId: users.externalId,
    })
    .from(users)
    .where(eq(users.externalId, logtoSub))
    .limit(1);
  if (!userRow) {
    return {
      ok: false,
      httpStatus: 409,
      error: "not_bound",
      code: "not_bound",
    };
  }
  const [redemptionRow] = await probeDb
    .select({ completedAt: inviteRedemptions.completedAt })
    .from(inviteRedemptions)
    .where(
      and(
        eq(inviteRedemptions.inviteId, inviteRow.id),
        eq(inviteRedemptions.userId, userRow.id),
      ),
    )
    .limit(1);
  if (!redemptionRow) {
    return { ok: false, httpStatus: 409, error: "not_bound", code: "not_bound" };
  }
  const [actorRow] = await probeDb
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, userRow.id), eq(actors.kind, "user")))
    .limit(1);
  if (!actorRow) {
    return {
      ok: false,
      httpStatus: 500,
      error: "user_actor_invariant",
      code: "user_actor_invariant",
    };
  }

  // A completed per-Human redemption is the idempotency receipt. Aggregate
  // `used_count` cannot identify which Human completed a reusable Invite.
  if (userRow.handle !== null && redemptionRow.completedAt !== null) {
    if (inviteRow.kind === "claim") {
      // A process may have committed the profile transaction but crashed
      // before writing the local retirement sentinel. Retrying the completed
      // profile is safe and heals that durable boundary.
      finalizeBootstrapClaimRetirement(userRow.id, undefined, deps);
    }
    return {
      ok: true,
      recoveryCodes: [],
      newUserId: userRow.id,
      newActorId: actorRow.id,
      landingRoomId: await findCompletedLandingRoom(
        probeDb,
        inviteRow,
        userRow.id,
        actorRow.id,
      ),
    };
  }
  if (inviteRow.revokedAt) {
    return { ok: false, httpStatus: 410, error: "revoked", code: "revoked" };
  }

  // M107 Phase 2c: handle is set at bind time. complete-profile no
  // longer takes handle in its input; the route layer enforces back-
  // compat 409 `handle_mismatch` against the body if needed. The transaction
  // below still asserts the post-bind invariant before using the handle.

  const db = deps.db ?? getSharedDirectDb();
  try {
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, tokenHash))
        .for("update")
        .limit(1);
      if (!locked) throw new RedeemAbort(404, "not_found");
      const [user] = await tx
        .select({ id: users.id, handle: users.handle })
        .from(users)
        .where(eq(users.externalId, logtoSub))
        .limit(1);
      if (!user) throw new RedeemAbort(409, "not_bound");

      const [actor] = await tx
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.ownerId, user.id), eq(actors.kind, "user")))
        .limit(1);
      if (!actor) throw new RedeemAbort(500, "user_actor_invariant");

      const [redemption] = await tx
        .select({ completedAt: inviteRedemptions.completedAt })
        .from(inviteRedemptions)
        .where(
          and(
            eq(inviteRedemptions.inviteId, locked.id),
            eq(inviteRedemptions.userId, user.id),
          ),
        )
        .for("update")
        .limit(1);
      if (!redemption) throw new RedeemAbort(409, "not_bound");
      if (redemption.completedAt !== null) {
        return {
          recoveryCodes: [] as string[],
          newUserId: user.id,
          newActorId: actor.id,
          landingRoomId: null as string | null,
          isClaim: locked.kind === "claim",
          personalAgentId: null as string | null,
          isIdempotent: true,
          completedInvite: {
            kind: locked.kind,
            targetRoomId: locked.targetRoomId,
          },
        };
      }
      if (locked.revokedAt) throw new RedeemAbort(410, "revoked");
      if (locked.expiresAt && locked.expiresAt.getTime() < Date.now()) {
        throw new RedeemAbort(410, "expired");
      }
      if (locked.maxUses !== null && locked.usedCount >= locked.maxUses) {
        throw new RedeemAbort(409, "used_up");
      }
      if (
        locked.kind === "claim"
        && await hasClaimedOwner(tx as unknown as DirectDatabase)
      ) {
        throw new RedeemAbort(410, "used_up");
      }

      // M107 Phase 2c: handle was set at bind time; only update name
      // here. The legacy `.set({ handle, name })` shape is gone.
      await tx
        .update(users)
        .set({ name: args.displayName.trim() })
        .where(eq(users.id, user.id));

      // Set displayName on the matching actor row.
      await tx
        .update(actors)
        .set({ displayName: args.displayName.trim() })
        .where(eq(actors.id, actor.id));

      // Channel identities (mirrors atomic path). Use the persisted handle
      // from the users row (post-M107: set at bind time; pre-M107 callers
      // can't reach this branch because the route would have rejected the
      // older shape upstream).
      if (user.handle === null) {
        throw new RedeemAbort(500, "handle_invariant");
      }
      const claimFederatedId = composeFederatedId(user.handle, getServerHostname());
      const claimNow = new Date();
      for (const channel of OWNER_BOOT_CHANNELS) {
        await tx
          .insert(channelIdentities)
          .values({
            channel,
            externalId: claimFederatedId,
            userId: user.id,
            verifiedAt: claimNow,
          })
          .onConflictDoNothing({
            target: [channelIdentities.channel, channelIdentities.externalId],
          });
      }

      // Enroll PIN: `credentials` has no unique (user_id, type) in schema, so
      // `onConflictDoNothing` is not usable — skip insert when a PIN row exists.
      //
      // D168 P3 — establish trust context BEFORE the SELECT-then-INSERT so
      // the FORCE-RLS `credentials_self` policy lets both the read and the
      // write through. Without this, the SELECT returns 0 rows (so we'd
      // insert even when a credential already exists) AND the INSERT is
      // rejected by the WITH CHECK clause.
      await setTrustContextOnTx(tx, { userId: user.id });
      const [existingPinCredential] = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.userId, user.id), eq(credentials.type, "pin")))
        .limit(1);
      if (!existingPinCredential) {
        const hashed = await hashPin(args.pin);
        await tx.insert(credentials).values({
          userId: user.id,
          type: "pin",
          value: hashed,
        });
      }

      // M132 — the Profile is agent-keyed. The personal Agent was already
      // seeded during the bind half (`redeemInviteWithLogtoSub`); resolve
      // it here (oldest agent the user owns) so we can supply `agent_id`
      // and target `ON CONFLICT (agent_id)`.
      const [agentActor] = await tx
        .select({ agentId: actors.agentId })
        .from(actors)
        .where(and(eq(actors.ownerId, user.id), eq(actors.kind, "agent")))
        .orderBy(actors.createdAt)
        .limit(1);
      if (!agentActor?.agentId) throw new RedeemAbort(500, "no_personal_agent");

      // Profiles row: same shape as atomic path.
      const profileNow = new Date();
      await tx
        .insert(profiles)
        .values({
          userId: user.id,
          agentId: agentActor.agentId,
          name: "Genie",
          onboardingCompleted: false,
          updatedAt: profileNow,
        })
        .onConflictDoUpdate({
          target: profiles.agentId,
          set: {
            onboardingCompleted: false,
            updatedAt: profileNow,
          },
        });

      let landingRoomId: string;
      if (locked.kind === "server") {
        if (!locked.targetGroupId) {
          throw new RedeemAbort(409, "invite_target_unavailable");
        }
        const targetRoles = await tx
          .select({ id: groups.id, groupType: groups.type, roleSlug: roles.slug })
          .from(groups)
          .leftJoin(groupRoles, eq(groupRoles.groupId, groups.id))
          .leftJoin(roles, eq(roles.id, groupRoles.roleId))
          .where(eq(groups.id, locked.targetGroupId));
        const targetGroup = targetRoles[0];
        if (!targetGroup) {
          throw new RedeemAbort(409, "invite_target_unavailable");
        }
        if (targetRoles.some((row) => row.groupType === "communities" || row.roleSlug === "community")) {
          throw new RedeemAbort(409, "community_enrollment_unavailable");
        }

        await tx
          .insert(groupMembers)
          .values({
            groupId: targetGroup.id,
            userId: user.id,
            grantedBy: actor.id,
          })
          .onConflictDoNothing({
            target: [groupMembers.groupId, groupMembers.userId],
          });

        const resolvedLanding = await resolveInviteLandingRoomInTx(tx, {
          inviteeUserId: user.id,
          inviteeActorId: actor.id,
          targetRoomId: locked.targetRoomId,
        });
        if (!resolvedLanding) {
          throw new RedeemAbort(
            409,
            locked.targetRoomId ? "target_room_unavailable" : "landing_room_unavailable",
          );
        }
        landingRoomId = resolvedLanding.roomId;
        if (resolvedLanding.joinedExistingRoom) joinedExistingRoomId = resolvedLanding.roomId;
      } else {
        const [personalRoom] = await tx
          .select({ id: rooms.id })
          .from(rooms)
          .innerJoin(
            roomMembers,
            and(
              eq(roomMembers.roomId, rooms.id),
              eq(roomMembers.actorId, actor.id),
            ),
          )
          .where(and(eq(rooms.ownerId, user.id), isNull(rooms.archivedAt)))
          .orderBy(asc(rooms.createdAt), asc(rooms.id))
          .limit(1);
        if (!personalRoom) throw new RedeemAbort(409, "landing_room_unavailable");
        landingRoomId = personalRoom.id;
      }

      const recoveryCodes = await generateRecoveryCodesInTx(tx, user.id);

      await tx
        .update(invites)
        .set({
          usedCount: locked.usedCount + 1,
        })
        .where(eq(invites.id, locked.id));
      await tx
        .update(inviteRedemptions)
        .set({ completedAt: profileNow })
        .where(
          and(
            eq(inviteRedemptions.inviteId, locked.id),
            eq(inviteRedemptions.userId, user.id),
            isNull(inviteRedemptions.completedAt),
          ),
        );

      if (locked.kind === "claim") {
        // One owner has now been fully bound (PIN + profile + consumed claim
        // are committed together). Retire every remaining unconsumed claim
        // inside that same transaction; a replacement capability can never
        // survive first-owner completion.
        await tx
          .update(invites)
          .set({ revokedAt: profileNow })
          .where(
            and(
              eq(invites.kind, "claim"),
              eq(invites.usedCount, 0),
              isNull(invites.revokedAt),
            ),
          );
      }

      return {
        recoveryCodes,
        newUserId: user.id,
        newActorId: actor.id,
        landingRoomId,
        isClaim: locked.kind === "claim",
        personalAgentId: agentActor.agentId,
        isIdempotent: false,
        completedInvite: null,
      };
    });

    if (joinedExistingRoomId && !outcome.isIdempotent) {
      await emitCompletedInviteMembership(deps, inviteRow.id, joinedExistingRoomId, outcome.newUserId, outcome.newActorId);
    }

    if (outcome.isClaim) {
      finalizeBootstrapClaimRetirement(
        outcome.newUserId,
        outcome.personalAgentId ?? undefined,
        deps,
      );
    }

    const landingRoomId = outcome.isIdempotent && outcome.completedInvite
      ? await findCompletedLandingRoom(
          db,
          outcome.completedInvite,
          outcome.newUserId,
          outcome.newActorId,
        )
      : outcome.landingRoomId;

    return {
      ok: true,
      recoveryCodes: outcome.recoveryCodes,
      newUserId: outcome.newUserId,
      newActorId: outcome.newActorId,
      landingRoomId: landingRoomId ?? "",
    };
  } catch (err) {
    if (err instanceof RedeemAbort) {
      return {
        ok: false,
        httpStatus: err.status,
        error: err.code,
        code: err.code,
      };
    }
    throw err;
  }
}

/**
 * Retire remote bootstrap authority only after the canonical owner predicate
 * has become true: complete-profile inserts the PIN and profile and consumes
 * the claim in one transaction. Bind-logto-user intentionally does not call
 * this because its incomplete child redemption is still recoverable.
 */
function finalizeBootstrapClaimRetirement(
  userId: string,
  personalAgentId: string | undefined,
  deps: RedeemInviteSplitDeps,
): void {
  try {
    const dir =
      deps.bootstrapDirFn?.() ?? bootstrapDirForInstance(resolveInstance().instanceId);
    (deps.markBootstrapUsedFn ?? markBootstrapUsed)(dir);
  } catch (e) {
    console.warn(
      `[redeem-invite/complete-profile] failed to mark bootstrap dir used: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (personalAgentId) setBootstrapDefaultAgentId(personalAgentId);
  setBootstrapOwnerId(userId);
  setBootstrapOwnerBound(true);
}
