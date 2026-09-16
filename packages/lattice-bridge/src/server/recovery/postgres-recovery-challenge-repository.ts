import {
  cryptoDeviceId,
  humanId,
  prepareRecoveryDeviceActivationChallenge,
  prepareRecoveryDevicePossessionChallenge,
  unixTimestamp,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  deviceTransferInventoryDigestV2,
  deviceTransferInventoryRevisionV2,
  pendingDeviceRevisionV2,
  recoveryKeyGenerationV2,
  recoveryPublicKeyDigestV2,
} from "@nautilo/lattice-crypto/wire";
import { and, cryptoDeliveryMessages, eq, sql } from "@nautilo/db";
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
  reserveRecipientDeliverySequences,
} from "../delivery/postgres-recipient-delivery-sequence.ts";

const MAXIMUM_ATTEMPTS = 8;
const textEncoder = new TextEncoder();

export type RecoveryChallengePublicationResult = {
  readonly status: "published" | "duplicate";
  readonly operationId: string;
  readonly challengeId: string;
  readonly challengeBytes: Uint8Array;
  readonly expiresAt: number;
};

function oneOrNull(
  rows: readonly DatabaseRow[],
  label: string,
): DatabaseRow | null {
  if (rows.length > 1) {
    throw new Error(`${label} returned duplicate rows`);
  }
  return rows[0] ?? null;
}

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Recovery challenge column ${name} must be text`);
  }
  return value;
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Recovery challenge column ${name} must be bytea`);
  }
  return value;
}

function nullableBytes(row: DatabaseRow, name: string): Uint8Array | null {
  return row[name] === null ? null : requiredBytes(row, name);
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
      `Recovery challenge column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      "Recovery challenge timestamp must be nonnegative",
    );
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

export class PostgresRecoveryChallengeRepository {
  readonly #handle: CryptoPostgresHandle;
  readonly #crypto: LatticeCrypto;
  readonly #purpose: "inventory_activation" | "mls_rebootstrap_possession";

  constructor(input: {
    readonly handle: CryptoPostgresHandle;
    readonly crypto: LatticeCrypto;
    readonly purpose?: "inventory_activation" | "mls_rebootstrap_possession";
  }) {
    assertVerifiedCryptoPostgresHandle(input.handle);
    this.#handle = input.handle;
    this.#crypto = input.crypto;
    this.#purpose = input.purpose ?? "inventory_activation";
  }

  publish(input: {
    readonly operationId: string;
    readonly publishedAt: number;
  }): Promise<RecoveryChallengePublicationResult> {
    portable("Recovery challenge operation id", input.operationId);
    const publishedAt = isoTime(input.publishedAt);
    return this.#handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`recovery-challenge/${input.operationId}`],
      );
      const current = oneOrNull(
        await transaction.query(
          `SELECT o.operation_id,
                  o.kind AS operation_kind,
                  o.state AS operation_state,
                  o.human_id AS operation_human_id,
                  o.target_device_id,
                  o.expected_custody_revision
                    AS operation_expected_custody_revision,
                  o.expected_recovery_generation
                    AS operation_expected_recovery_generation,
                  o.expected_device_revision
                    AS operation_expected_device_revision,
                  o.expected_participant_digest
                    AS operation_participant_digest,
                  o.fanout_row_count AS operation_fanout_row_count,
                  o.aggregate_payload_bytes
                    AS operation_aggregate_payload_bytes,
                  c.challenge_id,
                  c.kind AS challenge_kind,
                  c.challenge_hash,
                  c.expected_response_digest
                    AS challenge_expected_response_digest,
                  c.expected_custody_revision
                    AS challenge_expected_custody_revision,
                  c.expected_recovery_generation
                    AS challenge_expected_recovery_generation,
                  c.signing_public_key_digest
                    AS challenge_signing_public_key_digest,
                  c.encryption_public_key_digest
                    AS challenge_encryption_public_key_digest,
                  c.consumed_at AS challenge_consumed_at,
                  c.invalidated_at AS challenge_invalidated_at,
                  c.revision AS challenge_revision,
                  floor(extract(epoch from c.issued_at) * 1000)::bigint
                    AS challenge_issued_at_ms,
                  floor(extract(epoch from c.expires_at) * 1000)::bigint
                    AS challenge_expires_at_ms,
                  d.human_id AS device_human_id,
                  d.state AS device_state,
                  d.revision AS device_revision,
                  d.signing_public_key AS device_signing_public_key,
                  d.encryption_public_key AS device_encryption_public_key,
                  h.state AS custody_state,
                  h.revision AS custody_revision,
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
                  k.public_key AS recovery_public_key,
                  k.public_key_digest AS recovery_public_key_digest,
                  k.archive_hash AS recovery_key_archive_hash,
                  k.state AS recovery_key_state,
                  a.recovery_key_generation AS archive_generation,
                  a.archive_hash,
                  a.archive_bytes
             FROM crypto_delivery_operations o
             JOIN human_crypto_device_challenges c
               ON c.pending_device_id = o.target_device_id
              AND c.idempotency_key = o.idempotency_key
             JOIN human_crypto_devices d
               ON d.device_id = o.target_device_id
             JOIN human_crypto_custodies h ON h.human_id = o.human_id
             JOIN human_crypto_recovery_keys k
               ON k.human_id = h.human_id
              AND k.generation = h.current_recovery_generation
              AND k.state = 'current'
             JOIN human_crypto_recovery_archives a
               ON a.human_id = h.human_id
            WHERE o.operation_id = $1
            LIMIT 2
            FOR UPDATE OF o, c, d, h, k, a`,
          [input.operationId],
        ),
        "Recovery challenge current-state lookup",
      );
      if (current === null) {
        throw new Error("Recovery challenge operation is stale");
      }
      const expectedResponseDigest = nullableBytes(
        current,
        "challenge_expected_response_digest",
      );
      if (expectedResponseDigest !== null) {
        const messages = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            message_id: cryptoDeliveryMessages.messageId,
            payload_hash: cryptoDeliveryMessages.payloadHash,
            payload_bytes: cryptoDeliveryMessages.payloadBytes,
            expires_at_ms: sql<number>`floor(extract(epoch from
              ${cryptoDeliveryMessages.expiresAt}) * 1000)::bigint`
              .as("expires_at_ms"),
          }).from(cryptoDeliveryMessages).where(and(
            eq(cryptoDeliveryMessages.operationId, input.operationId),
            eq(cryptoDeliveryMessages.kind, "recovery_challenge"),
            eq(
              cryptoDeliveryMessages.recipientDeviceId,
              requiredString(current, "target_device_id"),
            ),
          )).limit(2),
        );
        const message = oneOrNull(
          messages,
          "Recovery challenge replay-message lookup",
        );
        if (
          message === null
          || requiredString(current, "operation_state") !== "awaiting_committer"
          || requiredCounter(current, "operation_fanout_row_count") !== 1
          || requiredCounter(current, "operation_aggregate_payload_bytes")
            !== requiredBytes(message, "payload_bytes").length
          || !equalBytes(
            requiredBytes(current, "challenge_hash"),
            requiredBytes(message, "payload_hash"),
          )
          || !equalBytes(
            this.#crypto.hash(requiredBytes(message, "payload_bytes")),
            requiredBytes(message, "payload_hash"),
          )
        ) {
          throw new Error(
            "Recovery challenge replay conflicts with durable state",
          );
        }
        return {
          status: "duplicate",
          operationId: input.operationId,
          challengeId: requiredString(current, "challenge_id"),
          challengeBytes: Uint8Array.from(
            requiredBytes(message, "payload_bytes"),
          ),
          expiresAt: requiredCounter(message, "expires_at_ms"),
        };
      }

      const human = humanId(requiredString(current, "operation_human_id"));
      const targetDevice = cryptoDeviceId(
        requiredString(current, "target_device_id"),
      );
      const deviceRevision = requiredCounter(current, "device_revision");
      const custodyRevision = requiredCounter(current, "custody_revision");
      const recoveryGeneration = requiredCounter(
        current,
        "custody_recovery_generation",
      );
      const rawInventoryRevision = current["custody_inventory_revision"];
      const rawInventoryCount = current["custody_inventory_count"];
      const rawInventoryDigest = current["custody_inventory_digest"];
      const inventoryIsEmpty = rawInventoryRevision === null
        && rawInventoryCount === null
        && rawInventoryDigest === null;
      if (!inventoryIsEmpty && (
        rawInventoryRevision === null
        || rawInventoryCount === null
        || rawInventoryDigest === null
      )) {
        throw new Error("Recovery challenge inventory commitment is partial");
      }
      const inventoryRevision = inventoryIsEmpty
        ? 0
        : requiredCounter(current, "custody_inventory_revision");
      const inventoryCount = inventoryIsEmpty
        ? 0
        : requiredCounter(current, "custody_inventory_count");
      const inventoryDigest = inventoryIsEmpty
        ? deviceTransferInventoryDigestV2({
          humanId: human,
          inventoryRevision: deviceTransferInventoryRevisionV2(0),
          inventory: Object.freeze([]),
        })
        : requiredBytes(current, "custody_inventory_digest");
      const recoveryPublicKey = requiredBytes(
        current,
        "recovery_public_key",
      );
      const recoveryPublicKeyDigest = requiredBytes(
        current,
        "recovery_public_key_digest",
      );
      const archiveHash = requiredBytes(current, "archive_hash");
      const issuedAt = requiredCounter(current, "challenge_issued_at_ms");
      const expiresAt = requiredCounter(current, "challenge_expires_at_ms");
      if (
        requiredString(current, "operation_kind") !== "device_recovery"
        || requiredString(current, "operation_state")
          !== "awaiting_target_device"
        || requiredString(current, "challenge_kind") !== "device_recovery"
        || current["challenge_consumed_at"] !== null
        || current["challenge_invalidated_at"] !== null
        || requiredCounter(current, "challenge_revision") !== 0
        || !equalBytes(
          requiredBytes(current, "challenge_hash"),
          this.#crypto.hash(textEncoder.encode(
            requiredString(current, "challenge_id"),
          )),
        )
        || requiredString(current, "device_human_id") !== human
        || requiredString(current, "device_state") !== "pending"
        || deviceRevision !== 0
        || (
          requiredString(current, "custody_state") !== "active"
          && requiredString(current, "custody_state") !== "recovery_required"
        )
        || requiredCounter(
          current,
          "operation_expected_custody_revision",
        ) !== custodyRevision
        || requiredCounter(
          current,
          "challenge_expected_custody_revision",
        ) !== custodyRevision
        || requiredCounter(
          current,
          "operation_expected_recovery_generation",
        ) !== recoveryGeneration
        || requiredCounter(
          current,
          "challenge_expected_recovery_generation",
        ) !== recoveryGeneration
        || requiredCounter(
          current,
          "operation_expected_device_revision",
        ) !== deviceRevision
        || requiredCounter(current, "operation_fanout_row_count") !== 0
        || requiredCounter(
          current,
          "operation_aggregate_payload_bytes",
        ) !== 0
        || !equalBytes(
          requiredBytes(current, "operation_participant_digest"),
          inventoryDigest,
        )
        || !equalBytes(
          requiredBytes(current, "challenge_signing_public_key_digest"),
          this.#crypto.hash(
            requiredBytes(current, "device_signing_public_key"),
          ),
        )
        || !equalBytes(
          requiredBytes(current, "challenge_encryption_public_key_digest"),
          this.#crypto.hash(
            requiredBytes(current, "device_encryption_public_key"),
          ),
        )
        || requiredCounter(current, "recovery_key_generation")
          !== recoveryGeneration
        || requiredString(current, "recovery_key_state") !== "current"
        || !equalBytes(
          recoveryPublicKeyDigestV2(recoveryPublicKey),
          recoveryPublicKeyDigest,
        )
        || !equalBytes(
          requiredBytes(
            current,
            "custody_recovery_public_key_digest",
          ),
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
      ) {
        throw new Error("Recovery challenge state is stale");
      }
      if (input.publishedAt < issuedAt || input.publishedAt >= expiresAt) {
        throw new Error("Recovery challenge is expired");
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
      const prepareChallenge = this.#purpose === "mls_rebootstrap_possession"
        ? prepareRecoveryDevicePossessionChallenge
        : prepareRecoveryDeviceActivationChallenge;
      const prepared = await prepareChallenge({
        crypto: this.#crypto,
        challengeId: requiredString(current, "challenge_id"),
        pendingDevice,
        resolveTrustedPendingDevice: (candidateHuman, candidateDevice) =>
          candidateHuman === human && candidateDevice === targetDevice
            ? {
              humanId: human,
              deviceId: targetDevice,
              pendingDeviceRevision:
                pendingDeviceRevisionV2(deviceRevision),
              encryptionPublicKeyDigest: this.#crypto.hash(
                pendingDevice.encryptionPublicKey,
              ),
              signingPublicKeyDigest: this.#crypto.hash(
                pendingDevice.signingPublicKey,
              ),
              status: "pending",
            }
            : null,
        recoveryKeyId: requiredString(current, "recovery_key_id"),
        recoveryGeneration:
          recoveryKeyGenerationV2(recoveryGeneration),
        recoveryPublicKey,
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
        recoveryArchiveDigest: archiveHash,
        inventoryRevision:
          deviceTransferInventoryRevisionV2(inventoryRevision),
        resolveTrustedInventoryCommitment: (candidateHuman) =>
          candidateHuman === human
            ? {
              humanId: human,
              inventoryRevision:
                deviceTransferInventoryRevisionV2(inventoryRevision),
              inventoryCount,
              inventoryDigest,
            }
            : null,
        issuedAt: unixTimestamp(issuedAt),
        expiresAt: unixTimestamp(expiresAt),
      });
      const challengeHash = this.#crypto.hash(prepared.challengeBytes);
      if (
        !equalBytes(
          challengeHash,
          prepared.publicationCas.intendedChallengeHash,
        )
      ) {
        throw new Error("Recovery challenge core hash is inconsistent");
      }
      const token = hex(challengeHash);
      const messageId = `recovery_challenge_${token}`;
      const outboxId = `outbox_recovery_challenge_${token}`;
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_device_challenges
            SET challenge_hash = $2,
                expected_response_digest = $3,
                revision = revision + 1
          WHERE challenge_id = $1
            AND kind = 'device_recovery'
            AND expected_response_digest IS NULL
            AND consumed_at IS NULL
            AND invalidated_at IS NULL
            AND revision = 0
          RETURNING challenge_id`,
        [
          prepared.publicationCas.challengeId,
          challengeHash,
          prepared.verifier.expectedResponseDigest,
        ],
        "Recovery challenge verifier publication",
      );
      const [recipientSequence] =
        await reserveRecipientDeliverySequences(
          transaction,
          [targetDevice],
          input.publishedAt,
        );
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_delivery_messages (
           message_id, operation_id, domain_id, domain_sequence,
           recipient_sequence, kind, recipient_device_id, format_version,
           payload_hash, payload_bytes, created_at, expires_at
         ) VALUES (
           $1, $2, NULL, NULL, $3, 'recovery_challenge',
           $4, 2, $5, $6, $7, $8
         )
         RETURNING message_id`,
        [
          messageId,
          input.operationId,
          recipientSequence!,
          targetDevice,
          challengeHash,
          prepared.challengeBytes,
          publishedAt,
          isoTime(expiresAt),
        ],
        "Recovery challenge delivery publication",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_delivery_operations
            SET state = 'awaiting_committer',
                fanout_row_count = 1,
                aggregate_payload_bytes = $2,
                updated_at = $3
          WHERE operation_id = $1
            AND kind = 'device_recovery'
            AND state = 'awaiting_target_device'
            AND fanout_row_count = 0
            AND aggregate_payload_bytes = 0
          RETURNING operation_id`,
        [
          input.operationId,
          prepared.challengeBytes.length,
          publishedAt,
        ],
        "Recovery challenge operation publication",
      );
      const outboxPayload = textEncoder.encode(JSON.stringify({
        formatVersion: 1,
        eventType: "recovery_challenge_published",
        operationId: input.operationId,
        targetDeviceId: targetDevice,
        challengeId: prepared.publicationCas.challengeId,
      }));
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_operation_outbox (
           outbox_id, operation_id, sequence, event_type, payload_bytes,
           idempotency_key, claimed_by, claim_expires_at, attempts,
           maximum_attempts, delivered_at, terminal_at, failure_code,
           created_at
         ) VALUES (
           $1, $2, 0, 'recovery_challenge_published', $3, $4,
           NULL, NULL, 0, $5, NULL, NULL, NULL, $6
         )
         RETURNING outbox_id`,
        [
          outboxId,
          input.operationId,
          outboxPayload,
          `recovery-challenge/${token}`,
          MAXIMUM_ATTEMPTS,
          publishedAt,
        ],
        "Recovery challenge outbox publication",
      );
      return {
        status: "published",
        operationId: input.operationId,
        challengeId: prepared.publicationCas.challengeId,
        challengeBytes: Uint8Array.from(prepared.challengeBytes),
        expiresAt,
      };
    });
  }
}
