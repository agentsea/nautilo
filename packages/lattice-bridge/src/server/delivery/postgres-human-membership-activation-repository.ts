import {
  and,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoHumanMembershipTransitions,
  cryptoOperationOutbox,
  eq,
  namespaceCryptoBindings,
  sql,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  namespaceBindingSigningBytesV2,
  namespaceKeyringEnvelopeSigningBytesV2,
  parseNamespaceBindingV2,
  parseNamespaceKeyringEnvelopeV2,
  storageAdapterSupportV2,
  type NamespaceBindingWireRecordV2,
} from "@nautilo/lattice-crypto/wire";
import {
  humanMembershipRebindCandidateDigest,
  type HumanMembershipRebindCandidate,
  type HumanMembershipRebindKind,
} from "../../delivery/human-membership-rebind-submission.ts";
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

const textEncoder = new TextEncoder();

export type HumanMembershipActivationResult =
  | {
    readonly status: "activated" | "duplicate";
    readonly kind: HumanMembershipRebindKind;
    readonly namespaceId: string;
    readonly accessRevision: number;
  }
  | { readonly status: "not_ready" | "stale_state" };

function portable(label: string, value: string): void {
  if (
    value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      "Human membership activation timestamp must be nonnegative",
    );
  }
  return new Date(milliseconds).toISOString();
}

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(
      `Human membership activation column ${name} must be text`,
    );
  }
  return value;
}

function nullableString(row: DatabaseRow, name: string): string | null {
  return row[name] === null ? null : requiredString(row, name);
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(
      `Human membership activation column ${name} must be bytea`,
    );
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
      `Human membership activation column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(
      `Human membership activation column ${name} must be boolean`,
    );
  }
  return value;
}

function requiredStringArray(
  row: DatabaseRow,
  name: string,
): readonly string[] {
  const value = row[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(
      `Human membership activation column ${name} must be text[]`,
    );
  }
  return value as readonly string[];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
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

function candidateFromRow(
  row: DatabaseRow,
): HumanMembershipRebindCandidate | null {
  const targetDomainEpoch = row["target_domain_epoch"] === null
    ? null
    : requiredCounter(row, "target_domain_epoch");
  const candidateBindingHash = nullableBytes(row, "candidate_binding_hash");
  const candidateDigest = nullableBytes(row, "candidate_digest");
  const signedBindingBytes = nullableBytes(
    row,
    "candidate_signed_binding_bytes",
  );
  const humanKeyringEnvelopeBytes = nullableBytes(
    row,
    "candidate_human_keyring_envelope_bytes",
  );
  const aiKeyringEnvelopeBytes = nullableBytes(
    row,
    "candidate_ai_keyring_envelope_bytes",
  );
  if (
    nullableString(row, "committer_device_id") === null
    || targetDomainEpoch === null
    || candidateBindingHash === null
    || candidateDigest === null
    || signedBindingBytes === null
    || humanKeyringEnvelopeBytes === null
    || aiKeyringEnvelopeBytes === null
    || row["candidate_submitted_at"] === null
  ) return null;

  const namespaceId = requiredString(row, "namespace_id");
  const expectedAccessRevision = requiredCounter(
    row,
    "expected_access_revision",
  );
  const expectedBindingHash = requiredBytes(row, "expected_binding_hash");
  const binding = storageAdapterSupportV2.validateNamespaceBinding({
    namespaceId,
    revision: expectedAccessRevision + 1,
    bindingHash: candidateBindingHash,
    previousBindingHash: expectedBindingHash,
    signedBindingBytes,
    humanKeyringEnvelopeBytes,
    aiKeyringEnvelopeBytes,
  });
  return {
    expectedHead: {
      namespaceId,
      accessRevision: expectedAccessRevision,
      bindingHash: expectedBindingHash,
    },
    nextHead: storageAdapterSupportV2.validateNamespaceHead({
      namespaceId,
      accessRevision: expectedAccessRevision + 1,
      bindingHash: candidateBindingHash,
      domainId: requiredString(row, "target_domain_id"),
      domainEpoch: targetDomainEpoch,
    }),
    binding,
  };
}

function candidateIsAuthoritative(input: {
  readonly crypto: LatticeCrypto;
  readonly row: DatabaseRow;
  readonly candidate: HumanMembershipRebindCandidate;
  readonly activation: boolean;
}): boolean {
  try {
    const { row, candidate, crypto } = input;
    const committerDeviceId = requiredString(row, "committer_device_id");
    const committerHumanId = requiredString(row, "committer_human_id");
    const oldParticipants = requiredStringArray(row, "old_participants");
    const newParticipants = requiredStringArray(row, "new_participants");
    const signingPublicKey = requiredBytes(row, "signing_public_key");
    const signedBinding = parseNamespaceBindingV2(
      candidate.binding.signedBindingBytes,
    );
    const humanEnvelope = parseNamespaceKeyringEnvelopeV2(
      candidate.binding.humanKeyringEnvelopeBytes,
    );
    const aiEnvelope = parseNamespaceKeyringEnvelopeV2(
      candidate.binding.aiKeyringEnvelopeBytes,
    );
    const computedDigest = humanMembershipRebindCandidateDigest(
      crypto,
      candidate,
    );
    if (
      !equalBytes(computedDigest, requiredBytes(row, "candidate_digest"))
      || signedBinding.committerDeviceId !== committerDeviceId
      || humanEnvelope.committerDeviceId !== committerDeviceId
      || aiEnvelope.committerDeviceId !== committerDeviceId
      || !crypto.verify(
        signingPublicKey,
        namespaceBindingSigningBytesV2(signedBinding),
        signedBinding.signature,
      )
      || !crypto.verify(
        signingPublicKey,
        namespaceKeyringEnvelopeSigningBytesV2(humanEnvelope),
        humanEnvelope.signature,
      )
      || !crypto.verify(
        signingPublicKey,
        namespaceKeyringEnvelopeSigningBytesV2(aiEnvelope),
        aiEnvelope.signature,
      )
    ) return false;
    if (!input.activation) return true;
    return requiredString(row, "device_state") === "active"
      && oldParticipants.includes(committerHumanId)
      && newParticipants.includes(committerHumanId)
      && nullableString(row, "source_mapping_human_id") === committerHumanId
      && requiredCounter(row, "source_mapping_joined_epoch")
        <= requiredCounter(row, "source_epoch")
      && row["source_mapping_removed_epoch"] === null
      && row["source_mapping_removed_at"] === null
      && nullableString(row, "target_mapping_human_id") === committerHumanId
      && requiredCounter(row, "target_mapping_joined_epoch")
        <= requiredCounter(row, "target_domain_epoch")
      && row["target_mapping_removed_epoch"] === null
      && row["target_mapping_removed_at"] === null;
  } catch {
    return false;
  }
}

function canonicalBindingMatches(
  row: DatabaseRow,
  binding: NamespaceBindingWireRecordV2,
): boolean {
  return requiredString(row, "persisted_namespace_id")
      === String(binding.namespaceId)
    && requiredCounter(row, "persisted_revision") === binding.revision
    && equalBytes(
      requiredBytes(row, "persisted_binding_hash"),
      binding.bindingHash,
    )
    && nullableBytes(row, "persisted_previous_binding_hash") !== null
    && equalBytes(
      requiredBytes(row, "persisted_previous_binding_hash"),
      binding.previousBindingHash!,
    )
    && equalBytes(
      requiredBytes(row, "persisted_signed_binding_bytes"),
      binding.signedBindingBytes,
    )
    && equalBytes(
      requiredBytes(row, "persisted_human_keyring_envelope_bytes"),
      binding.humanKeyringEnvelopeBytes,
    )
    && equalBytes(
      requiredBytes(row, "persisted_ai_keyring_envelope_bytes"),
      binding.aiKeyringEnvelopeBytes,
    );
}

function committedPayload(input: {
  readonly operationId: string;
  readonly kind: HumanMembershipRebindKind;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly targetDomainId: string;
  readonly accessRevision: number;
}): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    formatVersion: 1,
    eventType: "crypto_human_membership_committed",
    operationId: input.operationId,
    kind: input.kind,
    roomId: input.roomId,
    namespaceId: input.namespaceId,
    targetDomainId: input.targetDomainId,
    accessRevision: input.accessRevision,
  }));
}

export class PostgresHumanMembershipActivationRepository {
  constructor(private readonly input: {
    readonly handle: CryptoPostgresHandle;
    readonly crypto: LatticeCrypto;
  }) {
    assertVerifiedCryptoPostgresHandle(input.handle);
  }

  activate(input: {
    readonly operationId: string;
    readonly activatedAt: number;
    readonly auditRef: string;
    readonly outboxId: string;
  }): Promise<HumanMembershipActivationResult> {
    portable("Human membership activation operation id", input.operationId);
    portable("Human membership activation audit ref", input.auditRef);
    portable("Human membership activation outbox id", input.outboxId);
    const activatedAt = isoTime(input.activatedAt);

    return this.input.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const transitionRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          namespace_id: cryptoHumanMembershipTransitions.namespaceId,
        }).from(cryptoHumanMembershipTransitions).where(eq(
          cryptoHumanMembershipTransitions.operationId,
          input.operationId,
        )).limit(2),
      );
      if (transitionRows.length !== 1) return { status: "stale_state" };
      const namespaceId = requiredString(transitionRows[0]!, "namespace_id");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [namespaceId],
      );

      const rows = await transaction.query(
        `SELECT o.operation_id, o.kind, o.state, o.fanout_row_count,
                o.aggregate_payload_bytes, o.failure_code, o.audit_ref,
                o.terminal_at, o.lease_owner, o.lease_expires_at,
                o.deadline_at > $3::timestamptz AS deadline_live,
                h.namespace_id, h.room_id,
                h.target_human_actor_id::text,
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
                d.human_id AS committer_human_id,
                d.state AS device_state, d.signing_public_key,
                source_map.human_id AS source_mapping_human_id,
                source_map.joined_epoch AS source_mapping_joined_epoch,
                source_map.removed_epoch AS source_mapping_removed_epoch,
                source_map.removed_at AS source_mapping_removed_at,
                target_map.human_id AS target_mapping_human_id,
                target_map.joined_epoch AS target_mapping_joined_epoch,
                target_map.removed_epoch AS target_mapping_removed_epoch,
                target_map.removed_at AS target_mapping_removed_at,
                required_device.device_id AS required_device_id,
                required_device.human_id AS required_device_human_id,
                required_device.human_actor_id::text
                  AS required_device_human_actor_id,
                required_device.state AS required_device_state,
                required_map.human_id AS required_mapping_human_id,
                required_map.joined_epoch AS required_mapping_joined_epoch,
                required_map.removed_epoch AS required_mapping_removed_epoch,
                required_map.removed_at AS required_mapping_removed_at,
                (
                  SELECT count(*) FROM crypto_delivery_messages m
                   WHERE m.operation_id = o.operation_id
                )::bigint AS message_count,
                (
                  SELECT coalesce(sum(octet_length(m.payload_bytes)), 0)
                    FROM crypto_delivery_messages m
                   WHERE m.operation_id = o.operation_id
                )::bigint AS message_payload_bytes,
                (
                  SELECT count(*) FROM crypto_delivery_messages m
                   WHERE m.operation_id = o.operation_id
                     AND m.recipient_device_id = CASE
                       WHEN o.kind = 'human_add' THEN h.bootstrap_device_id
                       ELSE h.committer_device_id
                     END
                )::bigint AS required_message_count,
                (
                  SELECT count(*)
                    FROM crypto_delivery_messages m
                    JOIN crypto_delivery_acknowledgements a
                      ON a.message_id = m.message_id
                     AND a.device_id = m.recipient_device_id
                   WHERE m.operation_id = o.operation_id
                     AND m.recipient_device_id = CASE
                       WHEN o.kind = 'human_add' THEN h.bootstrap_device_id
                       ELSE h.committer_device_id
                     END
                )::bigint AS required_acknowledged_count,
                (
                  SELECT coalesce(max(outbox.sequence), -1) + 1
                    FROM crypto_operation_outbox outbox
                   WHERE outbox.operation_id = o.operation_id
                )::bigint AS next_outbox_sequence
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
             ON d.device_id = h.committer_device_id
           JOIN crypto_domain_devices source_map
             ON source_map.domain_id = source.id
            AND source_map.device_id = d.device_id
           JOIN crypto_domain_devices target_map
             ON target_map.domain_id = target.id
            AND target_map.device_id = d.device_id
           JOIN human_crypto_devices required_device
             ON required_device.device_id = CASE
               WHEN o.kind = 'human_add' THEN h.bootstrap_device_id
               ELSE h.committer_device_id
             END
           JOIN crypto_domain_devices required_map
             ON required_map.domain_id = target.id
            AND required_map.device_id = required_device.device_id
          WHERE o.operation_id = $1
            AND h.namespace_id = $2
          LIMIT 2
          FOR UPDATE OF o, h, head, source, target, target_provider, d,
                        source_map, target_map, required_device, required_map`,
        [input.operationId, namespaceId, activatedAt],
      );
      if (rows.length !== 1) return { status: "stale_state" };
      const row = rows[0]!;
      const state = requiredString(row, "state");
      if (state !== "ready_to_activate" && state !== "active") {
        return state === "awaiting_delivery"
          ? { status: "not_ready" }
          : { status: "stale_state" };
      }
      const kind = requiredString(row, "kind");
      if (kind !== "human_add" && kind !== "human_remove") {
        return { status: "stale_state" };
      }
      let candidate: HumanMembershipRebindCandidate | null;
      try {
        candidate = candidateFromRow(row);
      } catch {
        candidate = null;
      }
      if (
        candidate === null
        || requiredString(row, "operation_id") !== input.operationId
        || requiredString(row, "namespace_id") !== namespaceId
        || !candidateIsAuthoritative({
          crypto: this.input.crypto,
          row,
          candidate,
          activation: state === "ready_to_activate",
        })
      ) return { status: "stale_state" };

      const expectedAccessRevision = requiredCounter(
        row,
        "expected_access_revision",
      );
      const accessRevision = expectedAccessRevision + 1;
      const targetDomainId = requiredString(row, "target_domain_id");
      const targetDomainEpoch = requiredCounter(row, "target_domain_epoch");
      const roomId = requiredString(row, "room_id");
      const payload = committedPayload({
        operationId: input.operationId,
        kind,
        roomId,
        namespaceId,
        targetDomainId,
        accessRevision,
      });
      const canonicalRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          persisted_namespace_id: sql`${namespaceCryptoBindings.namespaceId}`
            .as("persisted_namespace_id"),
          persisted_revision: sql`${namespaceCryptoBindings.revision}`
            .as("persisted_revision"),
          persisted_binding_hash: sql`${namespaceCryptoBindings.bindingHash}`
            .as("persisted_binding_hash"),
          persisted_previous_binding_hash:
            sql`${namespaceCryptoBindings.previousBindingHash}`
              .as("persisted_previous_binding_hash"),
          persisted_signed_binding_bytes:
            sql`${namespaceCryptoBindings.signedBindingBytes}`
              .as("persisted_signed_binding_bytes"),
          persisted_human_keyring_envelope_bytes:
            sql`${namespaceCryptoBindings.humanKeyringEnvelopeBytes}`
              .as("persisted_human_keyring_envelope_bytes"),
          persisted_ai_keyring_envelope_bytes:
            sql`${namespaceCryptoBindings.aiKeyringEnvelopeBytes}`
              .as("persisted_ai_keyring_envelope_bytes"),
        }).from(namespaceCryptoBindings).where(and(
          eq(namespaceCryptoBindings.namespaceId, namespaceId),
          eq(namespaceCryptoBindings.revision, accessRevision),
        )).limit(2),
      );
      if (canonicalRows.length > 1) return { status: "stale_state" };

      if (state === "active") {
        if (
          requiredString(row, "audit_ref") !== input.auditRef
          || row["failure_code"] !== null
          || row["terminal_at"] === null
          || row["activated_at"] === null
          || row["released_at"] === null
          || canonicalRows.length !== 1
          || !canonicalBindingMatches(canonicalRows[0]!, candidate.binding)
          || requiredCounter(row, "head_access_revision") !== accessRevision
          || !equalBytes(
            requiredBytes(row, "head_binding_hash"),
            candidate.binding.bindingHash,
          )
          || requiredString(row, "head_domain_id") !== targetDomainId
          || requiredCounter(row, "head_domain_epoch") !== targetDomainEpoch
          || requiredBoolean(row, "head_writes_paused")
          || row["head_pause_operation_id"] !== null
        ) return { status: "stale_state" };
        const outboxRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            outbox_id: cryptoOperationOutbox.outboxId,
            event_type: cryptoOperationOutbox.eventType,
            payload_bytes: cryptoOperationOutbox.payloadBytes,
            idempotency_key: cryptoOperationOutbox.idempotencyKey,
          }).from(cryptoOperationOutbox).where(and(
            eq(cryptoOperationOutbox.operationId, input.operationId),
            eq(
              cryptoOperationOutbox.eventType,
              "crypto_human_membership_committed",
            ),
          )).limit(2),
        );
        if (
          outboxRows.length !== 1
          || requiredString(outboxRows[0]!, "outbox_id") !== input.outboxId
          || requiredString(outboxRows[0]!, "event_type")
            !== "crypto_human_membership_committed"
          || requiredString(outboxRows[0]!, "idempotency_key")
            !== input.outboxId
          || !equalBytes(
            requiredBytes(outboxRows[0]!, "payload_bytes"),
            payload,
          )
        ) return { status: "stale_state" };
        return { status: "duplicate", kind, namespaceId, accessRevision };
      }

      const oldParticipants = requiredStringArray(row, "old_participants");
      const newParticipants = requiredStringArray(row, "new_participants");
      const requiredDeviceId = kind === "human_add"
        ? nullableString(row, "bootstrap_device_id")
        : nullableString(row, "committer_device_id");
      const expectedPause = kind === "human_remove";
      const requiredMessageCount = requiredCounter(
        row,
        "required_message_count",
      );
      if (
        row["failure_code"] !== null
        || row["audit_ref"] !== null
        || row["terminal_at"] !== null
        || !requiredBoolean(row, "deadline_live")
        || row["lease_owner"] !== null
        || row["lease_expires_at"] !== null
        || row["activated_at"] !== null
        || row["released_at"] !== null
        || !sameStrings(
          oldParticipants,
          requiredStringArray(row, "source_participants"),
        )
        || !equalBytes(
          requiredBytes(row, "old_participant_digest"),
          requiredBytes(row, "source_participant_digest"),
        )
        || !sameStrings(
          newParticipants,
          requiredStringArray(row, "target_participants"),
        )
        || !equalBytes(
          requiredBytes(row, "new_participant_digest"),
          requiredBytes(row, "target_participant_digest"),
        )
        || requiredCounter(row, "target_epoch") !== targetDomainEpoch
        || requiredCounter(row, "target_provider_epoch") !== targetDomainEpoch
        || requiredBoolean(row, "target_writes_paused")
        || requiredCounter(row, "head_access_revision")
          !== expectedAccessRevision
        || !equalBytes(
          requiredBytes(row, "head_binding_hash"),
          requiredBytes(row, "expected_binding_hash"),
        )
        || requiredString(row, "head_domain_id")
          !== requiredString(row, "old_domain_id")
        || requiredCounter(row, "head_domain_epoch")
          !== requiredCounter(row, "source_epoch")
        || requiredBoolean(row, "head_writes_paused") !== expectedPause
        || (
          expectedPause
            ? nullableString(row, "head_pause_operation_id")
                !== input.operationId
            : row["head_pause_operation_id"] !== null
        )
        || requiredDeviceId === null
        || nullableString(row, "required_device_id") !== requiredDeviceId
        || requiredString(row, "required_device_state") !== "active"
        || nullableString(row, "required_mapping_human_id")
          !== nullableString(row, "required_device_human_id")
        || requiredCounter(row, "required_mapping_joined_epoch")
          > targetDomainEpoch
        || row["required_mapping_removed_epoch"] !== null
        || row["required_mapping_removed_at"] !== null
        || (
          kind === "human_add"
          && nullableString(row, "required_device_human_actor_id")
            !== requiredString(row, "target_human_actor_id")
        )
        || requiredCounter(row, "message_count")
          !== requiredCounter(row, "fanout_row_count")
        || requiredCounter(row, "message_payload_bytes")
          !== requiredCounter(row, "aggregate_payload_bytes")
        || requiredMessageCount < 1
        || requiredCounter(row, "required_acknowledged_count")
          !== requiredMessageCount
      ) return { status: "not_ready" };
      if (canonicalRows.length !== 0) return { status: "stale_state" };

      await expectSingleMutation(
        transaction,
        `INSERT INTO namespace_crypto_bindings (
           namespace_id, revision, binding_hash, previous_binding_hash,
           signed_binding_bytes, human_keyring_envelope_bytes,
           ai_keyring_envelope_bytes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING namespace_id`,
        [
          namespaceId,
          accessRevision,
          candidate.binding.bindingHash,
          candidate.binding.previousBindingHash,
          candidate.binding.signedBindingBytes,
          candidate.binding.humanKeyringEnvelopeBytes,
          candidate.binding.aiKeyringEnvelopeBytes,
        ],
        "Human membership canonical binding append",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE namespace_crypto_heads
            SET access_revision = $2, binding_hash = $3,
                domain_id = $4, domain_epoch = $5,
                writes_paused = false, pause_operation_id = NULL
          WHERE namespace_id = $1
            AND access_revision = $6
            AND binding_hash = $7
            AND domain_id = $8
            AND domain_epoch = $10
            AND (
              (
                $9::text IS NULL
                AND writes_paused = false
                AND pause_operation_id IS NULL
              )
              OR (
                $9::text IS NOT NULL
                AND writes_paused = true
                AND pause_operation_id = $9
              )
            )
          RETURNING namespace_id`,
        [
          namespaceId,
          accessRevision,
          candidate.binding.bindingHash,
          targetDomainId,
          targetDomainEpoch,
          expectedAccessRevision,
          requiredBytes(row, "expected_binding_hash"),
          requiredString(row, "old_domain_id"),
          expectedPause ? input.operationId : null,
          requiredCounter(row, "source_epoch"),
        ],
        "Human membership Namespace head activation",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_human_membership_transitions
            SET activated_at = $2::timestamptz,
                released_at = $2::timestamptz
          WHERE operation_id = $1
            AND activated_at IS NULL
            AND released_at IS NULL
          RETURNING operation_id`,
        [input.operationId, activatedAt],
        "Human membership transition activation",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_delivery_operations
            SET state = 'active', failure_code = NULL, audit_ref = $2,
                updated_at = $3::timestamptz,
                terminal_at = $3::timestamptz,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE operation_id = $1
            AND kind = $4
            AND state = 'ready_to_activate'
          RETURNING operation_id`,
        [input.operationId, input.auditRef, activatedAt, kind],
        "Human membership operation activation",
      );
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_operation_outbox (
           outbox_id, operation_id, sequence, event_type, payload_bytes,
           idempotency_key, claimed_by, claim_expires_at, attempts,
           maximum_attempts, delivered_at, terminal_at, failure_code,
           created_at
         ) VALUES (
           $1, $2, $3, 'crypto_human_membership_committed', $4, $1,
           NULL, NULL, 0, $5, NULL, NULL, NULL, $6::timestamptz
         )
         RETURNING outbox_id`,
        [
          input.outboxId,
          input.operationId,
          requiredCounter(row, "next_outbox_sequence"),
          payload,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          activatedAt,
        ],
        "Human membership committed outbox insert",
      );
      return { status: "activated", kind, namespaceId, accessRevision };
    });
  }
}
