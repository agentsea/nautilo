import {
  actors,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDeliveryOperations,
  eq,
  humanCryptoDevices,
  sql,
  users,
} from "@nautilo/db";
import type {
  PendingAdditionalDeviceEnrollment,
} from "../../device/additional-device-enrollment.ts";
import type {
  AdditionalDeviceEnrollmentRepository,
} from "./additional-device-enrollment-service.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../storage/postgres-record-codecs.ts";
import {
  humanHasOperationCapacity,
} from "../delivery/postgres-human-operation-capacity.ts";

const OPERATION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Crypto delivery column ${name} must be text`);
  }
  return value;
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Crypto delivery column ${name} must be bytea`);
  }
  return value;
}

function requiredCounter(row: DatabaseRow, name: string): number {
  const value = row[name];
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string"
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) {
    throw new TypeError(`Crypto delivery column ${name} must be a safe counter`);
  }
  return normalized;
}

function nullableCounter(row: DatabaseRow, name: string): number | null {
  return row[name] === null ? null : requiredCounter(row, name);
}

function nullableBytes(row: DatabaseRow, name: string): Uint8Array | null {
  return row[name] === null ? null : requiredBytes(row, name);
}

function oneOrNull(
  rows: readonly DatabaseRow[],
  label: string,
): DatabaseRow | null {
  if (rows.length > 1) {
    throw new Error(`${label} returned more than one row`);
  }
  return rows[0] ?? null;
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Crypto delivery timestamp must be nonnegative");
  }
  return new Date(milliseconds).toISOString();
}

function challengeKind(
  enrollment: PendingAdditionalDeviceEnrollment,
): "device_approval" | "device_recovery" {
  return enrollment.method === "device_approval"
    ? "device_approval"
    : "device_recovery";
}

function operationKind(
  enrollment: PendingAdditionalDeviceEnrollment,
): "device_add" | "device_recovery" {
  return enrollment.method === "device_approval"
    ? "device_add"
    : "device_recovery";
}

function operationState(
  enrollment: PendingAdditionalDeviceEnrollment,
): "awaiting_committer" | "awaiting_target_device" {
  return enrollment.method === "device_approval"
    ? "awaiting_committer"
    : "awaiting_target_device";
}

function enrollmentMatches(
  row: DatabaseRow,
  enrollment: PendingAdditionalDeviceEnrollment,
  input: {
    readonly publicFingerprint: Uint8Array;
    readonly signingPublicKeyDigest: Uint8Array;
    readonly encryptionPublicKeyDigest: Uint8Array;
  },
): boolean {
  return requiredString(row, "human_id") === enrollment.humanActorId
    && requiredString(row, "user_id") === enrollment.userId
    && requiredString(row, "human_actor_id") === enrollment.humanActorId
    && requiredString(row, "pending_device_id") === enrollment.deviceId
    && requiredString(row, "client_kind") === enrollment.clientKind
    && requiredCounter(row, "device_generation")
      === enrollment.deviceGeneration
    && requiredString(row, "challenge_kind") === challengeKind(enrollment)
    && requiredString(row, "operation_kind") === operationKind(enrollment)
    && requiredString(row, "idempotency_key")
      === enrollment.idempotencyKey
    && requiredCounter(row, "expected_custody_revision")
      === enrollment.expectedCustodyRevision
    && requiredCounter(row, "expected_recovery_generation")
      === enrollment.expectedRecoveryGeneration
    && equalBytes(
      requiredBytes(row, "installation_lineage_digest"),
      enrollment.installationLineageDigest,
    )
    && equalBytes(
      requiredBytes(row, "authorization_digest"),
      enrollment.authorizationDigest,
    )
    && equalBytes(
      requiredBytes(row, "signing_public_key_digest"),
      input.signingPublicKeyDigest,
    )
    && equalBytes(
      requiredBytes(row, "encryption_public_key_digest"),
      input.encryptionPublicKeyDigest,
    )
    && equalBytes(
      requiredBytes(row, "signing_public_key"),
      enrollment.signingPublicKey,
    )
    && equalBytes(
      requiredBytes(row, "encryption_public_key"),
      enrollment.encryptionPublicKey,
    )
    && equalBytes(
      requiredBytes(row, "public_fingerprint"),
      input.publicFingerprint,
    );
}

async function expectSingleMutation(
  executor: CryptoPostgresExecutor,
  statement: string,
  parameters: readonly DatabaseScalar[],
  label: string,
): Promise<void> {
  const rows = await executor.query(statement, parameters);
  if (rows.length !== 1) {
    throw new Error(`${label} lost its compare-and-swap`);
  }
}

export class PostgresAdditionalDeviceEnrollmentRepository
  implements AdditionalDeviceEnrollmentRepository
{
  constructor(
    private readonly handle: CryptoPostgresHandle,
    private readonly enforceLegacyFleetBounds = true,
  ) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  begin(
    input: Parameters<AdditionalDeviceEnrollmentRepository["begin"]>[0],
  ): ReturnType<AdditionalDeviceEnrollmentRepository["begin"]> {
    return this.handle.transaction(async (transaction) => {
      const enrollment = input.enrollment;
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`additional-device/${enrollment.humanActorId}`],
      );

      const identity = oneOrNull(
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            user_id: sql<string>`${users.id}::text`.as("user_id"),
            human_actor_id: sql<string>`${actors.id}::text`.as(
              "human_actor_id",
            ),
            actor_owner_id: sql<string>`${actors.ownerId}::text`.as(
              "actor_owner_id",
            ),
            actor_kind: sql<string>`${actors.kind}`.as("actor_kind"),
          }).from(users).innerJoin(
            actors,
            eq(actors.id, enrollment.humanActorId),
          ).where(eq(users.id, enrollment.userId)).limit(2),
        ),
        "Additional-device identity lookup",
      );
      if (
        identity === null
        || requiredString(identity, "user_id") !== enrollment.userId
        || requiredString(identity, "human_actor_id")
          !== enrollment.humanActorId
        || requiredString(identity, "actor_owner_id") !== enrollment.userId
        || requiredString(identity, "actor_kind") !== "user"
      ) {
        return { status: "stale_state" };
      }

      const idempotent = oneOrNull(
        await transaction.query(
          `SELECT c.challenge_id,
                  c.challenge_hash,
                  c.kind AS challenge_kind,
                  c.human_id,
                  c.user_id::text AS user_id,
                  c.human_actor_id::text AS human_actor_id,
                  c.installation_lineage_digest,
                  c.authorization_digest,
                  c.pending_device_id,
                  c.signing_public_key_digest,
                  c.encryption_public_key_digest,
                  c.expected_custody_revision,
                  c.expected_recovery_generation,
                  c.idempotency_key,
                  floor(extract(epoch from c.issued_at) * 1000)::bigint
                    AS issued_at_ms,
                  floor(extract(epoch from c.expires_at) * 1000)::bigint
                    AS expires_at_ms,
                  d.client_kind,
                  d.device_generation,
                  d.signing_public_key,
                  d.encryption_public_key,
                  d.public_fingerprint,
                  d.state AS device_state,
                  d.revision AS device_revision,
                  d.key_package_count,
                  o.operation_id,
                  o.kind AS operation_kind,
                  o.state AS operation_state,
                  o.aggregate_payload_bytes AS operation_payload_bytes,
                  o.fanout_row_count AS operation_fanout_row_count,
                  c.consumed_at AS challenge_consumed_at,
                  c.invalidated_at AS challenge_invalidated_at
             FROM human_crypto_device_challenges c
             JOIN human_crypto_devices d
               ON d.device_id = c.pending_device_id
             JOIN crypto_delivery_operations o
               ON o.target_device_id = c.pending_device_id
              AND o.idempotency_key = c.idempotency_key
            WHERE c.human_id = $1
              AND c.kind = $2
              AND c.idempotency_key = $3
            LIMIT 2
            FOR UPDATE OF c, d, o`,
          [
            enrollment.humanActorId,
            challengeKind(enrollment),
            enrollment.idempotencyKey,
          ],
        ),
        "Additional-device idempotency lookup",
      );
      let refreshExpiredPristineAttempt: DatabaseRow | null = null;
      if (idempotent !== null) {
        if (!enrollmentMatches(idempotent, enrollment, input)) {
          return { status: "conflicting_idempotency" };
        }
        const idempotentOperationState = requiredString(
          idempotent,
          "operation_state",
        );
        const approvedNonterminalReplay = enrollment.method === "device_approval"
          && requiredString(idempotent, "device_state") === "pending"
          && idempotent["challenge_invalidated_at"] === null
          && [
            "preparing_domain",
            "awaiting_delivery",
            "ready_to_activate",
            "activating",
          ].includes(idempotentOperationState);
        if (approvedNonterminalReplay) {
          return {
            status: "duplicate",
            operationId: requiredString(idempotent, "operation_id"),
            challengeId: requiredString(idempotent, "challenge_id"),
            issuedAt: requiredCounter(idempotent, "issued_at_ms"),
            expiresAt: requiredCounter(idempotent, "expires_at_ms"),
          };
        }
        if (requiredCounter(idempotent, "expires_at_ms") > enrollment.issuedAt) {
          return {
            status: "duplicate",
            operationId: requiredString(idempotent, "operation_id"),
            challengeId: requiredString(idempotent, "challenge_id"),
            issuedAt: requiredCounter(idempotent, "issued_at_ms"),
            expiresAt: requiredCounter(idempotent, "expires_at_ms"),
          };
        }
        if (
          idempotentOperationState !== operationState(enrollment)
          || requiredCounter(idempotent, "operation_payload_bytes") !== 0
          || requiredCounter(idempotent, "operation_fanout_row_count") !== 0
          || requiredString(idempotent, "device_state") !== "pending"
          || requiredCounter(idempotent, "device_revision") !== 0
          || requiredCounter(idempotent, "key_package_count") !== 0
          || idempotent["challenge_consumed_at"] !== null
          || idempotent["challenge_invalidated_at"] !== null
        ) {
          return { status: "stale_state" };
        }
        refreshExpiredPristineAttempt = idempotent;
      }

      const custody = oneOrNull(
        await transaction.query(
          `SELECT human_id,
                  user_id::text AS user_id,
                  human_actor_id::text AS human_actor_id,
                  state,
                  current_recovery_generation,
                  current_inventory_revision,
                  current_inventory_count,
                  current_inventory_digest,
                  revision
             FROM human_crypto_custodies
            WHERE human_id = $1
            LIMIT 2
            FOR UPDATE`,
          [enrollment.humanActorId],
        ),
        "Additional-device custody lookup",
      );
      const currentInventoryRevision = custody === null
        ? null
        : nullableCounter(custody, "current_inventory_revision");
      const currentInventoryCount = custody === null
        ? null
        : nullableCounter(custody, "current_inventory_count");
      const currentInventoryDigest = custody === null
        ? null
        : nullableBytes(custody, "current_inventory_digest");
      const coherentEmptyInventory = currentInventoryRevision === null
        && currentInventoryCount === null
        && currentInventoryDigest === null
        && enrollment.inventoryRevision === 0
        && enrollment.inventoryCount === 0;
      const identityOnlyAdditionalDevice = enrollment.method === "device_approval"
        && enrollment.inventoryRevision === 0
        && enrollment.inventoryCount === 0;
      if (
        custody === null
        || requiredString(custody, "user_id") !== enrollment.userId
        || requiredString(custody, "human_actor_id")
          !== enrollment.humanActorId
        || (
          requiredString(custody, "state") !== "active"
          && !(
            enrollment.method === "recovery"
            && requiredString(custody, "state") === "recovery_required"
          )
        )
        || requiredCounter(custody, "revision")
          !== enrollment.expectedCustodyRevision
        || requiredCounter(custody, "current_recovery_generation")
          !== enrollment.expectedRecoveryGeneration
        || (!coherentEmptyInventory && !identityOnlyAdditionalDevice && (
          currentInventoryRevision !== enrollment.inventoryRevision
          || currentInventoryCount !== enrollment.inventoryCount
          || currentInventoryDigest === null
          || !equalBytes(currentInventoryDigest, enrollment.inventoryDigest)
        ))
      ) {
        return { status: "stale_state" };
      }

      if (refreshExpiredPristineAttempt !== null) {
        const operationId = requiredString(
          refreshExpiredPristineAttempt,
          "operation_id",
        );
        const challengeId = requiredString(
          refreshExpiredPristineAttempt,
          "challenge_id",
        );
        await expectSingleMutation(
          transaction,
          `UPDATE crypto_delivery_operations
              SET updated_at = $4::timestamptz,
                  deadline_at = $5::timestamptz
            WHERE operation_id = $1
              AND state = $2
              AND target_device_id = $3
              AND aggregate_payload_bytes = 0
              AND fanout_row_count = 0
            RETURNING operation_id`,
          [
            operationId,
            operationState(enrollment),
            enrollment.deviceId,
            isoTime(enrollment.issuedAt),
            isoTime(enrollment.issuedAt + OPERATION_TTL_MS),
          ],
          "Additional-device expired operation refresh",
        );
        await expectSingleMutation(
          transaction,
          `UPDATE human_crypto_device_challenges
              SET issued_at = $4::timestamptz,
                  expires_at = $5::timestamptz
            WHERE challenge_id = $1
              AND pending_device_id = $2
              AND idempotency_key = $3
              AND consumed_at IS NULL
              AND invalidated_at IS NULL
              AND revision = 0
              AND expires_at <= $4::timestamptz
            RETURNING challenge_id`,
          [
            challengeId,
            enrollment.deviceId,
            enrollment.idempotencyKey,
            isoTime(enrollment.issuedAt),
            isoTime(enrollment.expiresAt),
          ],
          "Additional-device expired challenge refresh",
        );
        return {
          status: "duplicate",
          operationId,
          challengeId,
          issuedAt: enrollment.issuedAt,
          expiresAt: enrollment.expiresAt,
        };
      }

      const duplicateDevice = oneOrNull(
        await transaction.query(
          `SELECT device_id
             FROM human_crypto_devices
            WHERE device_id = $1
               OR public_fingerprint = $2
               OR (
                 human_id = $3
                 AND installation_lineage_digest = $4
                 AND device_generation = $5
                 AND state IN ('pending', 'active')
               )
            LIMIT 2
            FOR UPDATE`,
          [
            enrollment.deviceId,
            input.publicFingerprint,
            enrollment.humanActorId,
            enrollment.installationLineageDigest,
            enrollment.deviceGeneration,
          ],
        ),
        "Additional-device identity collision lookup",
      );
      if (duplicateDevice !== null) {
        return { status: "already_registered" };
      }
      if (
        !(await humanHasOperationCapacity(
          transaction,
          enrollment.humanActorId,
        ))
      ) {
        return { status: "operation_limit_reached" };
      }

      const bounds = oneOrNull(
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            active_device_count: sql<number>`count(distinct
              ${humanCryptoDevices.deviceId}) filter (where
              ${humanCryptoDevices.state} = 'active')::bigint`
              .as("active_device_count"),
            pending_device_count: sql<number>`count(distinct
              ${humanCryptoDevices.deviceId}) filter (where
              ${humanCryptoDevices.state} = 'pending')::bigint`
              .as("pending_device_count"),
            outstanding_operation_count: sql<number>`count(distinct
              ${cryptoDeliveryOperations.operationId}) filter (where
              ${cryptoDeliveryOperations.state} not in
              ('active', 'failed', 'cancelled'))::bigint`
              .as("outstanding_operation_count"),
            live_device_roster_operation_count: sql<number>`count(distinct
              ${cryptoDeliveryOperations.operationId}) filter (where
              ${cryptoDeliveryOperations.kind} in
              ('device_add', 'device_recovery', 'device_revoke',
               'recovery_rotate') and ${cryptoDeliveryOperations.state} not in
              ('active', 'failed', 'cancelled'))::bigint`
              .as("live_device_roster_operation_count"),
          }).from(sql`(values (1)) as bounds_probe`).leftJoin(
            humanCryptoDevices,
            eq(humanCryptoDevices.humanId, enrollment.humanActorId),
          ).leftJoin(
            cryptoDeliveryOperations,
            eq(cryptoDeliveryOperations.humanId, enrollment.humanActorId),
          ),
        ),
        "Additional-device bounds lookup",
      );
      if (bounds === null) {
        throw new Error("Additional-device bounds lookup returned no row");
      }
      if (
        this.enforceLegacyFleetBounds
        &&
        requiredCounter(bounds, "active_device_count")
        >= CRYPTO_DELIVERY_COLLECTION_LIMITS.activeDevicesPerHuman
      ) {
        return { status: "device_limit_reached" };
      }
      if (
        this.enforceLegacyFleetBounds
        &&
        requiredCounter(bounds, "pending_device_count")
        >= CRYPTO_DELIVERY_COLLECTION_LIMITS.pendingDevicesPerHuman
      ) {
        return { status: "pending_limit_reached" };
      }
      if (
        requiredCounter(bounds, "outstanding_operation_count")
        >= CRYPTO_DELIVERY_COLLECTION_LIMITS.outstandingOperationsPerHuman
        || requiredCounter(bounds, "live_device_roster_operation_count") >= 1
      ) {
        return { status: "operation_limit_reached" };
      }

      await expectSingleMutation(
        transaction,
        `INSERT INTO human_crypto_devices (
           device_id, human_id, user_id, human_actor_id, client_kind,
           installation_lineage_digest, device_generation,
           signing_public_key, encryption_public_key, public_fingerprint,
           state, authorization_kind, approval_generation,
           recovery_generation, authorization_evidence_digest,
           key_package_generation, key_package_count, revision,
           created_at, activated_at, last_seen_at, revoked_at, rejected_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           'pending', $11, $12, $13, $14, 0, 0, 0,
           $15::timestamptz, NULL, NULL, NULL, NULL
         )
         RETURNING device_id`,
        [
          enrollment.deviceId,
          enrollment.humanActorId,
          enrollment.userId,
          enrollment.humanActorId,
          enrollment.clientKind,
          enrollment.installationLineageDigest,
          enrollment.deviceGeneration,
          enrollment.signingPublicKey,
          enrollment.encryptionPublicKey,
          input.publicFingerprint,
          enrollment.method,
          enrollment.method === "device_approval"
            ? enrollment.expectedCustodyRevision
            : null,
          enrollment.method === "recovery"
            ? enrollment.expectedRecoveryGeneration
            : null,
          enrollment.authorizationDigest,
          isoTime(enrollment.issuedAt),
        ],
        "Additional-device registry insert",
      );

      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_delivery_operations (
           operation_id, idempotency_key, kind, state, human_id,
           target_human_id, target_device_id, expected_custody_revision,
           expected_recovery_generation, expected_device_revision,
           expected_participant_digest, aggregate_payload_bytes,
           fanout_row_count, lease_owner, lease_expires_at, retry_count,
           maximum_attempts, failure_code, audit_ref, created_at, updated_at,
           deadline_at, terminal_at
         ) VALUES (
           $1, $2, $3, $4, $5, $5, $6, $7, $8, 0,
           $9, 0, 0, NULL, NULL, 0, $10, NULL, NULL,
           $11::timestamptz, $11::timestamptz, $12::timestamptz, NULL
         )
         RETURNING operation_id`,
        [
          enrollment.operationId,
          enrollment.idempotencyKey,
          operationKind(enrollment),
          operationState(enrollment),
          enrollment.humanActorId,
          enrollment.deviceId,
          enrollment.expectedCustodyRevision,
          enrollment.expectedRecoveryGeneration,
          enrollment.inventoryDigest,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          isoTime(enrollment.issuedAt),
          isoTime(enrollment.issuedAt + OPERATION_TTL_MS),
        ],
        "Additional-device operation insert",
      );

      await expectSingleMutation(
        transaction,
        `INSERT INTO human_crypto_device_challenges (
           challenge_id, challenge_hash, kind, bootstrap_context, human_id,
           user_id, human_actor_id, installation_lineage_digest,
           authorization_digest, pending_device_id,
           signing_public_key_digest, encryption_public_key_digest,
           recovery_public_key_digest, expected_custody_revision,
           expected_recovery_generation, idempotency_key, issued_at,
           expires_at, consumed_at, invalidated_at, terminal_result_code,
           receipt_audit_ref, revision
         ) VALUES (
           $1, $2, $3, NULL, $4, $5, $6, $7, $8, $9,
           $10, $11, NULL, $12, $13, $14, $15::timestamptz,
           $16::timestamptz, NULL, NULL, NULL, NULL, 0
         )
         RETURNING challenge_id`,
        [
          enrollment.challengeId,
          input.challengeHash,
          challengeKind(enrollment),
          enrollment.humanActorId,
          enrollment.userId,
          enrollment.humanActorId,
          enrollment.installationLineageDigest,
          enrollment.authorizationDigest,
          enrollment.deviceId,
          input.signingPublicKeyDigest,
          input.encryptionPublicKeyDigest,
          enrollment.expectedCustodyRevision,
          enrollment.expectedRecoveryGeneration,
          enrollment.idempotencyKey,
          isoTime(enrollment.issuedAt),
          isoTime(enrollment.expiresAt),
        ],
        "Additional-device challenge insert",
      );

      return {
        status: "created",
        operationId: enrollment.operationId,
        challengeId: enrollment.challengeId,
        issuedAt: enrollment.issuedAt,
        expiresAt: enrollment.expiresAt,
      };
    });
  }
}
