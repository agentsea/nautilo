import type {
  BeginInitialDeviceBootstrap,
  InitialDeviceBootstrapChallenge,
  InitialDeviceBootstrapReceipt,
  InitialDeviceBootstrapReceiptQuery,
} from "../../device/initial-bootstrap.ts";
import {
  actors,
  and,
  cryptoDeliveryOperations,
  cryptoOperationOutbox,
  eq,
  humanCryptoCustodies,
  humanCryptoDeviceChallenges,
  humanCryptoDevices,
  humanCryptoRecoveryArchives,
  humanCryptoRecoveryKeys,
  isNotNull,
  isNull,
  sql,
  users,
} from "@nautilo/db";
import type { InitialDeviceBootstrapRepository } from "./initial-bootstrap-service.ts";
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

const textEncoder = new TextEncoder();
const MAXIMUM_ATTEMPTS = 8;

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

function nullableString(row: DatabaseRow, name: string): string | null {
  const value = row[name];
  return value === null ? null : requiredString(row, name);
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

function timestampSql(milliseconds: number) {
  return sql`${isoTime(milliseconds)}::timestamptz`;
}

function operationId(challengeId: string): string {
  return `operation_${challengeId}`;
}

function outboxId(challengeId: string): string {
  return `outbox_${challengeId}`;
}

function bootstrapRowMatches(
  row: DatabaseRow,
  request: BeginInitialDeviceBootstrap,
  input: {
    readonly authorizationDigest: Uint8Array;
    readonly publicFingerprint: Uint8Array;
    readonly signingPublicKeyDigest: Uint8Array;
    readonly encryptionPublicKeyDigest: Uint8Array;
    readonly recoveryPublicKeyDigest: Uint8Array;
  },
): boolean {
  return requiredString(row, "human_id") === request.humanActorId
    && requiredString(row, "user_id") === request.userId
    && requiredString(row, "human_actor_id") === request.humanActorId
    && requiredString(row, "bootstrap_context") === request.context.kind
    && nullableString(row, "bootstrap_authority_id")
      === request.context.authorityId
    && requiredString(row, "pending_device_id") === request.deviceId
    && requiredString(row, "idempotency_key") === request.idempotencyKey
    && requiredString(row, "client_kind") === request.clientKind
    && equalBytes(
      requiredBytes(row, "installation_lineage_digest"),
      request.installationLineageDigest,
    )
    && equalBytes(
      requiredBytes(row, "authorization_digest"),
      input.authorizationDigest,
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
      requiredBytes(row, "recovery_public_key_digest"),
      input.recoveryPublicKeyDigest,
    )
    && equalBytes(
      requiredBytes(row, "device_lineage_digest"),
      request.installationLineageDigest,
    )
    && equalBytes(
      requiredBytes(row, "signing_public_key"),
      request.signingPublicKey,
    )
    && equalBytes(
      requiredBytes(row, "encryption_public_key"),
      request.encryptionPublicKey,
    )
    && equalBytes(
      requiredBytes(row, "public_fingerprint"),
      input.publicFingerprint,
    );
}

async function getBootstrap(
  executor: CryptoPostgresExecutor,
  challengeId: string,
): Promise<DatabaseRow | null> {
  return oneOrNull(
    await executor.query(
      `SELECT c.challenge_id,
              c.challenge_hash,
              c.bootstrap_context,
              c.bootstrap_authority_id,
              c.human_id,
              c.user_id::text AS user_id,
              c.human_actor_id::text AS human_actor_id,
              c.installation_lineage_digest,
              c.authorization_digest,
              c.pending_device_id,
              c.signing_public_key_digest,
              c.encryption_public_key_digest,
              c.recovery_public_key_digest,
              c.idempotency_key,
              floor(extract(epoch from c.issued_at) * 1000)::bigint
                AS issued_at_ms,
              floor(extract(epoch from c.expires_at) * 1000)::bigint
                AS expires_at_ms,
              floor(extract(epoch from c.consumed_at) * 1000)::bigint
                AS consumed_at_ms,
              c.invalidated_at IS NOT NULL AS invalidated,
              c.terminal_result_code,
              c.receipt_audit_ref,
              c.revision AS challenge_revision,
              d.client_kind,
              d.installation_lineage_digest AS device_lineage_digest,
              d.signing_public_key,
              d.encryption_public_key,
              d.public_fingerprint,
              d.state AS device_state,
              d.authorization_evidence_digest,
              d.revision AS device_revision,
              h.state AS custody_state,
              h.ever_initialized_at IS NOT NULL AS ever_initialized,
              h.current_recovery_generation,
              h.current_recovery_public_key_digest,
              h.revision AS custody_revision,
              o.state AS operation_state
         FROM human_crypto_device_challenges c
         JOIN human_crypto_devices d
           ON d.device_id = c.pending_device_id
         JOIN human_crypto_custodies h
           ON h.human_id = c.human_id
         JOIN crypto_delivery_operations o
           ON o.operation_id = ('operation_' || c.challenge_id)
        WHERE c.challenge_id = $1
        LIMIT 2
        FOR UPDATE OF c, d, h, o`,
      [challengeId],
    ),
    "Initial bootstrap lookup",
  );
}

function completeChallengeMatches(
  row: DatabaseRow,
  challenge: InitialDeviceBootstrapChallenge,
  input: {
    readonly challengeHash: Uint8Array;
    readonly publicFingerprint: Uint8Array;
    readonly signingPublicKeyDigest: Uint8Array;
    readonly encryptionPublicKeyDigest: Uint8Array;
    readonly recoveryPublicKeyDigest: Uint8Array;
  },
): boolean {
  return requiredString(row, "challenge_id") === challenge.challengeId
    && requiredString(row, "human_id") === challenge.humanActorId
    && requiredString(row, "user_id") === challenge.userId
    && requiredString(row, "human_actor_id") === challenge.humanActorId
    && requiredString(row, "bootstrap_context") === challenge.context.kind
    && nullableString(row, "bootstrap_authority_id")
      === challenge.context.authorityId
    && requiredString(row, "pending_device_id") === challenge.deviceId
    && requiredString(row, "idempotency_key") === challenge.idempotencyKey
    && requiredString(row, "client_kind") === challenge.clientKind
    && requiredCounter(row, "issued_at_ms") === challenge.issuedAt
    && requiredCounter(row, "expires_at_ms") === challenge.expiresAt
    && equalBytes(requiredBytes(row, "challenge_hash"), input.challengeHash)
    && equalBytes(
      requiredBytes(row, "installation_lineage_digest"),
      challenge.installationLineageDigest,
    )
    && equalBytes(
      requiredBytes(row, "authorization_digest"),
      challenge.authorizationDigest,
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
      requiredBytes(row, "recovery_public_key_digest"),
      input.recoveryPublicKeyDigest,
    )
    && equalBytes(
      requiredBytes(row, "device_lineage_digest"),
      challenge.installationLineageDigest,
    )
    && equalBytes(
      requiredBytes(row, "signing_public_key"),
      challenge.signingPublicKey,
    )
    && equalBytes(
      requiredBytes(row, "encryption_public_key"),
      challenge.encryptionPublicKey,
    )
    && equalBytes(
      requiredBytes(row, "public_fingerprint"),
      input.publicFingerprint,
    )
    && equalBytes(
      requiredBytes(row, "authorization_evidence_digest"),
      challenge.authorizationDigest,
    );
}

type PendingInviteAuthorityMode = "pending" | "replay";

async function getPendingInviteAuthority(
  executor: CryptoPostgresExecutor,
  authorityId: string,
  lock: boolean,
): Promise<DatabaseRow | null> {
  return oneOrNull(
    await executor.query(
      `SELECT o.operation_id, o.kind AS operation_kind,
              o.state AS operation_state,
              o.target_human_id, o.target_device_id,
              floor(extract(epoch from o.deadline_at) * 1000)::bigint
                AS deadline_at_ms,
              h.namespace_id,
              h.target_human_actor_id::text AS target_human_actor_id,
              h.admitted_bootstrap_device_id,
              h.bootstrap_device_id,
              h.admitted_target_domain_id,
              h.target_domain_id,
              h.activated_at IS NOT NULL AS membership_activated,
              h.released_at IS NOT NULL AS membership_released
         FROM crypto_delivery_operations o
         JOIN crypto_human_membership_transitions h
           ON h.operation_id = o.operation_id
        WHERE o.operation_id = $1
        LIMIT 2
        ${lock ? "FOR UPDATE OF o, h" : ""}`,
      [authorityId],
    ),
    "Pending encrypted invite authority lookup",
  );
}

function pendingInviteAuthorityMatches(
  row: DatabaseRow,
  request: BeginInitialDeviceBootstrap,
  at: number,
  mode: PendingInviteAuthorityMode,
): boolean {
  const state = requiredString(row, "operation_state");
  const bootstrapDeviceId = nullableString(row, "bootstrap_device_id");
  const pending = state === "awaiting_target_device"
    && bootstrapDeviceId === null
    && nullableString(row, "target_human_id") === null
    && nullableString(row, "target_device_id") === null;
  const progressed = [
    "preparing_domain",
    "awaiting_committer",
    "awaiting_delivery",
    "ready_to_activate",
    "activating",
    "active",
  ].includes(state)
    && bootstrapDeviceId === request.deviceId
    && nullableString(row, "target_human_id") === request.humanActorId
    && nullableString(row, "target_device_id") === request.deviceId;
  return requiredString(row, "operation_id") === request.context.authorityId
    && requiredString(row, "operation_kind") === "human_add"
    && requiredString(row, "target_human_actor_id") === request.humanActorId
    && nullableString(row, "admitted_bootstrap_device_id") === null
    && nullableString(row, "admitted_target_domain_id") === null
    && row["membership_activated"] === (state === "active")
    && row["membership_released"] === (state === "active")
    && (mode === "replay" || requiredCounter(row, "deadline_at_ms") > at)
    && (mode === "pending" ? pending : pending || progressed);
}

function receiptFromRow(
  row: DatabaseRow,
  challenge: InitialDeviceBootstrapChallenge,
): InitialDeviceBootstrapReceipt {
  const auditRef = nullableString(row, "receipt_audit_ref");
  const committedAtValue = row["consumed_at_ms"];
  if (auditRef === null || committedAtValue === null) {
    throw new TypeError("Consumed bootstrap is missing its terminal receipt");
  }
  if (
    requiredCounter(row, "device_revision") !== 1
    || requiredCounter(row, "custody_revision") !== 1
  ) {
    throw new TypeError("Consumed bootstrap has an invalid terminal revision");
  }
  return Object.freeze({
    formatVersion: 1,
    status: "active",
    humanActorId: challenge.humanActorId,
    deviceId: challenge.deviceId,
    recoveryKeyId: challenge.recoveryKeyId,
    recoveryGeneration: 1,
    deviceRevision: 1,
    custodyRevision: 1,
    auditRef,
    committedAt: requiredCounter(row, "consumed_at_ms"),
  });
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

async function expectMutationIncludes(
  executor: CryptoPostgresExecutor,
  statement: string,
  parameters: readonly DatabaseScalar[],
  operationId: string,
  label: string,
): Promise<void> {
  const rows = await executor.query(statement, parameters);
  if (!rows.some((row) =>
    requiredString(row, "operation_id") === operationId
  )) {
    throw new Error(`${label} lost its authority compare-and-swap`);
  }
}

export class PostgresInitialDeviceBootstrapRepository
  implements InitialDeviceBootstrapRepository
{
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  begin(
    input: Parameters<InitialDeviceBootstrapRepository["begin"]>[0],
  ): ReturnType<InitialDeviceBootstrapRepository["begin"]> {
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`initial-bootstrap/${input.request.humanActorId}`],
      );

      let pendingInviteAuthority: DatabaseRow | null = null;
      if (input.request.context.kind === "pending_encrypted_invite") {
        const preflight = await getPendingInviteAuthority(
          transaction,
          input.request.context.authorityId,
          false,
        );
        if (preflight === null) return { status: "stale_state" };
        await transaction.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [requiredString(preflight, "namespace_id")],
        );
        pendingInviteAuthority = await getPendingInviteAuthority(
          transaction,
          input.request.context.authorityId,
          true,
        );
        if (pendingInviteAuthority === null) {
          return { status: "stale_state" };
        }
      }

      const identity = oneOrNull(
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            user_id: sql<string>`${users.id}::text`.as("user_id"),
            human_actor_id: sql<string>`${actors.id}::text`
              .as("human_actor_id"),
            actor_owner_id: sql<string>`${actors.ownerId}::text`
              .as("actor_owner_id"),
            actor_kind: sql<string>`${actors.kind}`.as("actor_kind"),
          }).from(users).innerJoin(
            actors,
            eq(actors.id, input.request.humanActorId),
          ).where(eq(users.id, input.request.userId)).limit(2),
        ),
        "Initial bootstrap identity lookup",
      );
      if (
        identity === null
        || requiredString(identity, "user_id") !== input.request.userId
        || requiredString(identity, "human_actor_id")
          !== input.request.humanActorId
        || requiredString(identity, "actor_owner_id") !== input.request.userId
        || requiredString(identity, "actor_kind") !== "user"
      ) {
        return { status: "stale_state" };
      }

      const idempotent = oneOrNull(
        await transaction.query(
          `SELECT c.bootstrap_context,
                  c.bootstrap_authority_id,
                  c.human_id,
                  c.user_id::text AS user_id,
                  c.human_actor_id::text AS human_actor_id,
                  c.installation_lineage_digest,
                  c.authorization_digest,
                  c.pending_device_id,
                  c.signing_public_key_digest,
                  c.encryption_public_key_digest,
                  c.recovery_public_key_digest,
                  c.idempotency_key,
                  c.challenge_id,
                  floor(extract(epoch from c.issued_at) * 1000)::bigint
                    AS issued_at_ms,
                  floor(extract(epoch from c.expires_at) * 1000)::bigint
                    AS expires_at_ms,
                  d.client_kind,
                  d.installation_lineage_digest AS device_lineage_digest,
                  d.signing_public_key,
                  d.encryption_public_key,
                  d.public_fingerprint
             FROM human_crypto_device_challenges c
             JOIN human_crypto_devices d
               ON d.device_id = c.pending_device_id
            WHERE c.human_id = $1
              AND c.kind = 'initial_bootstrap'
              AND c.idempotency_key = $2
            LIMIT 2
            FOR UPDATE OF c, d`,
          [input.request.humanActorId, input.request.idempotencyKey],
        ),
        "Initial bootstrap idempotency lookup",
      );
      if (idempotent !== null) {
        if (
          !bootstrapRowMatches(idempotent, input.request, input)
          || (
            pendingInviteAuthority !== null
            && !pendingInviteAuthorityMatches(
              pendingInviteAuthority,
              input.request,
              input.issuedAt,
              "replay",
            )
          )
        ) {
          return { status: "conflicting_idempotency" };
        }
        return {
          status: "duplicate",
          challengeId: requiredString(idempotent, "challenge_id"),
          issuedAt: requiredCounter(idempotent, "issued_at_ms"),
          expiresAt: requiredCounter(idempotent, "expires_at_ms"),
        };
      }
      if (
        pendingInviteAuthority !== null
        && !pendingInviteAuthorityMatches(
          pendingInviteAuthority,
          input.request,
          input.issuedAt,
          "pending",
        )
      ) {
        return { status: "stale_state" };
      }

      const custodyRows = await transaction.query(
        `SELECT human_id,
                user_id::text AS user_id,
                human_actor_id::text AS human_actor_id,
                initial_installation_lineage_digest,
                state,
                ever_initialized_at IS NOT NULL AS ever_initialized,
                revision
           FROM human_crypto_custodies
          WHERE human_id = $1
             OR user_id = $2
             OR human_actor_id = $3
          LIMIT 2
          FOR UPDATE`,
        [
          input.request.humanActorId,
          input.request.userId,
          input.request.humanActorId,
        ],
      );
      if (custodyRows.length > 1) return { status: "stale_state" };
      const custody = custodyRows[0];
      let createCustody = true;
      if (custody !== undefined) {
        if (
          custody["ever_initialized"] === true
          || requiredString(custody, "state") === "active"
        ) {
          return { status: "already_initialized" };
        }
        if (
          requiredString(custody, "human_id") !== input.request.humanActorId
          || requiredString(custody, "user_id") !== input.request.userId
          || requiredString(custody, "human_actor_id")
            !== input.request.humanActorId
          || requiredString(custody, "state") !== "initializing"
          || custody["ever_initialized"] !== false
          || requiredCounter(custody, "revision") !== 0
          || !equalBytes(
            requiredBytes(
              custody,
              "initial_installation_lineage_digest",
            ),
            input.request.installationLineageDigest,
          )
        ) {
          return { status: "stale_state" };
        }
        const liveChallenge = oneOrNull(
          await transaction.query(
            `SELECT challenge_id, pending_device_id, bootstrap_context,
                    floor(extract(epoch from expires_at) * 1000)::bigint
                      AS expires_at_ms,
                    revision
               FROM human_crypto_device_challenges
              WHERE human_id = $1
                AND kind = 'initial_bootstrap'
                AND consumed_at IS NULL
                AND invalidated_at IS NULL
              LIMIT 2
              FOR UPDATE`,
            [input.request.humanActorId],
          ),
          "Live initial bootstrap lookup",
        );
        if (liveChallenge !== null) {
          if (
            requiredString(liveChallenge, "bootstrap_context")
              !== input.request.context.kind
            || input.issuedAt
              < requiredCounter(liveChallenge, "expires_at_ms")
          ) {
            return { status: "stale_state" };
          }
          const invalidatedAt = isoTime(input.issuedAt);
          const oldChallengeId = requiredString(
            liveChallenge,
            "challenge_id",
          );
          const oldDeviceId = requiredString(
            liveChallenge,
            "pending_device_id",
          );
          await expectSingleMutation(
            transaction,
            `UPDATE human_crypto_device_challenges
                SET invalidated_at = $2,
                    terminal_result_code = 'challenge_expired',
                    revision = revision + 1
              WHERE challenge_id = $1
                AND consumed_at IS NULL
                AND invalidated_at IS NULL
              RETURNING challenge_id`,
            [oldChallengeId, invalidatedAt],
            "Expired initial bootstrap invalidation",
          );
          await expectSingleMutation(
            transaction,
            `UPDATE human_crypto_devices
                SET state = 'rejected', rejected_at = $2,
                    revision = revision + 1
              WHERE device_id = $1 AND state = 'pending'
              RETURNING device_id`,
            [oldDeviceId, invalidatedAt],
            "Expired initial bootstrap device rejection",
          );
          await expectSingleMutation(
            transaction,
            `UPDATE crypto_delivery_operations
                SET state = 'failed', failure_code = 'challenge_expired',
                    updated_at = $2, terminal_at = $2
              WHERE operation_id = $1
                AND state NOT IN ('active', 'failed', 'cancelled')
              RETURNING operation_id`,
            [operationId(oldChallengeId), invalidatedAt],
            "Expired initial bootstrap operation failure",
          );
        }
        createCustody = false;
      }

      const deviceConflict = await transaction.query(
        `SELECT device_id
           FROM human_crypto_devices
          WHERE device_id = $1 OR public_fingerprint = $2
          LIMIT 2
          FOR UPDATE`,
        [input.request.deviceId, input.publicFingerprint],
      );
      if (deviceConflict.length !== 0) return { status: "stale_state" };

      const humanId = input.request.humanActorId;
      if (!(await humanHasOperationCapacity(transaction, humanId))) {
        return { status: "stale_state" };
      }
      if (createCustody) {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.insert(humanCryptoCustodies).values({
            humanId,
            userId: input.request.userId,
            humanActorId: input.request.humanActorId,
            initialInstallationLineageDigest:
              input.request.installationLineageDigest,
            state: "initializing",
            everInitializedAt: null,
            firstDeviceId: null,
            currentRecoveryGeneration: null,
            currentRecoveryPublicKeyDigest: null,
            currentInventoryRevision: null,
            currentInventoryCount: null,
            currentInventoryDigest: null,
            revision: 0,
            lastTransitionAuditRef: null,
            createdAt: timestampSql(input.issuedAt),
            updatedAt: timestampSql(input.issuedAt),
          }),
        );
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(humanCryptoDevices).values({
          deviceId: input.request.deviceId,
          humanId,
          userId: input.request.userId,
          humanActorId: input.request.humanActorId,
          clientKind: input.request.clientKind,
          installationLineageDigest: input.request.installationLineageDigest,
          deviceGeneration: 1,
          signingPublicKey: input.request.signingPublicKey,
          encryptionPublicKey: input.request.encryptionPublicKey,
          publicFingerprint: input.publicFingerprint,
          state: "pending",
          authorizationKind: "first_bootstrap",
          approvalGeneration: null,
          recoveryGeneration: 1,
          authorizationEvidenceDigest: input.authorizationDigest,
          keyPackageGeneration: 0,
          keyPackageCount: 0,
          revision: 0,
          createdAt: timestampSql(input.issuedAt),
          activatedAt: null,
          lastSeenAt: null,
          revokedAt: null,
          rejectedAt: null,
        }),
      );
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(cryptoDeliveryOperations).values({
          operationId: operationId(input.challengeId),
          idempotencyKey: `first_bootstrap/${input.challengeId}`,
          kind: "first_device_bootstrap",
          state: "awaiting_target_device",
          humanId,
          targetHumanId: humanId,
          targetDeviceId: input.request.deviceId,
          expectedCustodyRevision: 0,
          expectedRecoveryGeneration: null,
          expectedDeviceRevision: 0,
          expectedParticipantDigest: null,
          aggregatePayloadBytes: 0,
          fanoutRowCount: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          retryCount: 0,
          maximumAttempts: MAXIMUM_ATTEMPTS,
          failureCode: null,
          auditRef: null,
          createdAt: timestampSql(input.issuedAt),
          updatedAt: timestampSql(input.issuedAt),
          deadlineAt: timestampSql(input.expiresAt),
          terminalAt: null,
        }),
      );
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(humanCryptoDeviceChallenges).values({
          challengeId: input.challengeId,
          challengeHash: input.challengeHash,
          kind: "initial_bootstrap",
          bootstrapContext: input.request.context.kind,
          bootstrapAuthorityId: input.request.context.authorityId,
          humanId,
          userId: input.request.userId,
          humanActorId: input.request.humanActorId,
          installationLineageDigest: input.request.installationLineageDigest,
          authorizationDigest: input.authorizationDigest,
          pendingDeviceId: input.request.deviceId,
          signingPublicKeyDigest: input.signingPublicKeyDigest,
          encryptionPublicKeyDigest: input.encryptionPublicKeyDigest,
          recoveryPublicKeyDigest: input.recoveryPublicKeyDigest,
          expectedResponseDigest: null,
          expectedCustodyRevision: 0,
          expectedRecoveryGeneration: null,
          idempotencyKey: input.request.idempotencyKey,
          issuedAt: timestampSql(input.issuedAt),
          expiresAt: timestampSql(input.expiresAt),
          consumedAt: null,
          invalidatedAt: null,
          terminalResultCode: null,
          receiptAuditRef: null,
          revision: 0,
        }),
      );
      return {
        status: "created",
        challengeId: input.challengeId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      };
    });
  }

  complete(
    input: Parameters<InitialDeviceBootstrapRepository["complete"]>[0],
  ): ReturnType<InitialDeviceBootstrapRepository["complete"]> {
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`initial-bootstrap/${input.challenge.humanActorId}`],
      );
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`recovery-key/${input.challenge.recoveryKeyId}`],
      );
      let pendingInviteAuthority: DatabaseRow | null = null;
      if (input.challenge.context.kind === "pending_encrypted_invite") {
        const preflight = await getPendingInviteAuthority(
          transaction,
          input.challenge.context.authorityId,
          false,
        );
        if (preflight === null) return { status: "challenge_invalid" };
        await transaction.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [requiredString(preflight, "namespace_id")],
        );
        pendingInviteAuthority = await getPendingInviteAuthority(
          transaction,
          input.challenge.context.authorityId,
          true,
        );
        if (pendingInviteAuthority === null) {
          return { status: "challenge_invalid" };
        }
      }
      const row = await getBootstrap(
        transaction,
        input.challenge.challengeId,
      );
      if (
        row === null
        || !completeChallengeMatches(row, input.challenge, input)
      ) {
        return { status: "challenge_invalid" };
      }

      if (row["consumed_at_ms"] !== null) {
        if (
          pendingInviteAuthority !== null
          && !pendingInviteAuthorityMatches(
            pendingInviteAuthority,
            input.challenge,
            input.committedAt,
            "replay",
          )
        ) {
          return { status: "challenge_invalid" };
        }
        const archive = oneOrNull(
          await transaction.query(
            `SELECT archive_hash
               FROM human_crypto_recovery_archives
              WHERE human_id = $1
              LIMIT 2
              FOR UPDATE`,
            [input.challenge.humanActorId],
          ),
          "Initial bootstrap replay archive lookup",
        );
        const recoveryKey = oneOrNull(
          await transaction.query(
            `SELECT recovery_key_id, public_key_digest
               FROM human_crypto_recovery_keys
              WHERE human_id = $1 AND generation = 1
              LIMIT 2
              FOR UPDATE`,
            [input.challenge.humanActorId],
          ),
          "Initial bootstrap replay recovery-key lookup",
        );
        if (
          requiredString(row, "terminal_result_code") !== "active"
          || archive === null
          || recoveryKey === null
          || !equalBytes(
            requiredBytes(archive, "archive_hash"),
            input.recoveryArchiveHash,
          )
          || requiredString(recoveryKey, "recovery_key_id")
            !== input.challenge.recoveryKeyId
          || !equalBytes(
            requiredBytes(recoveryKey, "public_key_digest"),
            input.recoveryPublicKeyDigest,
          )
        ) {
          return { status: "challenge_invalid" };
        }
        return {
          status: "duplicate",
          receipt: receiptFromRow(row, input.challenge),
        };
      }
      if (row["invalidated"] === true) {
        return { status: "challenge_invalid" };
      }
      if (input.committedAt >= requiredCounter(row, "expires_at_ms")) {
        return { status: "challenge_expired" };
      }
      if (
        pendingInviteAuthority !== null
        && !pendingInviteAuthorityMatches(
          pendingInviteAuthority,
          input.challenge,
          input.committedAt,
          "pending",
        )
      ) {
        return { status: "stale_state" };
      }
      if (
        requiredString(row, "custody_state") !== "initializing"
        || row["ever_initialized"] !== false
        || requiredCounter(row, "custody_revision") !== 0
        || requiredString(row, "device_state") !== "pending"
        || requiredCounter(row, "device_revision") !== 0
        || requiredCounter(row, "challenge_revision") !== 0
        || requiredString(row, "operation_state") !== "awaiting_target_device"
      ) {
        return { status: "stale_state" };
      }

      const recoveryKeyCollision = await transaction.query(
        `SELECT human_id
           FROM human_crypto_recovery_keys
          WHERE recovery_key_id = $1
          LIMIT 2
          FOR UPDATE`,
        [input.challenge.recoveryKeyId],
      );
      const archiveCollision = await transaction.query(
        `SELECT human_id
           FROM human_crypto_recovery_archives
          WHERE human_id = $1
          LIMIT 2
          FOR UPDATE`,
        [input.challenge.humanActorId],
      );
      if (
        recoveryKeyCollision.length !== 0
        || archiveCollision.length !== 0
      ) {
        return { status: "stale_state" };
      }

      const committedAt = isoTime(input.committedAt);
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(humanCryptoRecoveryKeys).values({
          humanId: input.challenge.humanActorId,
          generation: 1,
          recoveryKeyId: input.challenge.recoveryKeyId,
          formatVersion: 1,
          publicKey: input.challenge.recoveryPublicKey,
          publicKeyDigest: input.recoveryPublicKeyDigest,
          archiveHash: input.recoveryArchiveHash,
          issuerDeviceId: input.challenge.deviceId,
          state: "current",
          activatedAt: timestampSql(input.committedAt),
          retiredAt: null,
          revision: 1,
        }),
      );
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(humanCryptoRecoveryArchives).values({
          humanId: input.challenge.humanActorId,
          recoveryKeyGeneration: 1,
          archiveHash: input.recoveryArchiveHash,
          archiveBytes: input.recoveryArchiveBytes,
        }),
      );
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_devices
            SET state = 'active', activated_at = $2, last_seen_at = $2,
                revision = 1
          WHERE device_id = $1 AND state = 'pending' AND revision = 0
          RETURNING device_id`,
        [input.challenge.deviceId, committedAt],
        "Initial bootstrap device activation",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_custodies
            SET state = 'active', ever_initialized_at = $2,
                first_device_id = $3, current_recovery_generation = 1,
                current_recovery_public_key_digest = $4, revision = 1,
                last_transition_audit_ref = $5, updated_at = $2
          WHERE human_id = $1 AND state = 'initializing'
            AND ever_initialized_at IS NULL AND revision = 0
          RETURNING human_id`,
        [
          input.challenge.humanActorId,
          committedAt,
          input.challenge.deviceId,
          input.recoveryPublicKeyDigest,
          input.auditRef,
        ],
        "Initial bootstrap custody activation",
      );
      if (pendingInviteAuthority !== null) {
        await expectMutationIncludes(
          transaction,
          `UPDATE crypto_human_membership_transitions AS membership
              SET bootstrap_device_id = $1
             FROM crypto_delivery_operations AS operation
            WHERE operation.operation_id = membership.operation_id
              AND operation.kind = 'human_add'
              AND operation.state = 'awaiting_target_device'
              AND operation.deadline_at > $3::timestamptz
              AND membership.target_human_actor_id = $2::uuid
              AND membership.admitted_bootstrap_device_id IS NULL
              AND membership.bootstrap_device_id IS NULL
              AND membership.admitted_target_domain_id IS NULL
              AND membership.target_domain_id IS NULL
              AND membership.activated_at IS NULL
              AND membership.released_at IS NULL
          RETURNING membership.operation_id`,
          [
            input.challenge.deviceId,
            input.challenge.humanActorId,
            committedAt,
          ],
          input.challenge.context.authorityId,
          "Pending invite bootstrap-device attachment",
        );
        await expectMutationIncludes(
          transaction,
          `UPDATE crypto_delivery_operations AS operation
              SET state = 'preparing_domain',
                  target_human_id = $2,
                  target_device_id = $1,
                  updated_at = $3
             FROM crypto_human_membership_transitions AS membership
            WHERE membership.operation_id = operation.operation_id
              AND operation.kind = 'human_add'
              AND operation.state = 'awaiting_target_device'
              AND operation.deadline_at > $3::timestamptz
              AND membership.target_human_actor_id = $2::uuid
              AND membership.admitted_bootstrap_device_id IS NULL
              AND membership.bootstrap_device_id = $1
              AND membership.admitted_target_domain_id IS NULL
              AND membership.target_domain_id IS NULL
              AND membership.activated_at IS NULL
              AND membership.released_at IS NULL
          RETURNING operation.operation_id`,
          [
            input.challenge.deviceId,
            input.challenge.humanActorId,
            committedAt,
          ],
          input.challenge.context.authorityId,
          "Pending invite readiness advancement",
        );
      }
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_device_challenges
            SET consumed_at = $2, terminal_result_code = 'active',
                receipt_audit_ref = $3, revision = 1
          WHERE challenge_id = $1 AND consumed_at IS NULL
            AND invalidated_at IS NULL AND revision = 0
          RETURNING challenge_id`,
        [input.challenge.challengeId, committedAt, input.auditRef],
        "Initial bootstrap challenge consumption",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_delivery_operations
            SET state = 'active', audit_ref = $2, updated_at = $3,
                terminal_at = $3
          WHERE operation_id = $1
            AND state = 'awaiting_target_device'
          RETURNING operation_id`,
        [
          operationId(input.challenge.challengeId),
          input.auditRef,
          committedAt,
        ],
        "Initial bootstrap operation activation",
      );
      const outboxPayload = textEncoder.encode(JSON.stringify({
        formatVersion: 1,
        eventType: "first_device_activated",
        humanActorId: input.challenge.humanActorId,
        deviceId: input.challenge.deviceId,
        auditRef: input.auditRef,
      }));
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(cryptoOperationOutbox).values({
          outboxId: outboxId(input.challenge.challengeId),
          operationId: operationId(input.challenge.challengeId),
          sequence: 0,
          eventType: "first_device_activated",
          payloadBytes: outboxPayload,
          idempotencyKey:
            `first_device_activated/${input.challenge.challengeId}`,
          claimedBy: null,
          claimExpiresAt: null,
          attempts: 0,
          maximumAttempts: MAXIMUM_ATTEMPTS,
          deliveredAt: null,
          terminalAt: null,
          failureCode: null,
          createdAt: timestampSql(input.committedAt),
        }),
      );
      const receipt: InitialDeviceBootstrapReceipt = Object.freeze({
        formatVersion: 1,
        status: "active",
        humanActorId: input.challenge.humanActorId,
        deviceId: input.challenge.deviceId,
        recoveryKeyId: input.challenge.recoveryKeyId,
        recoveryGeneration: 1,
        deviceRevision: 1,
        custodyRevision: 1,
        auditRef: input.auditRef,
        committedAt: input.committedAt,
      });
      return { status: "applied", receipt };
    });
  }

  async resolveReceipt(
    query: InitialDeviceBootstrapReceiptQuery,
  ): Promise<InitialDeviceBootstrapReceipt | null> {
    const row = oneOrNull(
      await executeTypedCryptoQuery(
        this.handle,
        cryptoTypedDb.select({
          receipt_audit_ref: humanCryptoDeviceChallenges.receiptAuditRef,
          committed_at_ms: sql<number>`floor(extract(epoch from
            ${humanCryptoDeviceChallenges.consumedAt}) * 1000)::bigint`
            .as("committed_at_ms"),
          device_id: humanCryptoDevices.deviceId,
          device_revision: sql<number>`${humanCryptoDevices.revision}`
            .as("device_revision"),
          human_id: humanCryptoCustodies.humanId,
          current_recovery_generation:
            humanCryptoCustodies.currentRecoveryGeneration,
          custody_revision: sql<number>`${humanCryptoCustodies.revision}`
            .as("custody_revision"),
          recovery_key_id: humanCryptoRecoveryKeys.recoveryKeyId,
        }).from(humanCryptoDeviceChallenges).innerJoin(
          humanCryptoDevices,
          eq(
            humanCryptoDevices.deviceId,
            humanCryptoDeviceChallenges.pendingDeviceId,
          ),
        ).innerJoin(
          humanCryptoCustodies,
          eq(
            humanCryptoCustodies.humanId,
            humanCryptoDeviceChallenges.humanId,
          ),
        ).innerJoin(
          humanCryptoRecoveryKeys,
          and(
            eq(
              humanCryptoRecoveryKeys.humanId,
              humanCryptoCustodies.humanId,
            ),
            eq(
              humanCryptoRecoveryKeys.generation,
              humanCryptoCustodies.currentRecoveryGeneration,
            ),
          ),
        ).where(and(
          eq(humanCryptoDeviceChallenges.challengeId, query.challengeId),
          eq(humanCryptoDeviceChallenges.userId, query.userId),
          eq(humanCryptoDeviceChallenges.humanActorId, query.humanActorId),
          eq(humanCryptoDeviceChallenges.pendingDeviceId, query.deviceId),
          eq(humanCryptoDevices.publicFingerprint, query.publicFingerprint),
          isNotNull(humanCryptoDeviceChallenges.consumedAt),
          isNull(humanCryptoDeviceChallenges.invalidatedAt),
          eq(humanCryptoDeviceChallenges.terminalResultCode, "active"),
          eq(humanCryptoDevices.state, "active"),
          eq(humanCryptoCustodies.state, "active"),
          isNotNull(humanCryptoCustodies.everInitializedAt),
          eq(humanCryptoRecoveryKeys.state, "active"),
        )).limit(2),
      ),
      "Initial bootstrap receipt lookup",
    );
    if (row === null) return null;
    const recoveryGeneration = requiredCounter(
      row,
      "current_recovery_generation",
    );
    const deviceRevision = requiredCounter(row, "device_revision");
    const custodyRevision = requiredCounter(row, "custody_revision");
    if (
      requiredString(row, "human_id") !== query.humanActorId
      || requiredString(row, "device_id") !== query.deviceId
      || recoveryGeneration !== 1
      || deviceRevision !== 1
      || custodyRevision !== 1
    ) {
      throw new Error("Initial bootstrap receipt state is inconsistent");
    }
    const auditRef = requiredString(row, "receipt_audit_ref");
    return Object.freeze({
      formatVersion: 1,
      status: "active",
      humanActorId: query.humanActorId,
      deviceId: requiredString(row, "device_id"),
      recoveryKeyId: requiredString(row, "recovery_key_id"),
      recoveryGeneration,
      deviceRevision,
      custodyRevision,
      auditRef,
      committedAt: requiredCounter(row, "committed_at_ms"),
    });
  }
}
