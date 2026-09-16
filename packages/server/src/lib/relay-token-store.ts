/**
 * M056 — Relay-token persistence seam.
 *
 * The `POST /api/relay/pair` route, the `relay:register` validator, and
 * the `GET/DELETE /api/relay/devices` routes all funnel through this
 * adapter so unit tests can swap a fake in-memory store via
 * `setRelayTokenStore()` / `resetRelayTokenStore()`. Mirrors the M052
 * `logto-provisioning` adapter pattern.
 *
 * Token plaintext format: `rty_<32 base64url chars>` (192 bits of
 * entropy). The DB stores ONLY the SHA-256 hex hash; plaintext is
 * shown to the user once at pair time and never persisted server-side.
 */

import { createHash } from "node:crypto";
import {
  and,
  getSharedDirectDb,
  db,
  desc,
  eq,
  isNull,
  relayTokens,
  remoteControllerBindings,
  remotePairingChallenges,
} from "@nautilo/db";

export interface RelayTokenRow {
  readonly id: string;
  readonly userId: string;
  readonly actorId: string;
}

export interface RelayDeviceListItem {
  readonly id: string;
  readonly label: string;
  readonly capabilities: Record<string, unknown>;
  readonly createdAt: Date;
  readonly lastSeenAt: Date | null;
}

/** D480's deliberately bounded, non-secret summary for the legacy quarantine. */
export interface RelayHistoricalPairingsSummary {
  readonly activeCount: number;
  readonly oldestPairedAt: Date | null;
  readonly latestSeenAt: Date | null;
}

/** One caller-owned physical-device projection. No credential identifiers leak. */
export interface RelayGroupedDevice {
  readonly deviceManagementId: string;
  readonly label: string;
  readonly pairingCount: number;
  readonly firstPairedAt: Date;
  readonly lastSeenAt: Date | null;
  readonly profiles: readonly string[];
  readonly capabilities: readonly string[];
}

export interface RelayGroupedDevicesResult {
  readonly devices: readonly RelayGroupedDevice[];
  readonly historical: RelayHistoricalPairingsSummary;
}

export interface RelayDeviceMutationResult {
  readonly affectedPairingCount: number;
  /** Server-only pairing generations for the existing invalidation seam. */
  readonly revokedPairingGenerationIds: readonly string[];
  /** False means the opaque target was not caller-owned/current. */
  readonly matched: boolean;
  /** False means a supplied UI count was stale; no rows were changed. */
  readonly current: boolean;
}

class StaleRelayDeviceMutation extends Error {}

const MANAGEMENT_ID_DOMAIN = "nautilo.relay-device-management.v1\0";
const MAX_DEVICE_SUMMARIES = 100;
const MAX_SUMMARY_VALUES = 12;

/**
 * This is intentionally a one-way digest, rather than an encrypted raw group
 * UUID. The UUID remains server-only; binding the digest to userId prevents a
 * same pseudonym from correlating users. A server secret would permit a
 * stronger HMAC later, but this deterministic digest keeps an existing
 * database verifiable without introducing new key-management state.
 */
export function relayDeviceManagementIdFor(userId: string, deviceGroupId: string): string {
  const digest = createHash("sha256")
    .update(`${MANAGEMENT_ID_DOMAIN}${userId}\0${deviceGroupId}`)
    .digest("base64url");
  return `rdm_${digest}`;
}

function boundedStringSet(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_SUMMARY_VALUES);
}

function profileFromCapabilities(capabilities: Record<string, unknown>): string | null {
  const profile = capabilities["profile"];
  return typeof profile === "string" && profile.length > 0 && profile.length <= 120
    ? profile
    : null;
}

/** Return only capability *names* for boolean flags; never arbitrary values. */
function capabilityNames(capabilities: Record<string, unknown>): string[] {
  return Object.entries(capabilities)
    .filter(([name, value]) => name !== "profile" && value === true && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name))
    .map(([name]) => name);
}

export interface RelayTokenStore {
  /** Insert a freshly minted (token-hash, label, capabilities) row.
   *  Returns the new row's id. Legacy path — no installation id, so no
   *  revocation of prior rows (legacy rows MAY legitimately duplicate). */
  insertToken(args: {
    userId: string;
    actorId: string;
    tokenHash: string;
    label: string;
    capabilities: Record<string, unknown>;
    deviceGroupId?: string | null;
  }): Promise<{ id: string }>;

  /**
   * D418 — stable desktop pairing identity. For a present, valid
   * installation id, transactionally revoke every existing active
   * (non-revoked) row for the same (userId, installationId), then
   * insert a new row, returning the new row's id. The caller stamps
   * the returned id as `pairingGeneration` so re-pairing the same
   * installation yields a single active row instead of duplicates.
   * The revoke + insert run in one DB transaction so a crash between
   * them cannot leave the user with zero active rows or two.
   */
  pairForInstallation(args: {
    userId: string;
    actorId: string;
    tokenHash: string;
    label: string;
    capabilities: Record<string, unknown>;
    installationId: string;
    deviceGroupId?: string | null;
  }): Promise<{ id: string; revokedPairingGenerationIds?: readonly string[] }>;

  /** Look up an active (non-revoked) row by hash. */
  findActiveByHash(tokenHash: string): Promise<RelayTokenRow | null>;

  /** Bump `last_seen_at` to NOW for the given token id. Best-effort —
   *  failures are swallowed by the caller. */
  touchLastSeen(tokenId: string): Promise<void>;

  /** List active devices owned by `userId`, most-recently-seen first. */
  listForUser(userId: string): Promise<RelayDeviceListItem[]>;

  /** Mark the row revoked iff it belongs to `userId`. Returns true
   *  when a row was updated (used only by tests; the route silently
   *  returns 204 either way to hide cross-user existence). */
  revokeForUser(args: { id: string; userId: string }): Promise<boolean>;

  /** Bounded caller-owned grouped projection plus legacy quarantine summary. */
  listGroupedForUser?(userId: string): Promise<RelayGroupedDevicesResult>;

  /** Atomically revoke exactly one caller-owned active device-management group. */
  revokeGroupedForUser?(args: {
    userId: string;
    deviceManagementId: string;
    expectedPairingCount: number;
  }): Promise<RelayDeviceMutationResult>;

  /** Atomically clean only still-active legacy (NULL-group) rows for this caller. */
  cleanupHistoricalForUser?(args: {
    userId: string;
    expectedPairingCount: number;
  }): Promise<RelayDeviceMutationResult>;

  /**
   * D458 — optional richer revoke seam.  The HTTP surface stays deliberately
   * silent, while the server can invalidate in-memory live presence and any
   * remote-controller authority derived from the revoked generation(s).
   */
  revokeWithGenerationsForUser?(args: {
    id: string;
    userId: string;
  }): Promise<{ revoked: boolean; revokedPairingGenerationIds: readonly string[] }>;
}

// ---------------------------------------------------------------------------
// Default DB-backed adapter
// ---------------------------------------------------------------------------

function makeDefaultStore(): RelayTokenStore {
  return {
    async insertToken({ userId, actorId, tokenHash, label, capabilities, deviceGroupId = null }) {
      const inserted = await db
        .insert(relayTokens)
        .values({
          userId,
          actorId,
          tokenHash,
          label,
          capabilities,
          deviceGroupId,
          deviceManagementId: deviceGroupId
            ? relayDeviceManagementIdFor(userId, deviceGroupId)
            : null,
        })
        .returning({ id: relayTokens.id });
      const row = inserted[0];
      if (!row) {
        throw new Error("relay_token insert returned no row");
      }
      return { id: row.id };
    },

    async pairForInstallation({
      userId,
      actorId,
      tokenHash,
      label,
      capabilities,
      installationId,
      deviceGroupId = null,
    }) {
      // The default `db` uses Drizzle's stateless Neon HTTP adapter,
      // which rejects interactive `db.transaction()`. Re-pair needs
      // revoke + insert to be atomic, so use a short-lived direct Postgres
      // connection for this rare mutation. Routine relay reads and legacy
      // one-shot pair inserts remain on the HTTP path.
      const directDb = getSharedDirectDb();
      return await directDb.transaction(async (tx) => {
          // Revoke every existing active row for this (user, installation)
          // BEFORE inserting the replacement. Runs in the same transaction
          // as the insert so the partial unique index
          // `uq_relay_tokens_user_installation_active` sees the revoke
          // (the old row leaves the index) before the new row enters it —
          // a single transaction cannot conflict with itself.
          const revoked = await tx
            .update(relayTokens)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(relayTokens.userId, userId),
                eq(relayTokens.installationId, installationId),
                isNull(relayTokens.revokedAt),
              ),
            )
            .returning({ id: relayTokens.id });
          const inserted = await tx
            .insert(relayTokens)
            .values({
              userId,
              actorId,
              tokenHash,
              label,
              capabilities,
              installationId,
              deviceGroupId,
              deviceManagementId: deviceGroupId
                ? relayDeviceManagementIdFor(userId, deviceGroupId)
                : null,
            })
            .returning({ id: relayTokens.id });
          const row = inserted[0];
          if (!row) {
            throw new Error("relay_token pair insert returned no row");
          }
          const revokedPairingGenerationIds = revoked.map((entry) => entry.id);
          // A relay generation is the authority root for the mobile ceremony.
          // Re-pairing must retire its outstanding invitations and already
          // issued controller authority before the replacement is visible.
          for (const pairingGeneration of revokedPairingGenerationIds) {
            await tx
              .update(remotePairingChallenges)
              .set({ revokedAt: new Date() })
              .where(
                and(
                  eq(remotePairingChallenges.userId, userId),
                  eq(remotePairingChallenges.relayTokenId, pairingGeneration),
                  eq(remotePairingChallenges.pairingGeneration, pairingGeneration),
                  isNull(remotePairingChallenges.consumedAt),
                  isNull(remotePairingChallenges.revokedAt),
                ),
              );
            await tx
              .update(remoteControllerBindings)
              .set({ revokedAt: new Date() })
              .where(
                and(
                  eq(remoteControllerBindings.userId, userId),
                  eq(remoteControllerBindings.relayTokenId, pairingGeneration),
                  eq(remoteControllerBindings.pairingGeneration, pairingGeneration),
                  isNull(remoteControllerBindings.revokedAt),
                ),
              );
          }
          return { id: row.id, revokedPairingGenerationIds };
        });
    },

    async findActiveByHash(tokenHash) {
      const rows = await db
        .select({
          id: relayTokens.id,
          userId: relayTokens.userId,
          actorId: relayTokens.actorId,
        })
        .from(relayTokens)
        .where(
          and(
            eq(relayTokens.tokenHash, tokenHash),
            isNull(relayTokens.revokedAt),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async touchLastSeen(tokenId) {
      await db
        .update(relayTokens)
        .set({ lastSeenAt: new Date() })
        .where(eq(relayTokens.id, tokenId));
    },

    async listForUser(userId) {
      const rows = await db
        .select({
          id: relayTokens.id,
          label: relayTokens.label,
          capabilities: relayTokens.capabilities,
          createdAt: relayTokens.createdAt,
          lastSeenAt: relayTokens.lastSeenAt,
        })
        .from(relayTokens)
        .where(
          and(eq(relayTokens.userId, userId), isNull(relayTokens.revokedAt)),
        )
        .orderBy(desc(relayTokens.lastSeenAt), desc(relayTokens.createdAt));
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        capabilities: r.capabilities ?? {},
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
      }));
    },

    async revokeForUser({ id, userId }) {
      const directDb = getSharedDirectDb();
      return directDb.transaction(async (tx) => {
        const revokedAt = new Date();
        const result = await tx
          .update(relayTokens)
          .set({ revokedAt })
          .where(
            and(
              eq(relayTokens.id, id),
              eq(relayTokens.userId, userId),
              isNull(relayTokens.revokedAt),
            ),
          )
          .returning({ id: relayTokens.id });
        for (const generation of result) {
          await tx
            .update(remotePairingChallenges)
            .set({ revokedAt })
            .where(
              and(
                eq(remotePairingChallenges.userId, userId),
                eq(remotePairingChallenges.relayTokenId, generation.id),
                eq(remotePairingChallenges.pairingGeneration, generation.id),
                isNull(remotePairingChallenges.consumedAt),
                isNull(remotePairingChallenges.revokedAt),
              ),
            );
          await tx
            .update(remoteControllerBindings)
            .set({ revokedAt })
            .where(
              and(
                eq(remoteControllerBindings.userId, userId),
                eq(remoteControllerBindings.relayTokenId, generation.id),
                eq(remoteControllerBindings.pairingGeneration, generation.id),
                isNull(remoteControllerBindings.revokedAt),
              ),
            );
        }
        return result.length > 0;
      });
    },

    async revokeWithGenerationsForUser({ id, userId }) {
      const directDb = getSharedDirectDb();
      return directDb.transaction(async (tx) => {
        const revokedAt = new Date();
        const result = await tx
          .update(relayTokens)
          .set({ revokedAt })
          .where(
            and(
              eq(relayTokens.id, id),
              eq(relayTokens.userId, userId),
              isNull(relayTokens.revokedAt),
            ),
          )
          .returning({ id: relayTokens.id });
        for (const generation of result) {
          await tx
            .update(remotePairingChallenges)
            .set({ revokedAt })
            .where(
              and(
                eq(remotePairingChallenges.userId, userId),
                eq(remotePairingChallenges.relayTokenId, generation.id),
                eq(remotePairingChallenges.pairingGeneration, generation.id),
                isNull(remotePairingChallenges.consumedAt),
                isNull(remotePairingChallenges.revokedAt),
              ),
            );
          await tx
            .update(remoteControllerBindings)
            .set({ revokedAt })
            .where(
              and(
                eq(remoteControllerBindings.userId, userId),
                eq(remoteControllerBindings.relayTokenId, generation.id),
                eq(remoteControllerBindings.pairingGeneration, generation.id),
                isNull(remoteControllerBindings.revokedAt),
              ),
            );
        }
        return {
          revoked: result.length > 0,
          revokedPairingGenerationIds: result.map((row) => row.id),
        };
      });
    },

    async listGroupedForUser(userId) {
      // One bounded active-row query produces both the grouped projection and
      // the legacy summary; it deliberately never groups NULL-group rows by
      // their mutable label.
      const rows = await db
        .select({
          deviceManagementId: relayTokens.deviceManagementId,
          label: relayTokens.label,
          capabilities: relayTokens.capabilities,
          createdAt: relayTokens.createdAt,
          lastSeenAt: relayTokens.lastSeenAt,
        })
        .from(relayTokens)
        .where(and(eq(relayTokens.userId, userId), isNull(relayTokens.revokedAt)))
        .orderBy(desc(relayTokens.lastSeenAt), desc(relayTokens.createdAt))
        .limit(MAX_DEVICE_SUMMARIES * 20);

      const grouped = new Map<string, {
        label: string;
        pairingCount: number;
        firstPairedAt: Date;
        lastSeenAt: Date | null;
        profiles: string[];
        capabilities: string[];
      }>();
      let historicalCount = 0;
      let historicalOldest: Date | null = null;
      let historicalLatest: Date | null = null;
      for (const row of rows) {
        if (row.deviceManagementId === null) {
          historicalCount += 1;
          if (historicalOldest === null || row.createdAt < historicalOldest) historicalOldest = row.createdAt;
          if (row.lastSeenAt !== null && (historicalLatest === null || row.lastSeenAt > historicalLatest)) historicalLatest = row.lastSeenAt;
          continue;
        }
        let device = grouped.get(row.deviceManagementId);
        if (!device) {
          device = {
            label: row.label,
            pairingCount: 0,
            firstPairedAt: row.createdAt,
            lastSeenAt: row.lastSeenAt,
            profiles: [],
            capabilities: [],
          };
          grouped.set(row.deviceManagementId, device);
        }
        device.pairingCount += 1;
        if (row.createdAt < device.firstPairedAt) device.firstPairedAt = row.createdAt;
        if (row.lastSeenAt !== null && (device.lastSeenAt === null || row.lastSeenAt > device.lastSeenAt)) device.lastSeenAt = row.lastSeenAt;
        const caps = row.capabilities ?? {};
        const profile = profileFromCapabilities(caps);
        if (profile) device.profiles.push(profile);
        device.capabilities.push(...capabilityNames(caps));
      }
      return {
        devices: [...grouped.entries()]
          .map(([deviceManagementId, device]) => ({
            deviceManagementId,
            label: device.label,
            pairingCount: device.pairingCount,
            firstPairedAt: device.firstPairedAt,
            lastSeenAt: device.lastSeenAt,
            profiles: boundedStringSet(device.profiles),
            capabilities: boundedStringSet(device.capabilities),
          }))
          .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))
          .slice(0, MAX_DEVICE_SUMMARIES),
        historical: {
          activeCount: historicalCount,
          oldestPairedAt: historicalOldest,
          latestSeenAt: historicalLatest,
        },
      };
    },

    async revokeGroupedForUser({ userId, deviceManagementId, expectedPairingCount }) {
      const directDb = getSharedDirectDb();
      try {
        return await directDb.transaction(async (tx) => {
        const current = await tx
          .select({ id: relayTokens.id })
          .from(relayTokens)
          .where(and(
            eq(relayTokens.userId, userId),
            eq(relayTokens.deviceManagementId, deviceManagementId),
            isNull(relayTokens.revokedAt),
          ));
        if (current.length === 0) return { affectedPairingCount: 0, revokedPairingGenerationIds: [], matched: false, current: true };
        if (current.length !== expectedPairingCount) {
          return { affectedPairingCount: 0, revokedPairingGenerationIds: [], matched: true, current: false };
        }
        const changed = await tx.update(relayTokens).set({ revokedAt: new Date() }).where(and(
          eq(relayTokens.userId, userId),
          eq(relayTokens.deviceManagementId, deviceManagementId),
          isNull(relayTokens.revokedAt),
        )).returning({ id: relayTokens.id });
        // A concurrent revocation or new pairing may make the post-lock
        // mutation differ from the UI-confirmed count. Throwing rolls this
        // transaction back, rather than returning a misleading partial revoke.
        if (changed.length !== expectedPairingCount) throw new StaleRelayDeviceMutation();
        return {
          affectedPairingCount: changed.length,
          revokedPairingGenerationIds: changed.map((row) => row.id),
          matched: true,
          current: true,
        };
        });
      } catch (error) {
        if (error instanceof StaleRelayDeviceMutation) {
          return { affectedPairingCount: 0, revokedPairingGenerationIds: [], matched: true, current: false };
        }
        throw error;
      }
    },

    async cleanupHistoricalForUser({ userId, expectedPairingCount }) {
      const directDb = getSharedDirectDb();
      try {
        return await directDb.transaction(async (tx) => {
        const current = await tx.select({ id: relayTokens.id }).from(relayTokens).where(and(
          eq(relayTokens.userId, userId),
          isNull(relayTokens.deviceGroupId),
          isNull(relayTokens.revokedAt),
        ));
        if (current.length !== expectedPairingCount) {
          return { affectedPairingCount: 0, revokedPairingGenerationIds: [], matched: current.length > 0, current: false };
        }
        if (current.length === 0) return { affectedPairingCount: 0, revokedPairingGenerationIds: [], matched: false, current: true };
        // Repeat the NULL-group predicate in the mutation. A stale UI cannot
        // revoke a pairing which was migrated between its list and confirm.
        const changed = await tx.update(relayTokens).set({ revokedAt: new Date() }).where(and(
          eq(relayTokens.userId, userId),
          isNull(relayTokens.deviceGroupId),
          isNull(relayTokens.revokedAt),
        )).returning({ id: relayTokens.id });
        if (changed.length !== expectedPairingCount) throw new StaleRelayDeviceMutation();
        return {
          affectedPairingCount: changed.length,
          revokedPairingGenerationIds: changed.map((row) => row.id),
          matched: true,
          current: true,
        };
        });
      } catch (error) {
        if (error instanceof StaleRelayDeviceMutation) {
          return { affectedPairingCount: 0, revokedPairingGenerationIds: [], matched: true, current: false };
        }
        throw error;
      }
    },
  };
}

let store: RelayTokenStore = makeDefaultStore();

/** Test seam — replace the active store. */
export function setRelayTokenStore(next: RelayTokenStore): void {
  store = next;
}

/** Test seam — restore the default DB-backed store. */
export function resetRelayTokenStore(): void {
  store = makeDefaultStore();
}

/** Read-only accessor used by routes + the validator. */
export function getRelayTokenStore(): RelayTokenStore {
  return store;
}
