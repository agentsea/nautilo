import { createHash } from "node:crypto";
import { CRYPTO_DELIVERY_COLLECTION_LIMITS } from "@nautilo/db";
import {
  assertVerifiedHumanMembershipTransition,
  type HumanMembershipTransition,
} from "../../delivery/human-membership-transition.ts";
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
  allHumansHaveOperationCapacity,
} from "./postgres-human-operation-capacity.ts";

const OPERATION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const textEncoder = new TextEncoder();

export type HumanMembershipAdmissionResult =
  | {
    readonly status: "admitted";
    readonly state:
      | "awaiting_target_device"
      | "preparing_domain"
      | "awaiting_committer";
  }
  | {
    readonly status: "duplicate";
    readonly state:
      | "awaiting_target_device"
      | "awaiting_committer"
      | "preparing_domain"
      | "awaiting_delivery"
      | "ready_to_activate"
      | "activating"
      | "active"
      | "failed"
      | "cancelled";
  }
  | {
    readonly status:
      | "stale_state"
      | "conflicting_state"
      | "operation_limit_reached";
  };

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Human membership column ${name} must be text`);
  }
  return value;
}

function nullableString(row: DatabaseRow, name: string): string | null {
  return row[name] === null ? null : requiredString(row, name);
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Human membership column ${name} must be bytea`);
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
    throw new TypeError(`Human membership column ${name} must be a counter`);
  }
  return normalized;
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Human membership column ${name} must be boolean`);
  }
  return value;
}

function requiredStringArray(
  row: DatabaseRow,
  name: string,
): readonly string[] {
  const value = row[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`Human membership column ${name} must be text[]`);
  }
  return value as readonly string[];
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Human membership time must be nonnegative");
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

function replayMatches(
  row: DatabaseRow,
  transition: HumanMembershipTransition,
): boolean {
  const state = requiredString(row, "state");
  return requiredString(row, "operation_id") === transition.operationId
    && requiredString(row, "idempotency_key") === transition.idempotencyKey
    && requiredString(row, "kind") === transition.kind
    && [
      "awaiting_target_device",
      "awaiting_committer",
      "preparing_domain",
      "awaiting_delivery",
      "ready_to_activate",
      "activating",
      "active",
      "failed",
      "cancelled",
    ].includes(state)
    && requiredString(row, "namespace_id") === transition.namespaceId
    && requiredString(row, "room_id") === transition.roomId
    && requiredString(row, "target_human_actor_id")
      === transition.targetHumanActorId
    && nullableString(row, "admitted_bootstrap_device_id")
      === transition.bootstrapDeviceId
    && sameStrings(
      requiredStringArray(row, "old_participants"),
      transition.oldParticipants,
    )
    && equalBytes(
      requiredBytes(row, "old_participant_digest"),
      transition.oldParticipantDigest,
    )
    && sameStrings(
      requiredStringArray(row, "new_participants"),
      transition.newParticipants,
    )
    && equalBytes(
      requiredBytes(row, "new_participant_digest"),
      transition.newParticipantDigest,
    )
    && requiredString(row, "old_domain_id") === transition.oldDomainId
    && nullableString(row, "admitted_target_domain_id")
      === transition.targetDomainId
    && nullableString(row, "target_room_role") === transition.targetRoomRole
    && requiredCounter(row, "expected_access_revision")
      === transition.expectedAccessRevision
    && equalBytes(
      requiredBytes(row, "expected_binding_hash"),
      transition.expectedBindingHash,
    );
}

export class PostgresHumanMembershipAdmissionRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  admit(
    transition: HumanMembershipTransition,
    requestedAt: number,
  ): Promise<HumanMembershipAdmissionResult> {
    assertVerifiedHumanMembershipTransition(transition);
    const createdAt = isoTime(requestedAt);
    const deadlineAt = isoTime(requestedAt + OPERATION_TTL_MS);
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`initial-bootstrap/${transition.targetHumanActorId}`],
      );
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [transition.namespaceId],
      );
      const prior = await transaction.query(
        `SELECT o.operation_id, o.idempotency_key, o.kind, o.state,
                h.namespace_id, h.room_id,
                h.target_human_actor_id::text AS target_human_actor_id,
                h.admitted_bootstrap_device_id,
                h.admitted_target_domain_id,
                h.target_room_role,
                h.old_participants,
                h.old_participant_digest, h.new_participants,
                h.new_participant_digest, h.old_domain_id,
                h.target_domain_id, h.expected_access_revision,
                h.expected_binding_hash
           FROM crypto_delivery_operations o
           JOIN crypto_human_membership_transitions h
             ON h.operation_id = o.operation_id
          WHERE o.operation_id = $1 OR o.idempotency_key = $2
          ORDER BY convert_to(o.operation_id, 'UTF8')
          LIMIT 2
          FOR UPDATE OF o, h`,
        [transition.operationId, transition.idempotencyKey],
      );
      if (prior.length > 1) return { status: "conflicting_state" };
      if (prior.length === 1) {
        if (!replayMatches(prior[0]!, transition)) {
          return { status: "conflicting_state" };
        }
        return {
          status: "duplicate",
          state: requiredString(prior[0]!, "state") as
            | "awaiting_target_device"
            | "awaiting_committer"
            | "preparing_domain"
            | "awaiting_delivery"
            | "ready_to_activate"
            | "activating"
            | "active"
            | "failed"
            | "cancelled",
        };
      }
      if (
        !(await allHumansHaveOperationCapacity(transaction, [
          ...transition.oldParticipants,
          ...transition.newParticipants,
        ]))
      ) {
        return { status: "operation_limit_reached" };
      }

      const rows = await transaction.query(
        `SELECT a.kind AS actor_kind,
                h.namespace_id AS head_namespace_id,
                h.access_revision AS head_access_revision,
                h.binding_hash AS head_binding_hash,
                h.domain_id AS head_domain_id,
                h.domain_epoch AS head_domain_epoch,
                h.writes_paused AS head_writes_paused,
                h.pause_operation_id AS head_pause_operation_id,
                old.participants AS old_participants,
                old.participant_digest AS old_participant_digest,
                old.writes_paused AS old_writes_paused,
                d.device_id AS bootstrap_device_id,
                d.state AS bootstrap_device_state,
                d.human_id AS bootstrap_human_id,
                d.human_actor_id::text AS bootstrap_human_actor_id,
                c.human_id AS custody_human_id,
                c.state AS custody_state,
                c.current_recovery_generation,
                r.state AS recovery_key_state
           FROM namespace_crypto_heads h
           JOIN crypto_domains old ON old.id = h.domain_id
           JOIN actors a ON a.id = $3::uuid
           LEFT JOIN human_crypto_custodies c
             ON c.human_actor_id = a.id
           LEFT JOIN human_crypto_devices d
             ON d.device_id = $4 AND d.human_id = c.human_id
           LEFT JOIN human_crypto_recovery_keys r
             ON r.human_id = c.human_id
            AND r.generation = c.current_recovery_generation
          WHERE h.namespace_id = $1 AND old.id = $2
          LIMIT 2
          FOR UPDATE OF h, old`,
        [
          transition.namespaceId,
          transition.oldDomainId,
          transition.targetHumanActorId,
          transition.bootstrapDeviceId,
        ],
      );
      if (rows.length !== 1) return { status: "stale_state" };
      const row = rows[0]!;
      if (
        requiredString(row, "actor_kind") !== "user"
        || requiredString(row, "head_namespace_id") !== transition.namespaceId
        || requiredCounter(row, "head_access_revision")
          !== transition.expectedAccessRevision
        || !equalBytes(
          requiredBytes(row, "head_binding_hash"),
          transition.expectedBindingHash,
        )
        || requiredString(row, "head_domain_id") !== transition.oldDomainId
        || requiredBoolean(row, "head_writes_paused")
        || row["head_pause_operation_id"] !== null
        || !sameStrings(
          requiredStringArray(row, "old_participants"),
          transition.oldParticipants,
        )
        || !equalBytes(
          requiredBytes(row, "old_participant_digest"),
          transition.oldParticipantDigest,
        )
        || requiredBoolean(row, "old_writes_paused")
      ) return { status: "stale_state" };

      if (transition.targetDomainId !== null) {
        const targetRows = await transaction.query(
          `SELECT id, participants, participant_digest, epoch, writes_paused
             FROM crypto_domains
            WHERE id = $1
            LIMIT 2
            FOR UPDATE`,
          [transition.targetDomainId],
        );
        if (targetRows.length !== 1) return { status: "stale_state" };
        const target = targetRows[0]!;
        if (
          !sameStrings(
            requiredStringArray(target, "participants"),
            transition.newParticipants,
          )
          || !equalBytes(
            requiredBytes(target, "participant_digest"),
            transition.newParticipantDigest,
          )
          || requiredBoolean(target, "writes_paused")
        ) return { status: "stale_state" };
      }

      const targetDeviceReady = transition.kind === "human_remove"
        || (
          transition.bootstrapDeviceId !== null
          && nullableString(row, "bootstrap_device_id")
            === transition.bootstrapDeviceId
          && nullableString(row, "bootstrap_device_state") === "active"
          && nullableString(row, "bootstrap_human_actor_id")
            === transition.targetHumanActorId
          && nullableString(row, "custody_state") === "active"
          && row["current_recovery_generation"] !== null
          && nullableString(row, "recovery_key_state") === "current"
        );
      if (
        transition.kind === "human_add"
        && transition.bootstrapDeviceId === null
        && nullableString(row, "custody_state") === "active"
      ) return { status: "stale_state" };
      const state = !targetDeviceReady
        ? "awaiting_target_device"
        : transition.targetDomainId === null
        ? "preparing_domain"
        : "awaiting_committer";
      const targetHumanId = nullableString(row, "custody_human_id");
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
           $1, $2, $3, $4, NULL, $5, $6, NULL, NULL, NULL, $7,
           0, 0, NULL, NULL, 0, $8, NULL, NULL,
           $9::timestamptz, $9::timestamptz, $10::timestamptz, NULL
         )
         RETURNING operation_id`,
        [
          transition.operationId,
          transition.idempotencyKey,
          transition.kind,
          state,
          targetHumanId,
          transition.bootstrapDeviceId,
          transition.newParticipantDigest,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          createdAt,
          deadlineAt,
        ],
        "Human membership operation insert",
      );
      await expectSingleMutation(
        transaction,
         `INSERT INTO crypto_human_membership_transitions (
           operation_id, namespace_id, room_id, target_human_actor_id,
           admitted_bootstrap_device_id, bootstrap_device_id,
           old_participants, old_participant_digest,
           new_participants, new_participant_digest, old_domain_id,
           admitted_target_domain_id, target_domain_id,
           target_room_role, expected_access_revision, expected_binding_hash
         ) VALUES (
           $1, $2, $3, $4::uuid, $5, $5, $6::text[], $7, $8::text[], $9,
           $10, $11, $11, $12, $13, $14
         )
         RETURNING operation_id`,
        [
          transition.operationId,
          transition.namespaceId,
          transition.roomId,
          transition.targetHumanActorId,
          transition.bootstrapDeviceId,
          transition.oldParticipants,
          transition.oldParticipantDigest,
          transition.newParticipants,
          transition.newParticipantDigest,
          transition.oldDomainId,
          transition.targetDomainId,
          transition.targetRoomRole,
          transition.expectedAccessRevision,
          transition.expectedBindingHash,
        ],
        "Human membership transition insert",
      );
      if (transition.kind === "human_remove") {
        await expectSingleMutation(
          transaction,
          `UPDATE namespace_crypto_heads
              SET writes_paused = TRUE, pause_operation_id = $2
            WHERE namespace_id = $1
              AND access_revision = $3 AND binding_hash = $4
              AND domain_id = $5 AND writes_paused = FALSE
              AND pause_operation_id IS NULL
          RETURNING namespace_id`,
          [
            transition.namespaceId,
            transition.operationId,
            transition.expectedAccessRevision,
            transition.expectedBindingHash,
            transition.oldDomainId,
          ],
          "Human removal Namespace pause",
        );
      }
      const payload = textEncoder.encode(JSON.stringify({
        formatVersion: 1,
        eventType: "crypto_human_membership_started",
        operationId: transition.operationId,
        kind: transition.kind,
        roomId: transition.roomId,
        namespaceId: transition.namespaceId,
        state,
      }));
      const token = createHash("sha256").update(payload).digest("hex");
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_operation_outbox (
           outbox_id, operation_id, sequence, event_type, payload_bytes,
           idempotency_key, claimed_by, claim_expires_at, attempts,
           maximum_attempts, delivered_at, terminal_at, failure_code,
           created_at
         ) VALUES (
           $1, $2, 0, 'crypto_human_membership_started', $3, $4,
           NULL, NULL, 0, $5, NULL, NULL, NULL, $6::timestamptz
         )
         RETURNING outbox_id`,
        [
          `outbox_membership_started_${token}`,
          transition.operationId,
          payload,
          `membership_started_${token}`,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          createdAt,
        ],
        "Human membership outbox insert",
      );
      return { status: "admitted", state };
    });
  }
}
