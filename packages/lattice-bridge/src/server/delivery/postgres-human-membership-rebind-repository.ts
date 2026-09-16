import { createHash } from "node:crypto";
import {
  CRYPTO_DELIVERY_BYTE_LIMITS,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDeliveryMessages,
  eq,
  sql,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  assertCanonicalHumanMembershipRebindSubmission,
  verifyHumanMembershipRebindSubmission,
  type HumanMembershipRebindSubmission,
} from "../../delivery/human-membership-rebind-submission.ts";
import {
  createHumanMembershipRebindDelivery,
} from "../../delivery/human-membership-rebind-delivery.ts";
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
} from "./postgres-recipient-delivery-sequence.ts";

export type HumanMembershipRebindStagingResult =
  | {
    readonly status: "staged" | "duplicate";
    readonly recipientCount: number;
    readonly messageCount: number;
    readonly requiredAcknowledgementDeviceId: string;
  }
  | { readonly status: "stale_state" | "conflicting_state" };

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
    throw new TypeError(`Membership rebind column ${name} must be text`);
  }
  return value;
}

function nullableString(row: DatabaseRow, name: string): string | null {
  return row[name] === null ? null : requiredString(row, name);
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Membership rebind column ${name} must be bytea`);
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
    throw new TypeError(`Membership rebind column ${name} must be a counter`);
  }
  return normalized;
}

function nullableCounter(row: DatabaseRow, name: string): number | null {
  return row[name] === null ? null : requiredCounter(row, name);
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Membership rebind column ${name} must be boolean`);
  }
  return value;
}

function requiredStringArray(
  row: DatabaseRow,
  name: string,
): readonly string[] {
  const value = row[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`Membership rebind column ${name} must be text[]`);
  }
  return value as readonly string[];
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Membership rebind timestamp must be nonnegative");
  }
  return new Date(milliseconds).toISOString();
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
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

function sameCandidate(
  row: DatabaseRow,
  submission: HumanMembershipRebindSubmission,
): boolean {
  const candidate = submission.candidate;
  const submittedDigest = nullableBytes(row, "candidate_digest");
  const submittedBindingHash = nullableBytes(
    row,
    "candidate_binding_hash",
  );
  const submittedBinding = nullableBytes(
    row,
    "candidate_signed_binding_bytes",
  );
  const submittedHuman = nullableBytes(
    row,
    "candidate_human_keyring_envelope_bytes",
  );
  const submittedAi = nullableBytes(
    row,
    "candidate_ai_keyring_envelope_bytes",
  );
  return nullableString(row, "committer_device_id")
      === submission.committerDeviceId
    && nullableCounter(row, "target_domain_epoch")
      === candidate.nextHead.domainEpoch
    && submittedDigest !== null
    && equalBytes(submittedDigest, submission.candidateDigest)
    && submittedBindingHash !== null
    && equalBytes(submittedBindingHash, candidate.binding.bindingHash)
    && submittedBinding !== null
    && equalBytes(submittedBinding, candidate.binding.signedBindingBytes)
    && submittedHuman !== null
    && equalBytes(
      submittedHuman,
      candidate.binding.humanKeyringEnvelopeBytes,
    )
    && submittedAi !== null
    && equalBytes(
      submittedAi,
      candidate.binding.aiKeyringEnvelopeBytes,
    );
}

export class PostgresHumanMembershipRebindRepository {
  constructor(private readonly input: {
    readonly handle: CryptoPostgresHandle;
    readonly crypto: LatticeCrypto;
  }) {
    assertVerifiedCryptoPostgresHandle(input.handle);
  }

  stage(input: {
    readonly submission: HumanMembershipRebindSubmission;
    readonly submittedAt: number;
  }): Promise<HumanMembershipRebindStagingResult> {
    assertCanonicalHumanMembershipRebindSubmission(input.submission);
    const submittedAt = isoTime(input.submittedAt);
    const namespaceId = input.submission.candidate.expectedHead.namespaceId;
    return this.input.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [namespaceId],
      );
      const rows = await transaction.query(
        `SELECT o.operation_id, o.kind, o.state,
                o.fanout_row_count, o.aggregate_payload_bytes,
                o.lease_owner,
                o.deadline_at > $3::timestamptz AS deadline_live,
                CASE WHEN o.lease_expires_at IS NULL THEN NULL
                     ELSE floor(
                       extract(epoch from o.lease_expires_at) * 1000
                     )::bigint
                END AS lease_expires_at_ms,
                h.namespace_id, h.target_human_actor_id::text,
                h.bootstrap_device_id,
                h.old_participants, h.old_participant_digest,
                h.new_participants, h.new_participant_digest,
                h.old_domain_id, h.target_domain_id,
                h.expected_access_revision, h.expected_binding_hash,
                h.committer_device_id, h.target_domain_epoch,
                h.candidate_binding_hash, h.candidate_digest,
                h.candidate_signed_binding_bytes,
                h.candidate_human_keyring_envelope_bytes,
                h.candidate_ai_keyring_envelope_bytes,
                h.candidate_submitted_at, h.activated_at, h.released_at,
                head.access_revision AS head_access_revision,
                head.binding_hash AS head_binding_hash,
                head.domain_id AS head_domain_id,
                head.domain_epoch AS head_domain_epoch,
                head.writes_paused AS head_writes_paused,
                head.pause_operation_id AS head_pause_operation_id,
                source.participants AS source_participants,
                source.participant_digest AS source_participant_digest,
                source.epoch AS source_epoch,
                target.participants AS target_participants,
                target.participant_digest AS target_participant_digest,
                target.epoch AS target_epoch,
                target.writes_paused AS target_writes_paused,
                target_provider.epoch AS target_provider_epoch,
                d.device_id, d.human_id, d.state AS device_state,
                d.signing_public_key,
                source_map.human_id AS source_mapping_human_id,
                source_map.removed_at AS source_mapping_removed_at,
                target_map.human_id AS target_mapping_human_id,
                target_map.removed_at AS target_mapping_removed_at
           FROM crypto_delivery_operations o
           JOIN crypto_human_membership_transitions h
             ON h.operation_id = o.operation_id
           JOIN namespace_crypto_heads head
             ON head.namespace_id = h.namespace_id
           JOIN crypto_domains source ON source.id = h.old_domain_id
           JOIN crypto_domains target ON target.id = h.target_domain_id
           JOIN crypto_domain_provider_heads target_provider
             ON target_provider.domain_id = target.id
           JOIN human_crypto_devices d
             ON d.device_id = $2
           JOIN crypto_domain_devices source_map
             ON source_map.domain_id = source.id
            AND source_map.device_id = d.device_id
           JOIN crypto_domain_devices target_map
             ON target_map.domain_id = target.id
            AND target_map.device_id = d.device_id
          WHERE o.operation_id = $1
            AND o.deadline_at > $3::timestamptz
          LIMIT 2
          FOR UPDATE OF o, h, head, source, target, target_provider,
                        d, source_map, target_map`,
        [
          input.submission.operationId,
          input.submission.committerDeviceId,
          submittedAt,
        ],
      );
      if (rows.length !== 1) return { status: "stale_state" };
      const row = rows[0]!;
      if (
        row["candidate_submitted_at"] !== null
        || nullableBytes(row, "candidate_digest") !== null
      ) {
        if (
          !sameCandidate(row, input.submission)
          || !["awaiting_delivery", "ready_to_activate", "active"].includes(
            requiredString(row, "state"),
          )
        ) return { status: "conflicting_state" };
        const requiredAcknowledgementDeviceId =
          input.submission.kind === "human_add"
            ? nullableString(row, "bootstrap_device_id")
            : input.submission.committerDeviceId;
        if (requiredAcknowledgementDeviceId === null) {
          return { status: "conflicting_state" };
        }
        const recipients = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            recipient_count:
              sql<bigint>`count(DISTINCT ${cryptoDeliveryMessages.recipientDeviceId})::bigint`
                .as("recipient_count"),
            message_count: sql<bigint>`count(*)::bigint`
              .as("message_count"),
          }).from(cryptoDeliveryMessages).where(eq(
            cryptoDeliveryMessages.operationId,
            input.submission.operationId,
          )),
        );
        if (recipients.length !== 1) return { status: "conflicting_state" };
        return {
          status: "duplicate",
          recipientCount: requiredCounter(
            recipients[0]!,
            "recipient_count",
          ),
          messageCount: requiredCounter(recipients[0]!, "message_count"),
          requiredAcknowledgementDeviceId,
        };
      }
      const leaseOwner = nullableString(row, "lease_owner");
      const leaseExpiry = nullableCounter(row, "lease_expires_at_ms");
      const oldParticipants = requiredStringArray(row, "old_participants");
      const newParticipants = requiredStringArray(row, "new_participants");
      const expectedPause = input.submission.kind === "human_remove";
      if (
        requiredString(row, "operation_id") !== input.submission.operationId
        || requiredString(row, "kind") !== input.submission.kind
        || requiredString(row, "state") !== "awaiting_committer"
        || !requiredBoolean(row, "deadline_live")
        || row["activated_at"] !== null
        || row["released_at"] !== null
        || (leaseOwner !== null && (leaseExpiry ?? 0) > input.submittedAt)
        || requiredString(row, "namespace_id") !== namespaceId
        || requiredString(row, "old_domain_id")
          !== input.submission.sourceDomainId
        || requiredString(row, "target_domain_id")
          !== input.submission.targetDomainId
        || !equalBytes(
          requiredBytes(row, "old_participant_digest"),
          input.submission.oldParticipantDigest,
        )
        || !equalBytes(
          requiredBytes(row, "new_participant_digest"),
          input.submission.newParticipantDigest,
        )
        || !sameStrings(
          requiredStringArray(row, "source_participants"),
          oldParticipants,
        )
        || !sameStrings(
          requiredStringArray(row, "target_participants"),
          newParticipants,
        )
        || !oldParticipants.includes(input.submission.committerHumanId)
        || !newParticipants.includes(input.submission.committerHumanId)
        || requiredCounter(row, "head_access_revision")
          !== input.submission.candidate.expectedHead.accessRevision
        || !equalBytes(
          requiredBytes(row, "head_binding_hash"),
          input.submission.candidate.expectedHead.bindingHash,
        )
        || requiredString(row, "head_domain_id")
          !== input.submission.sourceDomainId
        || requiredCounter(row, "head_domain_epoch")
          !== requiredCounter(row, "source_epoch")
        || requiredBoolean(row, "head_writes_paused") !== expectedPause
        || (
          expectedPause
            ? nullableString(row, "head_pause_operation_id")
                !== input.submission.operationId
            : row["head_pause_operation_id"] !== null
        )
        || requiredCounter(row, "target_epoch")
          !== input.submission.candidate.nextHead.domainEpoch
        || requiredCounter(row, "target_provider_epoch")
          !== input.submission.candidate.nextHead.domainEpoch
        || requiredBoolean(row, "target_writes_paused")
        || requiredString(row, "device_id")
          !== input.submission.committerDeviceId
        || requiredString(row, "human_id")
          !== input.submission.committerHumanId
        || requiredString(row, "device_state") !== "active"
        || nullableString(row, "source_mapping_human_id")
          !== input.submission.committerHumanId
        || row["source_mapping_removed_at"] !== null
        || nullableString(row, "target_mapping_human_id")
          !== input.submission.committerHumanId
        || row["target_mapping_removed_at"] !== null
      ) return { status: "stale_state" };

      let verified;
      try {
        verified = verifyHumanMembershipRebindSubmission({
          crypto: this.input.crypto,
          submission: input.submission,
          expected: {
            operationId: requiredString(row, "operation_id"),
            kind: requiredString(row, "kind") as
              | "human_add"
              | "human_remove",
            sourceDomainId: requiredString(row, "old_domain_id"),
            targetDomainId: requiredString(row, "target_domain_id"),
            oldParticipantDigest: requiredBytes(
              row,
              "source_participant_digest",
            ),
            newParticipantDigest: requiredBytes(
              row,
              "target_participant_digest",
            ),
            expectedHead: {
              namespaceId,
              accessRevision: requiredCounter(
                row,
                "expected_access_revision",
              ),
              bindingHash: requiredBytes(row, "expected_binding_hash"),
            },
          },
          resolveSourceCommitter: (context) =>
            context.domainId === input.submission.sourceDomainId
              ? {
                state: "active",
                deviceId: requiredString(row, "device_id"),
                humanId: requiredString(row, "human_id"),
                signingPublicKey: requiredBytes(row, "signing_public_key"),
              }
              : null,
          resolveTargetCommitter: (context) =>
            context.domainId === input.submission.targetDomainId
              ? {
                state: "active",
                deviceId: requiredString(row, "device_id"),
                humanId: requiredString(row, "human_id"),
                signingPublicKey: requiredBytes(row, "signing_public_key"),
              }
              : null,
        });
      } catch {
        return { status: "conflicting_state" };
      }

      const recipientRows = await transaction.query(
        `SELECT map.device_id, map.human_id, map.joined_epoch,
                d.state, d.human_actor_id::text AS human_actor_id,
                custody.state AS custody_state,
                custody.current_recovery_generation,
                recovery.state AS recovery_key_state
           FROM crypto_domain_devices map
           JOIN human_crypto_devices d ON d.device_id = map.device_id
           JOIN human_crypto_custodies custody
             ON custody.human_id = d.human_id
           JOIN human_crypto_recovery_keys recovery
             ON recovery.human_id = custody.human_id
            AND recovery.generation = custody.current_recovery_generation
          WHERE map.domain_id = $1
            AND map.removed_at IS NULL
            AND map.removed_epoch IS NULL
            AND d.state = 'active'
          ORDER BY convert_to(map.device_id, 'UTF8')
          LIMIT $2
          FOR UPDATE OF d, map, custody, recovery`,
        [
          input.submission.targetDomainId,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.currentDeviceLeavesPerDomain + 1,
        ],
      );
      if (
        recipientRows.length < 1
        || recipientRows.length
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.currentDeviceLeavesPerDomain
        || recipientRows.some((recipient) =>
          !newParticipants.includes(requiredString(recipient, "human_id"))
          || requiredCounter(recipient, "joined_epoch")
            > input.submission.candidate.nextHead.domainEpoch
          || requiredString(recipient, "custody_state") !== "active"
          || recipient["current_recovery_generation"] === null
          || requiredString(recipient, "recovery_key_state") !== "current"
        )
        || newParticipants.some((participant) =>
          !recipientRows.some((recipient) =>
            requiredString(recipient, "human_id") === participant
          )
        )
      ) return { status: "stale_state" };
      const recipientDeviceIds = recipientRows.map((recipient) =>
        requiredString(recipient, "device_id")
      );
      const requiredAcknowledgementDeviceId =
        input.submission.kind === "human_add"
          ? nullableString(row, "bootstrap_device_id")
          : input.submission.committerDeviceId;
      if (
        requiredAcknowledgementDeviceId === null
        || !recipientDeviceIds.includes(requiredAcknowledgementDeviceId)
      ) return { status: "stale_state" };
      if (input.submission.kind === "human_add") {
        const bootstrap = recipientRows.find((recipient) =>
          requiredString(recipient, "device_id")
            === requiredAcknowledgementDeviceId
        );
        if (
          bootstrap === undefined
          || requiredString(bootstrap, "human_actor_id")
            !== requiredString(row, "target_human_actor_id")
          || requiredString(bootstrap, "recovery_key_state") !== "current"
        ) return { status: "stale_state" };
      }
      const delivery = createHumanMembershipRebindDelivery({
        crypto: this.input.crypto,
        submission: verified,
        recipientDeviceIds,
        requiredAcknowledgementDeviceId,
        now: input.submittedAt,
      });
      const priorFanoutRows = requiredCounter(row, "fanout_row_count");
      const priorPayloadBytes = requiredCounter(
        row,
        "aggregate_payload_bytes",
      );
      const totalFanoutRows = priorFanoutRows + delivery.fanoutRowCount;
      const totalPayloadBytes =
        priorPayloadBytes + delivery.aggregatePayloadBytes;
      if (
        totalFanoutRows
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation
        || totalPayloadBytes
          > CRYPTO_DELIVERY_BYTE_LIMITS.aggregateOpaquePayload
      ) return { status: "conflicting_state" };
      const recipientSequences = await reserveRecipientDeliverySequences(
        transaction,
        delivery.messages.map((message) => message.recipientDeviceId),
        input.submittedAt,
      );
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_human_membership_transitions
            SET committer_device_id = $2, target_domain_epoch = $3,
                candidate_binding_hash = $4, candidate_digest = $5,
                candidate_signed_binding_bytes = $6,
                candidate_human_keyring_envelope_bytes = $7,
                candidate_ai_keyring_envelope_bytes = $8,
                candidate_submitted_at = $9::timestamptz
          WHERE operation_id = $1
            AND released_at IS NULL
            AND candidate_submitted_at IS NULL
          RETURNING operation_id`,
        [
          input.submission.operationId,
          input.submission.committerDeviceId,
          verified.candidate.nextHead.domainEpoch,
          verified.candidate.binding.bindingHash,
          verified.candidateDigest,
          verified.candidate.binding.signedBindingBytes,
          verified.candidate.binding.humanKeyringEnvelopeBytes,
          verified.candidate.binding.aiKeyringEnvelopeBytes,
          submittedAt,
        ],
        "Human membership candidate staging",
      );
      for (const [index, message] of delivery.messages.entries()) {
        await expectSingleMutation(
          transaction,
          `INSERT INTO crypto_delivery_messages (
             message_id, operation_id, domain_id, domain_sequence,
             recipient_sequence, kind, recipient_device_id, format_version,
             payload_hash, payload_bytes, created_at, expires_at
           ) VALUES (
             $1, $2, NULL, NULL, $3, 'binding_candidate', $4, $5, $6, $7,
             $8::timestamptz, $9::timestamptz
           )
           RETURNING message_id`,
          [
            message.messageId,
            message.operationId,
            recipientSequences[index]!,
            message.recipientDeviceId,
            message.formatVersion,
            message.payloadHash,
            message.payloadBytes,
            isoTime(message.createdAt),
            isoTime(message.expiresAt),
          ],
          "Human membership delivery insert",
        );
      }
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_delivery_operations
            SET state = 'awaiting_delivery',
                fanout_row_count = $2, aggregate_payload_bytes = $3,
                updated_at = $4::timestamptz,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE operation_id = $1
            AND state = 'awaiting_committer'
            AND fanout_row_count = $5
            AND aggregate_payload_bytes = $6
          RETURNING operation_id`,
        [
          input.submission.operationId,
          totalFanoutRows,
          totalPayloadBytes,
          submittedAt,
          priorFanoutRows,
          priorPayloadBytes,
        ],
        "Human membership operation staging",
      );
      const payload = new TextEncoder().encode(JSON.stringify({
        formatVersion: 1,
        eventType: "crypto_human_membership_candidate_staged",
        operationId: input.submission.operationId,
        kind: input.submission.kind,
        namespaceId,
        targetDomainId: input.submission.targetDomainId,
        requiredAcknowledgementDeviceId,
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
           $1, $2, 1, 'crypto_human_membership_candidate_staged',
           $3, $4, NULL, NULL, 0, $5, NULL, NULL, NULL, $6::timestamptz
         )
         RETURNING outbox_id`,
        [
          `outbox_membership_staged_${token}`,
          input.submission.operationId,
          payload,
          `membership-staged/${token}`,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          submittedAt,
        ],
        "Human membership staging outbox insert",
      );
      return {
        status: "staged",
        recipientCount: recipientDeviceIds.length,
        messageCount: delivery.messages.length,
        requiredAcknowledgementDeviceId,
      };
    });
  }
}
