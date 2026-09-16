/**
 * D458 Wave 7 durable pairing store.
 *
 * Routes validate authority and verifier material before calling this adapter.
 * The adapter's job is persistence only: consume the exact challenge version,
 * reconcile the controller's one active logical binding, and commit the
 * challenge in one direct-Postgres transaction.
 */
import {
  and,
  eq,
  getSharedDirectDb,
  isNull,
  lt,
  relayTokens,
  remoteControllerBindings,
  remoteControllerInstallations,
  remotePairingChallenges,
  sql,
} from "@nautilo/db";
import type { StoredControllerOrigin } from "./ordinary-origin-proof";
import type { PairedHostRow } from "./host-projection";

/** Throwing this from a transaction (rather than returning) preserves rollback. */
class PairingCeremonyConflict extends Error {}

export interface CreateControllerInstallationInput {
  userId: string;
  actorId: string;
  serverInstanceId: string;
  serverBindingGeneration: number;
  installationId: string;
  /** Public material only; later protocol work validates encoding/algorithm. */
  proofKeyAlgorithm: string;
  proofKey: string;
  proofKeyFingerprint: string;
  label?: string;
}

export interface CreatePairingChallengeInput {
  serverInstanceId: string;
  serverBindingGeneration: number;
  userId: string;
  actorId: string;
  relayTokenId: string;
  hostInstallationId: string;
  desktopSessionId: string;
  /** Existing validated relay_tokens.id UUID, represented as a string. */
  pairingGeneration: string;
  qrVerifierDigest: string;
  manualVerifierDigest?: string | null;
  expiresAt: Date;
}

export interface ConsumePairingChallengeInput {
  challengeId: string;
  expectedVersion: number;
  consumedAt: Date;
  controllerInstallationId: string;
  serverInstanceId: string;
  serverBindingGeneration: number;
  installationGeneration: number;
  userId: string;
  actorId: string;
  relayTokenId: string;
  hostInstallationId: string;
  desktopSessionId: string;
  pairingGeneration: string;
}

/**
 * Ceremony commit input. The controller installation is intentionally inside
 * the same transaction as the challenge CAS: a failed/replayed challenge may
 * not leave a durable, unbound controller installation behind.
 */
export interface ConsumeChallengeEnsureInstallationInput extends Omit<
  ConsumePairingChallengeInput,
  "controllerInstallationId" | "installationGeneration"
> {
  controller: CreateControllerInstallationInput;
}

export interface ActivePairingChallenge {
  id: string;
  version: number;
  serverInstanceId: string;
  serverBindingGeneration: number;
  userId: string;
  actorId: string;
  relayTokenId: string;
  hostInstallationId: string;
  desktopSessionId: string;
  pairingGeneration: string;
  qrVerifierDigest: string;
  manualVerifierDigest: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  failedAttempts: number;
}

export interface RemotePairingStore {
  ensureControllerInstallation(
    input: CreateControllerInstallationInput,
  ): Promise<{ id: string; installationGeneration?: number } | null>;
  createChallenge(input: CreatePairingChallengeInput): Promise<{ id: string; version: number }>;
  /**
   * Returns verifier material for an exact challenge id to the authenticated
   * ceremony handler. That handler must use `pairingVerifierMatches()` before
   * making any decision; this method's result must never be projected to a
   * client. Looking up by id avoids treating database equality as verification.
   */
  findChallengeForVerification(
    challengeId: string,
  ): Promise<ActivePairingChallenge | null>;
  /** Owner-scoped manual-code lookup; only the HMAC digest is queried. */
  findChallengeForManualVerifier(input: {
    manualVerifierDigest: string;
    userId: string;
    actorId: string;
    serverInstanceId: string;
    serverBindingGeneration: number;
  }): Promise<ActivePairingChallenge | null>;
  /** Always returns the generic rejection outcome, including stale IDs. */
  recordFailedVerifierAttempt(input: {
    challengeId: string;
    expectedVersion: number;
    userId: string;
    actorId: string;
    serverInstanceId: string;
    serverBindingGeneration: number;
    attemptedAt: Date;
  }): Promise<"rejected">;
  /** Returns `conflict` for replay, expiry, revoke, stale-version, or race. */
  consumeChallengeAndCreateBinding(
    input: ConsumePairingChallengeInput,
  ): Promise<"committed" | "conflict">;
  consumeChallengeEnsureInstallationAndCreateBinding(
    input: ConsumeChallengeEnsureInstallationInput,
  ): Promise<{
    outcome: "committed" | "conflict";
    controllerInstallationId?: string;
    bindingId?: string;
    installationGeneration?: number;
  }>;
  revokeBindingForUser(input: {
    bindingId: string;
    userId: string;
    revokedAt?: Date;
  }): Promise<boolean>;
  revokeChallenge(input: {
    challengeId: string;
    userId: string;
    revokedAt?: Date;
  }): Promise<boolean>;
  cleanupExpiredChallenges(now: Date): Promise<number>;
  findActiveRelayForUser(input: {
    relayTokenId: string;
    userId: string;
    actorId: string;
  }): Promise<{
    relayTokenId: string;
    hostInstallationId: string;
    label: string;
    revokedAt: Date | null;
  } | null>;
  /**
   * One caller-scoped durable projection query.  Live relay state is joined
   * separately in memory so a database row can never manufacture presence.
   */
  listPairedHostRowsForUser(input: {
    userId: string;
    serverInstanceId: string;
    serverBindingGeneration: number;
  }): Promise<PairedHostRow[]>;
  /** One verified controller's label and active host relationships. */
  listPairedHostRowsForController(input: {
    userId: string;
    actorId: string;
    controllerInstallationId: string;
    installationGeneration: number;
    serverInstanceId: string;
    serverBindingGeneration: number;
  }): Promise<{
    controllerLabel: string | null;
    rows: PairedHostRow[];
  }>;
  /** Exact active bindings for one already-verified controller origin. */
  listActiveHostBindingsForController(input: {
    controllerInstallationId: string;
    installationGeneration: number;
    userId: string;
    actorId: string;
    serverInstanceId: string;
    serverBindingGeneration: number;
  }): Promise<Array<{
    bindingId: string;
    pairingGeneration: string;
    label: string;
  }>>;
  listControllerBindingsForUser(userId: string): Promise<Array<{
    bindingId: string;
    installationId: string;
    label: string | null;
    hostInstallationId: string;
    createdAt: Date;
    lastSeenAt: Date | null;
  }>>;
  renameControllerInstallationForUser(input: {
    bindingId: string;
    userId: string;
    label: string;
  }): Promise<boolean>;
  /**
   * Resolves one controller installation only when at least one exact current
   * host binding remains. It deliberately does not select or return a host.
   */
  findControllerOriginForOrdinaryRequest(input: {
    installationId: string;
    userId: string;
    actorId: string;
    serverInstanceId: string;
    serverBindingGeneration: number;
  }): Promise<StoredControllerOrigin | null>;
}

function makeDefaultStore(): RemotePairingStore {
  return {
    async ensureControllerInstallation(input) {
      const directDb = getSharedDirectDb();
      return directDb.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: remoteControllerInstallations.id,
            userId: remoteControllerInstallations.userId,
            actorId: remoteControllerInstallations.actorId,
            serverInstanceId: remoteControllerInstallations.serverInstanceId,
            serverBindingGeneration:
              remoteControllerInstallations.serverBindingGeneration,
            proofKeyAlgorithm: remoteControllerInstallations.proofKeyAlgorithm,
            proofKey: remoteControllerInstallations.proofKey,
            proofKeyFingerprint: remoteControllerInstallations.proofKeyFingerprint,
            installationGeneration:
              remoteControllerInstallations.installationGeneration,
            revokedAt: remoteControllerInstallations.revokedAt,
          })
          .from(remoteControllerInstallations)
          .where(
            and(
              eq(remoteControllerInstallations.installationId, input.installationId),
              eq(remoteControllerInstallations.userId, input.userId),
              eq(
                remoteControllerInstallations.serverInstanceId,
                input.serverInstanceId,
              ),
              eq(
                remoteControllerInstallations.serverBindingGeneration,
                input.serverBindingGeneration,
              ),
            ),
          )
          .limit(1);
        const row = existing[0];
        if (row) {
          // A controller is scoped to one user + immutable server authority.
          if (
            row.userId !== input.userId ||
            row.actorId !== input.actorId ||
            row.serverInstanceId !== input.serverInstanceId ||
            row.serverBindingGeneration !== input.serverBindingGeneration ||
            row.proofKeyAlgorithm !== input.proofKeyAlgorithm ||
            row.proofKey !== input.proofKey ||
            row.proofKeyFingerprint !== input.proofKeyFingerprint ||
            row.revokedAt !== null
          ) {
            return null;
          }
          return { id: row.id, installationGeneration: row.installationGeneration };
        }
        const inserted = await tx
          .insert(remoteControllerInstallations)
          .values(input)
          .returning({
            id: remoteControllerInstallations.id,
            installationGeneration:
              remoteControllerInstallations.installationGeneration,
          });
        return inserted[0] ?? null;
      });
    },

    async createChallenge(input) {
      // Relay registration defines pairingGeneration as its token-row UUID.
      // Reject a divergent tuple before it can become durable state.
      if (input.pairingGeneration !== input.relayTokenId) {
        throw new Error("remote pairing generation must equal relay token id");
      }
      const directDb = getSharedDirectDb();
      const inserted = await directDb
        .insert(remotePairingChallenges)
        .values(input)
        .returning({
          id: remotePairingChallenges.id,
          version: remotePairingChallenges.version,
        });
      const row = inserted[0];
      if (!row) throw new Error("remote pairing challenge insert returned no row");
      return row;
    },

    async findChallengeForVerification(challengeId) {
      const directDb = getSharedDirectDb();
      const rows = await directDb
        .select({
          id: remotePairingChallenges.id,
          version: remotePairingChallenges.version,
          serverInstanceId: remotePairingChallenges.serverInstanceId,
          serverBindingGeneration: remotePairingChallenges.serverBindingGeneration,
          userId: remotePairingChallenges.userId,
          actorId: remotePairingChallenges.actorId,
          relayTokenId: remotePairingChallenges.relayTokenId,
          hostInstallationId: remotePairingChallenges.hostInstallationId,
          desktopSessionId: remotePairingChallenges.desktopSessionId,
          pairingGeneration: remotePairingChallenges.pairingGeneration,
          qrVerifierDigest: remotePairingChallenges.qrVerifierDigest,
          manualVerifierDigest: remotePairingChallenges.manualVerifierDigest,
          expiresAt: remotePairingChallenges.expiresAt,
          consumedAt: remotePairingChallenges.consumedAt,
          revokedAt: remotePairingChallenges.revokedAt,
          failedAttempts: remotePairingChallenges.failedAttempts,
        })
        .from(remotePairingChallenges)
        .where(eq(remotePairingChallenges.id, challengeId))
        .limit(1);
      return rows[0] ?? null;
    },

    async findChallengeForManualVerifier(input) {
      const directDb = getSharedDirectDb();
      const rows = await directDb
        .select({
          id: remotePairingChallenges.id,
          version: remotePairingChallenges.version,
          serverInstanceId: remotePairingChallenges.serverInstanceId,
          serverBindingGeneration: remotePairingChallenges.serverBindingGeneration,
          userId: remotePairingChallenges.userId,
          actorId: remotePairingChallenges.actorId,
          relayTokenId: remotePairingChallenges.relayTokenId,
          hostInstallationId: remotePairingChallenges.hostInstallationId,
          desktopSessionId: remotePairingChallenges.desktopSessionId,
          pairingGeneration: remotePairingChallenges.pairingGeneration,
          qrVerifierDigest: remotePairingChallenges.qrVerifierDigest,
          manualVerifierDigest: remotePairingChallenges.manualVerifierDigest,
          expiresAt: remotePairingChallenges.expiresAt,
          consumedAt: remotePairingChallenges.consumedAt,
          revokedAt: remotePairingChallenges.revokedAt,
          failedAttempts: remotePairingChallenges.failedAttempts,
        })
        .from(remotePairingChallenges)
        .where(
          and(
            eq(remotePairingChallenges.manualVerifierDigest, input.manualVerifierDigest),
            eq(remotePairingChallenges.userId, input.userId),
            eq(remotePairingChallenges.actorId, input.actorId),
            eq(remotePairingChallenges.serverInstanceId, input.serverInstanceId),
            eq(remotePairingChallenges.serverBindingGeneration, input.serverBindingGeneration),
          ),
        )
        // A collision/duplicate is not a chooser: generic failure is safer.
        .limit(2);
      return rows.length === 1 ? rows[0]! : null;
    },

    async recordFailedVerifierAttempt({
      challengeId,
      expectedVersion,
      userId,
      actorId,
      serverInstanceId,
      serverBindingGeneration,
      attemptedAt,
    }) {
      const directDb = getSharedDirectDb();
      // At most five bad verifier attempts. The fifth mutation revokes the
      // challenge atomically; every caller gets the same generic outcome.
      await directDb
        .update(remotePairingChallenges)
        .set({
          failedAttempts: sql`${remotePairingChallenges.failedAttempts} + 1`,
          revokedAt: sql`CASE WHEN ${remotePairingChallenges.failedAttempts} + 1 >= 5 THEN ${attemptedAt} ELSE ${remotePairingChallenges.revokedAt} END`,
        })
        .where(
          and(
            eq(remotePairingChallenges.id, challengeId),
            eq(remotePairingChallenges.version, expectedVersion),
            eq(remotePairingChallenges.userId, userId),
            eq(remotePairingChallenges.actorId, actorId),
            eq(remotePairingChallenges.serverInstanceId, serverInstanceId),
            eq(
              remotePairingChallenges.serverBindingGeneration,
              serverBindingGeneration,
            ),
            isNull(remotePairingChallenges.consumedAt),
            isNull(remotePairingChallenges.revokedAt),
            sql`${remotePairingChallenges.expiresAt} > ${sql.param(
              attemptedAt,
              remotePairingChallenges.expiresAt,
            )}`,
            sql`${remotePairingChallenges.failedAttempts} < 5`,
          ),
        );
      return "rejected" as const;
    },

    async consumeChallengeAndCreateBinding(input) {
      if (input.pairingGeneration !== input.relayTokenId) return "conflict";
      const directDb = getSharedDirectDb();
      return directDb.transaction(async (tx) => {
        // Lock the authority root before mutating ceremony state. A concurrent
        // relay revocation updates this same row first, so it either completes
        // before this recheck (conflict) or waits until any binding created by
        // this transaction can be revoked before the revocation commits.
        const relay = await tx
          .select({ id: relayTokens.id })
          .from(relayTokens)
          .where(
            and(
              eq(relayTokens.id, input.relayTokenId),
              eq(relayTokens.id, input.pairingGeneration),
              eq(relayTokens.userId, input.userId),
              eq(relayTokens.actorId, input.actorId),
              eq(relayTokens.installationId, input.hostInstallationId),
              isNull(relayTokens.revokedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (relay.length !== 1) return "conflict" as const;
        const installation = await tx
          .select({ id: remoteControllerInstallations.id })
          .from(remoteControllerInstallations)
          .where(
            and(
              eq(remoteControllerInstallations.id, input.controllerInstallationId),
              eq(remoteControllerInstallations.userId, input.userId),
              eq(remoteControllerInstallations.actorId, input.actorId),
              eq(
                remoteControllerInstallations.serverInstanceId,
                input.serverInstanceId,
              ),
              eq(
                remoteControllerInstallations.serverBindingGeneration,
                input.serverBindingGeneration,
              ),
              eq(
                remoteControllerInstallations.installationGeneration,
                input.installationGeneration,
              ),
              isNull(remoteControllerInstallations.revokedAt),
            ),
          )
          .limit(1);
        if (installation.length !== 1) return "conflict" as const;
        // The conditional update is the concurrency boundary. It includes all
        // immutable tuple fields as defense in depth; a validated decision
        // cannot be redirected to another owner, host, or relay enrollment.
        const consumed = await tx
          .update(remotePairingChallenges)
          .set({
            consumedAt: input.consumedAt,
          })
          .where(
            and(
              eq(remotePairingChallenges.id, input.challengeId),
              eq(remotePairingChallenges.version, input.expectedVersion),
              isNull(remotePairingChallenges.consumedAt),
              isNull(remotePairingChallenges.revokedAt),
              sql`${remotePairingChallenges.expiresAt} > ${sql.param(
                input.consumedAt,
                remotePairingChallenges.expiresAt,
              )}`,
              eq(remotePairingChallenges.serverInstanceId, input.serverInstanceId),
              eq(
                remotePairingChallenges.serverBindingGeneration,
                input.serverBindingGeneration,
              ),
              eq(remotePairingChallenges.userId, input.userId),
              eq(remotePairingChallenges.actorId, input.actorId),
              eq(remotePairingChallenges.relayTokenId, input.relayTokenId),
              eq(
                remotePairingChallenges.hostInstallationId,
                input.hostInstallationId,
              ),
              eq(remotePairingChallenges.desktopSessionId, input.desktopSessionId),
              eq(remotePairingChallenges.pairingGeneration, input.pairingGeneration),
              sql`${remotePairingChallenges.failedAttempts} < 5`,
            ),
          )
          .returning({ id: remotePairingChallenges.id });
        if (consumed.length !== 1) return "conflict" as const;

        // One active binding per controller-installation/desktop-enrollment
        // tuple. Re-pairing this exact Mac replaces only this tuple; other
        // paired Macs remain active for capability-bound host resolution.
        await tx
          .update(remoteControllerBindings)
          .set({ revokedAt: input.consumedAt })
          .where(
            and(
              eq(
                remoteControllerBindings.controllerInstallationId,
                input.controllerInstallationId,
              ),
              eq(remoteControllerBindings.relayTokenId, input.relayTokenId),
              isNull(remoteControllerBindings.revokedAt),
            ),
          );
        await tx.insert(remoteControllerBindings).values({
          serverInstanceId: input.serverInstanceId,
          serverBindingGeneration: input.serverBindingGeneration,
          controllerInstallationId: input.controllerInstallationId,
          installationGeneration: input.installationGeneration,
          userId: input.userId,
          actorId: input.actorId,
          relayTokenId: input.relayTokenId,
          hostInstallationId: input.hostInstallationId,
          desktopSessionId: input.desktopSessionId,
          pairingGeneration: input.pairingGeneration,
          challengeId: input.challengeId,
        });
        return "committed" as const;
      });
    },

    async consumeChallengeEnsureInstallationAndCreateBinding(input) {
      if (input.pairingGeneration !== input.relayTokenId) return { outcome: "conflict" as const };
      const directDb = getSharedDirectDb();
      try {
        return await directDb.transaction(async (tx) => {
        // Acquire the relay authority-row lock before creating controller
        // state. This is deliberately the same row lock taken by relay token
        // revocation, closing the consume-versus-revoke window.
        const relay = await tx
          .select({ id: relayTokens.id })
          .from(relayTokens)
          .where(
            and(
              eq(relayTokens.id, input.relayTokenId),
              eq(relayTokens.id, input.pairingGeneration),
              eq(relayTokens.userId, input.userId),
              eq(relayTokens.actorId, input.actorId),
              eq(relayTokens.installationId, input.hostInstallationId),
              isNull(relayTokens.revokedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (relay.length !== 1) throw new PairingCeremonyConflict();
        const existing = await tx
          .select({
            id: remoteControllerInstallations.id,
            actorId: remoteControllerInstallations.actorId,
            proofKeyAlgorithm: remoteControllerInstallations.proofKeyAlgorithm,
            proofKey: remoteControllerInstallations.proofKey,
            proofKeyFingerprint: remoteControllerInstallations.proofKeyFingerprint,
            installationGeneration: remoteControllerInstallations.installationGeneration,
            revokedAt: remoteControllerInstallations.revokedAt,
          })
          .from(remoteControllerInstallations)
          .where(
            and(
              eq(remoteControllerInstallations.installationId, input.controller.installationId),
              eq(remoteControllerInstallations.userId, input.controller.userId),
              eq(remoteControllerInstallations.serverInstanceId, input.controller.serverInstanceId),
              eq(
                remoteControllerInstallations.serverBindingGeneration,
                input.controller.serverBindingGeneration,
              ),
            ),
          )
          .limit(1);
        const prior = existing[0];
        let controllerInstallationId: string;
        let installationGeneration: number;
        if (prior) {
          if (
            prior.actorId !== input.controller.actorId ||
            prior.proofKeyAlgorithm !== input.controller.proofKeyAlgorithm ||
            prior.proofKey !== input.controller.proofKey ||
            prior.proofKeyFingerprint !== input.controller.proofKeyFingerprint ||
            prior.revokedAt !== null
          ) {
            throw new PairingCeremonyConflict();
          }
          controllerInstallationId = prior.id;
          installationGeneration = prior.installationGeneration;
        } else {
          const inserted = await tx
            .insert(remoteControllerInstallations)
            .values(input.controller)
            .returning({
              id: remoteControllerInstallations.id,
              installationGeneration: remoteControllerInstallations.installationGeneration,
            });
          if (!inserted[0]) throw new PairingCeremonyConflict();
          controllerInstallationId = inserted[0].id;
          installationGeneration = inserted[0].installationGeneration;
        }
        const consumed = await tx
          .update(remotePairingChallenges)
          .set({ consumedAt: input.consumedAt })
          .where(
            and(
              eq(remotePairingChallenges.id, input.challengeId),
              eq(remotePairingChallenges.version, input.expectedVersion),
              isNull(remotePairingChallenges.consumedAt),
              isNull(remotePairingChallenges.revokedAt),
              sql`${remotePairingChallenges.expiresAt} > ${sql.param(
                input.consumedAt,
                remotePairingChallenges.expiresAt,
              )}`,
              eq(remotePairingChallenges.serverInstanceId, input.serverInstanceId),
              eq(remotePairingChallenges.serverBindingGeneration, input.serverBindingGeneration),
              eq(remotePairingChallenges.userId, input.userId),
              eq(remotePairingChallenges.actorId, input.actorId),
              eq(remotePairingChallenges.relayTokenId, input.relayTokenId),
              eq(remotePairingChallenges.hostInstallationId, input.hostInstallationId),
              eq(remotePairingChallenges.desktopSessionId, input.desktopSessionId),
              eq(remotePairingChallenges.pairingGeneration, input.pairingGeneration),
              sql`${remotePairingChallenges.failedAttempts} < 5`,
            ),
          )
          .returning({ id: remotePairingChallenges.id });
        if (consumed.length !== 1) throw new PairingCeremonyConflict();
        const activeBindings = await tx
          .select({
            id: remoteControllerBindings.id,
            relayTokenId: remoteControllerBindings.relayTokenId,
            hostInstallationId: remoteControllerBindings.hostInstallationId,
          })
          .from(remoteControllerBindings)
          .where(
            and(
              eq(remoteControllerBindings.controllerInstallationId, controllerInstallationId),
              eq(remoteControllerBindings.relayTokenId, input.relayTokenId),
              isNull(remoteControllerBindings.revokedAt),
            ),
          )
          .for("update")
          .limit(1);
        const activeBinding = activeBindings[0];
        if (
          activeBinding &&
          activeBinding.relayTokenId === input.relayTokenId &&
          activeBinding.hostInstallationId === input.hostInstallationId
        ) {
          // OpenClaw keys durable pairing by stable device identity and Codex
          // upserts enrollment by its logical client tuple. Do the same here:
          // pairing the same phone to the same Mac refreshes one authority
          // record instead of manufacturing a trail of replacement devices.
          const refreshed = await tx
            .update(remoteControllerBindings)
            .set({
              serverBindingGeneration: input.serverBindingGeneration,
              installationGeneration,
              userId: input.userId,
              actorId: input.actorId,
              desktopSessionId: input.desktopSessionId,
              pairingGeneration: input.pairingGeneration,
              challengeId: input.challengeId,
              lastSeenAt: input.consumedAt,
            })
            .where(
              and(
                eq(remoteControllerBindings.id, activeBinding.id),
                isNull(remoteControllerBindings.revokedAt),
              ),
            )
            .returning({ id: remoteControllerBindings.id });
          if (refreshed.length !== 1) throw new PairingCeremonyConflict();
          return {
            outcome: "committed" as const,
            controllerInstallationId,
            bindingId: activeBinding.id,
            installationGeneration,
          };
        }
        const binding = await tx
          .insert(remoteControllerBindings)
          .values({
            serverInstanceId: input.serverInstanceId,
            serverBindingGeneration: input.serverBindingGeneration,
            controllerInstallationId,
            installationGeneration,
            userId: input.userId,
            actorId: input.actorId,
            relayTokenId: input.relayTokenId,
            hostInstallationId: input.hostInstallationId,
            desktopSessionId: input.desktopSessionId,
            pairingGeneration: input.pairingGeneration,
            challengeId: input.challengeId,
          })
          .returning({ id: remoteControllerBindings.id });
        const created = binding[0];
        if (!created) throw new PairingCeremonyConflict();
        return {
          outcome: "committed" as const,
          controllerInstallationId,
          bindingId: created.id,
          installationGeneration,
        };
        });
      } catch (error) {
        if (error instanceof PairingCeremonyConflict) return { outcome: "conflict" as const };
        throw error;
      }
    },

    async revokeBindingForUser({ bindingId, userId, revokedAt = new Date() }) {
      const directDb = getSharedDirectDb();
      const updated = await directDb
        .update(remoteControllerBindings)
        .set({ revokedAt })
        .where(
          and(
            eq(remoteControllerBindings.id, bindingId),
            eq(remoteControllerBindings.userId, userId),
            isNull(remoteControllerBindings.revokedAt),
          ),
        )
        .returning({ id: remoteControllerBindings.id });
      return updated.length === 1;
    },

    async revokeChallenge({ challengeId, userId, revokedAt = new Date() }) {
      const directDb = getSharedDirectDb();
      const updated = await directDb
        .update(remotePairingChallenges)
        .set({ revokedAt })
        .where(
          and(
            eq(remotePairingChallenges.id, challengeId),
            eq(remotePairingChallenges.userId, userId),
            isNull(remotePairingChallenges.consumedAt),
            isNull(remotePairingChallenges.revokedAt),
          ),
        )
        .returning({ id: remotePairingChallenges.id });
      return updated.length === 1;
    },

    async cleanupExpiredChallenges(now) {
      const directDb = getSharedDirectDb();
      const deleted = await directDb
        .delete(remotePairingChallenges)
        .where(
          and(
            lt(remotePairingChallenges.expiresAt, now),
            isNull(remotePairingChallenges.consumedAt),
          ),
        )
        .returning({ id: remotePairingChallenges.id });
      return deleted.length;
    },

    async findActiveRelayForUser({ relayTokenId, userId, actorId }) {
      const directDb = getSharedDirectDb();
      const rows = await directDb
        .select({
          relayTokenId: relayTokens.id,
          hostInstallationId: relayTokens.installationId,
          label: relayTokens.label,
          revokedAt: relayTokens.revokedAt,
        })
        .from(relayTokens)
        .where(
          and(
            eq(relayTokens.id, relayTokenId),
            eq(relayTokens.userId, userId),
            eq(relayTokens.actorId, actorId),
            isNull(relayTokens.revokedAt),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row || !row.hostInstallationId) return null;
      return {
        relayTokenId: row.relayTokenId,
        hostInstallationId: row.hostInstallationId,
        label: row.label,
        revokedAt: row.revokedAt,
      };
    },

    async listPairedHostRowsForUser({
      userId,
      serverInstanceId,
      serverBindingGeneration,
    }) {
      const directDb = getSharedDirectDb();
      return directDb
        .select({
          remoteHostId: remoteControllerBindings.id,
          label: relayTokens.label,
          pairingGeneration: remoteControllerBindings.pairingGeneration,
          durableLastSeenAt: relayTokens.lastSeenAt,
        })
        .from(remoteControllerBindings)
        .innerJoin(
          remoteControllerInstallations,
          and(
            eq(
              remoteControllerBindings.controllerInstallationId,
              remoteControllerInstallations.id,
            ),
            eq(remoteControllerBindings.userId, remoteControllerInstallations.userId),
            eq(remoteControllerBindings.actorId, remoteControllerInstallations.actorId),
            eq(
              remoteControllerBindings.serverInstanceId,
              remoteControllerInstallations.serverInstanceId,
            ),
            eq(
              remoteControllerBindings.serverBindingGeneration,
              remoteControllerInstallations.serverBindingGeneration,
            ),
            eq(
              remoteControllerBindings.installationGeneration,
              remoteControllerInstallations.installationGeneration,
            ),
            isNull(remoteControllerInstallations.revokedAt),
          ),
        )
        .innerJoin(
          relayTokens,
          and(
            eq(remoteControllerBindings.relayTokenId, relayTokens.id),
            eq(remoteControllerBindings.pairingGeneration, relayTokens.id),
            eq(remoteControllerBindings.userId, relayTokens.userId),
            eq(remoteControllerBindings.actorId, relayTokens.actorId),
            eq(remoteControllerBindings.hostInstallationId, relayTokens.installationId),
            isNull(relayTokens.revokedAt),
          ),
        )
        .where(
          and(
            eq(remoteControllerBindings.userId, userId),
            eq(remoteControllerBindings.serverInstanceId, serverInstanceId),
            eq(
              remoteControllerBindings.serverBindingGeneration,
              serverBindingGeneration,
            ),
            isNull(remoteControllerBindings.revokedAt),
          ),
        );
    },

    async listPairedHostRowsForController({
      userId,
      actorId,
      controllerInstallationId,
      installationGeneration,
      serverInstanceId,
      serverBindingGeneration,
    }) {
      const directDb = getSharedDirectDb();
      const rows = await directDb
        .select({
          controllerLabel: remoteControllerInstallations.label,
          remoteHostId: remoteControllerBindings.id,
          label: relayTokens.label,
          pairingGeneration: remoteControllerBindings.pairingGeneration,
          durableLastSeenAt: relayTokens.lastSeenAt,
        })
        .from(remoteControllerBindings)
        .innerJoin(
          remoteControllerInstallations,
          and(
            eq(remoteControllerBindings.controllerInstallationId, remoteControllerInstallations.id),
            eq(remoteControllerBindings.userId, remoteControllerInstallations.userId),
            eq(remoteControllerBindings.actorId, remoteControllerInstallations.actorId),
            eq(remoteControllerBindings.serverInstanceId, remoteControllerInstallations.serverInstanceId),
            eq(remoteControllerBindings.serverBindingGeneration, remoteControllerInstallations.serverBindingGeneration),
            eq(remoteControllerBindings.installationGeneration, remoteControllerInstallations.installationGeneration),
            isNull(remoteControllerInstallations.revokedAt),
          ),
        )
        .innerJoin(
          relayTokens,
          and(
            eq(remoteControllerBindings.relayTokenId, relayTokens.id),
            eq(remoteControllerBindings.pairingGeneration, relayTokens.id),
            eq(remoteControllerBindings.userId, relayTokens.userId),
            eq(remoteControllerBindings.actorId, relayTokens.actorId),
            eq(remoteControllerBindings.hostInstallationId, relayTokens.installationId),
            isNull(relayTokens.revokedAt),
          ),
        )
        .where(
          and(
            eq(remoteControllerBindings.userId, userId),
            eq(remoteControllerBindings.actorId, actorId),
            eq(remoteControllerBindings.controllerInstallationId, controllerInstallationId),
            eq(remoteControllerBindings.installationGeneration, installationGeneration),
            eq(remoteControllerBindings.serverInstanceId, serverInstanceId),
            eq(remoteControllerBindings.serverBindingGeneration, serverBindingGeneration),
            isNull(remoteControllerBindings.revokedAt),
          ),
        );
      return {
        controllerLabel: rows[0]?.controllerLabel ?? null,
        rows: rows.map(({ controllerLabel: _controllerLabel, ...row }) => row),
      };
    },

    async listActiveHostBindingsForController(input) {
      const directDb = getSharedDirectDb();
      return directDb
        .select({
          bindingId: remoteControllerBindings.id,
          pairingGeneration: remoteControllerBindings.pairingGeneration,
          label: relayTokens.label,
        })
        .from(remoteControllerBindings)
        .innerJoin(
          remoteControllerInstallations,
          and(
            eq(
              remoteControllerBindings.controllerInstallationId,
              remoteControllerInstallations.id,
            ),
            eq(
              remoteControllerBindings.installationGeneration,
              remoteControllerInstallations.installationGeneration,
            ),
            isNull(remoteControllerInstallations.revokedAt),
          ),
        )
        .innerJoin(
          relayTokens,
          and(
            eq(remoteControllerBindings.relayTokenId, relayTokens.id),
            eq(remoteControllerBindings.pairingGeneration, relayTokens.id),
            eq(remoteControllerBindings.userId, relayTokens.userId),
            eq(remoteControllerBindings.actorId, relayTokens.actorId),
            eq(remoteControllerBindings.hostInstallationId, relayTokens.installationId),
            isNull(relayTokens.revokedAt),
          ),
        )
        .where(
          and(
            eq(
              remoteControllerBindings.controllerInstallationId,
              input.controllerInstallationId,
            ),
            eq(
              remoteControllerBindings.installationGeneration,
              input.installationGeneration,
            ),
            eq(remoteControllerBindings.userId, input.userId),
            eq(remoteControllerBindings.actorId, input.actorId),
            eq(remoteControllerBindings.serverInstanceId, input.serverInstanceId),
            eq(
              remoteControllerBindings.serverBindingGeneration,
              input.serverBindingGeneration,
            ),
            isNull(remoteControllerBindings.revokedAt),
          ),
        );
    },

    async listControllerBindingsForUser(userId) {
      const directDb = getSharedDirectDb();
      return directDb
        .select({
          bindingId: remoteControllerBindings.id,
          installationId: remoteControllerInstallations.installationId,
          label: remoteControllerInstallations.label,
          hostInstallationId: remoteControllerBindings.hostInstallationId,
          createdAt: remoteControllerBindings.createdAt,
          lastSeenAt: remoteControllerBindings.lastSeenAt,
        })
        .from(remoteControllerBindings)
        .innerJoin(
          remoteControllerInstallations,
          eq(
            remoteControllerBindings.controllerInstallationId,
            remoteControllerInstallations.id,
          ),
        )
        .where(
          and(
            eq(remoteControllerBindings.userId, userId),
            isNull(remoteControllerBindings.revokedAt),
            isNull(remoteControllerInstallations.revokedAt),
          ),
        );
    },

    async renameControllerInstallationForUser({ bindingId, userId, label }) {
      const directDb = getSharedDirectDb();
      return directDb.transaction(async (tx) => {
        const binding = await tx
          .select({ controllerInstallationId: remoteControllerBindings.controllerInstallationId })
          .from(remoteControllerBindings)
          .where(
            and(
              eq(remoteControllerBindings.id, bindingId),
              eq(remoteControllerBindings.userId, userId),
              isNull(remoteControllerBindings.revokedAt),
            ),
          )
          .limit(1);
        const installation = binding[0];
        if (!installation) return false;
        const updated = await tx
          .update(remoteControllerInstallations)
          .set({ label })
          .where(
            and(
              eq(remoteControllerInstallations.id, installation.controllerInstallationId),
              eq(remoteControllerInstallations.userId, userId),
              isNull(remoteControllerInstallations.revokedAt),
            ),
          )
          .returning({ id: remoteControllerInstallations.id });
        return updated.length === 1;
      });
    },

    async findControllerOriginForOrdinaryRequest(input) {
      const directDb = getSharedDirectDb();
      const rows = await directDb
        .select({
          controllerInstallationId: remoteControllerInstallations.id,
          installationId: remoteControllerInstallations.installationId,
          installationGeneration:
            remoteControllerInstallations.installationGeneration,
          serverInstanceId: remoteControllerInstallations.serverInstanceId,
          serverBindingGeneration:
            remoteControllerInstallations.serverBindingGeneration,
          userId: remoteControllerInstallations.userId,
          actorId: remoteControllerInstallations.actorId,
          proofKeyAlgorithm: remoteControllerInstallations.proofKeyAlgorithm,
          proofKey: remoteControllerInstallations.proofKey,
          revokedAt: remoteControllerInstallations.revokedAt,
        })
        .from(remoteControllerInstallations)
        .innerJoin(
          remoteControllerBindings,
          and(
            eq(
              remoteControllerBindings.controllerInstallationId,
              remoteControllerInstallations.id,
            ),
            eq(
              remoteControllerBindings.installationGeneration,
              remoteControllerInstallations.installationGeneration,
            ),
            eq(remoteControllerBindings.userId, remoteControllerInstallations.userId),
            eq(remoteControllerBindings.actorId, remoteControllerInstallations.actorId),
            eq(
              remoteControllerBindings.serverInstanceId,
              remoteControllerInstallations.serverInstanceId,
            ),
            eq(
              remoteControllerBindings.serverBindingGeneration,
              remoteControllerInstallations.serverBindingGeneration,
            ),
            isNull(remoteControllerBindings.revokedAt),
          ),
        )
        .where(
          and(
            eq(remoteControllerInstallations.installationId, input.installationId),
            eq(remoteControllerInstallations.userId, input.userId),
            eq(remoteControllerInstallations.actorId, input.actorId),
            eq(
              remoteControllerInstallations.serverInstanceId,
              input.serverInstanceId,
            ),
            eq(
              remoteControllerInstallations.serverBindingGeneration,
              input.serverBindingGeneration,
            ),
            isNull(remoteControllerInstallations.revokedAt),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row?.proofKeyAlgorithm === "Ed25519"
        ? { ...row, proofKeyAlgorithm: "Ed25519" }
        : null;
    },
  };
}

const store: RemotePairingStore = makeDefaultStore();

export function getRemotePairingStore(): RemotePairingStore {
  return store;
}
