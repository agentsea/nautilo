import { randomUUID } from "node:crypto";
import { warn } from "@nautilo/logger";
import {
  accountDeletionPhotoCleanup,
  actors,
  agents,
  and,
  agentPhotoSelectionRevisions,
  approvalChallenges,
  codexThreadBindings,
  connectedWebAccounts,
  connectedWebOperations,
  codexUserInputRequests,
  db,
  eq,
  getSharedDirectDb,
  groupMembers,
  groups,
  humanCryptoCustodies,
  inArray,
  isNotNull,
  jobs,
  memoryNamespaces,
  mediaGenerations,
  memberRollouts,
  or,
  ownedPhotoEntries,
  photoLibraryOperations,
  profiles,
  pushInstallationBindings,
  pushNotificationDeliveries,
  pushNotificationTestIntents,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  sql,
  standingApprovals,
  users,
  workspaceDocumentMutations,
  type ConnectedWebAccountRow,
  type DirectDatabase,
} from "@nautilo/db";
import { BrowserUseCloudAdapter } from "../browser-use/browser-use-cloud";
import { ConnectedWebOperationSecrets } from "../connected-web-accounts/operation-secrets";
import { stopIdleConnectedWebBrowser } from "../connected-web-accounts/browser-idle-cleanup";
import { requirePairingPepper } from "../remote-control/pairing-secrets";
import {
  findCanonicalGroupByType,
  findUserById,
  getLogtoAdminClient,
} from "@nautilo/trust";
import {
  accountDeletionOwnedMediaDeleteSql,
  accountDeletionSharedRoomLocksSql,
} from "./account-deletion-sql";
import { removeKnownOwnedAvatarMedia } from "../photo-library/owned-photo-gc";

export type AccountDeletionEligibility =
  | { eligible: true }
  | { eligible: false; code: "user_not_found" }
  | { eligible: false; code: "federated_user" }
  | { eligible: false; code: "protected_custody" }
  | { eligible: false; code: "active_media_operation" }
  | { eligible: false; code: "last_owner" }
  | {
      eligible: false;
      code: "owns_shared_rooms";
      sharedRoomCount: number;
    };

export interface AccountDeletionResult {
  readonly logtoRevoked: boolean;
  readonly deletedAgents: number;
  readonly deletedRooms: number;
  readonly deletedSessions: number;
}

export class AccountDeletionIneligibleError extends Error {
  constructor(
    readonly eligibility: Exclude<AccountDeletionEligibility, { eligible: true }>,
  ) {
    super(eligibility.code);
    this.name = "AccountDeletionIneligibleError";
  }
}

/** External profile deletion is a fail-closed prerequisite for Human deletion. */
export class AccountDeletionConnectedWebAccountsCleanupError extends Error {
  constructor() {
    super("connected_web_accounts_cleanup_unavailable");
    this.name = "AccountDeletionConnectedWebAccountsCleanupError";
  }
}

function connectedWebAccountCleanupFailed(result: unknown): boolean {
  return typeof result === "object" && result !== null && "kind" in result
    && (result as { code?: unknown }).code !== "resource_not_found";
}

/** Provider cleanup must finish before the RESTRICT-owned local row can be removed. */
export async function cleanupConnectedWebAccountsBeforeAccountDeletion(
  rows: readonly {
    readonly profileRef: ConnectedWebAccountRow["profileRef"];
    readonly checkpoint: ConnectedWebAccountRow["executionCheckpoint"];
  }[],
  browser: Pick<BrowserUseCloudAdapter, "stopBrowser" | "stopHostedReadBrowser" | "deleteProfile">,
): Promise<void> {
  for (const row of rows) {
    const checkpoint = row.checkpoint;
    if (checkpoint?.phase === "reserving") throw new AccountDeletionConnectedWebAccountsCleanupError();
    if (checkpoint?.phase === "active" && checkpoint.opaqueExecutionRef) {
      const direct = checkpoint.resource === "login" || checkpoint.resource === "view";
      const stopped = direct ? await browser.stopBrowser(checkpoint.opaqueExecutionRef)
        : await browser.stopHostedReadBrowser(checkpoint.opaqueExecutionRef);
      if (direct ? connectedWebAccountCleanupFailed(stopped) : stopped !== true) {
        throw new AccountDeletionConnectedWebAccountsCleanupError();
      }
    }
    if (!row.profileRef) continue;
    const deleted = await browser.deleteProfile(row.profileRef);
    if (connectedWebAccountCleanupFailed(deleted)) {
      throw new AccountDeletionConnectedWebAccountsCleanupError();
    }
  }
}

async function targetIsLastOwner(targetUserId: string): Promise<boolean> {
  const ownersGroup = await findCanonicalGroupByType("owners");
  if (!ownersGroup) return false;
  const rows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, ownersGroup.id));
  const targetIsOwner = rows.some((row) => row.userId === targetUserId);
  return targetIsOwner && rows.every((row) => row.userId === targetUserId);
}

async function countOwnedSharedRooms(targetUserId: string): Promise<number> {
  const sharedRooms = await db
    .select({ roomId: rooms.id })
    .from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(
      and(
        eq(rooms.ownerId, targetUserId),
        isNotNull(actors.ownerId),
        sql`${actors.ownerId} <> ${targetUserId}`,
      ),
    )
    .groupBy(rooms.id);
  return sharedRooms.length;
}

type MediaOperationForDeletion = Readonly<{
  providerQueueId: string | null;
  state: string;
  cleanupState: string;
}>;

/**
 * An unadmitted receipt has no external work and never blocks deletion. A
 * provider-accepted receipt is deletable only once its external lifecycle is
 * terminal. `unknown` is deliberately active: it might represent paid
 * provider work that still needs reconciliation. Ready work is terminal only
 * after its artifact cleanup has committed.
 */
export function isSafelyTerminalMediaOperation(
  receipt: MediaOperationForDeletion,
): boolean {
  if (receipt.providerQueueId === null) return true;
  return receipt.state === "needs_action"
    || receipt.state === "failed"
    || (receipt.state === "ready" && receipt.cleanupState === "completed");
}

async function hasActiveMediaOperation(targetUserId: string): Promise<boolean> {
  const rows = await db.select({
    providerQueueId: mediaGenerations.providerQueueId,
    state: mediaGenerations.state,
    cleanupState: mediaGenerations.cleanupState,
  }).from(mediaGenerations).where(eq(mediaGenerations.ownerId, targetUserId));
  return rows.some((row) => !isSafelyTerminalMediaOperation(row));
}

export async function assessAccountDeletion(
  targetUserId: string,
): Promise<AccountDeletionEligibility> {
  const target = await findUserById(targetUserId);
  if (!target) return { eligible: false, code: "user_not_found" };
  if (target.server !== null) {
    return { eligible: false, code: "federated_user" };
  }
  const custody = await db.select({ humanId: humanCryptoCustodies.humanId })
    .from(humanCryptoCustodies)
    .where(eq(humanCryptoCustodies.userId, targetUserId))
    .limit(1);
  if (custody.length > 0) return { eligible: false, code: "protected_custody" };
  if (await hasActiveMediaOperation(targetUserId)) {
    return { eligible: false, code: "active_media_operation" };
  }
  if (await targetIsLastOwner(targetUserId)) {
    return { eligible: false, code: "last_owner" };
  }
  const sharedRoomCount = await countOwnedSharedRooms(targetUserId);
  if (sharedRoomCount > 0) {
    return { eligible: false, code: "owns_shared_rooms", sharedRoomCount };
  }
  return { eligible: true };
}

const ACCOUNT_DELETION_PHOTO_CLEANUP_LIMIT = 25;
const ACCOUNT_DELETION_PHOTO_CLEANUP_LEASE_MS = 15 * 60 * 1000;

/**
 * Complete a bounded page of committed account-deletion blob receipts. The
 * claim is committed before any filesystem mutation, and a stale claim is
 * safe to replay because the exact removal primitive treats missing bytes as
 * a successful reconciliation outcome.
 */
export async function reconcileAccountDeletionPhotoCleanup(
  input: {
    readonly db?: DirectDatabase;
    readonly limit?: number;
    readonly now?: () => Date;
    readonly removeMedia?: (entry: Pick<typeof ownedPhotoEntries.$inferSelect, "avatarKind" | "blobId">) => Promise<unknown>;
    /** Test/host seam between irreversible removal and receipt finalization. */
    readonly afterRemoveMedia?: (entry: { readonly id: string }) => Promise<void>;
  } = {},
): Promise<number> {
  const directDb = input.db ?? getSharedDirectDb();
  const limit = input.limit ?? ACCOUNT_DELETION_PHOTO_CLEANUP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ACCOUNT_DELETION_PHOTO_CLEANUP_LIMIT) {
    throw new Error(`account deletion photo cleanup limit must be 1-${ACCOUNT_DELETION_PHOTO_CLEANUP_LIMIT}`);
  }
  const now = input.now ?? (() => new Date());
  const removeMedia = input.removeMedia ?? removeKnownOwnedAvatarMedia;
  const claimed = await directDb.transaction(async (tx) => {
    const current = now();
    const staleBefore = new Date(current.getTime() - ACCOUNT_DELETION_PHOTO_CLEANUP_LEASE_MS);
    const rows = await tx.execute(sql`
      SELECT id, avatar_kind, blob_id
      FROM account_deletion_photo_cleanup
      WHERE claimed_at IS NULL OR claimed_at < ${staleBefore.toISOString()}::timestamptz
      ORDER BY created_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `) as unknown as Array<{ id: string; avatar_kind: "generated" | "uploaded"; blob_id: string }>;
    const out: Array<{ id: string; token: string; avatarKind: "generated" | "uploaded"; blobId: string }> = [];
    for (const row of rows) {
      const token = randomUUID();
      const updated = await tx.update(accountDeletionPhotoCleanup).set({
        claimToken: token,
        claimedAt: current,
        attempts: sql`${accountDeletionPhotoCleanup.attempts} + 1`,
      }).where(and(
        eq(accountDeletionPhotoCleanup.id, row.id),
      )).returning({ id: accountDeletionPhotoCleanup.id });
      if (updated.length === 1) out.push({
        id: row.id,
        token,
        avatarKind: row.avatar_kind,
        blobId: row.blob_id,
      });
    }
    return out;
  });

  let completed = 0;
  for (const entry of claimed) {
    try {
      await removeMedia({ avatarKind: entry.avatarKind, blobId: entry.blobId });
      await input.afterRemoveMedia?.({ id: entry.id });
      const finalized = await directDb.delete(accountDeletionPhotoCleanup).where(and(
        eq(accountDeletionPhotoCleanup.id, entry.id),
        eq(accountDeletionPhotoCleanup.claimToken, entry.token),
      )).returning({ id: accountDeletionPhotoCleanup.id });
      completed += finalized.length;
    } catch {
      // Retain the committed lease. A subsequent bounded run reclaims only
      // after expiry, avoiding hot-looping a broken filesystem while making
      // interruption after byte deletion safely idempotent.
    }
  }
  return completed;
}

/** Start bounded boot/timer reconciliation for committed account deletions. */
export function startAccountDeletionPhotoCleanupRecovery(input: {
  readonly db: DirectDatabase;
  readonly intervalMs?: number;
}): () => void {
  const intervalMs = input.intervalMs ?? 60_000;
  const run = async (): Promise<void> => {
    try {
      await reconcileAccountDeletionPhotoCleanup({ db: input.db });
    } catch (error) {
      warn(`[account-deletion] photo cleanup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Canonical irreversible local-account cascade used by both Admin and
 * self-service routes. Callers must assess eligibility immediately before
 * invoking it and apply their own authorization/fresh-auth policy.
 */
export async function deleteLocalUserAccount(
  targetUserId: string,
): Promise<AccountDeletionResult> {
  const directDb = getSharedDirectDb();
  const deletion = await directDb.transaction(async (tx) => {
    // The mutation boundary owns all snapshots. These row locks fence the
    // exact FKs that could otherwise turn a checked account into the last
    // owner or turn an owned Room into a shared Room during deletion.
    const targetRows = await tx.execute(sql`
      SELECT id, external_id, server
      FROM users
      WHERE id = ${targetUserId}
      FOR UPDATE
    `) as unknown as Array<{ id: string; external_id: string | null; server: string | null }>;
    const target = targetRows[0];
    if (!target) throw new AccountDeletionIneligibleError({ eligible: false, code: "user_not_found" });
    if (target.server !== null) throw new AccountDeletionIneligibleError({ eligible: false, code: "federated_user" });
    const custody = await tx.select({ humanId: humanCryptoCustodies.humanId })
      .from(humanCryptoCustodies)
      .where(eq(humanCryptoCustodies.userId, targetUserId))
      .for("update");
    if (custody.length > 0) {
      throw new AccountDeletionIneligibleError({ eligible: false, code: "protected_custody" });
    }
    const targetMediaRows = await tx.execute(sql`
      SELECT provider_queue_id, state, cleanup_state
      FROM media_generations
      WHERE owner_id = ${targetUserId}
      ORDER BY id
      FOR UPDATE
    `) as unknown as Array<{
      provider_queue_id: string | null;
      state: string;
      cleanup_state: string;
    }>;
    if (targetMediaRows.some((row) => !isSafelyTerminalMediaOperation({
      providerQueueId: row.provider_queue_id,
      state: row.state,
      cleanupState: row.cleanup_state,
    }))) {
      throw new AccountDeletionIneligibleError({
        eligible: false,
        code: "active_media_operation",
      });
    }

    const ownerGroups = await tx.execute(sql`
      SELECT id FROM groups WHERE type = 'owners' FOR UPDATE
    `) as unknown as Array<{ id: string }>;
    const ownerMemberships = ownerGroups.length === 0 ? [] : await tx.execute(sql`
      SELECT user_id FROM group_members
      WHERE group_id = ${ownerGroups[0]!.id}
      ORDER BY user_id
      FOR UPDATE
    `) as unknown as Array<{ user_id: string }>;
    const ownerIds = ownerMemberships.map((row) => row.user_id);
    if (ownerIds.includes(targetUserId) && ownerIds.every((id) => id === targetUserId)) {
      throw new AccountDeletionIneligibleError({ eligible: false, code: "last_owner" });
    }

    const roomRows = await tx.execute(sql`
      SELECT r.id, r.namespace_id
      FROM rooms r
      WHERE r.owner_id = ${targetUserId}
      ORDER BY r.id
      FOR UPDATE
    `) as unknown as Array<{ id: string; namespace_id: string }>;
    const roomIdList = roomRows.map((row) => row.id);
    const namespaceIds = [...new Set(roomRows.map((row) => row.namespace_id))];
    const sharedRows = roomIdList.length === 0 ? [] : await tx.execute(
      accountDeletionSharedRoomLocksSql(roomIdList, targetUserId),
    ) as unknown as Array<{ room_id: string }>;
    const sharedRoomCount = new Set(sharedRows.map((row) => row.room_id)).size;
    if (sharedRoomCount > 0) {
      throw new AccountDeletionIneligibleError({
        eligible: false,
        code: "owns_shared_rooms",
        sharedRoomCount,
      });
    }

    // This is intentionally after every locked eligibility gate. A rejected
    // deletion must never tear down an otherwise valid Human's website
    // session. The rare deletion transaction holds its lock through this
    // bounded cleanup; a provider 404 is already-cleaned and idempotent.
    // Lock operations before accounts, matching supervision and warm reuse.
    // An active operation (including uncertain provider creation) must finish
    // or be explicitly stopped before its durable cleanup owner is deleted.
    const websiteOperations = await tx.select().from(connectedWebOperations)
      .where(eq(connectedWebOperations.ownerUserId, targetUserId)).for("update");
    if (websiteOperations.some((operation) => operation.lifecycle !== "terminal")) {
      throw new AccountDeletionConnectedWebAccountsCleanupError();
    }
    const connectedRows = await tx.select({
      profileRef: connectedWebAccounts.profileRef,
      checkpoint: connectedWebAccounts.executionCheckpoint,
    })
      .from(connectedWebAccounts).where(eq(connectedWebAccounts.ownerUserId, targetUserId)).for("update");
    // In-flight synchronous work may be creating its next verifier before
    // checkpoint activation. Explicit Stop/completion owns that barrier; user
    // deletion must not race it or discard an uncertain admission fence.
    if (connectedRows.some((row) => row.checkpoint !== null)) throw new AccountDeletionConnectedWebAccountsCleanupError();
    if (websiteOperations.length || connectedRows.some((row) => row.profileRef !== null || row.checkpoint !== null)) {
      const browser = new BrowserUseCloudAdapter({ serverKeys: process.env });
      for (const operation of websiteOperations) {
        if (operation.browserIdleUntil === null) continue;
        // The locked row cannot be reused; deletion commits only after exact
        // cleanup. A rollback keeps custody and makes stop safely retryable.
        const stopped = await stopIdleConnectedWebBrowser({
          operation: { ...operation, browserCleanupStartedAt: new Date() },
          secrets: new ConnectedWebOperationSecrets({ stableServerSecret: requirePairingPepper() }),
          provider: browser,
        });
        if (!stopped) throw new AccountDeletionConnectedWebAccountsCleanupError();
      }
      await cleanupConnectedWebAccountsBeforeAccountDeletion(connectedRows, browser);
    }

    const ownedAgentRows = await tx.execute(sql`
      SELECT agent_id
      FROM actors
      WHERE kind = 'agent' AND owner_id = ${targetUserId} AND agent_id IS NOT NULL
      ORDER BY agent_id
      FOR UPDATE
    `) as unknown as Array<{ agent_id: string }>;
    const agentIdList = [...new Set(ownedAgentRows.map((row) => row.agent_id))];
    const sessionRows = await tx.select({ id: sessions.id }).from(sessions)
      .where(eq(sessions.ownerId, targetUserId)).for("update");
    const sessionIdList = sessionRows.map((row) => row.id);
    const ownedGroupRows = await tx.select({ id: groups.id }).from(groups)
      .where(eq(groups.ownerId, targetUserId)).for("update");
    const ownedGroupIds = ownedGroupRows.map((row) => row.id);
    const pushBindingRows = await tx.select({ id: pushInstallationBindings.bindingId })
      .from(pushInstallationBindings).where(eq(pushInstallationBindings.userId, targetUserId)).for("update");
    const pushBindingIds = pushBindingRows.map((row) => row.id);
    const photoRows = await tx.select({
      serverInstanceId: ownedPhotoEntries.serverInstanceId,
      avatarKind: ownedPhotoEntries.avatarKind,
      blobId: ownedPhotoEntries.blobId,
    }).from(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, targetUserId)).for("update");

    if (photoRows.length > 0) {
      await tx.insert(accountDeletionPhotoCleanup).values(photoRows).onConflictDoNothing();
    }

    // The owned photo rows have RESTRICT history/receipt edges. Their exact
    // bytes remain reachable through the durable post-commit outbox above.
    await tx.delete(agentPhotoSelectionRevisions)
      .where(eq(agentPhotoSelectionRevisions.ownerUserId, targetUserId));
    await tx.delete(photoLibraryOperations)
      .where(eq(photoLibraryOperations.ownerUserId, targetUserId));
    await tx.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.ownerUserId, targetUserId));

    // Shared document/rollout receipts survive without the former identity.
    await tx.update(workspaceDocumentMutations).set({ ownerId: null })
      .where(eq(workspaceDocumentMutations.ownerId, targetUserId));
    await tx.update(workspaceDocumentMutations).set({ actorId: "deleted-account" }).where(and(
      eq(workspaceDocumentMutations.actorKind, "human"),
      eq(workspaceDocumentMutations.userId, targetUserId),
    ));
    await tx.update(memberRollouts).set({ createdBy: null })
      .where(eq(memberRollouts.createdBy, targetUserId));

    // An unadmitted receipt has no external operation to reconcile. Private
    // Room receipts die with their Room. The active-operation guard above
    // means the remaining accepted receipts are terminal shared-Room history:
    // retain that history, but scrub all creative inputs and human identity.
    if (roomIdList.length > 0) {
      await tx.execute(accountDeletionOwnedMediaDeleteSql(roomIdList, targetUserId));
    } else {
      await tx.delete(mediaGenerations).where(and(
        eq(mediaGenerations.ownerId, targetUserId),
        sql`${mediaGenerations.providerQueueId} IS NULL`,
      ));
    }
    await tx.execute(sql`
      UPDATE media_generations
      SET owner_id = NULL,
          initiating_agent_id = NULL,
          initiating_thread_id = NULL,
          request_payload = jsonb_build_object(
            'version', 1,
            'model', provider_model,
            'prompt', '',
            'normalizedSettings', request_payload->'normalizedSettings'
          ),
          safe_snapshot = jsonb_build_object(
            'version', 1,
            'normalizedSettings', request_payload->'normalizedSettings',
            'inputSummary', jsonb_build_object('promptCharacters', 0)
          ),
          updated_at = now()
      WHERE owner_id = ${targetUserId}
        AND provider_queue_id IS NOT NULL
    `);

    // These rows have restrictive Room and Agent FKs. A private Room can
    // legitimately host a system-owned source agent, so clear Room-scoped
    // receipts as well as target-user and target-agent receipts.
    if (roomIdList.length > 0) {
      await tx.delete(codexUserInputRequests)
        .where(inArray(codexUserInputRequests.roomId, roomIdList));
      await tx.delete(codexThreadBindings)
        .where(inArray(codexThreadBindings.roomId, roomIdList));
    }
    await tx.delete(codexUserInputRequests)
      .where(eq(codexUserInputRequests.userId, targetUserId));
    await tx.delete(codexThreadBindings)
      .where(eq(codexThreadBindings.userId, targetUserId));

    if (agentIdList.length > 0) {
      await tx.delete(codexUserInputRequests)
        .where(inArray(codexUserInputRequests.sourceAgentId, agentIdList));
      await tx.delete(codexThreadBindings)
        .where(inArray(codexThreadBindings.sourceAgentId, agentIdList));
      await tx.update(mediaGenerations).set({ initiatingAgentId: null, initiatingThreadId: null })
        .where(inArray(mediaGenerations.initiatingAgentId, agentIdList));
      await tx.update(sessions).set({ agentId: null })
        .where(inArray(sessions.agentId, agentIdList));
    }

    if (sessionIdList.length > 0) {
      await tx
        .delete(sessionMessages)
        .where(inArray(sessionMessages.sessionId, sessionIdList));
      await tx.delete(sessions).where(inArray(sessions.id, sessionIdList));
    }

    if (roomIdList.length > 0) {
      await tx.update(sessions).set({ roomId: null }).where(inArray(sessions.roomId, roomIdList));
      await tx.update(jobs).set({ roomId: null }).where(inArray(jobs.roomId, roomIdList));
      if (namespaceIds.length > 0) {
        await tx
          .delete(memoryNamespaces)
          .where(inArray(memoryNamespaces.namespaceId, namespaceIds));
      }
    }

    await tx.delete(profiles).where(eq(profiles.userId, targetUserId));

    // Account cascade removes operation/activity/action rows before their
    // RESTRICT references to initiating Genies and Rooms are crossed.
    await tx.delete(connectedWebAccounts).where(eq(connectedWebAccounts.ownerUserId, targetUserId));

    if (agentIdList.length > 0) {
      await tx.delete(actors).where(inArray(actors.agentId, agentIdList));
      await tx.delete(agents).where(inArray(agents.id, agentIdList));
    }

    await tx
      .delete(approvalChallenges)
      .where(
        ownedGroupIds.length > 0
          ? or(
              eq(approvalChallenges.requestedBy, targetUserId),
              eq(approvalChallenges.resolvedBy, targetUserId),
              inArray(approvalChallenges.groupId, ownedGroupIds),
            )
          : or(
              eq(approvalChallenges.requestedBy, targetUserId),
              eq(approvalChallenges.resolvedBy, targetUserId),
            ),
      );
    await tx
      .delete(standingApprovals)
      .where(
        or(
          eq(standingApprovals.createdBy, targetUserId),
          eq(standingApprovals.actorPattern, targetUserId),
        ),
      );
    await tx
      .delete(jobs)
      .where(or(eq(jobs.ownerId, targetUserId), eq(jobs.requestorId, targetUserId)));
    await tx.delete(groupMembers).where(eq(groupMembers.userId, targetUserId));

    // Delivery/test rows deliberately RESTRICT binding deletion. Remove the
    // content-free dependents before the binding and user cascade.
    if (pushBindingIds.length > 0) {
      await tx
        .delete(pushNotificationDeliveries)
        .where(inArray(pushNotificationDeliveries.bindingId, pushBindingIds));
      await tx
        .delete(pushNotificationTestIntents)
        .where(inArray(pushNotificationTestIntents.bindingId, pushBindingIds));
      await tx
        .delete(pushInstallationBindings)
        .where(inArray(pushInstallationBindings.bindingId, pushBindingIds));
    }

    await tx.delete(users).where(eq(users.id, targetUserId));
    return {
      logtoSub: target.external_id,
      deletedAgents: agentIdList.length,
      deletedRooms: roomIdList.length,
      deletedSessions: sessionIdList.length,
    };
  });

  await reconcileAccountDeletionPhotoCleanup({ db: directDb }).catch(() => {
    warn(`[account-deletion] photo cleanup deferred for ${targetUserId}`);
  });

  let logtoRevoked = false;
  if (deletion.logtoSub) {
    try {
      await getLogtoAdminClient().deleteUser(deletion.logtoSub);
      logtoRevoked = true;
    } catch {
      warn(`[account-deletion] Logto deleteUser failed for ${targetUserId}`);
    }
  }

  return {
    logtoRevoked,
    deletedAgents: deletion.deletedAgents,
    deletedRooms: deletion.deletedRooms,
    deletedSessions: deletion.deletedSessions,
  };
}
