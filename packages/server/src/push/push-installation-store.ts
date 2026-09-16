/**
 * D468 owner-scoped push-installation persistence.
 *
 * This is deliberately the only persistence adapter that can see a raw Expo
 * token or revoke proof. The token is encrypted before it crosses the DB
 * boundary; the proof becomes a domain-separated digest and is never returned.
 * Delivery/provider work is intentionally absent — a test request persists a
 * fixed generic intent for the later bounded worker to claim.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  and,
  desc,
  eq,
  getSharedDirectDb,
  isNull,
  ne,
  pushInstallationBindings,
  pushNotificationTestIntents,
  sql,
  withTrustContext,
  type DirectDatabase,
} from "@nautilo/db";
import type {
  MobilePushInstallationBadgePreferenceRequest,
  MobilePushInstallationBadgePreferenceResponse,
  MobilePushInstallationDisableRequest,
  MobilePushInstallationRegisterRequest,
  MobilePushInstallationStatus,
} from "@nautilo/types";

import {
  decryptPushToken,
  encryptPushToken,
  requirePushTokenEncryptionKey,
  type EncryptedPushTokenV1,
  type PushTokenEncryptionContext,
} from "./push-token-crypto";

const REVOKE_PROOF_DOMAIN = "nautilo.push-installation-revoke.v1\0";
const REVOKE_DIGEST_BYTES = 32;
const TEST_INTENT_COOLDOWN_MS = 60_000;

export type PushInstallationStoreErrorCode =
  | "invalid"
  | "not_found"
  | "stale_generation"
  | "revoked"
  | "permission_denied"
  | "unavailable"
  | "test_rate_limited";

export class PushInstallationStoreError extends Error {
  constructor(readonly code: PushInstallationStoreErrorCode) {
    super(`push installation ${code}`);
    this.name = "PushInstallationStoreError";
  }
}

export interface PushInstallationStore {
  register(input: {
    userId: string;
    request: MobilePushInstallationRegisterRequest;
  }): Promise<MobilePushInstallationStatus>;
  getStatus(input: {
    userId: string;
    bindingId: string;
  }): Promise<MobilePushInstallationStatus>;
  disable(input: {
    userId: string;
    request: MobilePushInstallationDisableRequest;
  }): Promise<MobilePushInstallationStatus>;
  setBadgePreference(input: {
    userId: string;
    request: MobilePushInstallationBadgePreferenceRequest;
  }): Promise<MobilePushInstallationBadgePreferenceResponse>;
  revokeForUser(input: { userId: string; bindingId: string }): Promise<void>;
  revokeWithProof(input: { bindingId: string; revokeProof: string }): Promise<void>;
  enqueueGenericTest(input: {
    userId: string;
    bindingId: string;
  }): Promise<{ notificationId: string }>;
}

export interface PushInstallationStoreDeps {
  readonly db?: DirectDatabase;
  readonly now?: () => Date;
  readonly newNotificationId?: () => string;
  /** Injectable only for deterministic unit tests; never defaults to random. */
  readonly getEncryptionKey?: () => Uint8Array;
}

type BindingRow = typeof pushInstallationBindings.$inferSelect;
type PushDb = DirectDatabase;
type PushTx = Parameters<Parameters<PushDb["transaction"]>[0]>[0];

/** Hashes a high-entropy proof in an explicit protocol domain. */
function digestPushInstallationRevokeProof(revokeProof: string): string {
  return createHash("sha256")
    .update(REVOKE_PROOF_DOMAIN, "utf8")
    .update(revokeProof, "utf8")
    .digest("hex");
}

/** Constant-time comparator for the fixed-size stored digest. */
function pushInstallationRevokeProofMatches(
  expectedDigest: string,
  revokeProof: string,
): boolean {
  const expected = Buffer.from(expectedDigest, "hex");
  const candidate = Buffer.from(digestPushInstallationRevokeProof(revokeProof), "hex");
  return (
    expected.length === REVOKE_DIGEST_BYTES &&
    candidate.length === REVOKE_DIGEST_BYTES &&
    timingSafeEqual(expected, candidate)
  );
}

function contextFor(row: Pick<
  BindingRow,
  "userId" | "installationId" | "bindingId" | "tokenGeneration"
>): PushTokenEncryptionContext {
  return {
    userId: row.userId,
    installationId: row.installationId,
    bindingId: row.bindingId,
    tokenGeneration: row.tokenGeneration,
  };
}

function envelopeFor(row: BindingRow): EncryptedPushTokenV1 {
  return {
    keyVersion: row.tokenKeyVersion as 1,
    nonceBase64: row.tokenNonceBase64,
    ciphertextBase64: row.tokenCiphertextBase64,
    authTagBase64: row.tokenAuthTagBase64,
  };
}

function projectStatus(
  row: BindingRow,
  options: { cryptoAvailable: boolean },
): MobilePushInstallationStatus {
  const unavailable = row.state === "active" && !options.cryptoAvailable;
  return {
    version: 1,
    installationId: row.installationId,
    bindingId: row.bindingId,
    platform: row.platform,
    enabled: row.enabled,
    tokenGeneration: row.tokenGeneration,
    permission: row.permission,
    state: unavailable ? "unavailable" : row.state,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function cryptoAvailable(getEncryptionKey: () => Uint8Array): boolean {
  try {
    getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

function unavailable(error: unknown): never {
  // The configuration/envelope messages intentionally contain no token. This
  // adapter still converts them to one public condition so routes never leak
  // storage shape or deployment key details.
  if (error instanceof Error) {
    throw new PushInstallationStoreError("unavailable");
  }
  throw error;
}

function selectOwnedBinding(tx: PushTx, userId: string, bindingId: string) {
  return tx
    .select()
    .from(pushInstallationBindings)
    .where(
      and(
        eq(pushInstallationBindings.userId, userId),
        eq(pushInstallationBindings.bindingId, bindingId),
      ),
    )
    .limit(1)
    .for("update");
}

function createDefaultStore(deps: PushInstallationStoreDeps = {}): PushInstallationStore {
  const db = deps.db ?? getSharedDirectDb();
  const now = deps.now ?? (() => new Date());
  const newNotificationId = deps.newNotificationId ?? randomUUID;
  const getEncryptionKey = deps.getEncryptionKey ?? (() => requirePushTokenEncryptionKey());

  async function scoped<T>(userId: string, fn: (tx: PushTx) => Promise<T>): Promise<T> {
    return withTrustContext({ userId }, fn, db);
  }

  return {
    async register({ userId, request }) {
      let key: Uint8Array;
      try {
        key = getEncryptionKey();
      } catch (error) {
        return unavailable(error);
      }
      const requestedDigest = digestPushInstallationRevokeProof(request.revokeProof);
      const at = now();
      return scoped(userId, async (tx) => {
        const [existing] = await selectOwnedBinding(tx, userId, request.bindingId);
        if (existing) {
          if (
            existing.installationId !== request.installationId ||
            existing.platform !== request.platform
          ) {
            throw new PushInstallationStoreError("invalid");
          }
          if (existing.state === "revoked") {
            throw new PushInstallationStoreError("revoked");
          }
          if (request.tokenGeneration < existing.tokenGeneration) {
            throw new PushInstallationStoreError("stale_generation");
          }
          if (request.tokenGeneration === existing.tokenGeneration) {
            let tokenMatches = false;
            try {
              tokenMatches = decryptPushToken(
                key,
                envelopeFor(existing),
                contextFor(existing),
              ) === request.expoPushToken;
            } catch (error) {
              return unavailable(error);
            }
            const proofMatches = pushInstallationRevokeProofMatches(
              existing.revokeVerifierDigest,
              request.revokeProof,
            );
            // A same-generation register is a replay only. It cannot carry a
            // different token/proof or reactivate an intentionally-disabled
            // binding after a late async response.
            if (!tokenMatches || !proofMatches || existing.state !== "active") {
              throw new PushInstallationStoreError("stale_generation");
            }
            return projectStatus(existing, { cryptoAvailable: true });
          }

          const nextContext: PushTokenEncryptionContext = {
            userId,
            installationId: request.installationId,
            bindingId: request.bindingId,
            tokenGeneration: request.tokenGeneration,
          };
          const envelope = encryptPushToken(key, request.expoPushToken, nextContext);
          const [updated] = await tx
            .update(pushInstallationBindings)
            .set({
              tokenGeneration: request.tokenGeneration,
              enabled: true,
              permission: "granted",
              state: "active",
              appVersion: request.appVersion,
              tokenKeyVersion: envelope.keyVersion,
              tokenNonceBase64: envelope.nonceBase64,
              tokenCiphertextBase64: envelope.ciphertextBase64,
              tokenAuthTagBase64: envelope.authTagBase64,
              revokeVerifierDigest: requestedDigest,
              disabledAt: null,
              updatedAt: at,
            })
            .where(
              and(
                eq(pushInstallationBindings.bindingId, request.bindingId),
                eq(pushInstallationBindings.userId, userId),
                eq(pushInstallationBindings.tokenGeneration, existing.tokenGeneration),
                ne(pushInstallationBindings.state, "revoked"),
              ),
            )
            .returning();
          if (!updated) throw new PushInstallationStoreError("stale_generation");
          return projectStatus(updated, { cryptoAvailable: true });
        }

        const [existingInstallation] = await tx
          .select({ bindingId: pushInstallationBindings.bindingId })
          .from(pushInstallationBindings)
          .where(
            and(
              eq(pushInstallationBindings.userId, userId),
              eq(pushInstallationBindings.installationId, request.installationId),
              isNull(pushInstallationBindings.revokedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (existingInstallation) throw new PushInstallationStoreError("invalid");

        const envelope = encryptPushToken(key, request.expoPushToken, {
          userId,
          installationId: request.installationId,
          bindingId: request.bindingId,
          tokenGeneration: request.tokenGeneration,
        });
        const [inserted] = await tx
          .insert(pushInstallationBindings)
          .values({
            bindingId: request.bindingId,
            userId,
            installationId: request.installationId,
            platform: request.platform,
            tokenGeneration: request.tokenGeneration,
            enabled: true,
            permission: "granted",
            state: "active",
            appVersion: request.appVersion,
            tokenKeyVersion: envelope.keyVersion,
            tokenNonceBase64: envelope.nonceBase64,
            tokenCiphertextBase64: envelope.ciphertextBase64,
            tokenAuthTagBase64: envelope.authTagBase64,
            revokeVerifierDigest: requestedDigest,
            updatedAt: at,
          })
          // A concurrent registration can conflict either on this client-minted
          // binding UUID or on the live owner × installation uniqueness rule.
          // Both become a bounded lifecycle result below, never a raw
          // unique-constraint failure.
          .onConflictDoNothing()
          .returning();
        if (!inserted) throw new PushInstallationStoreError("invalid");
        return projectStatus(inserted, { cryptoAvailable: true });
      });
    },

    async getStatus({ userId, bindingId }) {
      return scoped(userId, async (tx) => {
        const [row] = await selectOwnedBinding(tx, userId, bindingId);
        if (!row) throw new PushInstallationStoreError("not_found");
        return projectStatus(row, { cryptoAvailable: cryptoAvailable(getEncryptionKey) });
      });
    },

    async disable({ userId, request }) {
      return scoped(userId, async (tx) => {
        const [existing] = await selectOwnedBinding(tx, userId, request.bindingId);
        if (!existing || existing.installationId !== request.installationId) {
          throw new PushInstallationStoreError("not_found");
        }
        if (existing.state === "revoked") throw new PushInstallationStoreError("revoked");
        if (existing.tokenGeneration !== request.tokenGeneration) {
          throw new PushInstallationStoreError("stale_generation");
        }
        if (existing.state === "disabled") {
          return projectStatus(existing, {
            cryptoAvailable: cryptoAvailable(getEncryptionKey),
          });
        }
        const [updated] = await tx
          .update(pushInstallationBindings)
          .set({
            enabled: false,
            permission: request.permission,
            state: "disabled",
            disabledAt: now(),
            updatedAt: now(),
          })
          .where(
            and(
              eq(pushInstallationBindings.bindingId, request.bindingId),
              eq(pushInstallationBindings.userId, userId),
              eq(pushInstallationBindings.tokenGeneration, request.tokenGeneration),
              eq(pushInstallationBindings.state, "active"),
            ),
          )
          .returning();
        if (!updated) throw new PushInstallationStoreError("stale_generation");
        return projectStatus(updated, {
          cryptoAvailable: cryptoAvailable(getEncryptionKey),
        });
      });
    },

    async setBadgePreference({ userId, request }) {
      return scoped(userId, async (tx) => {
        const [existing] = await selectOwnedBinding(tx, userId, request.bindingId);
        if (!existing) throw new PushInstallationStoreError("not_found");
        if (existing.state === "revoked") throw new PushInstallationStoreError("revoked");
        if (existing.tokenGeneration !== request.tokenGeneration) {
          throw new PushInstallationStoreError("stale_generation");
        }
        if (existing.badgeEnabled !== request.enabled) {
          const [updated] = await tx
            .update(pushInstallationBindings)
            .set({ badgeEnabled: request.enabled, updatedAt: now() })
            .where(
              and(
                eq(pushInstallationBindings.bindingId, request.bindingId),
                eq(pushInstallationBindings.userId, userId),
                eq(pushInstallationBindings.tokenGeneration, request.tokenGeneration),
                ne(pushInstallationBindings.state, "revoked"),
              ),
            )
            .returning({ badgeEnabled: pushInstallationBindings.badgeEnabled });
          if (!updated) throw new PushInstallationStoreError("stale_generation");
        }
        return {
          version: 1,
          bindingId: request.bindingId,
          tokenGeneration: request.tokenGeneration,
          enabled: request.enabled,
        };
      });
    },

    async revokeForUser({ userId, bindingId }) {
      await scoped(userId, async (tx) => {
        // Deliberately idempotent and non-enumerating for unknown/cross-owner
        // UUIDs: a zero-row update is still a successful terminal operation.
        await tx
          .update(pushInstallationBindings)
          .set({
            enabled: false,
            state: "revoked",
            revokedAt: now(),
            updatedAt: now(),
          })
          .where(
            and(
              eq(pushInstallationBindings.bindingId, bindingId),
              eq(pushInstallationBindings.userId, userId),
              ne(pushInstallationBindings.state, "revoked"),
            ),
          );
      });
    },

    async revokeWithProof({ bindingId, revokeProof }) {
      // The SQL helper is exact-binding only and returns no data to the HTTP
      // caller. Use a fixed-length dummy so misses follow the same local
      // constant-time compare path as a real binding.
      const rows = await db.select({
        user_id: sql<string>`user_id`,
        revoke_verifier_digest: sql<string>`revoke_verifier_digest`,
      }).from(
        sql`public.app_read_push_installation_revoke_verifier(${bindingId}::uuid)`,
      );
      const row = rows[0];
      const expectedDigest = row?.revoke_verifier_digest ?? "0".repeat(64);
      const valid = pushInstallationRevokeProofMatches(expectedDigest, revokeProof);
      if (!row || !valid) return;
      await scoped(row.user_id, async (tx) => {
        await tx
          .update(pushInstallationBindings)
          .set({
            enabled: false,
            state: "revoked",
            revokedAt: now(),
            updatedAt: now(),
          })
          .where(
            and(
              eq(pushInstallationBindings.bindingId, bindingId),
              eq(pushInstallationBindings.userId, row.user_id),
              ne(pushInstallationBindings.state, "revoked"),
            ),
          );
      });
    },

    async enqueueGenericTest({ userId, bindingId }) {
      return scoped(userId, async (tx) => {
        const [binding] = await selectOwnedBinding(tx, userId, bindingId);
        if (!binding) throw new PushInstallationStoreError("not_found");
        if (binding.state === "revoked") throw new PushInstallationStoreError("revoked");
        if (binding.state !== "active" || !binding.enabled || binding.permission !== "granted") {
          throw new PushInstallationStoreError("permission_denied");
        }
        if (!cryptoAvailable(getEncryptionKey)) {
          throw new PushInstallationStoreError("unavailable");
        }
        const cutoff = new Date(now().getTime() - TEST_INTENT_COOLDOWN_MS);
        const [recent] = await tx
          .select({ notificationId: pushNotificationTestIntents.notificationId })
          .from(pushNotificationTestIntents)
          .where(
            and(
              eq(pushNotificationTestIntents.userId, userId),
              eq(pushNotificationTestIntents.bindingId, bindingId),
              sql`${pushNotificationTestIntents.createdAt} > ${cutoff.toISOString()}::timestamptz`,
            ),
          )
          .orderBy(desc(pushNotificationTestIntents.createdAt))
          .limit(1)
          .for("key share");
        if (recent) throw new PushInstallationStoreError("test_rate_limited");
        const notificationId = newNotificationId();
        await tx.insert(pushNotificationTestIntents).values({
          notificationId,
          userId,
          bindingId,
          tokenGeneration: binding.tokenGeneration,
          state: "pending",
        });
        return { notificationId };
      });
    },
  };
}

const store = createDefaultStore();

export function getPushInstallationStore(): PushInstallationStore {
  return store;
}

/** Exported factory gives focused tests a real production implementation. */
export function createPushInstallationStore(
  deps: PushInstallationStoreDeps = {},
): PushInstallationStore {
  return createDefaultStore(deps);
}
