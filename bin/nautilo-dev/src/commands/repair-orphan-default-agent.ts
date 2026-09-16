/**
 * D140 — operator repair for instances stuck in the pre-D140
 * "INSERT new + retire old" default-agent shape.
 *
 * Pre-D140 model (the bug): bootstrap-seeded one Agent row at boot;
 * Logto-claim redeem INSERTed a SECOND Agent + Actor for the
 * claimer, left the seed Agent alive as an "inert pre-claim row,"
 * and re-pointed `NAUTILO_DEFAULT_AGENT_ID` to the new one. Every
 * pre-claim `room_members.actor_id` / `memories.agent_id` / etc.
 * still pointed at the SEED agent's actor — the trust resolver
 * then couldn't find the claimer's effective agent inside those
 * rooms, returned an empty room id, and the chat route 404'd with
 * "Room not found or unavailable" (see
 * `ISSUE-D140-customize-in-place-default-agent.md` §"Concrete
 * failure mode" for the live evidence trail).
 *
 * Path A extends the same operator repair to the parallel-INSERT
 * orphan **User** + mirror user-**Actor** from the Logto-claim path:
 * reparent every FK onto the active claimer, then delete the orphan
 * user-actor and user row.
 *
 * Post-D140 model (the fix): claim-redeem UPDATEs the seed Agent
 * row in place (`claimBootstrapSeedAgentInTx`). One agent row,
 * one actor row, same UUIDs through claim. No repair needed on
 * fresh installs after D140.
 *
 * M:N safety: this command merges **at most one** orphan Agent and/or
 * **at most one** orphan User per invocation. Nominate the orphan
 * with `--orphan-agent-id` / `--orphan-user-id` (required — auto-detect
 * was removed in M128 when per-Agent ownership groups were retired).
 * Refuses non-empty transcript footprint on the orphan unless
 * `--allow-active-orphan-merge`. Broad "every other row is an orphan"
 * scans are intentionally not supported — multi-agent instances would
 * otherwise merge unrelated agents into the keeper.
 *
 * This command repairs already-broken instances by merging the chosen
 * orphan seed Agent + Actor into the effective Agent + Actor:
 *
 *   1. Resolve the active agent (`NAUTILO_DEFAULT_AGENT_ID` or
 *      `--keep-agent-id`) and the orphan (explicit `--orphan-agent-id`
 *      / `--orphan-user-id`).
 *   2. Reparent every FK that points at the orphan actor / orphan
 *      agent to point at the active actor / active agent. Conflict-
 *      tolerant (room_members has a UNIQUE constraint on
 *      `(room_id, actor_id)` — duplicate rows get deduped).
 *   3. Delete the orphan actor (cascades through any remaining
 *      ON DELETE CASCADE FKs).
 *   4. Delete the orphan agent (cascades to its 4 `groups` rows
 *      via `groups.agent_id ON DELETE CASCADE`).
 *
 * User half (Path A): same narrowing — one orphan user per run via
 * explicit `--orphan-user-id`.
 *
 * Default is `--dry-run`: print the merge plan, change nothing.
 * Pass `--apply` to commit. Idempotent: a second run finds nothing
 * to repair, exits 0.
 *
 * Companion: ISSUE-D140 §Implementation Phase 3.
 */
import {
  and,
  count,
  eq,
  inArray,
  sql,
  createDirectDb,
  agents,
  actors,
  rooms,
  roomMembers,
  sessions,
  groups,
  groupMembers,
  relayTokens,
  logtoAccountSecurity,
  sessionMessages,
  users,
  credentials,
  recoveryCodes,
  channelIdentities,
  profiles,
  invites,
  fileRevisions,
  jobs,
  agentScopes,
  standingApprovals,
  approvalChallenges,
} from "@nautilo/db";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";

export interface RepairOrphanDefaultAgentArgs {
  apply?: boolean | undefined;
  /**
   * Override the active-agent predicate. Useful on instances where
   * `NAUTILO_DEFAULT_AGENT_ID` is missing from `config.env` but the
   * operator knows which row is the effective one (e.g. inspected
   * via `psql`). Mutually exclusive with the env-var fallback;
   * `--apply` is still required to commit.
   */
  keepAgentId?: string | undefined;
  /**
   * Override the active-user predicate. When omitted, the active user
   * is resolved from the active agent's mirror actor (`owner_id` on the
   * `kind='agent'` actor row).
   */
  keepUserId?: string | undefined;
  /**
   * Explicit orphan agent to merge (required for agent-side repair).
   */
  orphanAgentId?: string | undefined;
  /**
   * Explicit orphan user to merge (required for user-side repair).
   */
  orphanUserId?: string | undefined;
  /**
   * Allow merging an orphan that still has session transcript rows and/or
   * (agent path) memory rows — normally refused as a typo / misclassification guard.
   */
  allowActiveOrphanMerge?: boolean | undefined;
  configEnvPath?: string | undefined;
  /** D202: explicit opt-in to apply repair against the protected (default) instance. */
  iKnowWhatIAmDoing?: boolean | undefined;
}

interface OrphanPlan {
  readonly orphanAgentId: string;
  readonly orphanAgentHandle: string;
  readonly orphanActorId: string;
  readonly counts: {
    roomMembersReparented: number;
    roomMembersDeduped: number;
    roomsCreatedByReparented: number;
    roomsHumanActorIdsRewritten: number;
    memoriesReparented: number;
    sessionsReparented: number;
    groupMembersGrantedByReparented: number;
    relayTokensReparented: number;
    logtoSecurityReparented: number;
    groupsCascadeDeleted: number;
  };
}

interface UserOrphanPlan {
  readonly orphanUserId: string;
  readonly orphanHandle: string | null;
  readonly orphanName: string;
  readonly orphanActorId: string;
  readonly counts: {
    roomMembersReparented: number;
    roomMembersDeduped: number;
    roomsCreatedByReparented: number;
    roomsHumanActorIdsRewritten: number;
    credentialsReparented: number;
    credentialsDeduped: number;
    recoveryCodesReparented: number;
    channelIdentitiesReparented: number;
    channelIdentitiesDeduped: number;
    profilesDeleteOrphan: number;
    groupMembersUserIdReparented: number;
    groupMembersUserIdDeduped: number;
    groupMembersGrantedByReparented: number;
    sessionsOwnerReparented: number;
    sessionsDeduped: number;
    roomsOwnerReparented: number;
    fileRevisionsOwnerReparented: number;
    relayTokensUserReparented: number;
    relayTokensActorReparented: number;
    logtoLastOperatorActorReparented: number;
    logtoAccountSecurityDeleteOrphan: number;
    logtoAccountSecurityUserPkReparent: number;
    invitesCreatedByReparented: number;
    groupsOwnerReparented: number;
    jobsOwnerReparented: number;
    jobsRequestorReparented: number;
    agentScopesSpeakerReparented: number;
    agentScopesDeduped: number;
    standingApprovalsCreatedByReparented: number;
    standingApprovalsActorPatternReparented: number;
    approvalChallengesRequestedByReparented: number;
    approvalChallengesResolvedByReparented: number;
  };
}

export async function repairOrphanDefaultAgent(
  args: RepairOrphanDefaultAgentArgs,
): Promise<number> {
  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:repair-orphan-default-agent",
    cwd: process.cwd(),
    isDryRunOrReadOnly: args.apply !== true,
    ...(args.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  loadConfigEnvIntoProcess({ path: args.configEnvPath });

  const keepAgentId =
    args.keepAgentId?.trim() ||
    process.env["NAUTILO_DEFAULT_AGENT_ID"]?.trim() ||
    "";
  if (!keepAgentId) {
    console.error(
      "repair-orphan-default-agent: cannot identify the active agent.\n" +
        "  Neither --keep-agent-id <uuid> nor NAUTILO_DEFAULT_AGENT_ID is set.\n" +
        "  Run `bun run dev:inspect` to find the effective agent row, then\n" +
        "  re-run with --keep-agent-id <uuid>.",
    );
    return 1;
  }

  const apply = args.apply === true;
  const db = createDirectDb(1);

  try {
    const allAgents = await db
      .select({ id: agents.id, handle: agents.handle })
      .from(agents);

    if (allAgents.length === 0) {
      console.log("[repair] no agents rows — nothing to repair.");
      return 0;
    }

    const active = allAgents.find((a) => a.id === keepAgentId);
    if (!active) {
      console.error(
        `repair-orphan-default-agent: active agent ${keepAgentId} not found in the agents table.`,
      );
      return 1;
    }

    // Safety check: refuse if the operator passes --keep-agent-id
    // pointing at an orphan by accident (would merge onto the wrong row).

    // Resolve the active mirror agent-actor once.
    const [activeActorRow] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.agentId, active.id), eq(actors.kind, "agent")))
      .limit(1);
    if (!activeActorRow) {
      console.error(
        `repair-orphan-default-agent: active agent ${active.id} has no mirror actor (kind='agent'). Aborting; this is a deeper inconsistency than D140.`,
      );
      return 1;
    }
    const activeActorId = activeActorRow.id;
    console.log(`[repair] active mirror actor (agent): id=${activeActorId}`);

    const keepUserIdArg = args.keepUserId?.trim() || "";
    let activeUserId = keepUserIdArg;
    if (!activeUserId) {
      const [ownerRow] = await db
        .select({ ownerId: actors.ownerId })
        .from(actors)
        .where(and(eq(actors.agentId, active.id), eq(actors.kind, "agent")))
        .limit(1);
      activeUserId = ownerRow?.ownerId?.trim() ?? "";
    }
    if (!activeUserId) {
      console.error(
        "repair-orphan-default-agent: cannot identify the active user.\n" +
          "  Neither --keep-user-id <uuid> nor a resolvable owner on the active agent's mirror actor.\n" +
          "  Pass --keep-user-id <uuid> explicitly.",
      );
      return 1;
    }

    const [activeUserRowBase] = await db
      .select({
        id: users.id,
        name: users.name,
        handle: users.handle,
      })
      .from(users)
      .where(eq(users.id, activeUserId))
      .limit(1);
    const [activeUserCred] = activeUserRowBase
      ? await db
          .select({ id: credentials.id })
          .from(credentials)
          .where(eq(credentials.userId, activeUserRowBase.id))
          .limit(1)
      : [];
    const activeUserRow = activeUserRowBase
      ? { ...activeUserRowBase, hasCredentials: Boolean(activeUserCred) }
      : undefined;
    if (!activeUserRow) {
      console.error(
        `repair-orphan-default-agent: active user ${activeUserId} not found in the users table.`,
      );
      return 1;
    }

    const [activeUserActor] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.ownerId, activeUserId), eq(actors.kind, "user")))
      .limit(1);
    const [activeUserGroupMember] = await db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.userId, activeUserId))
      .limit(1);
    if (!activeUserActor && !activeUserGroupMember) {
      console.error(
        `repair-orphan-default-agent: refusing to keep user ${activeUserId} (handle=${activeUserRow.handle ?? "null"}, name=${activeUserRow.name}) — ` +
          `it has no mirror user-actor (kind='user') and no group_members row.\n` +
          `  This looks like an orphan seed user, not the claimer's customized user.\n` +
          `  Pass --keep-user-id <uuid> with the claimer's user id if appropriate.`,
      );
      return 1;
    }

    const activeUserActorId = activeUserActor?.id ?? "";
    console.log(
      `[repair] active user: id=${activeUserRow.id} handle=${activeUserRow.handle ?? "null"} name=${activeUserRow.name}` +
        ` (has_credentials=${activeUserRow.hasCredentials})` +
        (activeUserActorId ? ` mirror user-actor=${activeUserActorId}` : " (no user-actor)"),
    );

    // Load users for explicit --orphan-user-id validation (M105
    // half-redeemed guard: external_id set + no credentials).
    const allUserRowsRaw = await db
      .select({
        id: users.id,
        name: users.name,
        handle: users.handle,
        externalId: users.externalId,
      })
      .from(users);
    const usersWithCreds = await db
      .selectDistinct({ userId: credentials.userId })
      .from(credentials);
    const userIdsWithCreds = new Set(
      usersWithCreds.map((r) => r.userId).filter((id): id is string => Boolean(id)),
    );
    const allUserRows = allUserRowsRaw.map((u) => ({
      id: u.id,
      name: u.name,
      handle: u.handle,
      externalId: u.externalId,
      hasCredentials: userIdsWithCreds.has(u.id),
    }));

    let userOrphans: typeof allUserRows = [];
    const orphanUserIdArg = args.orphanUserId?.trim() || "";
    if (orphanUserIdArg) {
      const explicit = allUserRows.find((u) => u.id === orphanUserIdArg);
      if (!explicit) {
        console.error(
          `repair-orphan-default-agent: --orphan-user-id ${orphanUserIdArg} not found in users table.`,
        );
        return 1;
      }
      if (explicit.id === activeUserId) {
        console.error(
          "repair-orphan-default-agent: --orphan-user-id equals --keep-user-id (or resolved active user); nothing to merge.",
        );
        return 1;
      }
      if (explicit.externalId !== null) {
        console.error(
          `repair-orphan-default-agent: --orphan-user-id ${orphanUserIdArg} has external_id='${explicit.externalId}' set.\n` +
            "  This is an M105 half-redeemed in-flight claim, not an orphan. Refusing to merge.\n" +
            "  If you genuinely want to discard the half-redeemed row, clear external_id first (and verify\n" +
            "  the corresponding Logto user is intended to be revoked).",
        );
        return 1;
      }
      userOrphans = [explicit];
    }

    if (userOrphans.length > 0 && !activeUserActorId) {
      console.error(
        "repair-orphan-default-agent: cannot merge orphan user-actors — the active user has no mirror user-actor (kind='user').\n" +
          "  Reparenting room_members / relay_tokens.actor_id / etc. requires the active user's actor row.\n" +
          "  Restore a user-actor for the active user or pick a different --keep-user-id.",
      );
      return 1;
    }

    let agentOrphans: Array<{ id: string; handle: string }> = [];
    const orphanAgentIdArg = args.orphanAgentId?.trim() || "";
    if (orphanAgentIdArg) {
      const explicit = allAgents.find((a) => a.id === orphanAgentIdArg);
      if (!explicit) {
        console.error(
          `repair-orphan-default-agent: --orphan-agent-id ${orphanAgentIdArg} not found in agents table.`,
        );
        return 1;
      }
      if (explicit.id === keepAgentId) {
        console.error(
          "repair-orphan-default-agent: --orphan-agent-id equals --keep-agent-id; nothing to merge.",
        );
        return 1;
      }
      agentOrphans = [explicit];
    }

    if (agentOrphans.length === 0 && userOrphans.length === 0) {
      console.log(
        `[repair] only one agent row (${active.id}, handle=${active.handle}) and no orphan user rows — instance is healthy. Nothing to repair.`,
      );
      return 0;
    }

    if (agentOrphans.length > 0) {
      console.log(
        `[repair] active agent: id=${active.id} handle=${active.handle}`,
      );
      console.log(`[repair] candidate agent orphans: ${agentOrphans.length}`);
      for (const o of agentOrphans) {
        console.log(`[repair]   orphan agent: id=${o.id} handle=${o.handle}`);
      }
    }

    if (userOrphans.length > 0) {
      console.log(`[repair] candidate user orphans: ${userOrphans.length}`);
      for (const u of userOrphans) {
        console.log(
          `[repair]   orphan user: id=${u.id} handle=${u.handle ?? "null"} name=${u.name}` +
            ` (has_credentials=${u.hasCredentials})`,
        );
      }
    }

    const allowActive = args.allowActiveOrphanMerge === true;

    for (const orphan of agentOrphans) {
      const [msgRow] = await db
        .select({ msgs: count() })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
        .where(eq(sessions.agentId, orphan.id));
      const msgs = Number(msgRow?.msgs ?? 0);
      // M127: memories no longer carry agent_id. Memory rows survive
      // orphan agent deletion by design (Namespace-only content scope).
      // The orphan-merge check now only considers session activity.
      const mems = 0;
      if (msgs > 0 || mems > 0) {
        if (allowActive) {
          console.log(
            `[repair] WARNING: merging orphan agent ${orphan.id} despite footprint (session_messages=${msgs}, memories=${mems}); --allow-active-orphan-merge is set.`,
          );
        } else {
          console.error(
            `repair-orphan-default-agent: refuse to merge orphan agent ${orphan.id} (handle=${orphan.handle}): session_messages=${msgs}, memories=${mems}.\n` +
              "  Pass --allow-active-orphan-merge only if this merge is intentional.",
          );
          return 1;
        }
      }
    }

    for (const orphanUser of userOrphans) {
      const [msgRow] = await db
        .select({ msgs: count() })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
        .where(eq(sessions.ownerId, orphanUser.id));
      const msgs = Number(msgRow?.msgs ?? 0);
      if (msgs > 0) {
        if (allowActive) {
          console.log(
            `[repair] WARNING: merging orphan user ${orphanUser.id} despite footprint (session_messages=${msgs}); --allow-active-orphan-merge is set.`,
          );
        } else {
          console.error(
            `repair-orphan-default-agent: refuse to merge orphan user ${orphanUser.id}: session_messages=${msgs}.\n` +
              "  Pass --allow-active-orphan-merge only if this merge is intentional.",
          );
          return 1;
        }
      }
    }

    const plans: OrphanPlan[] = [];

    for (const orphan of agentOrphans) {
      const [orphanActorRow] = await db
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.agentId, orphan.id), eq(actors.kind, "agent")))
        .limit(1);
      if (!orphanActorRow) {
        console.log(
          `[repair] orphan agent ${orphan.id} has no mirror actor; it will be deleted directly.`,
        );
      }
      const orphanActorId = orphanActorRow?.id ?? "";

      const counts: OrphanPlan["counts"] = {
        roomMembersReparented: 0,
        roomMembersDeduped: 0,
        roomsCreatedByReparented: 0,
        roomsHumanActorIdsRewritten: 0,
        memoriesReparented: 0,
        sessionsReparented: 0,
        groupMembersGrantedByReparented: 0,
        relayTokensReparented: 0,
        logtoSecurityReparented: 0,
        groupsCascadeDeleted: 0,
      };

      if (orphanActorId) {
        const conflicts = await db
          .select({ roomId: roomMembers.roomId })
          .from(roomMembers)
          .where(
            and(
              eq(roomMembers.actorId, orphanActorId),
              inArray(
                roomMembers.roomId,
                db
                  .select({ roomId: roomMembers.roomId })
                  .from(roomMembers)
                  .where(eq(roomMembers.actorId, activeActorId)),
              ),
            ),
          );
        counts.roomMembersDeduped = conflicts.length;

        const remainingOrphanMembers = await db
          .select({ roomId: roomMembers.roomId })
          .from(roomMembers)
          .where(eq(roomMembers.actorId, orphanActorId));
        counts.roomMembersReparented = Math.max(
          0,
          remainingOrphanMembers.length - conflicts.length,
        );

        const cb = await db
          .select({ id: rooms.id })
          .from(rooms)
          .where(eq(rooms.createdBy, orphanActorId));
        counts.roomsCreatedByReparented = cb.length;

        const hai = await db
          .select({ id: rooms.id })
          .from(rooms)
          .where(sql`${rooms.humanActorIds} @> ARRAY[${orphanActorId}]::uuid[]`);
        counts.roomsHumanActorIdsRewritten = hai.length;

        const gm = await db
          .select({ groupId: groupMembers.groupId })
          .from(groupMembers)
          .where(eq(groupMembers.grantedBy, orphanActorId));
        counts.groupMembersGrantedByReparented = gm.length;

        const rt = await db
          .select({ id: relayTokens.id })
          .from(relayTokens)
          .where(eq(relayTokens.actorId, orphanActorId));
        counts.relayTokensReparented = rt.length;

        const las = await db
          .select({ userId: logtoAccountSecurity.userId })
          .from(logtoAccountSecurity)
          .where(eq(logtoAccountSecurity.lastOperatorActorId, orphanActorId));
        counts.logtoSecurityReparented = las.length;
      }

      // M127: memories no longer carry agent_id; nothing to reparent.
      counts.memoriesReparented = 0;

      const ses = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.agentId, orphan.id));
      counts.sessionsReparented = ses.length;

      // M128: groups.agent_id dropped — agent delete no longer cascades groups.
      counts.groupsCascadeDeleted = 0;

      plans.push({
        orphanAgentId: orphan.id,
        orphanAgentHandle: orphan.handle,
        orphanActorId,
        counts,
      });
    }

    const userPlans: UserOrphanPlan[] = [];

    for (const orphanUser of userOrphans) {
      const [orphanUserActorRow] = await db
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.ownerId, orphanUser.id), eq(actors.kind, "user")))
        .limit(1);
      const orphanUserActorId = orphanUserActorRow?.id ?? "";
      if (!orphanUserActorId) continue;

      const c: UserOrphanPlan["counts"] = {
        roomMembersReparented: 0,
        roomMembersDeduped: 0,
        roomsCreatedByReparented: 0,
        roomsHumanActorIdsRewritten: 0,
        credentialsReparented: 0,
        credentialsDeduped: 0,
        recoveryCodesReparented: 0,
        channelIdentitiesReparented: 0,
        channelIdentitiesDeduped: 0,
        profilesDeleteOrphan: 0,
        groupMembersUserIdReparented: 0,
        groupMembersUserIdDeduped: 0,
        groupMembersGrantedByReparented: 0,
        sessionsOwnerReparented: 0,
        sessionsDeduped: 0,
        roomsOwnerReparented: 0,
        fileRevisionsOwnerReparented: 0,
        relayTokensUserReparented: 0,
        relayTokensActorReparented: 0,
        logtoLastOperatorActorReparented: 0,
        logtoAccountSecurityDeleteOrphan: 0,
        logtoAccountSecurityUserPkReparent: 0,
        invitesCreatedByReparented: 0,
        groupsOwnerReparented: 0,
        jobsOwnerReparented: 0,
        jobsRequestorReparented: 0,
        agentScopesSpeakerReparented: 0,
        agentScopesDeduped: 0,
        standingApprovalsCreatedByReparented: 0,
        standingApprovalsActorPatternReparented: 0,
        approvalChallengesRequestedByReparented: 0,
        approvalChallengesResolvedByReparented: 0,
      };

      const rmConflicts = await db
        .select({ roomId: roomMembers.roomId })
        .from(roomMembers)
        .where(
          and(
            eq(roomMembers.actorId, orphanUserActorId),
            inArray(
              roomMembers.roomId,
              db
                .select({ roomId: roomMembers.roomId })
                .from(roomMembers)
                .where(eq(roomMembers.actorId, activeUserActorId)),
            ),
          ),
        );
      c.roomMembersDeduped = rmConflicts.length;
      const rmOrphan = await db
        .select({ roomId: roomMembers.roomId })
        .from(roomMembers)
        .where(eq(roomMembers.actorId, orphanUserActorId));
      c.roomMembersReparented = Math.max(0, rmOrphan.length - rmConflicts.length);

      const cb = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.createdBy, orphanUserActorId));
      c.roomsCreatedByReparented = cb.length;

      const hai = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(sql`${rooms.humanActorIds} @> ARRAY[${orphanUserActorId}]::uuid[]`);
      c.roomsHumanActorIdsRewritten = hai.length;

      const activeCredTypes = new Set(
        (
          await db
            .select({ type: credentials.type })
            .from(credentials)
            .where(eq(credentials.userId, activeUserId))
        ).map((r) => r.type),
      );
      const orphanCreds = await db
        .select({ id: credentials.id, type: credentials.type })
        .from(credentials)
        .where(eq(credentials.userId, orphanUser.id));
      const credDupList = orphanCreds.filter((r) => activeCredTypes.has(r.type));
      c.credentialsDeduped = credDupList.length;
      c.credentialsReparented = Math.max(0, orphanCreds.length - credDupList.length);

      const rc = await db
        .select({ id: recoveryCodes.id })
        .from(recoveryCodes)
        .where(eq(recoveryCodes.userId, orphanUser.id));
      c.recoveryCodesReparented = rc.length;

      const activeCiRows = await db
        .select({
          channel: channelIdentities.channel,
          externalId: channelIdentities.externalId,
        })
        .from(channelIdentities)
        .where(eq(channelIdentities.userId, activeUserId));
      const activeCiKeys = new Set(
        activeCiRows.map((r) => `${r.channel}\u0000${r.externalId}`),
      );
      const orphanCiRows = await db
        .select({
          id: channelIdentities.id,
          channel: channelIdentities.channel,
          externalId: channelIdentities.externalId,
        })
        .from(channelIdentities)
        .where(eq(channelIdentities.userId, orphanUser.id));
      const ciDupList = orphanCiRows.filter((r) =>
        activeCiKeys.has(`${r.channel}\u0000${r.externalId}`),
      );
      c.channelIdentitiesDeduped = ciDupList.length;
      c.channelIdentitiesReparented = Math.max(0, orphanCiRows.length - ciDupList.length);

      const prof = await db
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.userId, orphanUser.id));
      c.profilesDeleteOrphan = prof.length;

      const gmUserDup = await db
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.userId, orphanUser.id),
            inArray(
              groupMembers.groupId,
              db
                .select({ groupId: groupMembers.groupId })
                .from(groupMembers)
                .where(eq(groupMembers.userId, activeUserId)),
            ),
          ),
        );
      c.groupMembersUserIdDeduped = gmUserDup.length;
      const gmUserAll = await db
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .where(eq(groupMembers.userId, orphanUser.id));
      c.groupMembersUserIdReparented = Math.max(0, gmUserAll.length - gmUserDup.length);

      const gmGrantedRows = await db
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .where(eq(groupMembers.grantedBy, orphanUserActorId));
      c.groupMembersGrantedByReparented = gmGrantedRows.length;

      const sesDup = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.ownerId, orphanUser.id),
            inArray(
              sessions.threadId,
              db
                .select({ threadId: sessions.threadId })
                .from(sessions)
                .where(eq(sessions.ownerId, activeUserId)),
            ),
          ),
        );
      c.sessionsDeduped = sesDup.length;
      const sesAll = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.ownerId, orphanUser.id));
      c.sessionsOwnerReparented = Math.max(0, sesAll.length - sesDup.length);

      const roomsOwn = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.ownerId, orphanUser.id));
      c.roomsOwnerReparented = roomsOwn.length;

      const fr = await db
        .select({ id: fileRevisions.id })
        .from(fileRevisions)
        .where(eq(fileRevisions.ownerId, orphanUser.id));
      c.fileRevisionsOwnerReparented = fr.length;

      const rtUser = await db
        .select({ id: relayTokens.id })
        .from(relayTokens)
        .where(eq(relayTokens.userId, orphanUser.id));
      c.relayTokensUserReparented = rtUser.length;

      const rtAct = await db
        .select({ id: relayTokens.id })
        .from(relayTokens)
        .where(eq(relayTokens.actorId, orphanUserActorId));
      c.relayTokensActorReparented = rtAct.length;

      const lasOp = await db
        .select({ userId: logtoAccountSecurity.userId })
        .from(logtoAccountSecurity)
        .where(eq(logtoAccountSecurity.lastOperatorActorId, orphanUserActorId));
      c.logtoLastOperatorActorReparented = lasOp.length;

      const lasUserOrphan = await db
        .select({ userId: logtoAccountSecurity.userId })
        .from(logtoAccountSecurity)
        .where(eq(logtoAccountSecurity.userId, orphanUser.id));
      const lasUserActive = await db
        .select({ userId: logtoAccountSecurity.userId })
        .from(logtoAccountSecurity)
        .where(eq(logtoAccountSecurity.userId, activeUserId))
        .limit(1);
      c.logtoAccountSecurityDeleteOrphan =
        lasUserOrphan.length > 0 && lasUserActive.length > 0 ? lasUserOrphan.length : 0;
      c.logtoAccountSecurityUserPkReparent =
        lasUserOrphan.length > 0 && lasUserActive.length === 0 ? lasUserOrphan.length : 0;

      const inv = await db
        .select({ id: invites.id })
        .from(invites)
        .where(eq(invites.createdBy, orphanUser.id));
      c.invitesCreatedByReparented = inv.length;

      const grpOwn = await db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.ownerId, orphanUser.id));
      c.groupsOwnerReparented = grpOwn.length;

      const jOwn = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.ownerId, orphanUser.id));
      c.jobsOwnerReparented = jOwn.length;
      const jReq = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.requestorId, orphanUser.id));
      c.jobsRequestorReparented = jReq.length;

      const activeScopeRows = await db
        .select({
          parentAgentId: agentScopes.parentAgentId,
          name: agentScopes.name,
        })
        .from(agentScopes)
        .where(eq(agentScopes.speakerUserId, activeUserId));
      const activeScopeKeys = new Set(
        activeScopeRows.map((r) => `${r.parentAgentId}\u0000${r.name}`),
      );
      const orphanScopeRows = await db
        .select({
          id: agentScopes.id,
          parentAgentId: agentScopes.parentAgentId,
          name: agentScopes.name,
        })
        .from(agentScopes)
        .where(eq(agentScopes.speakerUserId, orphanUser.id));
      const asDupList = orphanScopeRows.filter((r) =>
        activeScopeKeys.has(`${r.parentAgentId}\u0000${r.name}`),
      );
      c.agentScopesDeduped = asDupList.length;
      c.agentScopesSpeakerReparented = Math.max(0, orphanScopeRows.length - asDupList.length);

      const saCb = await db
        .select({ id: standingApprovals.id })
        .from(standingApprovals)
        .where(eq(standingApprovals.createdBy, orphanUser.id));
      c.standingApprovalsCreatedByReparented = saCb.length;
      const saAp = await db
        .select({ id: standingApprovals.id })
        .from(standingApprovals)
        .where(eq(standingApprovals.actorPattern, orphanUser.id));
      c.standingApprovalsActorPatternReparented = saAp.length;

      const acReq = await db
        .select({ id: approvalChallenges.id })
        .from(approvalChallenges)
        .where(eq(approvalChallenges.requestedBy, orphanUser.id));
      c.approvalChallengesRequestedByReparented = acReq.length;
      const acRes = await db
        .select({ id: approvalChallenges.id })
        .from(approvalChallenges)
        .where(eq(approvalChallenges.resolvedBy, orphanUser.id));
      c.approvalChallengesResolvedByReparented = acRes.length;

      userPlans.push({
        orphanUserId: orphanUser.id,
        orphanHandle: orphanUser.handle,
        orphanName: orphanUser.name,
        orphanActorId: orphanUserActorId,
        counts: c,
      });
    }

    for (const p of plans) {
      console.log("");
      console.log(`[repair] plan for orphan agent ${p.orphanAgentId} (handle=${p.orphanAgentHandle}):`);
      console.log(`[repair]   mirror actor: ${p.orphanActorId || "(none)"}`);
      console.log(`[repair]   room_members reparent: ${p.counts.roomMembersReparented} (dedupe: ${p.counts.roomMembersDeduped})`);
      console.log(`[repair]   rooms.created_by reparent: ${p.counts.roomsCreatedByReparented}`);
      console.log(`[repair]   rooms.human_actor_ids rewrite: ${p.counts.roomsHumanActorIdsRewritten}`);
      // M127: memories.agent_id is gone; reparent count is always 0 post-M127.
      console.log(`[repair]   memories reparent (M127: noop): ${p.counts.memoriesReparented}`);
      console.log(`[repair]   sessions.agent_id reparent: ${p.counts.sessionsReparented}`);
      console.log(`[repair]   group_members.granted_by reparent: ${p.counts.groupMembersGrantedByReparented}`);
      console.log(`[repair]   relay_tokens.actor_id reparent: ${p.counts.relayTokensReparented}`);
      console.log(`[repair]   logto_account_security.last_operator_actor_id reparent: ${p.counts.logtoSecurityReparented}`);
      console.log(`[repair]   groups cascaded on agent delete: ${p.counts.groupsCascadeDeleted}`);
    }

    for (const u of userPlans) {
      const q = u.counts;
      const gmTotal = q.groupMembersUserIdReparented + q.groupMembersGrantedByReparented;
      console.log("");
      console.log(
        `[repair] plan for orphan user ${u.orphanUserId} (handle=${u.orphanHandle ?? "null"}, name=${u.orphanName}):`,
      );
      console.log(`[repair]   mirror user-actor: ${u.orphanActorId}`);
      console.log(`[repair]   room_members reparent: ${q.roomMembersReparented} (dedupe: ${q.roomMembersDeduped})`);
      console.log(`[repair]   rooms.created_by reparent: ${q.roomsCreatedByReparented}`);
      console.log(`[repair]   rooms.human_actor_ids rewrite: ${q.roomsHumanActorIdsRewritten}`);
      console.log(`[repair]   credentials reparent: ${q.credentialsReparented} (dedupe: ${q.credentialsDeduped})`);
      console.log(`[repair]   recovery_codes reparent: ${q.recoveryCodesReparented}`);
      console.log(
        `[repair]   channel_identities reparent: ${q.channelIdentitiesReparented} (dedupe: ${q.channelIdentitiesDeduped})`,
      );
      console.log(`[repair]   profiles delete-orphan: ${q.profilesDeleteOrphan}`);
      console.log(`[repair]   group_members reparent: ${gmTotal} (dedupe: ${q.groupMembersUserIdDeduped})`);
      console.log(`[repair]   sessions.owner_id reparent: ${q.sessionsOwnerReparented} (dedupe: ${q.sessionsDeduped})`);
      console.log(`[repair]   rooms.owner_id reparent: ${q.roomsOwnerReparented}`);
      console.log(`[repair]   file_revisions.owner_id reparent: ${q.fileRevisionsOwnerReparented}`);
      console.log(`[repair]   relay_tokens.actor_id reparent: ${q.relayTokensActorReparented}`);
      console.log(`[repair]   relay_tokens.user_id reparent: ${q.relayTokensUserReparented}`);
      console.log(`[repair]   logto_account_security.last_operator_actor_id reparent: ${q.logtoLastOperatorActorReparented}`);
      console.log(`[repair]   logto_account_security delete-orphan: ${q.logtoAccountSecurityDeleteOrphan}`);
      if (q.logtoAccountSecurityUserPkReparent > 0) {
        console.log(`[repair]   logto_account_security user_id reparent (PK): ${q.logtoAccountSecurityUserPkReparent}`);
      }
      console.log(`[repair]   invites.created_by reparent: ${q.invitesCreatedByReparented}`);
      if (
        q.groupsOwnerReparented > 0 ||
        q.jobsOwnerReparented > 0 ||
        q.jobsRequestorReparented > 0 ||
        q.agentScopesSpeakerReparented > 0 ||
        q.agentScopesDeduped > 0 ||
        q.standingApprovalsCreatedByReparented > 0 ||
        q.standingApprovalsActorPatternReparented > 0 ||
        q.approvalChallengesRequestedByReparented > 0 ||
        q.approvalChallengesResolvedByReparented > 0
      ) {
        console.log(
          `[repair]   (schema extras) groups.owner_id: ${q.groupsOwnerReparented}; jobs owner/requestor: ${q.jobsOwnerReparented}/${q.jobsRequestorReparented}; agent_scopes speaker: ${q.agentScopesSpeakerReparented} (dedupe ${q.agentScopesDeduped}); standing_approvals created_by/actor_pattern: ${q.standingApprovalsCreatedByReparented}/${q.standingApprovalsActorPatternReparented}; approval_challenges requested_by/resolved_by: ${q.approvalChallengesRequestedByReparented}/${q.approvalChallengesResolvedByReparented}`,
        );
      }
    }

    if (!apply) {
      console.log("");
      console.log("[repair] DRY-RUN — no rows changed. Re-run with --apply to commit.");
      return 0;
    }

    await db.transaction(async (tx) => {
      for (const p of plans) {
        if (p.orphanActorId) {
          await tx.execute(sql`
            DELETE FROM ${roomMembers}
              WHERE ${roomMembers.actorId} = ${p.orphanActorId}
              AND ${roomMembers.roomId} IN (
                SELECT ${roomMembers.roomId} FROM ${roomMembers}
                  WHERE ${roomMembers.actorId} = ${activeActorId}
              );
          `);

          await tx
            .update(roomMembers)
            .set({ actorId: activeActorId })
            .where(eq(roomMembers.actorId, p.orphanActorId));

          await tx
            .update(rooms)
            .set({ createdBy: activeActorId })
            .where(eq(rooms.createdBy, p.orphanActorId));

          await tx.execute(sql`
            UPDATE ${rooms}
              SET human_actor_ids = (
                SELECT ARRAY(
                  SELECT DISTINCT unnest(
                    array_replace(human_actor_ids, ${p.orphanActorId}::uuid, ${activeActorId}::uuid)
                  )
                )
              )
              WHERE human_actor_ids @> ARRAY[${p.orphanActorId}::uuid];
          `);

          await tx
            .update(groupMembers)
            .set({ grantedBy: activeActorId })
            .where(eq(groupMembers.grantedBy, p.orphanActorId));

          await tx
            .update(relayTokens)
            .set({ actorId: activeActorId })
            .where(eq(relayTokens.actorId, p.orphanActorId));

          await tx
            .update(logtoAccountSecurity)
            .set({ lastOperatorActorId: activeActorId })
            .where(eq(logtoAccountSecurity.lastOperatorActorId, p.orphanActorId));
        }

        // M127: memories.agent_id is gone — no reparent needed.
        // Memory rows authored under the orphan agent remain attached
        // to their Namespace (the canonical content scope).

        await tx
          .update(sessions)
          .set({ agentId: active.id })
          .where(eq(sessions.agentId, p.orphanAgentId));

        if (p.orphanActorId) {
          await tx.delete(actors).where(eq(actors.id, p.orphanActorId));
        }
        await tx.delete(agents).where(eq(agents.id, p.orphanAgentId));

        console.log(
          `[repair] applied: orphan agent ${p.orphanAgentId} (handle=${p.orphanAgentHandle}) merged into ${active.id}; ${p.counts.groupsCascadeDeleted} group(s) cascaded.`,
        );
      }

      for (const u of userPlans) {
        const oid = u.orphanUserId;
        const oAct = u.orphanActorId;

        await tx.execute(sql`
          DELETE FROM ${roomMembers}
            WHERE ${roomMembers.actorId} = ${oAct}
            AND ${roomMembers.roomId} IN (
              SELECT ${roomMembers.roomId} FROM ${roomMembers}
                WHERE ${roomMembers.actorId} = ${activeUserActorId}
            );
        `);

        await tx
          .update(roomMembers)
          .set({ actorId: activeUserActorId })
          .where(eq(roomMembers.actorId, oAct));

        await tx
          .update(rooms)
          .set({ createdBy: activeUserActorId })
          .where(eq(rooms.createdBy, oAct));

        await tx.execute(sql`
          UPDATE ${rooms}
            SET human_actor_ids = (
              SELECT ARRAY(
                SELECT DISTINCT unnest(
                  array_replace(human_actor_ids, ${oAct}::uuid, ${activeUserActorId}::uuid)
                )
              )
            )
            WHERE human_actor_ids @> ARRAY[${oAct}::uuid];
        `);

        await tx
          .update(groupMembers)
          .set({ grantedBy: activeUserActorId })
          .where(eq(groupMembers.grantedBy, oAct));

        await tx
          .update(relayTokens)
          .set({ actorId: activeUserActorId })
          .where(eq(relayTokens.actorId, oAct));

        await tx
          .update(logtoAccountSecurity)
          .set({ lastOperatorActorId: activeUserActorId })
          .where(eq(logtoAccountSecurity.lastOperatorActorId, oAct));

        await tx.execute(sql`
          DELETE FROM ${credentials}
            WHERE ${credentials.userId} = ${oid}
            AND ${credentials.type} IN (
              SELECT ${credentials.type} FROM ${credentials}
                WHERE ${credentials.userId} = ${activeUserId}
            );
        `);

        await tx
          .update(credentials)
          .set({ userId: activeUserId })
          .where(eq(credentials.userId, oid));

        await tx
          .update(recoveryCodes)
          .set({ userId: activeUserId })
          .where(eq(recoveryCodes.userId, oid));

        await tx.execute(sql`
          DELETE FROM ${channelIdentities} o
            USING ${channelIdentities} a
            WHERE o.user_id = ${oid}
            AND a.user_id = ${activeUserId}
            AND a.channel = o.channel
            AND a.external_id = o.external_id;
        `);

        await tx
          .update(channelIdentities)
          .set({ userId: activeUserId })
          .where(eq(channelIdentities.userId, oid));

        await tx.delete(profiles).where(eq(profiles.userId, oid));

        await tx.execute(sql`
          DELETE FROM ${groupMembers}
            WHERE ${groupMembers.userId} = ${oid}
            AND ${groupMembers.groupId} IN (
              SELECT ${groupMembers.groupId} FROM ${groupMembers}
                WHERE ${groupMembers.userId} = ${activeUserId}
            );
        `);

        await tx
          .update(groupMembers)
          .set({ userId: activeUserId })
          .where(eq(groupMembers.userId, oid));

        await tx.execute(sql`
          DELETE FROM ${sessions}
            WHERE ${sessions.ownerId} = ${oid}
            AND ${sessions.threadId} IN (
              SELECT ${sessions.threadId} FROM ${sessions}
                WHERE ${sessions.ownerId} = ${activeUserId}
            );
        `);

        await tx
          .update(sessions)
          .set({ ownerId: activeUserId })
          .where(eq(sessions.ownerId, oid));

        await tx.update(rooms).set({ ownerId: activeUserId }).where(eq(rooms.ownerId, oid));

        await tx
          .update(fileRevisions)
          .set({ ownerId: activeUserId })
          .where(eq(fileRevisions.ownerId, oid));

        await tx
          .update(relayTokens)
          .set({ userId: activeUserId, actorId: activeUserActorId })
          .where(eq(relayTokens.userId, oid));

        await tx
          .delete(logtoAccountSecurity)
          .where(and(eq(logtoAccountSecurity.userId, oid), sql`EXISTS (
            SELECT 1 FROM ${logtoAccountSecurity} las2
            WHERE las2.user_id = ${activeUserId}
          )`));

        await tx
          .update(logtoAccountSecurity)
          .set({ userId: activeUserId })
          .where(eq(logtoAccountSecurity.userId, oid));

        await tx.update(invites).set({ createdBy: activeUserId }).where(eq(invites.createdBy, oid));

        await tx.update(groups).set({ ownerId: activeUserId }).where(eq(groups.ownerId, oid));

        await tx.update(jobs).set({ ownerId: activeUserId }).where(eq(jobs.ownerId, oid));
        await tx.update(jobs).set({ requestorId: activeUserId }).where(eq(jobs.requestorId, oid));

        await tx.execute(sql`
          DELETE FROM ${agentScopes} o
            USING ${agentScopes} a
            WHERE o.speaker_user_id = ${oid}
            AND a.speaker_user_id = ${activeUserId}
            AND a.parent_agent_id = o.parent_agent_id
            AND a.name = o.name;
        `);

        await tx
          .update(agentScopes)
          .set({ speakerUserId: activeUserId })
          .where(eq(agentScopes.speakerUserId, oid));

        await tx
          .update(standingApprovals)
          .set({ createdBy: activeUserId })
          .where(eq(standingApprovals.createdBy, oid));

        await tx
          .update(standingApprovals)
          .set({ actorPattern: activeUserId })
          .where(eq(standingApprovals.actorPattern, oid));

        await tx
          .update(approvalChallenges)
          .set({ requestedBy: activeUserId })
          .where(eq(approvalChallenges.requestedBy, oid));

        await tx
          .update(approvalChallenges)
          .set({ resolvedBy: activeUserId })
          .where(eq(approvalChallenges.resolvedBy, oid));

        await tx.delete(actors).where(eq(actors.id, oAct));
        await tx.delete(users).where(eq(users.id, oid));

        console.log(
          `[repair] applied: orphan user ${oid} (handle=${u.orphanHandle ?? "null"}) merged into ${activeUserId}.`,
        );
      }

      // D140 (post-rebase): no `is_bootstrap_seed` columns to flip.
      // M100's helpers detect the claimer via the presence of
      // credentials + the existence of an agent_ownership group; both
      // of those are now true on the active rows (the agent has its
      // group from the claim path, the user has credentials from PIN
      // hashing). The repair is structurally complete after the
      // orphan delete above.
    });

    console.log("");
    console.log("[repair] APPLIED — merged orphan agent/user wiring where needed. Restart the server to re-pick up env state.");
    return 0;
  } finally {
    await db.end();
  }
}
