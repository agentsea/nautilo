import {
  cryptoDeviceId,
  humanId,
  unixTimestamp,
  verifyRecoveryDeviceActivationProof,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeRecoveryDeviceActivationProofV2,
  deviceTransferInventoryRevisionV2,
  pendingDeviceRevisionV2,
  recoveryKeyGenerationV2,
  recoveryReadinessDigestV2,
} from "@nautilo/lattice-crypto/wire";
import {
  and,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDomainTransitionNamespaces,
  cryptoDomainTransitionSteps,
  cryptoOperationOutbox,
  eq,
  sql,
} from "@nautilo/db";
import {
  MAX_ACTIVE_DOMAINS_PER_DEVICE,
  MAX_NAMESPACES_PER_DOMAIN_TRANSITION,
  assertDeviceFanoutPlan,
  type DeviceFanoutDomainPlan,
  type DeviceFanoutPlan,
} from "../../delivery/device-fanout.ts";
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

export type RecoveryFanoutAdmissionResult =
  | {
    readonly status: "admitted" | "duplicate";
    readonly domainCount: number;
    readonly blockedDomainCount: number;
  }
  | { readonly status: "stale_state" | "conflicting_state" };

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
    throw new TypeError(`Recovery fanout column ${name} must be text`);
  }
  return value;
}

function nullableString(row: DatabaseRow, name: string): string | null {
  return row[name] === null ? null : requiredString(row, name);
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Recovery fanout column ${name} must be bytea`);
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
    throw new TypeError(
      `Recovery fanout column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Recovery fanout column ${name} must be boolean`);
  }
  return value;
}

function requiredStringArray(
  row: DatabaseRow,
  name: string,
): readonly string[] {
  const value = row[name];
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== "string")
  ) {
    throw new TypeError(`Recovery fanout column ${name} must be text[]`);
  }
  return value as string[];
}

function oneOrNull(
  rows: readonly DatabaseRow[],
  label: string,
): DatabaseRow | null {
  if (rows.length > 1) {
    throw new Error(`${label} returned duplicate rows`);
  }
  return rows[0] ?? null;
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Recovery fanout timestamp must be nonnegative");
  }
  return new Date(milliseconds).toISOString();
}

function portable(label: string, value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function recoveryAdmissionArtifactHash(
  crypto: LatticeCrypto,
  proofBytes: Uint8Array,
  domains: readonly DeviceFanoutDomainPlan[],
): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify({
    formatVersion: 1,
    domain: "nautilo/lattice-bridge/recovery-fanout-admission/v1",
    proofHash: hex(crypto.hash(proofBytes)),
    domains: domains.map((item) => ({
      domainId: item.domainId,
      expectedEpoch: item.expectedEpoch,
      targetEpoch: item.targetEpoch,
      expectedAuthorizationRevision: item.expectedAuthorizationRevision,
      expectedParticipantDigest: hex(item.expectedParticipantDigest),
      committerDeviceId: item.committerDeviceId,
      namespaces: item.namespaces.map((namespace) => ({
        namespaceId: namespace.namespaceId,
        expectedAccessRevision: namespace.expectedAccessRevision,
        expectedBindingHash: hex(namespace.expectedBindingHash),
      })),
    })),
  }));
  return crypto.hash(bytes);
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

export class PostgresRecoveryFanoutAdmissionRepository {
  readonly #handle: CryptoPostgresHandle;
  readonly #crypto: LatticeCrypto;

  constructor(input: {
    readonly handle: CryptoPostgresHandle;
    readonly crypto: LatticeCrypto;
  }) {
    assertVerifiedCryptoPostgresHandle(input.handle);
    this.#handle = input.handle;
    this.#crypto = input.crypto;
  }

  admit(input: {
    readonly operationId: string;
    readonly proofBytes: Uint8Array;
    readonly admittedAt: number;
  }): Promise<RecoveryFanoutAdmissionResult> {
    portable("Recovery fanout operation id", input.operationId);
    if (!(input.proofBytes instanceof Uint8Array)) {
      throw new TypeError("Recovery fanout proof must be bytes");
    }
    const admittedAt = isoTime(input.admittedAt);
    return this.#handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`recovery-fanout/${input.operationId}`],
      );
      const current = oneOrNull(
        await transaction.query(
          `SELECT o.operation_id, o.kind AS operation_kind,
                  o.state AS operation_state,
                  o.human_id AS operation_human_id,
                  o.target_device_id, o.expected_custody_revision,
                  o.expected_recovery_generation,
                  o.expected_device_revision,
                  o.expected_participant_digest AS expected_inventory_digest,
                  o.fanout_row_count, o.aggregate_payload_bytes,
                  c.challenge_id, c.kind AS challenge_kind,
                  c.challenge_hash,
                  c.expected_response_digest
                    AS challenge_expected_response_digest,
                  c.expected_custody_revision
                    AS challenge_expected_custody_revision,
                  c.expected_recovery_generation
                    AS challenge_expected_recovery_generation,
                  c.encryption_public_key_digest
                    AS challenge_encryption_public_key_digest,
                  c.signing_public_key_digest
                    AS challenge_signing_public_key_digest,
                  c.consumed_at AS challenge_consumed_at,
                  c.invalidated_at AS challenge_invalidated_at,
                  floor(extract(epoch from c.expires_at) * 1000)::bigint
                    AS challenge_expires_at_ms,
                  d.human_id AS device_human_id,
                  d.state AS device_state, d.revision AS device_revision,
                  d.encryption_public_key AS device_encryption_public_key,
                  d.signing_public_key AS device_signing_public_key,
                  h.state AS custody_state, h.revision AS custody_revision,
                  h.current_recovery_generation
                    AS custody_recovery_generation,
                  h.current_recovery_public_key_digest
                    AS custody_recovery_public_key_digest,
                  h.current_inventory_revision
                    AS custody_inventory_revision,
                  h.current_inventory_count AS custody_inventory_count,
                  h.current_inventory_digest AS custody_inventory_digest,
                  k.recovery_key_id,
                  k.generation AS recovery_key_generation,
                  k.public_key_digest AS recovery_public_key_digest,
                  k.archive_hash AS recovery_key_archive_hash,
                  k.state AS recovery_key_state,
                  a.recovery_key_generation AS archive_generation,
                  a.archive_hash, a.archive_bytes,
                  m.message_id AS challenge_message_id,
                  m.payload_hash AS challenge_message_hash,
                  m.payload_bytes AS challenge_message_bytes,
                  e.operation_id AS admitted_operation_id,
                  e.target_device_id AS admitted_target_device_id,
                  e.owner_human_id AS admitted_owner_human_id,
                  e.source_device_id AS admitted_source_device_id,
                  e.expected_device_revision
                    AS admitted_device_revision,
                  e.expected_inventory_revision
                    AS admitted_inventory_revision,
                  e.expected_inventory_count AS admitted_inventory_count,
                  e.expected_inventory_digest AS admitted_inventory_digest,
                  e.authorization_artifact_hash
                    AS admitted_authorization_artifact_hash,
                  e.recovery_readiness_digest
                    AS admitted_recovery_readiness_digest
             FROM crypto_delivery_operations o
             JOIN human_crypto_device_challenges c
               ON c.human_id = o.human_id
              AND c.pending_device_id = o.target_device_id
              AND c.idempotency_key = o.idempotency_key
             JOIN human_crypto_devices d
               ON d.device_id = o.target_device_id
             JOIN human_crypto_custodies h ON h.human_id = o.human_id
             JOIN human_crypto_recovery_keys k
               ON k.human_id = o.human_id
              AND k.generation = o.expected_recovery_generation
             JOIN human_crypto_recovery_archives a
               ON a.human_id = h.human_id
             LEFT JOIN crypto_delivery_messages m
               ON m.operation_id = o.operation_id
              AND m.kind = 'recovery_challenge'
              AND m.recipient_device_id = o.target_device_id
             LEFT JOIN crypto_device_epoch_operations e
               ON e.operation_id = o.operation_id
            WHERE o.operation_id = $1
            LIMIT 2
            FOR UPDATE OF o, c, d, h, k, a`,
          [input.operationId],
        ),
        "Recovery fanout current-state lookup",
      );
      if (current === null) return { status: "stale_state" };
      const human = humanId(
        requiredString(current, "operation_human_id"),
      );
      const targetDevice = cryptoDeviceId(
        requiredString(current, "target_device_id"),
      );
      const challengeHash = requiredBytes(current, "challenge_hash");
      const proof = decodeRecoveryDeviceActivationProofV2(input.proofBytes);
      const admittedOperation = nullableString(
        current,
        "admitted_operation_id",
      );
      if (admittedOperation !== null) {
        const admittedInventoryRevision = requiredCounter(
          current,
          "admitted_inventory_revision",
        );
        const admittedInventoryCount = requiredCounter(
          current,
          "admitted_inventory_count",
        );
        const admittedInventoryDigest = requiredBytes(
          current,
          "admitted_inventory_digest",
        );
        const replayReadinessDigest = recoveryReadinessDigestV2(
          requiredBytes(current, "recovery_key_archive_hash"),
          {
            humanId: human,
            inventoryRevision:
              deviceTransferInventoryRevisionV2(admittedInventoryRevision),
            inventoryCount: admittedInventoryCount,
            inventoryDigest: admittedInventoryDigest,
          },
        );
        if (
          admittedOperation !== input.operationId
          || requiredString(current, "operation_kind") !== "device_recovery"
          || requiredString(current, "admitted_target_device_id")
            !== targetDevice
          || requiredString(current, "admitted_owner_human_id") !== human
          || current["admitted_source_device_id"] !== null
          || requiredCounter(current, "admitted_device_revision")
            !== requiredCounter(current, "expected_device_revision")
          || !equalBytes(
            admittedInventoryDigest,
            requiredBytes(current, "expected_inventory_digest"),
          )
          || !equalBytes(proof.challengeHash, challengeHash)
          || !equalBytes(
            requiredBytes(
              current,
              "admitted_recovery_readiness_digest",
            ),
            proof.readinessDigest,
          )
          || !equalBytes(replayReadinessDigest, proof.readinessDigest)
        ) return { status: "conflicting_state" };
        const persisted = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            domain_id: cryptoDomainTransitionSteps.domainId,
            expected_epoch: cryptoDomainTransitionSteps.expectedEpoch,
            expected_authorization_revision:
              cryptoDomainTransitionSteps.expectedAuthorizationRevision,
            expected_participant_digest:
              cryptoDomainTransitionSteps.expectedParticipantDigest,
            target_epoch: cryptoDomainTransitionSteps.targetEpoch,
            committer_device_id: cryptoDomainTransitionSteps.committerDeviceId,
            state: cryptoDomainTransitionSteps.state,
            failure_code: cryptoDomainTransitionSteps.failureCode,
          }).from(cryptoDomainTransitionSteps).where(eq(
            cryptoDomainTransitionSteps.operationId,
            input.operationId,
          )).orderBy(sql`convert_to(
            ${cryptoDomainTransitionSteps.domainId}, 'UTF8')`),
        );
        const persistedNamespaces = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            domain_id: cryptoDomainTransitionNamespaces.domainId,
            namespace_id: cryptoDomainTransitionNamespaces.namespaceId,
            expected_access_revision:
              cryptoDomainTransitionNamespaces.expectedAccessRevision,
            expected_binding_hash:
              cryptoDomainTransitionNamespaces.expectedBindingHash,
          }).from(cryptoDomainTransitionNamespaces).where(eq(
            cryptoDomainTransitionNamespaces.operationId,
            input.operationId,
          )).orderBy(sql`convert_to(
            ${cryptoDomainTransitionNamespaces.namespaceId}, 'UTF8')`),
        );
        const replayDomains: DeviceFanoutDomainPlan[] = persisted.map(
          (row) => ({
            domainId: requiredString(row, "domain_id"),
            expectedEpoch: requiredCounter(row, "expected_epoch"),
            targetEpoch: requiredCounter(row, "target_epoch"),
            expectedAuthorizationRevision: requiredCounter(
              row,
              "expected_authorization_revision",
            ),
            expectedParticipantDigest: requiredBytes(
              row,
              "expected_participant_digest",
            ),
            committerDeviceId: nullableString(
              row,
              "committer_device_id",
            ),
            namespaces: persistedNamespaces
              .filter((namespace) =>
                requiredString(namespace, "domain_id")
                  === requiredString(row, "domain_id")
              )
              .map((namespace) => ({
                namespaceId: requiredString(namespace, "namespace_id"),
                expectedAccessRevision: requiredCounter(
                  namespace,
                  "expected_access_revision",
                ),
                expectedBindingHash: requiredBytes(
                  namespace,
                  "expected_binding_hash",
                ),
              })),
          }),
        );
        const blockedDomainCount = persisted.filter((row) =>
          nullableString(row, "committer_device_id") === null
          && requiredString(row, "state") === "failed"
          && requiredString(row, "failure_code")
            === "domain_rebootstrap_required"
        ).length;
        const replayPlan: DeviceFanoutPlan = {
          formatVersion: 1,
          operationId: input.operationId,
          method: "recovery",
          humanId: human,
          targetDeviceId: targetDevice,
          expectedDeviceRevision: requiredCounter(
            current,
            "admitted_device_revision",
          ),
          expectedCustodyRevision: requiredCounter(
            current,
            "expected_custody_revision",
          ),
          expectedRecoveryGeneration: requiredCounter(
            current,
            "expected_recovery_generation",
          ),
          inventoryRevision: admittedInventoryRevision,
          inventoryCount: admittedInventoryCount,
          inventoryDigest: admittedInventoryDigest,
          authorizationArtifactHash: requiredBytes(
            current,
            "admitted_authorization_artifact_hash",
          ),
          recoveryReadinessDigest: proof.readinessDigest,
          fanoutRowCount: 1,
          aggregatePayloadBytes: 1,
          domains: replayDomains,
        };
        assertDeviceFanoutPlan(replayPlan);
        const expectedArtifactHash = recoveryAdmissionArtifactHash(
          this.#crypto,
          input.proofBytes,
          replayDomains,
        );
        if (
          persistedNamespaces.some((namespace) =>
            !persisted.some((domain) =>
              requiredString(domain, "domain_id")
                === requiredString(namespace, "domain_id")
            )
          )
          || !equalBytes(
            replayPlan.authorizationArtifactHash,
            expectedArtifactHash,
          )
        ) return { status: "conflicting_state" };
        const eventType = blockedDomainCount > 0
          ? "recovery_fanout_blocked"
          : "recovery_fanout_admitted";
        const outboxDigest = this.#crypto.hash(new Uint8Array([
          ...new TextEncoder().encode("recovery-fanout"),
          ...expectedArtifactHash,
        ]));
        const expectedPayload = new TextEncoder().encode(JSON.stringify({
          formatVersion: 1,
          eventType,
          operationId: input.operationId,
          targetDeviceId: targetDevice,
          domainCount: persisted.length,
          blockedDomainCount,
        }));
        const outbox = oneOrNull(
          await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              outbox_id: cryptoOperationOutbox.outboxId,
              event_type: cryptoOperationOutbox.eventType,
              payload_bytes: cryptoOperationOutbox.payloadBytes,
              idempotency_key: cryptoOperationOutbox.idempotencyKey,
            }).from(cryptoOperationOutbox).where(and(
              eq(cryptoOperationOutbox.operationId, input.operationId),
              eq(cryptoOperationOutbox.sequence, 1),
            )).limit(2),
          ),
          "Recovery fanout replay outbox lookup",
        );
        const outboxConflicts = outbox === null
          ? !["active", "failed", "cancelled"].includes(
            requiredString(current, "operation_state"),
          )
          : requiredString(outbox, "outbox_id")
              !== `outbox_recovery_fanout_${hex(outboxDigest)}`
            || requiredString(outbox, "event_type") !== eventType
            || requiredString(outbox, "idempotency_key")
              !== `recovery_fanout_${hex(outboxDigest)}`
            || !equalBytes(
              requiredBytes(outbox, "payload_bytes"),
              expectedPayload,
            );
        if (outboxConflicts) return { status: "conflicting_state" };
        return {
          status: "duplicate",
          domainCount: persisted.length,
          blockedDomainCount,
        };
      }
      const challengeBytes = requiredBytes(
        current,
        "challenge_message_bytes",
      );
      const deviceRevision = requiredCounter(current, "device_revision");
      const custodyRevision = requiredCounter(current, "custody_revision");
      const recoveryGeneration = requiredCounter(
        current,
        "custody_recovery_generation",
      );
      const inventoryRevision = requiredCounter(
        current,
        "custody_inventory_revision",
      );
      const inventoryCount = requiredCounter(
        current,
        "custody_inventory_count",
      );
      const inventoryDigest = requiredBytes(
        current,
        "custody_inventory_digest",
      );
      const archiveHash = requiredBytes(current, "archive_hash");
      const expectedResponseDigest = requiredBytes(
        current,
        "challenge_expected_response_digest",
      );
      const recoveryPublicKeyDigest = requiredBytes(
        current,
        "recovery_public_key_digest",
      );
      if (
        requiredString(current, "operation_kind") !== "device_recovery"
        || ![
          "awaiting_committer",
          "preparing_domain",
          "awaiting_delivery",
          "ready_to_activate",
          "failed",
        ].includes(requiredString(current, "operation_state"))
        || requiredString(current, "challenge_kind") !== "device_recovery"
        || current["challenge_consumed_at"] !== null
        || current["challenge_invalidated_at"] !== null
        || requiredCounter(current, "challenge_expires_at_ms")
          <= input.admittedAt
        || requiredString(current, "device_human_id") !== human
        || requiredString(current, "device_state") !== "pending"
        || requiredCounter(current, "expected_device_revision")
          !== deviceRevision
        || (
          requiredString(current, "custody_state") !== "active"
          && requiredString(current, "custody_state") !== "recovery_required"
        )
        || requiredCounter(current, "expected_custody_revision")
          !== custodyRevision
        || requiredCounter(current, "challenge_expected_custody_revision")
          !== custodyRevision
        || requiredCounter(current, "expected_recovery_generation")
          !== recoveryGeneration
        || requiredCounter(
          current,
          "challenge_expected_recovery_generation",
        ) !== recoveryGeneration
        || requiredCounter(current, "fanout_row_count") !== 1
        || requiredCounter(current, "aggregate_payload_bytes")
          !== challengeBytes.length
        || !equalBytes(
          requiredBytes(current, "expected_inventory_digest"),
          inventoryDigest,
        )
        || !equalBytes(
          requiredBytes(current, "challenge_encryption_public_key_digest"),
          this.#crypto.hash(
            requiredBytes(current, "device_encryption_public_key"),
          ),
        )
        || !equalBytes(
          requiredBytes(current, "challenge_signing_public_key_digest"),
          this.#crypto.hash(
            requiredBytes(current, "device_signing_public_key"),
          ),
        )
        || requiredCounter(current, "recovery_key_generation")
          !== recoveryGeneration
        || requiredString(current, "recovery_key_state") !== "current"
        || !equalBytes(
          requiredBytes(current, "custody_recovery_public_key_digest"),
          recoveryPublicKeyDigest,
        )
        || requiredCounter(current, "archive_generation")
          !== recoveryGeneration
        || !equalBytes(
          requiredBytes(current, "recovery_key_archive_hash"),
          archiveHash,
        )
        || !equalBytes(
          this.#crypto.hash(requiredBytes(current, "archive_bytes")),
          archiveHash,
        )
        || !equalBytes(
          this.#crypto.hash(challengeBytes),
          challengeHash,
        )
        || !equalBytes(
          requiredBytes(current, "challenge_message_hash"),
          challengeHash,
        )
      ) {
        return { status: "stale_state" };
      }

      const pendingDevice = Object.freeze({
        humanId: human,
        deviceId: targetDevice,
        pendingDeviceRevision: pendingDeviceRevisionV2(deviceRevision),
        encryptionPublicKey: requiredBytes(
          current,
          "device_encryption_public_key",
        ),
        signingPublicKey: requiredBytes(
          current,
          "device_signing_public_key",
        ),
      });
      const verified = verifyRecoveryDeviceActivationProof({
        challengeBytes,
        proofBytes: input.proofBytes,
        resolveTrustedChallenge: (challengeId) =>
          challengeId === requiredString(current, "challenge_id")
            ? {
              challengeId,
              challengeHash,
              expectedResponseDigest,
              expectedStatus: "pending",
            }
            : null,
        pendingDevice,
        resolveTrustedPendingDevice: (
          candidateHuman,
          candidateDevice,
        ) =>
          candidateHuman === human && candidateDevice === targetDevice
            ? {
              humanId: human,
              deviceId: targetDevice,
              pendingDeviceRevision: pendingDeviceRevisionV2(deviceRevision),
              encryptionPublicKeyDigest: this.#crypto.hash(
                pendingDevice.encryptionPublicKey,
              ),
              signingPublicKeyDigest: this.#crypto.hash(
                pendingDevice.signingPublicKey,
              ),
              status: "pending",
            }
            : null,
        resolveTrustedCurrentRecoveryKey: (candidateHuman) =>
          candidateHuman === human
            ? {
              humanId: human,
              recoveryKeyId: requiredString(current, "recovery_key_id"),
              recoveryGeneration:
                recoveryKeyGenerationV2(recoveryGeneration),
              publicKeyDigest: recoveryPublicKeyDigest,
            }
            : null,
        currentTime: unixTimestamp(input.admittedAt),
      });
      const activation = verified.activationCas;
      if (
        activation.humanId !== human
        || activation.deviceId !== targetDevice
        || Number(activation.expectedPendingDeviceRevision) !== deviceRevision
        || activation.recoveryKeyId
          !== requiredString(current, "recovery_key_id")
        || Number(activation.expectedRecoveryGeneration)
          !== recoveryGeneration
        || Number(activation.expectedInventoryRevision)
          !== inventoryRevision
        || activation.expectedInventoryCount !== inventoryCount
        || !equalBytes(activation.expectedInventoryDigest, inventoryDigest)
        || !equalBytes(activation.recoveryArchiveDigest, archiveHash)
        || !equalBytes(
          activation.expectedRecoveryPublicKeyDigest,
          recoveryPublicKeyDigest,
        )
        || !equalBytes(activation.expectedChallengeHash, challengeHash)
      ) {
        return { status: "stale_state" };
      }
      if (requiredString(current, "operation_state") !== "awaiting_committer") {
        return { status: "stale_state" };
      }

      const domainRows = await transaction.query(
        `SELECT d.id AS domain_id, d.epoch, d.authorization_revision,
                d.participant_digest, d.writes_paused,
                (
                  SELECT count(*)
                    FROM crypto_domain_devices leaves
                   WHERE leaves.domain_id = d.id
                     AND leaves.removed_at IS NULL
                )::bigint AS current_leaf_count,
                (
                  SELECT leaves.device_id
                    FROM crypto_domain_devices leaves
                    JOIN human_crypto_devices candidate
                      ON candidate.device_id = leaves.device_id
                     AND candidate.state = 'active'
                   WHERE leaves.domain_id = d.id
                     AND leaves.removed_at IS NULL
                     AND leaves.human_id = candidate.human_id
                     AND leaves.human_id = ANY(d.participants)
                   ORDER BY convert_to(leaves.device_id, 'UTF8')
                   LIMIT 1
                ) AS committer_device_id,
                (
                  SELECT leaves.human_id
                    FROM crypto_domain_devices leaves
                    JOIN human_crypto_devices candidate
                      ON candidate.device_id = leaves.device_id
                     AND candidate.state = 'active'
                   WHERE leaves.domain_id = d.id
                     AND leaves.removed_at IS NULL
                     AND leaves.human_id = candidate.human_id
                     AND leaves.human_id = ANY(d.participants)
                   ORDER BY convert_to(leaves.device_id, 'UTF8')
                   LIMIT 1
                ) AS committer_human_id,
                d.participants
           FROM crypto_domains d
          WHERE $1 = ANY(d.participants)
          ORDER BY convert_to(d.id, 'UTF8')
          FOR UPDATE OF d`,
        [human],
      );
      const predictedFanoutRows = 1 + domainRows.reduce(
        (total, row) =>
          total + requiredCounter(row, "current_leaf_count") + 1,
        0,
      );
      if (
        domainRows.length > MAX_ACTIVE_DOMAINS_PER_DEVICE
        || predictedFanoutRows
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation
        || domainRows.some((row) =>
          requiredBoolean(row, "writes_paused")
          || requiredCounter(row, "current_leaf_count") > 256
        )
      ) return { status: "stale_state" };
      const committerIds = domainRows.flatMap((row) => {
        const committer = nullableString(row, "committer_device_id");
        return committer === null ? [] : [committer];
      });
      const uniqueCommitterIds = [...new Set(committerIds)].sort();
      const committerRows = await transaction.query(
        `SELECT device_id, human_id, state
           FROM human_crypto_devices
          WHERE device_id = ANY($1::text[])
          ORDER BY convert_to(device_id, 'UTF8')
          FOR UPDATE`,
        [uniqueCommitterIds],
      );
      if (
        committerRows.length !== uniqueCommitterIds.length
        || committerRows.some((row, index) =>
          requiredString(row, "device_id") !== uniqueCommitterIds[index]
          || requiredString(row, "state") !== "active"
          || !domainRows.some((domain) =>
            nullableString(domain, "committer_device_id")
                === requiredString(row, "device_id")
            && nullableString(domain, "committer_human_id")
              === requiredString(row, "human_id")
            && requiredStringArray(domain, "participants").includes(
              requiredString(row, "human_id"),
            )
          )
        )
      ) return { status: "stale_state" };
      const namespaceRows = await transaction.query(
        `SELECT namespace_id, domain_id, domain_epoch, access_revision,
                binding_hash, writes_paused
           FROM namespace_crypto_heads
          WHERE domain_id = ANY($1::text[])
          ORDER BY convert_to(namespace_id, 'UTF8')
          FOR UPDATE`,
        [domainRows.map((row) => requiredString(row, "domain_id"))],
      );
      if (
        namespaceRows.some((row) => {
          if (requiredBoolean(row, "writes_paused")) return true;
          const domain = domainRows.find((candidate) =>
            requiredString(candidate, "domain_id")
              === requiredString(row, "domain_id")
          );
          return domain === undefined
            || requiredCounter(row, "domain_epoch")
              !== requiredCounter(domain, "epoch");
        })
        || domainRows.some((domain) =>
          namespaceRows.filter((namespace) =>
            requiredString(namespace, "domain_id")
              === requiredString(domain, "domain_id")
          ).length > MAX_NAMESPACES_PER_DOMAIN_TRANSITION
        )
      ) return { status: "stale_state" };

      const domains: DeviceFanoutDomainPlan[] = domainRows.map((row) => {
        const domainId = requiredString(row, "domain_id");
        const expectedEpoch = requiredCounter(row, "epoch");
        const namespaces = namespaceRows
          .filter((namespace) =>
            requiredString(namespace, "domain_id") === domainId
          )
          .map((namespace) => ({
            namespaceId: requiredString(namespace, "namespace_id"),
            expectedAccessRevision: requiredCounter(
              namespace,
              "access_revision",
            ),
            expectedBindingHash: requiredBytes(namespace, "binding_hash"),
          }));
        return {
          domainId,
          expectedEpoch,
          targetEpoch: expectedEpoch + 1,
          expectedAuthorizationRevision: requiredCounter(
            row,
            "authorization_revision",
          ),
          expectedParticipantDigest: requiredBytes(
            row,
            "participant_digest",
          ),
          committerDeviceId: nullableString(row, "committer_device_id"),
          namespaces,
        };
      });
      if (
        namespaceRows.length
          !== domains.reduce(
            (total, domain) => total + domain.namespaces.length,
            0,
          )
      ) return { status: "stale_state" };
      const admissionIsBlocked = domains.some(
        (domain) => domain.committerDeviceId === null,
      );
      const admittedDomains = admissionIsBlocked
        ? domains.map((domain) => ({ ...domain, namespaces: [] }))
        : domains;
      const authorizationArtifactHash = recoveryAdmissionArtifactHash(
        this.#crypto,
        input.proofBytes,
        admittedDomains,
      );
      const plan: DeviceFanoutPlan = {
        formatVersion: 1,
        operationId: input.operationId,
        method: "recovery",
        humanId: human,
        targetDeviceId: targetDevice,
        expectedDeviceRevision: deviceRevision,
        expectedCustodyRevision: custodyRevision,
        expectedRecoveryGeneration: recoveryGeneration,
        inventoryRevision,
        inventoryCount,
        inventoryDigest,
        authorizationArtifactHash,
        recoveryReadinessDigest: proof.readinessDigest,
        fanoutRowCount: 1,
        aggregatePayloadBytes: challengeBytes.length,
        domains: admittedDomains,
      };
      assertDeviceFanoutPlan(plan);
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_device_epoch_operations (
           operation_id, target_device_id, owner_human_id, source_device_id,
           expected_device_revision, expected_inventory_revision,
           expected_inventory_count, expected_inventory_digest,
           authorization_artifact_hash, recovery_readiness_digest
         ) VALUES (
           $1, $2, $3, NULL, $4, $5, $6, $7, $8, $9
         )
         RETURNING operation_id`,
        [
          plan.operationId,
          plan.targetDeviceId,
          plan.humanId,
          plan.expectedDeviceRevision,
          plan.inventoryRevision,
          plan.inventoryCount,
          plan.inventoryDigest,
          plan.authorizationArtifactHash,
          plan.recoveryReadinessDigest,
        ],
        "Recovery fanout activation-gate insert",
      );
      let blockedDomainCount = 0;
      for (const domain of plan.domains) {
        if (domain.committerDeviceId === null) blockedDomainCount++;
        const domainFailureCode = domain.committerDeviceId === null
          ? "domain_rebootstrap_required"
          : admissionIsBlocked
          ? "recovery_blocked_by_domain"
          : null;
        await expectSingleMutation(
          transaction,
          `INSERT INTO crypto_domain_transition_steps (
             operation_id, domain_id, expected_epoch,
             expected_authorization_revision, expected_participant_digest,
             target_epoch, committer_device_id, state, lease_owner,
             lease_expires_at, retry_count, failure_code, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             NULL, NULL, 0, $9, $10::timestamptz, $10::timestamptz
           )
           RETURNING operation_id`,
          [
            plan.operationId,
            domain.domainId,
            domain.expectedEpoch,
            domain.expectedAuthorizationRevision,
            domain.expectedParticipantDigest,
            domain.targetEpoch,
            domain.committerDeviceId,
            admissionIsBlocked ? "failed" : "awaiting_committer",
            domainFailureCode,
            admittedAt,
          ],
          "Recovery fanout Domain-step insert",
        );
        for (const namespace of admissionIsBlocked ? [] : domain.namespaces) {
          await expectSingleMutation(
            transaction,
            `INSERT INTO crypto_domain_transition_namespaces (
               operation_id, domain_id, namespace_id,
               expected_access_revision, expected_binding_hash,
               candidate_binding_hash, state, failure_code,
               created_at, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, NULL, $6, $7,
               $8::timestamptz, $8::timestamptz
             )
             RETURNING namespace_id`,
            [
              plan.operationId,
              domain.domainId,
              namespace.namespaceId,
              namespace.expectedAccessRevision,
              namespace.expectedBindingHash,
              "pending",
              null,
              admittedAt,
            ],
            "Recovery fanout Namespace-step insert",
          );
        }
      }
      const nextState = domains.length === 0
        ? "ready_to_activate"
        : admissionIsBlocked
        ? "failed"
        : "awaiting_committer";
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_delivery_operations
            SET state = $2, failure_code = $3,
                updated_at = $4::timestamptz,
                terminal_at = $5::timestamptz
          WHERE operation_id = $1
            AND kind = 'device_recovery'
            AND state = 'awaiting_committer'
            AND fanout_row_count = 1
            AND aggregate_payload_bytes = $6
          RETURNING operation_id`,
        [
          input.operationId,
          nextState,
          admissionIsBlocked ? "domain_rebootstrap_required" : null,
          admittedAt,
          admissionIsBlocked ? admittedAt : null,
          challengeBytes.length,
        ],
        "Recovery fanout operation admission",
      );
      const outboxPayload = new TextEncoder().encode(JSON.stringify({
        formatVersion: 1,
        eventType: admissionIsBlocked
          ? "recovery_fanout_blocked"
          : "recovery_fanout_admitted",
        operationId: input.operationId,
        targetDeviceId: targetDevice,
        domainCount: domains.length,
        blockedDomainCount,
      }));
      const outboxDigest = this.#crypto.hash(new Uint8Array([
        ...new TextEncoder().encode("recovery-fanout"),
        ...authorizationArtifactHash,
      ]));
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_operation_outbox (
           outbox_id, operation_id, sequence, event_type, payload_bytes,
           idempotency_key, claimed_by, claim_expires_at, attempts,
           maximum_attempts, delivered_at, terminal_at, failure_code,
           created_at
         ) VALUES (
           $1, $2, 1, $3, $4, $5, NULL, NULL, 0, $6,
           NULL, NULL, NULL, $7::timestamptz
         )
         RETURNING outbox_id`,
        [
          `outbox_recovery_fanout_${hex(outboxDigest)}`,
          input.operationId,
          admissionIsBlocked
            ? "recovery_fanout_blocked"
            : "recovery_fanout_admitted",
          outboxPayload,
          `recovery_fanout_${hex(outboxDigest)}`,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          admittedAt,
        ],
        "Recovery fanout outbox insert",
      );
      return {
        status: "admitted",
        domainCount: domains.length,
        blockedDomainCount,
      };
    });
  }
}
