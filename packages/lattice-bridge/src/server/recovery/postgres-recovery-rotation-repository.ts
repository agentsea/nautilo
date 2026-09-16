import {
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanRecoveryArchiveV2,
  recoveryPublicKeyDigestV2,
} from "@nautilo/lattice-crypto/wire";
import {
  normalizeRecoveryRotationSubmission,
  recoveryRotationSubmissionSigningBytes,
  verifyRecoveryRotationSubmission,
  type RecoveryRotationSubmission,
} from "../../recovery/recovery-rotation.ts";
import {
  assertVerifiedCryptoPostgresHandle,
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

const MAXIMUM_ATTEMPTS = 8;
const OPERATION_TTL_MS = 24 * 60 * 60 * 1_000;
const textEncoder = new TextEncoder();

export type RecoveryRotationResult = {
  readonly status: "rotated" | "duplicate";
  readonly humanId: string;
  readonly recoveryGeneration: number;
  readonly custodyRevision: number;
  readonly operationId: string;
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
    throw new TypeError(`Recovery rotation column ${name} must be text`);
  }
  return value;
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Recovery rotation column ${name} must be bytea`);
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
      `Recovery rotation column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function nullableCounter(row: DatabaseRow, name: string): number | null {
  return row[name] === null ? null : requiredCounter(row, name);
}

function nullableBytes(row: DatabaseRow, name: string): Uint8Array | null {
  return row[name] === null ? null : requiredBytes(row, name);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function bytesHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      "Recovery rotation timestamp must be a nonnegative safe integer",
    );
  }
  return new Date(milliseconds).toISOString();
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

function assertCurrentStateIntegrity(
  crypto: LatticeCrypto,
  row: DatabaseRow,
): void {
  const generation = requiredCounter(row, "current_recovery_generation");
  if (
    requiredString(row, "custody_state") !== "active"
    || requiredCounter(row, "recovery_key_format_version") !== 1
    || requiredString(row, "recovery_key_state") !== "current"
    || requiredCounter(row, "archive_generation") !== generation
    || !equalBytes(
      requiredBytes(row, "custody_recovery_public_key_digest"),
      requiredBytes(row, "recovery_public_key_digest"),
    )
    || !equalBytes(
      recoveryPublicKeyDigestV2(
        requiredBytes(row, "recovery_public_key"),
      ),
      requiredBytes(row, "recovery_public_key_digest"),
    )
    || !equalBytes(
      requiredBytes(row, "recovery_archive_hash"),
      requiredBytes(row, "archive_hash"),
    )
    || !equalBytes(
      crypto.hash(requiredBytes(row, "archive_bytes")),
      requiredBytes(row, "archive_hash"),
    )
  ) {
    throw new Error("Current recovery custody state is inconsistent");
  }
}

export class PostgresRecoveryRotationRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  rotate(input: {
    readonly crypto: LatticeCrypto;
    readonly submission: RecoveryRotationSubmission;
    readonly expectedHumanId: string;
    readonly rotatedAt: number;
  }): Promise<RecoveryRotationResult> {
    const expectedHumanId = humanId(input.expectedHumanId);
    const submission = normalizeRecoveryRotationSubmission(input.submission);
    const submittedArchive = decodeHumanRecoveryArchiveV2(
      submission.archiveBytes,
    );
    if (submittedArchive.humanId !== expectedHumanId) {
      throw new Error("Recovery rotation Human does not match its archive");
    }
    const submittedArchiveHash = input.crypto.hash(submission.archiveBytes);
    const { signature, ...unsignedSubmission } = submission;
    const submissionHash = input.crypto.hash(concatBytes([
      recoveryRotationSubmissionSigningBytes(
        input.crypto,
        unsignedSubmission,
      ),
      signature,
    ]));
    const token = bytesHex(submissionHash);
    const operationId = `operation_recovery_rotate_${token}`;
    const idempotencyKey = `recovery-rotate/${token}`;
    const auditRef = `audit_recovery_rotate_${token}`;
    const outboxId = `outbox_recovery_rotate_${token}`;
    const rotatedAt = isoTime(input.rotatedAt);
    const deadlineAt = isoTime(input.rotatedAt + OPERATION_TTL_MS);

    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`recovery-rotation/${expectedHumanId}`],
      );
      const existingOperation = oneOrNull(
        await transaction.query(
          `SELECT operation_id,
                  state AS operation_state,
                  human_id,
                  target_device_id,
                  expected_custody_revision,
                  expected_recovery_generation,
                  expected_device_revision,
                  expected_participant_digest,
                  aggregate_payload_bytes,
                  fanout_row_count,
                  audit_ref
             FROM crypto_delivery_operations
            WHERE operation_id = $1 OR idempotency_key = $2
            FOR UPDATE`,
          [operationId, idempotencyKey],
        ),
        "Recovery rotation operation lookup",
      );
      if (existingOperation !== null) {
        const historical = oneOrNull(
          await transaction.query(
            `SELECT recovery_key_id,
                    format_version AS recovery_key_format_version,
                    public_key AS recovery_public_key,
                    public_key_digest AS recovery_public_key_digest,
                    archive_hash AS recovery_archive_hash,
                    issuer_device_id,
                    state AS recovery_key_state
               FROM human_crypto_recovery_keys
              WHERE human_id = $1 AND generation = $2
              FOR UPDATE`,
            [
              expectedHumanId,
              submission.expectedRecoveryGeneration + 1,
            ],
          ),
          "Recovery rotation historical-key lookup",
        );
        if (
          historical === null
          || requiredString(existingOperation, "operation_id") !== operationId
          || requiredString(existingOperation, "operation_state") !== "active"
          || requiredString(existingOperation, "human_id") !== expectedHumanId
          || requiredString(existingOperation, "target_device_id")
            !== submittedArchive.issuerDeviceId
          || requiredCounter(
              existingOperation,
              "expected_custody_revision",
            ) !== submission.expectedCustodyRevision
          || requiredCounter(
              existingOperation,
              "expected_recovery_generation",
            ) !== submission.expectedRecoveryGeneration
          || requiredCounter(
              existingOperation,
              "expected_device_revision",
            ) !== submission.expectedIssuerDeviceRevision
          || !equalBytes(
            requiredBytes(
              existingOperation,
              "expected_participant_digest",
            ),
            submissionHash,
          )
          || requiredCounter(
              existingOperation,
              "aggregate_payload_bytes",
            ) !== submission.archiveBytes.length
          || requiredCounter(existingOperation, "fanout_row_count") !== 0
          || requiredString(existingOperation, "audit_ref") !== auditRef
          || requiredString(historical, "recovery_key_id")
            !== submittedArchive.recoveryKeyId
          || requiredCounter(
              historical,
              "recovery_key_format_version",
            ) !== 1
          || requiredString(historical, "issuer_device_id")
            !== submittedArchive.issuerDeviceId
          || (
            requiredString(historical, "recovery_key_state") !== "current"
            && requiredString(historical, "recovery_key_state") !== "retired"
          )
          || !equalBytes(
            requiredBytes(historical, "recovery_public_key"),
            submission.recoveryPublicKey,
          )
          || !equalBytes(
            requiredBytes(historical, "recovery_public_key_digest"),
            recoveryPublicKeyDigestV2(submission.recoveryPublicKey),
          )
          || !equalBytes(
            requiredBytes(historical, "recovery_archive_hash"),
            submittedArchiveHash,
          )
        ) {
          throw new Error("Recovery rotation replay conflicts with current state");
        }
        return {
          status: "duplicate",
          humanId: expectedHumanId,
          recoveryGeneration: submission.expectedRecoveryGeneration + 1,
          custodyRevision: submission.expectedCustodyRevision + 1,
          operationId,
        };
      }
      const current = oneOrNull(
        await transaction.query(
          `SELECT h.human_id,
                  h.state AS custody_state,
                  h.revision AS custody_revision,
                  h.current_recovery_generation,
                  h.current_recovery_public_key_digest
                    AS custody_recovery_public_key_digest,
                  h.current_inventory_revision,
                  h.current_inventory_count,
                  h.current_inventory_digest,
                  k.recovery_key_id,
                  k.format_version AS recovery_key_format_version,
                  k.public_key AS recovery_public_key,
                  k.public_key_digest AS recovery_public_key_digest,
                  k.archive_hash AS recovery_archive_hash,
                  k.state AS recovery_key_state,
                  k.revision AS recovery_key_revision,
                  a.recovery_key_generation AS archive_generation,
                  a.archive_hash,
                  a.archive_bytes,
                  d.state AS issuer_device_state,
                  d.human_id AS issuer_device_human_id,
                  d.revision AS issuer_device_revision,
                  d.signing_public_key AS issuer_signing_public_key
             FROM human_crypto_custodies h
             JOIN human_crypto_recovery_keys k
               ON k.human_id = h.human_id
              AND k.generation = h.current_recovery_generation
              AND k.state = 'current'
             JOIN human_crypto_recovery_archives a
               ON a.human_id = h.human_id
             JOIN human_crypto_devices d
               ON d.device_id = $2
            WHERE h.human_id = $1
            FOR UPDATE OF h, k, a, d`,
          [expectedHumanId, submittedArchive.issuerDeviceId],
        ),
        "Recovery rotation current-state lookup",
      );
      if (current === null) {
        throw new Error("Recovery rotation state is stale or unauthorized");
      }
      if (
        !(await humanHasOperationCapacity(transaction, expectedHumanId))
      ) {
        throw new Error(
          "Recovery rotation reached the Human operation limit",
        );
      }
      assertCurrentStateIntegrity(input.crypto, current);

      const currentGeneration = requiredCounter(
        current,
        "current_recovery_generation",
      );
      const custodyRevision = requiredCounter(current, "custody_revision");
      const currentInventoryRevision = nullableCounter(
        current,
        "current_inventory_revision",
      );
      const currentInventoryCount = nullableCounter(
        current,
        "current_inventory_count",
      );
      const currentInventoryDigest = nullableBytes(
        current,
        "current_inventory_digest",
      );
      const isInitialAttempt = currentGeneration
          === submission.expectedRecoveryGeneration
        && custodyRevision === submission.expectedCustodyRevision;
      if (!isInitialAttempt) {
        throw new Error(
          "Recovery rotation generation or custody revision is stale",
        );
      }
      if (
        currentInventoryRevision !== submission.expectedInventoryRevision
        || currentInventoryCount !== submission.expectedInventoryCount
        || (
          currentInventoryDigest === null
            ? submission.expectedInventoryDigest !== null
            : submission.expectedInventoryDigest === null
              || !equalBytes(
                currentInventoryDigest,
                submission.expectedInventoryDigest,
              )
        )
      ) {
        throw new Error("Recovery rotation inventory snapshot is stale");
      }

      const verified = verifyRecoveryRotationSubmission({
        crypto: input.crypto,
        submission,
        expectedHumanId,
        currentCustodyRevision: submission.expectedCustodyRevision,
        currentRecoveryGeneration: submission.expectedRecoveryGeneration,
        resolveActiveIssuer: (deviceId) =>
          deviceId === submittedArchive.issuerDeviceId
            && requiredString(current, "issuer_device_state") === "active"
            && requiredString(current, "issuer_device_human_id")
              === expectedHumanId
            ? {
              state: "active",
              humanId: expectedHumanId,
              revision: requiredCounter(current, "issuer_device_revision"),
              signingPublicKey: requiredBytes(
                current,
                "issuer_signing_public_key",
              ),
            }
            : null,
      });
      const liveOperations = await transaction.query(
        `SELECT operation_id
           FROM crypto_delivery_operations
          WHERE human_id = $1
            AND kind IN (
              'device_add', 'device_recovery', 'device_revoke',
              'recovery_rotate'
            )
            AND state NOT IN ('active', 'failed', 'cancelled')
          LIMIT 2
          FOR UPDATE`,
        [expectedHumanId],
      );
      if (liveOperations.length !== 0) {
        throw new Error(
          "Recovery rotation conflicts with a live device-roster operation",
        );
      }
      const recoveryKeyCollisions = await transaction.query(
        `SELECT human_id, generation
           FROM human_crypto_recovery_keys
          WHERE recovery_key_id = $1
             OR (human_id = $2 AND public_key_digest = $3)
          LIMIT 2
          FOR UPDATE`,
        [
          verified.recoveryKeyId,
          expectedHumanId,
          verified.recoveryPublicKeyDigest,
        ],
      );
      if (recoveryKeyCollisions.length !== 0) {
        throw new Error("Recovery rotation key material was already used");
      }
      if (input.rotatedAt < verified.createdAt) {
        throw new Error("Recovery rotation predates its signed archive");
      }

      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_recovery_keys
            SET state = 'retired', retired_at = $4, revision = revision + 1
          WHERE human_id = $1 AND generation = $2
            AND state = 'current' AND revision = $3
          RETURNING human_id`,
        [
          expectedHumanId,
          submission.expectedRecoveryGeneration,
          requiredCounter(current, "recovery_key_revision"),
          rotatedAt,
        ],
        "Current recovery-key retirement",
      );
      await expectSingleMutation(
        transaction,
        `INSERT INTO human_crypto_recovery_keys (
           human_id, generation, recovery_key_id, format_version,
           public_key, public_key_digest, archive_hash, issuer_device_id,
           state, activated_at, retired_at, revision
         ) VALUES (
           $1, $2, $3, 1, $4, $5, $6, $7,
           'current', $8, NULL, 1
         )
         RETURNING human_id`,
        [
          expectedHumanId,
          verified.recoveryGeneration,
          verified.recoveryKeyId,
          verified.recoveryPublicKey,
          verified.recoveryPublicKeyDigest,
          verified.archiveHash,
          verified.issuerDeviceId,
          rotatedAt,
        ],
        "Next recovery-key publication",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_recovery_archives
            SET recovery_key_generation = $2,
                archive_hash = $3,
                archive_bytes = $4
          WHERE human_id = $1
            AND recovery_key_generation = $5
            AND archive_hash = $6
          RETURNING human_id`,
        [
          expectedHumanId,
          verified.recoveryGeneration,
          verified.archiveHash,
          verified.archiveBytes,
          submission.expectedRecoveryGeneration,
          requiredBytes(current, "archive_hash"),
        ],
        "Recovery archive publication",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_custodies
            SET current_recovery_generation = $2,
                current_recovery_public_key_digest = $3,
                revision = revision + 1,
                last_transition_audit_ref = $4,
                updated_at = $5
          WHERE human_id = $1
            AND state = 'active'
            AND revision = $6
            AND current_recovery_generation = $7
            AND current_recovery_public_key_digest = $8
          RETURNING human_id`,
        [
          expectedHumanId,
          verified.recoveryGeneration,
          verified.recoveryPublicKeyDigest,
          auditRef,
          rotatedAt,
          submission.expectedCustodyRevision,
          submission.expectedRecoveryGeneration,
          requiredBytes(
            current,
            "custody_recovery_public_key_digest",
          ),
        ],
        "Recovery custody publication",
      );
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_delivery_operations (
           operation_id, idempotency_key, kind, state, human_id,
           target_human_id, target_device_id, expected_custody_revision,
           expected_recovery_generation, expected_device_revision,
           expected_participant_digest, aggregate_payload_bytes,
           fanout_row_count, lease_owner, lease_expires_at,
           retry_count, maximum_attempts, failure_code, audit_ref,
           created_at, updated_at, deadline_at, terminal_at
         ) VALUES (
           $1, $2, 'recovery_rotate', 'active', $3,
           NULL, $4, $5, $6, $7, $8, $9, 0, NULL, NULL,
           0, $10, NULL, $11, $12, $12, $13, $12
         )
         RETURNING operation_id`,
        [
          operationId,
          idempotencyKey,
          expectedHumanId,
          verified.issuerDeviceId,
          submission.expectedCustodyRevision,
          submission.expectedRecoveryGeneration,
          submission.expectedIssuerDeviceRevision,
          submissionHash,
          submission.archiveBytes.length,
          MAXIMUM_ATTEMPTS,
          auditRef,
          rotatedAt,
          deadlineAt,
        ],
        "Recovery rotation operation publication",
      );
      const outboxPayload = textEncoder.encode(JSON.stringify({
        formatVersion: 1,
        eventType: "recovery_rotated",
        humanId: expectedHumanId,
        recoveryGeneration: verified.recoveryGeneration,
        auditRef,
      }));
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_operation_outbox (
           outbox_id, operation_id, sequence, event_type, payload_bytes,
           idempotency_key, claimed_by, claim_expires_at, attempts,
           maximum_attempts, delivered_at, terminal_at, failure_code,
           created_at
         ) VALUES (
           $1, $2, 0, 'recovery_rotated', $3, $4,
           NULL, NULL, 0, $5, NULL, NULL, NULL, $6
         )
         RETURNING outbox_id`,
        [
          outboxId,
          operationId,
          outboxPayload,
          `recovery-rotated/${token}`,
          MAXIMUM_ATTEMPTS,
          rotatedAt,
        ],
        "Recovery rotation outbox publication",
      );
      return {
        status: "rotated",
        humanId: expectedHumanId,
        recoveryGeneration: verified.recoveryGeneration,
        custodyRevision: submission.expectedCustodyRevision + 1,
        operationId,
      };
    });
  }
}
