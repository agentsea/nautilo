import {
  and,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDeliveryAcknowledgements,
  cryptoDeliveryMessages,
  cryptoDomainTransitionNamespaces,
  cryptoDomainTransitionSteps,
  cryptoDomains,
  cryptoOperationOutbox,
  eq,
  inArray,
  namespaceCryptoHeads,
  sql,
} from "@nautilo/db";
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
const BLOCKED_FAILURE_CODE = "domain_rebootstrap_required";

export type DeviceRevocationFinalizationResult =
  | {
    readonly status: "finalized" | "duplicate";
    readonly operationState: "active" | "failed";
    readonly activatedDomainCount: number;
    readonly blockedDomainCount: number;
  }
  | { readonly status: "not_ready" | "stale_state" };

interface DomainStep {
  readonly domainId: string;
  readonly state: "ready_to_activate" | "active" | "failed";
  readonly expectedEpoch: number;
  readonly targetEpoch: number;
  readonly expectedAuthorizationRevision: number;
  readonly expectedParticipantDigest: Uint8Array;
  readonly expectedProviderStateHash: Uint8Array | null;
  readonly candidateProviderId: string | null;
  readonly candidateProviderStateHash: Uint8Array | null;
  readonly candidateRosterBytes: Uint8Array | null;
  readonly candidateTargetLeafIndex: number | null;
}

interface NamespaceStep {
  readonly domainId: string;
  readonly namespaceId: string;
  readonly state: "pending" | "prepared" | "active" | "failed";
  readonly expectedAccessRevision: number;
  readonly expectedBindingHash: Uint8Array;
  readonly candidateBindingHash: Uint8Array | null;
  readonly candidateSignedBindingBytes: Uint8Array | null;
  readonly candidateHumanKeyringEnvelopeBytes: Uint8Array | null;
  readonly candidateAiKeyringEnvelopeBytes: Uint8Array | null;
}

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(
      `Device revocation finalization column ${name} must be text`,
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
      `Device revocation finalization column ${name} must be bytea`,
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
      `Device revocation finalization column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function nullableCounter(row: DatabaseRow, name: string): number | null {
  return row[name] === null ? null : requiredCounter(row, name);
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(
      `Device revocation finalization column ${name} must be boolean`,
    );
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      "Device revocation finalization timestamp must be nonnegative",
    );
  }
  return new Date(milliseconds).toISOString();
}

function portable(label: string, value: string): void {
  if (
    value.length < 1
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

function terminalPayload(input: {
  readonly operationId: string;
  readonly targetDeviceId: string;
  readonly activatedDomainCount: number;
  readonly blockedDomainCount: number;
  readonly operationState: "active" | "failed";
}): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    formatVersion: 1,
    eventType: input.operationState === "active"
      ? "crypto_device_revocation_finalized"
      : "crypto_device_revocation_blocked",
    operationId: input.operationId,
    targetDeviceId: input.targetDeviceId,
    activatedDomainCount: input.activatedDomainCount,
    blockedDomainCount: input.blockedDomainCount,
  }));
}

export class PostgresDeviceRevocationFinalizationRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  finalize(input: {
    readonly operationId: string;
    readonly finalizedAt: number;
    readonly auditRef: string;
    readonly outboxId: string;
  }): Promise<DeviceRevocationFinalizationResult> {
    portable("Device revocation finalization operation id", input.operationId);
    portable("Device revocation finalization audit ref", input.auditRef);
    portable("Device revocation finalization outbox id", input.outboxId);
    const finalizedAt = isoTime(input.finalizedAt);

    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`device-revocation-finalization/${input.operationId}`],
      );

      const operations = await transaction.query(
        `SELECT o.operation_id, o.kind AS operation_kind,
                o.state AS operation_state,
                o.human_id AS operation_human_id,
                o.target_device_id AS operation_target_device_id,
                o.expected_device_revision
                  AS operation_expected_device_revision,
                o.fanout_row_count AS operation_fanout_row_count,
                o.aggregate_payload_bytes
                  AS operation_aggregate_payload_bytes,
                o.failure_code AS operation_failure_code,
                o.audit_ref AS operation_audit_ref,
                o.terminal_at AS operation_terminal_at,
                o.lease_owner AS operation_lease_owner,
                o.lease_expires_at AS operation_lease_expires_at,
                e.target_device_id AS epoch_target_device_id,
                e.owner_human_id AS epoch_owner_human_id,
                e.expected_device_revision
                  AS epoch_expected_device_revision,
                d.human_id AS target_human_id,
                d.state AS target_state,
                d.revision AS target_revision,
                d.revoked_at AS target_revoked_at,
                (
                  SELECT coalesce(max(outbox.sequence), -1) + 1
                    FROM crypto_operation_outbox outbox
                   WHERE outbox.operation_id = o.operation_id
                )::bigint AS next_outbox_sequence
           FROM crypto_delivery_operations o
           JOIN crypto_device_epoch_operations e
             ON e.operation_id = o.operation_id
           JOIN human_crypto_devices d
             ON d.device_id = o.target_device_id
          WHERE o.operation_id = $1
          LIMIT 2
          FOR UPDATE OF o, e, d`,
        [input.operationId],
      );
      if (operations.length !== 1) return { status: "stale_state" };
      const operation = operations[0]!;

      const domainRows = await transaction.query(
        `SELECT s.domain_id, s.state AS step_state, s.failure_code,
                s.expected_epoch, s.target_epoch,
                s.expected_authorization_revision,
                s.expected_participant_digest,
                s.expected_provider_state_hash,
                s.candidate_provider_id,
                s.candidate_provider_state_hash,
                s.candidate_roster_bytes,
                s.candidate_transition_digest,
                s.candidate_target_leaf_index,
                s.lease_owner AS step_lease_owner,
                s.lease_expires_at AS step_lease_expires_at,
                d.epoch AS current_epoch,
                d.authorization_revision AS current_authorization_revision,
                d.participant_digest AS current_participant_digest,
                d.roster_bytes AS current_roster_bytes,
                d.writes_paused AS domain_writes_paused,
                d.pause_operation_id AS domain_pause_operation_id,
                p.provider_id, p.epoch AS provider_epoch,
                p.state_hash AS provider_state_hash,
                p.roster_bytes AS provider_roster_bytes,
                target_mapping.device_id AS target_mapping_device_id,
                target_mapping.human_id AS target_mapping_human_id,
                target_mapping.leaf_index AS target_mapping_leaf_index,
                target_mapping.joined_epoch AS target_mapping_joined_epoch,
                target_mapping.removed_epoch AS target_mapping_removed_epoch,
                target_mapping.removed_at AS target_mapping_removed_at
           FROM crypto_domain_transition_steps s
           JOIN crypto_delivery_operations operation
             ON operation.operation_id = s.operation_id
           JOIN crypto_domains d ON d.id = s.domain_id
           JOIN crypto_domain_provider_heads p ON p.domain_id = d.id
           LEFT JOIN crypto_domain_devices target_mapping
             ON target_mapping.domain_id = s.domain_id
            AND target_mapping.device_id = operation.target_device_id
          WHERE s.operation_id = $1
          ORDER BY convert_to(s.domain_id, 'UTF8')
          LIMIT $2
          FOR UPDATE OF s, d, p`,
        [
          input.operationId,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation + 1,
        ],
      );
      const namespaceRows = await transaction.query(
        `SELECT n.domain_id, n.namespace_id,
                n.state AS namespace_state,
                n.failure_code AS namespace_failure_code,
                n.expected_access_revision, n.expected_binding_hash,
                n.candidate_binding_hash,
                n.candidate_signed_binding_bytes,
                n.candidate_human_keyring_envelope_bytes,
                n.candidate_ai_keyring_envelope_bytes,
                candidate.revision AS candidate_revision,
                candidate.binding_hash
                  AS persisted_candidate_binding_hash,
                candidate.previous_binding_hash
                  AS candidate_previous_binding_hash,
                candidate.signed_binding_bytes
                  AS persisted_candidate_signed_bytes,
                candidate.human_keyring_envelope_bytes
                  AS persisted_candidate_human_keyring_bytes,
                candidate.ai_keyring_envelope_bytes
                  AS persisted_candidate_ai_keyring_bytes
           FROM crypto_domain_transition_namespaces n
           LEFT JOIN namespace_crypto_bindings candidate
             ON candidate.namespace_id = n.namespace_id
            AND candidate.revision = n.expected_access_revision + 1
            AND candidate.binding_hash = n.candidate_binding_hash
          WHERE n.operation_id = $1
          ORDER BY convert_to(n.namespace_id, 'UTF8')
          LIMIT $2
          FOR UPDATE OF n`,
        [
          input.operationId,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation + 1,
        ],
      );
      const headRows = await transaction.query(
        `SELECT h.namespace_id, h.domain_id, h.domain_epoch,
                h.access_revision, h.binding_hash, h.writes_paused,
                h.pause_operation_id
           FROM namespace_crypto_heads h
           JOIN crypto_domain_transition_steps s
             ON s.domain_id = h.domain_id
            AND s.operation_id = $1
          ORDER BY convert_to(h.namespace_id, 'UTF8')
          LIMIT $2
          FOR UPDATE OF h`,
        [
          input.operationId,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation + 1,
        ],
      );
      const deliveryRows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          message_count:
            sql<number>`count(${cryptoDeliveryMessages.messageId})::bigint`
              .as("message_count"),
          acknowledged_count:
            sql<number>`count(${cryptoDeliveryAcknowledgements.messageId})::bigint`
              .as("acknowledged_count"),
          successful_message_count: sql<number>`count(
            ${cryptoDeliveryMessages.messageId}) filter (where
            ${cryptoDomainTransitionSteps.state} in
            ('ready_to_activate', 'active'))::bigint`
            .as("successful_message_count"),
          successful_acknowledged_count: sql<number>`count(
            ${cryptoDeliveryAcknowledgements.messageId}) filter (where
            ${cryptoDomainTransitionSteps.state} in
            ('ready_to_activate', 'active'))::bigint`
            .as("successful_acknowledged_count"),
          aggregate_payload_bytes: sql<number>`coalesce(sum(octet_length(
            ${cryptoDeliveryMessages.payloadBytes})), 0)::bigint`
            .as("aggregate_payload_bytes"),
          invalid_message_count: sql<number>`count(
            ${cryptoDeliveryMessages.messageId}) filter (where
            ${cryptoDeliveryMessages.domainId} is null or
            ${cryptoDomainTransitionSteps.operationId} is null or
            ${cryptoDomainTransitionSteps.state} not in
            ('ready_to_activate', 'active', 'failed'))::bigint`
            .as("invalid_message_count"),
        }).from(cryptoDeliveryMessages).leftJoin(
          cryptoDomainTransitionSteps,
          and(
            eq(
              cryptoDomainTransitionSteps.operationId,
              cryptoDeliveryMessages.operationId,
            ),
            eq(
              cryptoDomainTransitionSteps.domainId,
              cryptoDeliveryMessages.domainId,
            ),
          ),
        ).leftJoin(
          cryptoDeliveryAcknowledgements,
          and(
            eq(
              cryptoDeliveryAcknowledgements.messageId,
              cryptoDeliveryMessages.messageId,
            ),
            eq(
              cryptoDeliveryAcknowledgements.deviceId,
              cryptoDeliveryMessages.recipientDeviceId,
            ),
          ),
        ).where(eq(cryptoDeliveryMessages.operationId, input.operationId)),
      );
      if (
        domainRows.length
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation
        || namespaceRows.length
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation
        || headRows.length
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation
        || deliveryRows.length !== 1
      ) return { status: "stale_state" };

      const operationId = requiredString(operation, "operation_id");
      const targetDeviceId = requiredString(
        operation,
        "operation_target_device_id",
      );
      const expectedDeviceRevision = requiredCounter(
        operation,
        "operation_expected_device_revision",
      );
      if (
        operationId !== input.operationId
        || requiredString(operation, "operation_kind") !== "device_revoke"
        || requiredString(operation, "epoch_target_device_id")
          !== targetDeviceId
        || requiredString(operation, "epoch_owner_human_id")
          !== requiredString(operation, "operation_human_id")
        || requiredString(operation, "target_human_id")
          !== requiredString(operation, "operation_human_id")
        || requiredCounter(operation, "epoch_expected_device_revision")
          !== expectedDeviceRevision
        || requiredString(operation, "target_state") !== "revoked"
        || requiredCounter(operation, "target_revision")
          !== expectedDeviceRevision + 1
        || operation["target_revoked_at"] === null
        || operation["operation_lease_owner"] !== null
        || operation["operation_lease_expires_at"] !== null
      ) return { status: "stale_state" };

      const operationState = requiredString(operation, "operation_state");
      const terminal = operationState === "active"
        || operationState === "failed";
      if (!terminal && operationState !== "ready_to_activate") {
        return { status: "not_ready" };
      }
      if (
        !terminal
        && (
          operation["operation_failure_code"] !== null
          || operation["operation_audit_ref"] !== null
          || operation["operation_terminal_at"] !== null
        )
      ) return { status: "stale_state" };

      const domains: DomainStep[] = [];
      for (const row of domainRows) {
        const state = requiredString(row, "step_state");
        if (
          state !== "ready_to_activate"
          && state !== "active"
          && state !== "failed"
        ) return { status: "not_ready" };
        if (
          row["step_lease_owner"] !== null
          || row["step_lease_expires_at"] !== null
          || (state === "failed"
            ? nullableString(row, "failure_code") !== BLOCKED_FAILURE_CODE
            : row["failure_code"] !== null)
        ) return { status: "stale_state" };
        domains.push({
          domainId: requiredString(row, "domain_id"),
          state,
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
          expectedProviderStateHash: nullableBytes(
            row,
            "expected_provider_state_hash",
          ),
          candidateProviderId: nullableString(
            row,
            "candidate_provider_id",
          ),
          candidateProviderStateHash: nullableBytes(
            row,
            "candidate_provider_state_hash",
          ),
          candidateRosterBytes: nullableBytes(
            row,
            "candidate_roster_bytes",
          ),
          candidateTargetLeafIndex: nullableCounter(
            row,
            "candidate_target_leaf_index",
          ),
        });
      }
      const successfulDomains = domains.filter((domain) =>
        domain.state !== "failed"
      );
      const blockedDomains = domains.filter((domain) =>
        domain.state === "failed"
      );
      const expectedSuccessfulState = terminal
        ? "active"
        : "ready_to_activate";
      if (
        successfulDomains.some((domain) =>
          domain.state !== expectedSuccessfulState
          || domain.expectedProviderStateHash === null
          || domain.candidateProviderId === null
          || domain.candidateProviderStateHash === null
          || domain.candidateRosterBytes === null
          || domain.candidateTargetLeafIndex === null
        )
      ) return { status: "not_ready" };

      const namespaces: NamespaceStep[] = [];
      for (const row of namespaceRows) {
        const state = requiredString(row, "namespace_state");
        if (
          state !== "pending"
          && state !== "prepared"
          && state !== "active"
          && state !== "failed"
        ) return { status: "stale_state" };
        const domain = domains.find((candidate) =>
          candidate.domainId === requiredString(row, "domain_id")
        );
        if (domain === undefined) return { status: "stale_state" };
        const candidateBindingHash = nullableBytes(
          row,
          "candidate_binding_hash",
        );
        if (domain.state !== "failed") {
          if (
            state !== (terminal ? "active" : "prepared")
            || row["namespace_failure_code"] !== null
            || candidateBindingHash === null
            || requiredBytes(
              row,
              "candidate_signed_binding_bytes",
            ).length < 1
            || requiredBytes(
              row,
              "candidate_human_keyring_envelope_bytes",
            ).length < 1
            || requiredBytes(
              row,
              "candidate_ai_keyring_envelope_bytes",
            ).length < 1
          ) return { status: terminal ? "stale_state" : "not_ready" };
          if (
            terminal
              ? nullableCounter(row, "candidate_revision")
                  !== requiredCounter(row, "expected_access_revision") + 1
                || !equalBytes(
                  requiredBytes(row, "persisted_candidate_binding_hash"),
                  candidateBindingHash,
                )
                || !equalBytes(
                  requiredBytes(row, "candidate_previous_binding_hash"),
                  requiredBytes(row, "expected_binding_hash"),
                )
                || !equalBytes(
                  requiredBytes(row, "persisted_candidate_signed_bytes"),
                  requiredBytes(row, "candidate_signed_binding_bytes"),
                )
                || !equalBytes(
                  requiredBytes(
                    row,
                    "persisted_candidate_human_keyring_bytes",
                  ),
                  requiredBytes(
                    row,
                    "candidate_human_keyring_envelope_bytes",
                  ),
                )
                || !equalBytes(
                  requiredBytes(
                    row,
                    "persisted_candidate_ai_keyring_bytes",
                  ),
                  requiredBytes(
                    row,
                    "candidate_ai_keyring_envelope_bytes",
                  ),
                )
              : row["candidate_revision"] !== null
                || row["persisted_candidate_binding_hash"] !== null
                || row["candidate_previous_binding_hash"] !== null
          ) return { status: "stale_state" };
        } else {
          if (
            terminal
              ? state !== "failed"
                || nullableString(row, "namespace_failure_code")
                  !== BLOCKED_FAILURE_CODE
              : state === "active"
                || (
                  state === "failed"
                    ? nullableString(row, "namespace_failure_code")
                        !== BLOCKED_FAILURE_CODE
                    : row["namespace_failure_code"] !== null
                )
          ) return { status: "stale_state" };
          if (
            candidateBindingHash === null
              ? row["candidate_revision"] !== null
                || row["persisted_candidate_binding_hash"] !== null
                || row["candidate_previous_binding_hash"] !== null
              : row["candidate_revision"] !== null
                || row["persisted_candidate_binding_hash"] !== null
                || row["candidate_previous_binding_hash"] !== null
          ) return { status: "stale_state" };
        }
        namespaces.push({
          domainId: domain.domainId,
          namespaceId: requiredString(row, "namespace_id"),
          state,
          expectedAccessRevision: requiredCounter(
            row,
            "expected_access_revision",
          ),
          expectedBindingHash: requiredBytes(row, "expected_binding_hash"),
          candidateBindingHash,
          candidateSignedBindingBytes: nullableBytes(
            row,
            "candidate_signed_binding_bytes",
          ),
          candidateHumanKeyringEnvelopeBytes: nullableBytes(
            row,
            "candidate_human_keyring_envelope_bytes",
          ),
          candidateAiKeyringEnvelopeBytes: nullableBytes(
            row,
            "candidate_ai_keyring_envelope_bytes",
          ),
        });
      }

      for (const row of domainRows) {
        const domain = domains.find((candidate) =>
          candidate.domainId === requiredString(row, "domain_id")
        )!;
        const successful = domain.state !== "failed";
        const expectedEpoch = successful && terminal
          ? domain.targetEpoch
          : domain.expectedEpoch;
        const expectedPaused = successful ? !terminal : true;
        const expectedOwner = expectedPaused ? input.operationId : null;
        const targetMappingDeviceId = nullableString(
          row,
          "target_mapping_device_id",
        );
        if (
          requiredCounter(row, "current_epoch") !== expectedEpoch
          || requiredCounter(row, "current_authorization_revision")
            !== domain.expectedAuthorizationRevision
          || !equalBytes(
            requiredBytes(row, "current_participant_digest"),
            domain.expectedParticipantDigest,
          )
          || requiredCounter(row, "provider_epoch") !== expectedEpoch
          || requiredBoolean(row, "domain_writes_paused") !== expectedPaused
          || nullableString(row, "domain_pause_operation_id") !== expectedOwner
          || targetMappingDeviceId !== targetDeviceId
          || nullableString(row, "target_mapping_human_id")
            !== requiredString(operation, "operation_human_id")
          || (
            domain.candidateTargetLeafIndex !== null
            && nullableCounter(row, "target_mapping_leaf_index")
              !== domain.candidateTargetLeafIndex
          )
          || (
            successful && terminal
              ? row["target_mapping_removed_epoch"] === null
                || requiredCounter(row, "target_mapping_removed_epoch")
                  !== domain.targetEpoch
                || row["target_mapping_removed_at"] === null
              : row["target_mapping_removed_epoch"] !== null
                || row["target_mapping_removed_at"] !== null
          )
        ) return { status: "stale_state" };
        if (successful) {
          if (
            requiredString(row, "provider_id")
                !== domain.candidateProviderId
            || !equalBytes(
              requiredBytes(row, "provider_state_hash"),
              terminal
                ? domain.candidateProviderStateHash!
                : domain.expectedProviderStateHash!,
            )
            || !equalBytes(
              requiredBytes(row, "provider_roster_bytes"),
              terminal
                ? domain.candidateRosterBytes!
                : requiredBytes(row, "current_roster_bytes"),
            )
            || (
              terminal
                ? !equalBytes(
                  requiredBytes(row, "current_roster_bytes"),
                  domain.candidateRosterBytes!,
                )
                : false
            )
          ) return { status: "stale_state" };
        } else if (
          !equalBytes(
            requiredBytes(row, "provider_roster_bytes"),
            requiredBytes(row, "current_roster_bytes"),
          )
          || (
            domain.expectedProviderStateHash !== null
            && !equalBytes(
              requiredBytes(row, "provider_state_hash"),
              domain.expectedProviderStateHash,
            )
          )
        ) return { status: "stale_state" };
      }

      for (const row of headRows) {
        const domainId = requiredString(row, "domain_id");
        const domain = domains.find((candidate) =>
          candidate.domainId === domainId
        );
        if (domain === undefined) return { status: "stale_state" };
        const successful = domain.state !== "failed";
        const expectedPaused = successful ? !terminal : true;
        if (
          requiredBoolean(row, "writes_paused") !== expectedPaused
          || nullableString(row, "pause_operation_id")
            !== (expectedPaused ? input.operationId : null)
        ) return { status: "stale_state" };
        const namespace = namespaces.find((candidate) =>
          candidate.domainId === domainId
          && candidate.namespaceId === requiredString(row, "namespace_id")
        );
        if (namespace === undefined) return { status: "stale_state" };
        if (successful) {
          if (
            requiredCounter(row, "domain_epoch") !== (
              terminal ? domain.targetEpoch : domain.expectedEpoch
            )
            || requiredCounter(row, "access_revision")
              !== (
                terminal
                  ? namespace.expectedAccessRevision + 1
                  : namespace.expectedAccessRevision
              )
            || !equalBytes(
              requiredBytes(row, "binding_hash"),
              terminal
                ? namespace.candidateBindingHash!
                : namespace.expectedBindingHash,
            )
          ) return { status: "stale_state" };
        } else if (
          requiredCounter(row, "domain_epoch") !== domain.expectedEpoch
          || requiredCounter(row, "access_revision")
            !== namespace.expectedAccessRevision
          || !equalBytes(
            requiredBytes(row, "binding_hash"),
            namespace.expectedBindingHash,
          )
        ) return { status: "stale_state" };
      }
      if (
        namespaces.some((namespace) =>
          !headRows.some((row) =>
            requiredString(row, "domain_id") === namespace.domainId
            && requiredString(row, "namespace_id") === namespace.namespaceId
          )
        )
      ) return { status: "stale_state" };
      const successfulNamespaces = namespaces.filter((namespace) =>
        successfulDomains.some((domain) =>
          domain.domainId === namespace.domainId
        )
      );

      const delivery = deliveryRows[0]!;
      const messageCount = requiredCounter(delivery, "message_count");
      requiredCounter(delivery, "acknowledged_count");
      const successfulMessageCount = requiredCounter(
        delivery,
        "successful_message_count",
      );
      const successfulAcknowledgedCount = requiredCounter(
        delivery,
        "successful_acknowledged_count",
      );
      const aggregatePayloadBytes = requiredCounter(
        delivery,
        "aggregate_payload_bytes",
      );
      const retainedAccountingIsExact = messageCount
          === requiredCounter(operation, "operation_fanout_row_count")
        && aggregatePayloadBytes
          === requiredCounter(
            operation,
            "operation_aggregate_payload_bytes",
          );
      if (
        messageCount
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation
        || requiredCounter(delivery, "invalid_message_count") !== 0
        || (
          terminal
            ? messageCount !== 0
              && (!retainedAccountingIsExact
                || successfulAcknowledgedCount !== successfulMessageCount)
            : !retainedAccountingIsExact
        )
      ) return { status: "stale_state" };
      if (
        !terminal
        && successfulAcknowledgedCount !== successfulMessageCount
      ) {
        return { status: "not_ready" };
      }

      const finalOperationState = blockedDomains.length === 0
        ? "active"
        : "failed";
      const payload = terminalPayload({
        operationId,
        targetDeviceId,
        activatedDomainCount: successfulDomains.length,
        blockedDomainCount: blockedDomains.length,
        operationState: finalOperationState,
      });
      const eventType = finalOperationState === "active"
        ? "crypto_device_revocation_finalized"
        : "crypto_device_revocation_blocked";

      if (terminal) {
        if (
          operationState !== finalOperationState
          || nullableString(operation, "operation_failure_code")
            !== (
              finalOperationState === "failed" ? BLOCKED_FAILURE_CODE : null
            )
          || nullableString(operation, "operation_audit_ref") !== input.auditRef
          || operation["operation_terminal_at"] === null
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
            inArray(cryptoOperationOutbox.eventType, [
              "crypto_device_revocation_finalized",
              "crypto_device_revocation_blocked",
            ]),
          )).limit(2),
        );
        if (
          outboxRows.length > 1
          || (
            outboxRows.length === 1
            && (
              requiredString(outboxRows[0]!, "outbox_id") !== input.outboxId
              || requiredString(outboxRows[0]!, "event_type") !== eventType
              || requiredString(outboxRows[0]!, "idempotency_key")
                !== input.outboxId
              || !equalBytes(
                requiredBytes(outboxRows[0]!, "payload_bytes"),
                payload,
              )
            )
          )
        ) return { status: "stale_state" };
        return {
          status: "duplicate",
          operationState: finalOperationState,
          activatedDomainCount: successfulDomains.length,
          blockedDomainCount: blockedDomains.length,
        };
      }

      for (const namespace of namespaces) {
        const domain = domains.find((candidate) =>
          candidate.domainId === namespace.domainId
        )!;
        if (domain.state === "failed") {
          if (namespace.state !== "failed") {
            await expectSingleMutation(
              transaction,
              `UPDATE crypto_domain_transition_namespaces
                  SET state = 'failed', failure_code = $4,
                      updated_at = $5::timestamptz
                WHERE operation_id = $1
                  AND domain_id = $2
                  AND namespace_id = $3
                  AND state = $6
                RETURNING namespace_id`,
              [
                input.operationId,
                namespace.domainId,
                namespace.namespaceId,
                BLOCKED_FAILURE_CODE,
                finalizedAt,
                namespace.state,
              ],
              "Device revocation blocked Namespace terminalization",
            );
          }
          continue;
        }
        await expectSingleMutation(
          transaction,
          `INSERT INTO namespace_crypto_bindings (
             namespace_id, revision, binding_hash, previous_binding_hash,
             signed_binding_bytes, human_keyring_envelope_bytes,
             ai_keyring_envelope_bytes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING namespace_id`,
          [
            namespace.namespaceId,
            namespace.expectedAccessRevision + 1,
            namespace.candidateBindingHash!,
            namespace.expectedBindingHash,
            namespace.candidateSignedBindingBytes!,
            namespace.candidateHumanKeyringEnvelopeBytes!,
            namespace.candidateAiKeyringEnvelopeBytes!,
          ],
          "Device revocation canonical Namespace binding append",
        );
        await expectSingleMutation(
          transaction,
          `UPDATE namespace_crypto_heads
              SET access_revision = $2, binding_hash = $3,
                  domain_epoch = $5
            WHERE namespace_id = $1
              AND access_revision = $4
              AND binding_hash = $6
              AND domain_id = $7
              AND domain_epoch = $8
              AND writes_paused = true
              AND pause_operation_id = $9
            RETURNING namespace_id`,
          [
            namespace.namespaceId,
            namespace.expectedAccessRevision + 1,
            namespace.candidateBindingHash!,
            namespace.expectedAccessRevision,
            domain.targetEpoch,
            namespace.expectedBindingHash,
            namespace.domainId,
            domain.expectedEpoch,
            input.operationId,
          ],
          "Device revocation Namespace head activation",
        );
        await expectSingleMutation(
          transaction,
          `UPDATE crypto_domain_transition_namespaces
              SET state = 'active', failure_code = NULL,
                  updated_at = $4::timestamptz
            WHERE operation_id = $1
              AND domain_id = $2
              AND namespace_id = $3
              AND state = 'prepared'
            RETURNING namespace_id`,
          [
            input.operationId,
            namespace.domainId,
            namespace.namespaceId,
            finalizedAt,
          ],
          "Device revocation Namespace activation",
        );
      }
      for (const domain of successfulDomains) {
        const row = domainRows.find((candidate) =>
          requiredString(candidate, "domain_id") === domain.domainId
        )!;
        await expectSingleMutation(
          transaction,
          `UPDATE crypto_domain_provider_heads
              SET epoch = $3, state_hash = $4, roster_bytes = $5
            WHERE domain_id = $1
              AND epoch = $2
              AND provider_id = $6
              AND state_hash = $7
              AND roster_bytes = $8
            RETURNING domain_id`,
          [
            domain.domainId,
            domain.expectedEpoch,
            domain.targetEpoch,
            domain.candidateProviderStateHash!,
            domain.candidateRosterBytes!,
            domain.candidateProviderId!,
            domain.expectedProviderStateHash!,
            requiredBytes(row, "provider_roster_bytes"),
          ],
          "Device revocation provider head activation",
        );
        await expectSingleMutation(
          transaction,
          `UPDATE crypto_domains
              SET epoch = $3, roster_bytes = $4
            WHERE id = $1
              AND epoch = $2
              AND authorization_revision = $5
              AND participant_digest = $6
              AND roster_bytes = $7
              AND writes_paused = true
              AND pause_operation_id = $8
            RETURNING id`,
          [
            domain.domainId,
            domain.expectedEpoch,
            domain.targetEpoch,
            domain.candidateRosterBytes!,
            domain.expectedAuthorizationRevision,
            domain.expectedParticipantDigest,
            requiredBytes(row, "current_roster_bytes"),
            input.operationId,
          ],
          "Device revocation Domain head activation",
        );
        await expectSingleMutation(
          transaction,
          `UPDATE crypto_domain_devices
              SET removed_epoch = $3, removed_at = $4::timestamptz
            WHERE domain_id = $1
              AND device_id = $2
              AND human_id = $5
              AND leaf_index = $6
              AND removed_epoch IS NULL
              AND removed_at IS NULL
            RETURNING device_id`,
          [
            domain.domainId,
            targetDeviceId,
            domain.targetEpoch,
            finalizedAt,
            requiredString(operation, "operation_human_id"),
            domain.candidateTargetLeafIndex!,
          ],
          "Device revocation Domain membership tombstone",
        );
        await expectSingleMutation(
          transaction,
          `UPDATE crypto_domain_transition_steps
              SET state = 'active', failure_code = NULL,
                  lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = $3::timestamptz
            WHERE operation_id = $1
              AND domain_id = $2
              AND state = 'ready_to_activate'
            RETURNING domain_id`,
          [input.operationId, domain.domainId, finalizedAt],
          "Device revocation Domain activation",
        );
      }
      const resumedNamespaces = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(namespaceCryptoHeads).set({
          writesPaused: false,
          pauseOperationId: null,
        }).from(cryptoDomainTransitionNamespaces).innerJoin(
          cryptoDomainTransitionSteps,
          and(
            eq(
              cryptoDomainTransitionSteps.operationId,
              cryptoDomainTransitionNamespaces.operationId,
            ),
            eq(
              cryptoDomainTransitionSteps.domainId,
              cryptoDomainTransitionNamespaces.domainId,
            ),
          ),
        ).where(and(
          eq(
            cryptoDomainTransitionNamespaces.operationId,
            input.operationId,
          ),
          eq(
            cryptoDomainTransitionNamespaces.namespaceId,
            namespaceCryptoHeads.namespaceId,
          ),
          eq(
            cryptoDomainTransitionNamespaces.domainId,
            namespaceCryptoHeads.domainId,
          ),
          eq(cryptoDomainTransitionNamespaces.state, "active"),
          eq(cryptoDomainTransitionSteps.state, "active"),
          eq(
            namespaceCryptoHeads.domainEpoch,
            cryptoDomainTransitionSteps.targetEpoch,
          ),
          eq(
            namespaceCryptoHeads.accessRevision,
            sql`${cryptoDomainTransitionNamespaces.expectedAccessRevision} + 1`,
          ),
          eq(
            namespaceCryptoHeads.bindingHash,
            cryptoDomainTransitionNamespaces.candidateBindingHash,
          ),
          eq(namespaceCryptoHeads.writesPaused, true),
          eq(namespaceCryptoHeads.pauseOperationId, input.operationId),
        )).returning({ namespace_id: namespaceCryptoHeads.namespaceId }),
      );
      if (resumedNamespaces.length !== successfulNamespaces.length) {
        throw new Error(
          "Device revocation Namespace resume lost its compare-and-swap",
        );
      }
      const resumedDomains = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDomains).set({
          writesPaused: false,
          pauseOperationId: null,
        }).from(cryptoDomainTransitionSteps).where(and(
          eq(cryptoDomainTransitionSteps.operationId, input.operationId),
          eq(cryptoDomainTransitionSteps.domainId, cryptoDomains.id),
          eq(cryptoDomainTransitionSteps.state, "active"),
          eq(cryptoDomains.epoch, cryptoDomainTransitionSteps.targetEpoch),
          eq(
            cryptoDomains.authorizationRevision,
            cryptoDomainTransitionSteps.expectedAuthorizationRevision,
          ),
          eq(
            cryptoDomains.participantDigest,
            cryptoDomainTransitionSteps.expectedParticipantDigest,
          ),
          eq(cryptoDomains.writesPaused, true),
          eq(cryptoDomains.pauseOperationId, input.operationId),
        )).returning({
          domain_id: sql`${cryptoDomains.id}`.as("domain_id"),
        }),
      );
      if (resumedDomains.length !== successfulDomains.length) {
        throw new Error(
          "Device revocation Domain resume lost its compare-and-swap",
        );
      }
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_delivery_operations
            SET state = $2, failure_code = $3, audit_ref = $4,
                updated_at = $5::timestamptz,
                terminal_at = $5::timestamptz,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE operation_id = $1
            AND kind = 'device_revoke'
            AND state = 'ready_to_activate'
          RETURNING operation_id`,
        [
          input.operationId,
          finalOperationState,
          finalOperationState === "failed" ? BLOCKED_FAILURE_CODE : null,
          input.auditRef,
          finalizedAt,
        ],
        "Device revocation terminal operation update",
      );
      const nextOutboxSequence = requiredCounter(
        operation,
        "next_outbox_sequence",
      );
      const outboxStatement = finalOperationState === "active"
        ? `INSERT INTO crypto_operation_outbox (
             outbox_id, operation_id, sequence, event_type, payload_bytes,
             idempotency_key, claimed_by, claim_expires_at, attempts,
             maximum_attempts, delivered_at, terminal_at, failure_code,
             created_at
           ) VALUES (
             $1, $2, $3, 'crypto_device_revocation_finalized', $4, $1,
             NULL, NULL, 0, $5, NULL, NULL, NULL, $6::timestamptz
           )
           RETURNING outbox_id`
        : `INSERT INTO crypto_operation_outbox (
             outbox_id, operation_id, sequence, event_type, payload_bytes,
             idempotency_key, claimed_by, claim_expires_at, attempts,
             maximum_attempts, delivered_at, terminal_at, failure_code,
             created_at
           ) VALUES (
             $1, $2, $3, 'crypto_device_revocation_blocked', $4, $1,
             NULL, NULL, 0, $5, NULL, NULL, NULL, $6::timestamptz
           )
           RETURNING outbox_id`;
      await expectSingleMutation(
        transaction,
        outboxStatement,
        [
          input.outboxId,
          input.operationId,
          nextOutboxSequence,
          payload,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          finalizedAt,
        ],
        "Device revocation terminal outbox insert",
      );
      return {
        status: "finalized",
        operationState: finalOperationState,
        activatedDomainCount: successfulDomains.length,
        blockedDomainCount: blockedDomains.length,
      };
    });
  }
}
