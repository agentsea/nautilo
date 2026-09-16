import {
  and,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDeliveryMessages,
  eq,
} from "@nautilo/db";
import type {
  DeviceFanoutAdmission,
} from "../../delivery/device-fanout-admission.ts";
import {
  assertVerifiedDeviceFanoutAdmission,
} from "../../delivery/device-fanout-admission.ts";
import {
  assertDeviceFanoutPlan,
  type DeviceFanoutDomainPlan,
  type DeviceFanoutNamespacePlan,
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
import {
  reserveRecipientDeliverySequences,
} from "../delivery/postgres-recipient-delivery-sequence.ts";

export type DeviceFanoutAdmissionResult =
  | { readonly status: "admitted" | "duplicate" }
  | { readonly status: "conflicting_state" | "stale_state" };

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
  return row[name] === null ? null : requiredString(row, name);
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Crypto delivery column ${name} must be bytea`);
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
    throw new TypeError(`Crypto delivery column ${name} must be a safe counter`);
  }
  return normalized;
}

function nullableCounter(row: DatabaseRow, name: string): number | null {
  return row[name] === null ? null : requiredCounter(row, name);
}

function custodyInventoryMatches(
  row: DatabaseRow,
  admission: DeviceFanoutAdmission,
): boolean {
  const revision = nullableCounter(row, "custody_inventory_revision");
  const count = nullableCounter(row, "custody_inventory_count");
  const digest = nullableBytes(row, "custody_inventory_digest");
  const plan = admission.plan;
  return revision === null && count === null && digest === null
    ? plan.inventoryRevision === 0 && plan.inventoryCount === 0
    : revision === plan.inventoryRevision
      && count === plan.inventoryCount
      && digest !== null
      && equalBytes(digest, plan.inventoryDigest);
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Crypto delivery column ${name} must be boolean`);
  }
  return value;
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

function assertAdmission(admission: DeviceFanoutAdmission): void {
  assertDeviceFanoutPlan(admission.plan);
  if (
    admission.plan.method !== "device_approval"
    || admission.sourceDeviceId.length < 1
    || admission.messages.length !== admission.plan.fanoutRowCount
    || admission.aggregatePayloadBytes
      !== admission.plan.aggregatePayloadBytes
    || !Number.isSafeInteger(admission.createdAt)
    || admission.createdAt < 0
  ) {
    throw new TypeError("Device fanout admission is inconsistent");
  }
  const ids = new Set<string>();
  let payloadBytes = 0;
  for (const message of admission.messages) {
    if (
      ids.has(message.messageId)
      || message.kind !== "device_transfer"
      || message.recipientDeviceId !== admission.plan.targetDeviceId
      || message.formatVersion !== 1
      || message.payloadHash.length !== 32
      || message.payloadBytes.length < 1
      || message.createdAt !== admission.createdAt
      || message.expiresAt <= message.createdAt
    ) {
      throw new TypeError("Device fanout delivery message is inconsistent");
    }
    ids.add(message.messageId);
    payloadBytes += message.payloadBytes.length;
  }
  if (
    payloadBytes !== admission.aggregatePayloadBytes
    || admission.outbox.payloadBytes.length < 1
    || admission.outbox.payloadBytes.length > 4_096
  ) {
    throw new TypeError("Device fanout delivery accounting is inconsistent");
  }
}

function currentStateMatches(
  row: DatabaseRow,
  admission: DeviceFanoutAdmission,
): boolean {
  const plan = admission.plan;
  return requiredString(row, "operation_id") === plan.operationId
    && requiredString(row, "operation_kind") === "device_add"
    && requiredString(row, "operation_state") === "awaiting_committer"
    && requiredString(row, "operation_human_id") === plan.humanId
    && requiredString(row, "operation_target_device_id")
      === plan.targetDeviceId
    && requiredCounter(row, "operation_custody_revision")
      === plan.expectedCustodyRevision
    && requiredCounter(row, "operation_recovery_generation")
      === plan.expectedRecoveryGeneration
    && requiredCounter(row, "operation_device_revision")
      === plan.expectedDeviceRevision
    && equalBytes(
      requiredBytes(row, "operation_inventory_digest"),
      plan.inventoryDigest,
    )
    && requiredCounter(row, "operation_fanout_row_count") === 0
    && requiredCounter(row, "operation_aggregate_payload_bytes") === 0
    && requiredString(row, "device_state") === "pending"
    && requiredCounter(row, "device_revision")
      === plan.expectedDeviceRevision
    && requiredString(row, "device_human_id") === plan.humanId
    && requiredString(row, "custody_state") === "active"
    && requiredCounter(row, "custody_revision")
      === plan.expectedCustodyRevision
    && requiredCounter(row, "custody_recovery_generation")
      === plan.expectedRecoveryGeneration
    && custodyInventoryMatches(row, admission)
    && requiredString(row, "challenge_kind") === "device_approval"
    && row["challenge_consumed_at"] === null
    && row["challenge_invalidated_at"] === null
    && requiredCounter(row, "challenge_expires_at_ms") > admission.createdAt
    && requiredString(row, "source_state") === "active"
    && requiredString(row, "source_human_id") === plan.humanId;
}

function domainMatches(
  row: DatabaseRow,
  plan: DeviceFanoutDomainPlan,
): boolean {
  return requiredString(row, "domain_id") === plan.domainId
    && requiredCounter(row, "epoch") === plan.expectedEpoch
    && requiredCounter(row, "authorization_revision")
      === plan.expectedAuthorizationRevision
    && equalBytes(
      requiredBytes(row, "participant_digest"),
      plan.expectedParticipantDigest,
    )
    && !requiredBoolean(row, "writes_paused");
}

function namespaceMatches(
  row: DatabaseRow,
  domain: DeviceFanoutDomainPlan,
  plan: DeviceFanoutNamespacePlan,
): boolean {
  return requiredString(row, "namespace_id") === plan.namespaceId
    && requiredString(row, "domain_id") === domain.domainId
    && requiredCounter(row, "domain_epoch") === domain.expectedEpoch
    && requiredCounter(row, "access_revision")
      === plan.expectedAccessRevision
    && equalBytes(
      requiredBytes(row, "binding_hash"),
      plan.expectedBindingHash,
    )
    && !requiredBoolean(row, "writes_paused");
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

export class PostgresDeviceFanoutAdmissionRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  admit(
    admission: DeviceFanoutAdmission,
  ): Promise<DeviceFanoutAdmissionResult> {
    assertVerifiedDeviceFanoutAdmission(admission);
    assertAdmission(admission);
    return this.handle.transaction(async (transaction) => {
      const plan = admission.plan;
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`device-fanout/${plan.humanId}`],
      );

      const current = oneOrNull(
        await transaction.query(
          `SELECT o.operation_id,
                  o.kind AS operation_kind,
                  o.state AS operation_state,
                  o.human_id AS operation_human_id,
                  o.target_device_id AS operation_target_device_id,
                  o.expected_custody_revision
                    AS operation_custody_revision,
                  o.expected_recovery_generation
                    AS operation_recovery_generation,
                  o.expected_device_revision AS operation_device_revision,
                  o.expected_participant_digest
                    AS operation_inventory_digest,
                  o.fanout_row_count AS operation_fanout_row_count,
                  o.aggregate_payload_bytes
                    AS operation_aggregate_payload_bytes,
                  d.state AS device_state,
                  d.revision AS device_revision,
                  d.human_id AS device_human_id,
                  h.state AS custody_state,
                  h.revision AS custody_revision,
                  h.current_recovery_generation
                    AS custody_recovery_generation,
                  h.current_inventory_revision AS custody_inventory_revision,
                  h.current_inventory_count AS custody_inventory_count,
                  h.current_inventory_digest AS custody_inventory_digest,
                  c.kind AS challenge_kind,
                  floor(extract(epoch from c.expires_at) * 1000)::bigint
                    AS challenge_expires_at_ms,
                  c.consumed_at AS challenge_consumed_at,
                  c.invalidated_at AS challenge_invalidated_at,
                  s.state AS source_state,
                  s.human_id AS source_human_id,
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
             JOIN human_crypto_devices d
               ON d.device_id = o.target_device_id
             JOIN human_crypto_custodies h ON h.human_id = o.human_id
             JOIN human_crypto_device_challenges c
               ON c.human_id = o.human_id
              AND c.pending_device_id = o.target_device_id
              AND c.idempotency_key = o.idempotency_key
             JOIN human_crypto_devices s ON s.device_id = $2
             LEFT JOIN crypto_device_epoch_operations e
               ON e.operation_id = o.operation_id
            WHERE o.operation_id = $1
            LIMIT 2
            FOR UPDATE OF o, d, h, c, s`,
          [plan.operationId, admission.sourceDeviceId],
        ),
        "Device fanout current-state lookup",
      );
      if (current === null) return { status: "stale_state" };

      const admittedOperationId = nullableString(
        current,
        "admitted_operation_id",
      );
      if (admittedOperationId !== null) {
        const recoveryDigest = nullableBytes(
          current,
          "admitted_recovery_readiness_digest",
        );
        const exact = admittedOperationId === plan.operationId
          && requiredString(current, "admitted_target_device_id")
            === plan.targetDeviceId
          && requiredString(current, "admitted_owner_human_id") === plan.humanId
          && requiredString(current, "admitted_source_device_id")
            === admission.sourceDeviceId
          && requiredCounter(current, "admitted_device_revision")
            === plan.expectedDeviceRevision
          && requiredCounter(current, "admitted_inventory_revision")
            === plan.inventoryRevision
          && requiredCounter(current, "admitted_inventory_count")
            === plan.inventoryCount
          && equalBytes(
            requiredBytes(current, "admitted_inventory_digest"),
            plan.inventoryDigest,
          )
          && equalBytes(
            requiredBytes(current, "admitted_authorization_artifact_hash"),
            plan.authorizationArtifactHash,
          )
          && recoveryDigest === null;
        if (!exact) return { status: "conflicting_state" };
        const persistedMessages = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            message_id: cryptoDeliveryMessages.messageId,
            payload_hash: cryptoDeliveryMessages.payloadHash,
            payload_bytes: cryptoDeliveryMessages.payloadBytes,
          }).from(cryptoDeliveryMessages).where(and(
            eq(cryptoDeliveryMessages.operationId, plan.operationId),
            eq(cryptoDeliveryMessages.kind, "device_transfer"),
            eq(
              cryptoDeliveryMessages.recipientDeviceId,
              plan.targetDeviceId,
            ),
          )).orderBy(cryptoDeliveryMessages.messageId),
        );
        const expectedMessages = [...admission.messages].sort((left, right) =>
          left.messageId.localeCompare(right.messageId)
        );
        if (
          persistedMessages.length !== expectedMessages.length
          || persistedMessages.some((row, index) => {
            const expected = expectedMessages[index]!;
            return requiredString(row, "message_id") !== expected.messageId
              || !equalBytes(
                requiredBytes(row, "payload_hash"),
                expected.payloadHash,
              )
              || !equalBytes(
                requiredBytes(row, "payload_bytes"),
                expected.payloadBytes,
              );
          })
        ) return { status: "conflicting_state" };
        return { status: "duplicate" };
      }
      if (!currentStateMatches(current, admission)) {
        return { status: "stale_state" };
      }

      const domains = await transaction.query(
        `SELECT id AS domain_id, epoch, authorization_revision,
                participant_digest, writes_paused
           FROM crypto_domains
          WHERE id = ANY($1::text[])
          ORDER BY id
          FOR UPDATE`,
        [plan.domains.map((domain) => domain.domainId)],
      );
      if (
        domains.length !== plan.domains.length
        || domains.some((row, index) =>
          !domainMatches(row, plan.domains[index]!)
        )
      ) return { status: "stale_state" };

      const committerIds = Array.from(new Set(
        plan.domains.flatMap((domain) =>
          domain.committerDeviceId === null ? [] : [domain.committerDeviceId]
        ),
      )).sort();
      const committers = await transaction.query(
        `SELECT device_id, human_id, state
           FROM human_crypto_devices
          WHERE device_id = ANY($1::text[])
          ORDER BY device_id
          FOR UPDATE`,
        [committerIds],
      );
      if (
        committers.length !== committerIds.length
        || committers.some((row, index) =>
          requiredString(row, "device_id") !== committerIds[index]
          || requiredString(row, "human_id") !== plan.humanId
          || requiredString(row, "state") !== "active"
        )
      ) return { status: "stale_state" };

      const namespacePlans = plan.domains.flatMap((domain) =>
        domain.namespaces.map((namespace) => ({ domain, namespace }))
      );
      const namespaces = await transaction.query(
        `SELECT namespace_id, domain_id, domain_epoch, access_revision,
                binding_hash, writes_paused
           FROM namespace_crypto_heads
          WHERE namespace_id = ANY($1::text[])
          ORDER BY namespace_id
          FOR UPDATE`,
        [namespacePlans.map(({ namespace }) => namespace.namespaceId)],
      );
      if (
        namespaces.length !== namespacePlans.length
        || namespaces.some((row, index) => {
          const expected = namespacePlans[index]!;
          return !namespaceMatches(row, expected.domain, expected.namespace);
        })
      ) return { status: "stale_state" };

      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_device_epoch_operations (
           operation_id, target_device_id, owner_human_id, source_device_id,
           expected_device_revision, expected_inventory_revision,
           expected_inventory_count, expected_inventory_digest,
           authorization_artifact_hash, recovery_readiness_digest
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
         RETURNING operation_id`,
        [
          plan.operationId,
          plan.targetDeviceId,
          plan.humanId,
          admission.sourceDeviceId,
          plan.expectedDeviceRevision,
          plan.inventoryRevision,
          plan.inventoryCount,
          plan.inventoryDigest,
          plan.authorizationArtifactHash,
        ],
        "Device fanout activation-gate insert",
      );
      for (const domain of plan.domains) {
        await expectSingleMutation(
          transaction,
          `INSERT INTO crypto_domain_transition_steps (
             operation_id, domain_id, expected_epoch,
             expected_authorization_revision, expected_participant_digest,
             target_epoch, committer_device_id, state, lease_owner,
             lease_expires_at, retry_count, failure_code, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, 'awaiting_committer',
             NULL, NULL, 0, NULL, $8::timestamptz, $8::timestamptz
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
            isoTime(admission.createdAt),
          ],
          "Device fanout Domain-step insert",
        );
        for (const namespace of domain.namespaces) {
          await expectSingleMutation(
            transaction,
            `INSERT INTO crypto_domain_transition_namespaces (
               operation_id, domain_id, namespace_id,
               expected_access_revision, expected_binding_hash,
               candidate_binding_hash, state, failure_code,
               created_at, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, NULL, 'pending', NULL,
               $6::timestamptz, $6::timestamptz
             )
             RETURNING namespace_id`,
            [
              plan.operationId,
              domain.domainId,
              namespace.namespaceId,
              namespace.expectedAccessRevision,
              namespace.expectedBindingHash,
              isoTime(admission.createdAt),
            ],
            "Device fanout Namespace-step insert",
          );
        }
      }
      const recipientSequences = await reserveRecipientDeliverySequences(
        transaction,
        admission.messages.map((message) => message.recipientDeviceId),
        admission.createdAt,
      );
      for (const [index, message] of admission.messages.entries()) {
        await expectSingleMutation(
          transaction,
          `INSERT INTO crypto_delivery_messages (
             message_id, operation_id, domain_id, domain_sequence,
             recipient_sequence, kind, recipient_device_id, format_version,
             payload_hash, payload_bytes, created_at, expires_at
           ) VALUES (
             $1, $2, NULL, NULL, $3, 'device_transfer', $4, $5, $6, $7,
             $8::timestamptz, $9::timestamptz
           )
           RETURNING message_id`,
          [
            message.messageId,
            plan.operationId,
            recipientSequences[index]!,
            message.recipientDeviceId,
            message.formatVersion,
            message.payloadHash,
            message.payloadBytes,
            isoTime(message.createdAt),
            isoTime(message.expiresAt),
          ],
          "Device fanout delivery-message insert",
        );
      }
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_delivery_operations
            SET state = CASE WHEN $5::boolean
                  THEN 'ready_to_activate' ELSE state END,
                fanout_row_count = $2,
                aggregate_payload_bytes = $3,
                updated_at = $4::timestamptz
          WHERE operation_id = $1
            AND state = 'awaiting_committer'
            AND fanout_row_count = 0
            AND aggregate_payload_bytes = 0
          RETURNING operation_id`,
        [
          plan.operationId,
          plan.fanoutRowCount,
          plan.aggregatePayloadBytes,
          isoTime(admission.createdAt),
          plan.domains.length === 0,
        ],
        "Device fanout operation accounting update",
      );
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_operation_outbox (
           outbox_id, operation_id, sequence, event_type, payload_bytes,
           idempotency_key, claimed_by, claim_expires_at, attempts,
           maximum_attempts, delivered_at, terminal_at, failure_code,
           created_at
         ) VALUES (
           $1, $2, 0, $3, $4, $5, NULL, NULL, 0, $6,
           NULL, NULL, NULL, $7::timestamptz
         )
         RETURNING outbox_id`,
        [
          admission.outbox.outboxId,
          plan.operationId,
          admission.outbox.eventType,
          admission.outbox.payloadBytes,
          admission.outbox.idempotencyKey,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          isoTime(admission.createdAt),
        ],
        "Device fanout outbox insert",
      );
      return { status: "admitted" };
    });
  }
}
