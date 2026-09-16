import {
  and,
  asc,
  cryptoDeliveryMessages,
  eq,
  humanCryptoDevices,
} from "@nautilo/db";
import {
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  persistNamespaceBinding,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeProviderRosterV2,
  providerPublicTransitionDigestV2,
  storageAdapterSupportV2,
  type ProviderRosterEntryV2,
} from "@nautilo/lattice-crypto/wire";
import {
  MAX_FANOUT_PAYLOAD_BYTES,
  MAX_FANOUT_ROWS_PER_OPERATION,
  type DeviceFanoutDomainPlan,
} from "../../delivery/device-fanout.ts";
import {
  createDomainTransitionDelivery,
} from "../../delivery/domain-transition-delivery.ts";
import type {
  NamespaceTransitionSubmission,
} from "../../delivery/namespace-transition-submission.ts";
import {
  serializeNamespaceTransitionSubmission,
  verifyNamespaceTransitionSubmission,
} from "../../delivery/namespace-transition-submission.ts";
import type {
  ProviderTransitionSubmission,
} from "../../delivery/provider-transition-submission.ts";
import {
  providerTransitionSubmissionSigningBytes,
  serializeProviderTransitionSubmission,
  verifyProviderTransitionSubmission,
} from "../../delivery/provider-transition-submission.ts";
import type {
  ClaimedDomainTransition,
} from "./postgres-domain-transition-lease-repository.ts";
import {
  reserveRecipientDeliverySequences,
} from "./postgres-recipient-delivery-sequence.ts";
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

export type DomainTransitionSubmissionResult =
  | {
    readonly status: "submitted" | "duplicate";
    readonly messageCount: number;
    readonly aggregatePayloadBytes: number;
  }
  | { readonly status: "lost_lease" | "stale_state" };

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

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Crypto delivery column ${name} must be boolean`);
  }
  return value;
}

function requiredStringArray(row: DatabaseRow, name: string): readonly string[] {
  const value = row[name];
  if (!Array.isArray(value)) {
    throw new TypeError(`Crypto delivery column ${name} must be text[]`);
  }
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new TypeError(`Crypto delivery column ${name} must be text[]`);
    }
    output.push(entry);
  }
  return output;
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

function exactLease(
  row: DatabaseRow,
  claim: ClaimedDomainTransition,
  submittedAt: number,
): boolean {
  return requiredString(row, "operation_id") === claim.operationId
    && requiredString(row, "step_domain_id") === claim.domainId
    && requiredString(row, "step_state") === claim.state
    && nullableString(row, "lease_owner") === claim.workerId
    && requiredCounter(row, "lease_expires_at_ms") === claim.leaseExpiresAt
    && claim.leaseExpiresAt > submittedAt
    && requiredCounter(row, "retry_count") === claim.retryCount;
}

export class PostgresDomainTransitionSubmissionRepository {
  constructor(
    private readonly handle: CryptoPostgresHandle,
    private readonly crypto: LatticeCrypto,
  ) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  submit(input: {
    readonly claim: ClaimedDomainTransition;
    readonly providerSubmission: ProviderTransitionSubmission;
    readonly namespaceSubmission: NamespaceTransitionSubmission;
    readonly submittedAt: number;
  }): Promise<DomainTransitionSubmissionResult> {
    isoTime(input.submittedAt);
    serializeProviderTransitionSubmission(input.providerSubmission);
    serializeNamespaceTransitionSubmission(input.namespaceSubmission);
    return this.handle.transaction(async (transaction) => {
      const { claim } = input;
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`domain-transition/${claim.operationId}/${claim.domainId}`],
      );
      const current = oneOrNull(
        await transaction.query(
          `SELECT o.operation_id, o.kind AS operation_kind,
                  o.state AS operation_state,
                  o.human_id AS target_human_id,
                  o.target_device_id,
                  o.fanout_row_count AS operation_fanout_row_count,
                  o.aggregate_payload_bytes
                    AS operation_aggregate_payload_bytes,
                  s.domain_id AS step_domain_id,
                  s.state AS step_state, s.expected_epoch, s.target_epoch,
                  s.expected_authorization_revision,
                  s.expected_participant_digest, s.committer_device_id,
                  s.expected_provider_state_hash,
                  s.candidate_provider_id,
                  s.candidate_provider_state_hash,
                  s.candidate_roster_bytes,
                  s.candidate_transition_digest,
                  s.candidate_target_leaf_index,
                  s.lease_owner,
                  floor(extract(epoch from s.lease_expires_at) * 1000)::bigint
                    AS lease_expires_at_ms,
                  s.retry_count,
                  d.epoch AS domain_epoch,
                  d.authorization_revision AS domain_authorization_revision,
                  d.participant_digest AS domain_participant_digest,
                  d.participants AS domain_participants,
                  d.roster_bytes AS domain_roster_bytes,
                  d.writes_paused AS domain_writes_paused,
                  d.pause_operation_id AS domain_pause_operation_id,
                  p.provider_id, p.epoch AS provider_epoch,
                  p.state_hash AS provider_state_hash,
                  p.roster_bytes AS provider_roster_bytes,
                  committer.human_id AS committer_human_id,
                  committer.state AS committer_state,
                  committer.signing_public_key
                    AS committer_signing_public_key,
                  target.state AS target_state,
                  target.human_id AS target_human_owner_id,
                  mapped.device_id AS mapped_device_id,
                  mapped.human_id AS mapped_human_id,
                  mapped.leaf_index AS mapped_leaf_index,
                  mapped.joined_epoch AS mapped_joined_epoch,
                  mapped.removed_epoch AS mapped_removed_epoch,
                  floor(extract(epoch from mapped.removed_at) * 1000)::bigint
                    AS mapped_removed_at_ms
             FROM crypto_delivery_operations o
             JOIN crypto_domain_transition_steps s
               ON s.operation_id = o.operation_id
              AND s.domain_id = $2
             JOIN crypto_domains d ON d.id = s.domain_id
             JOIN crypto_domain_provider_heads p ON p.domain_id = d.id
             JOIN human_crypto_devices committer
               ON committer.device_id = s.committer_device_id
             JOIN human_crypto_devices target
               ON target.device_id = o.target_device_id
             LEFT JOIN crypto_domain_devices mapped
               ON mapped.domain_id = d.id
              AND mapped.device_id = o.target_device_id
            WHERE o.operation_id = $1
              AND (
                o.lease_owner IS NULL
                OR o.lease_expires_at <= $3::timestamptz
              )
            LIMIT 2
            FOR UPDATE OF o, s, d, p, committer, target`,
          [
            claim.operationId,
            claim.domainId,
            isoTime(input.submittedAt),
          ],
        ),
        "Domain transition submission state lookup",
      );
      if (current === null) return { status: "stale_state" };
      const storedReplay = ["awaiting_delivery", "ready_to_activate"].includes(
        requiredString(current, "step_state"),
      );
      if (!storedReplay && !exactLease(current, claim, input.submittedAt)) {
        return { status: "lost_lease" };
      }
      const namespaceRows = await transaction.query(
        `SELECT n.namespace_id, n.expected_access_revision,
                n.expected_binding_hash, n.candidate_binding_hash,
                n.candidate_signed_binding_bytes,
                n.candidate_human_keyring_envelope_bytes,
                n.candidate_ai_keyring_envelope_bytes,
                n.state AS namespace_state,
                h.access_revision AS head_access_revision,
                h.binding_hash AS head_binding_hash,
                h.domain_id AS head_domain_id,
                h.domain_epoch AS head_domain_epoch,
                h.writes_paused AS head_writes_paused,
                h.pause_operation_id AS head_pause_operation_id
           FROM crypto_domain_transition_namespaces n
           JOIN namespace_crypto_heads h
             ON h.namespace_id = n.namespace_id
          WHERE n.operation_id = $1
            AND n.domain_id = $2
          ORDER BY n.namespace_id
          FOR UPDATE OF n, h`,
        [claim.operationId, claim.domainId],
      );
      const signingPublicKey = requiredBytes(
        current,
        "committer_signing_public_key",
      );
      const resolveActiveCommitter = (deviceId: string) =>
        deviceId === requiredString(current, "committer_device_id")
          ? {
            state: "active" as const,
            humanId: requiredString(current, "committer_human_id"),
            signingPublicKey,
          }
          : null;
      const domainPlan: DeviceFanoutDomainPlan = {
        domainId: claim.domainId,
        expectedEpoch: requiredCounter(current, "expected_epoch"),
        targetEpoch: requiredCounter(current, "target_epoch"),
        expectedAuthorizationRevision: requiredCounter(
          current,
          "expected_authorization_revision",
        ),
        expectedParticipantDigest: requiredBytes(
          current,
          "expected_participant_digest",
        ),
        committerDeviceId: requiredString(current, "committer_device_id"),
        namespaces: namespaceRows.map((row) => ({
          namespaceId: requiredString(row, "namespace_id"),
          expectedAccessRevision: requiredCounter(
            row,
            "expected_access_revision",
          ),
          expectedBindingHash: requiredBytes(row, "expected_binding_hash"),
        })),
      };
      const operationKind = requiredString(current, "operation_kind");
      const isRevocation = operationKind === "device_revoke";
      if (storedReplay) {
        const transition = input.providerSubmission.transition;
        const replayMappings = await transaction.query(
          `SELECT dd.device_id, dd.human_id, dd.leaf_index,
                  dd.removed_epoch,
                  floor(extract(epoch from dd.removed_at) * 1000)::bigint
                    AS removed_at_ms,
                  device.state AS device_state,
                  device.human_id AS device_human_id
             FROM crypto_domain_devices dd
             JOIN human_crypto_devices device
               ON device.device_id = dd.device_id
            WHERE dd.domain_id = $1
              AND (dd.removed_at IS NULL OR dd.device_id = $2)
            ORDER BY dd.leaf_index
            FOR UPDATE OF dd, device`,
          [claim.domainId, requiredString(current, "target_device_id")],
        );
        const namespaceVerified = verifyNamespaceTransitionSubmission({
          crypto: this.crypto,
          submission: input.namespaceSubmission,
          operationId: claim.operationId,
          domainPlan,
          providerTransitionDigest: input.providerSubmission.transitionDigest,
          resolveActiveCommitter,
        });
        const nextRoster = decodeProviderRosterV2(
          transition.providerId,
          transition.rosterBytes,
        );
        const replayPreviousRoster: ProviderRosterEntryV2[] =
          replayMappings.map((row) => ({
            deviceId: cryptoDeviceId(requiredString(row, "device_id")),
            humanId: humanId(requiredString(row, "human_id")),
            leafIndex: requiredCounter(row, "leaf_index"),
          }));
        const targetDeviceId = requiredString(current, "target_device_id");
        const target = (
          isRevocation ? replayPreviousRoster : nextRoster
        ).find((entry) => entry.deviceId === targetDeviceId);
        const targetMapping = replayMappings.find((row) =>
          requiredString(row, "device_id") === targetDeviceId
        );
        const replayMappingsMatch =
          replayMappings.length === replayPreviousRoster.length
          && replayMappings.every((row) =>
            requiredString(row, "device_human_id")
              === requiredString(row, "human_id")
            && requiredString(row, "device_state") === (
              isRevocation
                && requiredString(row, "device_id") === targetDeviceId
                ? "revoked"
                : "active"
            )
            && nullableCounter(row, "removed_epoch") === null
            && nullableCounter(row, "removed_at_ms") === null
          )
          && (
            isRevocation
              ? targetMapping !== undefined
                && requiredString(targetMapping, "human_id")
                  === requiredString(current, "target_human_id")
              : targetMapping === undefined
          );
        const pauseCoordinatesMatch = isRevocation
          ? requiredBoolean(current, "domain_writes_paused")
            && nullableString(current, "domain_pause_operation_id")
              === claim.operationId
            && namespaceRows.every((row) =>
              requiredBoolean(row, "head_writes_paused")
              && nullableString(row, "head_pause_operation_id")
                === claim.operationId
            )
          : !requiredBoolean(current, "domain_writes_paused")
            && nullableString(current, "domain_pause_operation_id") === null
            && namespaceRows.every((row) =>
              !requiredBoolean(row, "head_writes_paused")
              && nullableString(row, "head_pause_operation_id") === null
            );
        const replaySubmissionMatches =
          [
            "awaiting_committer",
            "awaiting_delivery",
            "ready_to_activate",
          ].includes(
            requiredString(current, "operation_state"),
          )
          && ["device_add", "device_recovery", "device_revoke"].includes(
            operationKind,
          )
          && transition.operation === (isRevocation ? "remove" : "add")
          && transition.targetHumanId
            === requiredString(current, "target_human_id")
          && transition.targetDeviceId
            === requiredString(current, "target_device_id")
          && input.providerSubmission.operationId === claim.operationId
          && input.providerSubmission.committerDeviceId
            === domainPlan.committerDeviceId
          && input.providerSubmission.expectedAuthorizationRevision
            === domainPlan.expectedAuthorizationRevision
          && equalBytes(
            input.providerSubmission.expectedParticipantDigest,
            domainPlan.expectedParticipantDigest,
          )
          && transition.domainId === claim.domainId
          && transition.expectedHead.epoch === domainPlan.expectedEpoch
          && transition.nextHead.epoch === domainPlan.targetEpoch;
        const replayAuthoritativeHeadsMatch =
          requiredCounter(current, "domain_epoch")
            === transition.expectedHead.epoch
          && equalBytes(
            requiredBytes(current, "domain_roster_bytes"),
            requiredBytes(current, "provider_roster_bytes"),
          )
          && requiredString(current, "provider_id") === transition.providerId
          && requiredCounter(current, "provider_epoch")
            === transition.expectedHead.epoch
          && equalBytes(
            requiredBytes(current, "provider_state_hash"),
            transition.expectedHead.stateHash,
          );
        const replayProofMatches =
          equalBytes(
            providerPublicTransitionDigestV2(this.crypto, transition),
            input.providerSubmission.transitionDigest,
          )
          && this.crypto.verify(
            signingPublicKey,
            providerTransitionSubmissionSigningBytes(
              input.providerSubmission,
            ),
            input.providerSubmission.signature,
          )
          && requiredString(current, "committer_state") === "active"
          && requiredString(current, "committer_device_id")
            !== requiredString(current, "target_device_id")
          && requiredString(current, "target_human_owner_id")
            === requiredString(current, "target_human_id")
          && requiredString(current, "target_state")
            === (isRevocation ? "revoked" : "pending")
          && pauseCoordinatesMatch;
        const replayStoredCandidateMatches =
          nullableString(current, "mapped_device_id")
            === (isRevocation ? targetDeviceId : null)
          && nullableString(current, "mapped_human_id")
            === (
              isRevocation
                ? requiredString(current, "target_human_id")
                : null
            )
          && nullableCounter(current, "mapped_removed_epoch") === null
          && nullableCounter(current, "mapped_removed_at_ms") === null
          && nullableString(current, "candidate_provider_id")
            === transition.providerId
          && nullableBytes(current, "expected_provider_state_hash") !== null
          && equalBytes(
            requiredBytes(current, "expected_provider_state_hash"),
            transition.expectedHead.stateHash,
          )
          && nullableBytes(current, "candidate_provider_state_hash") !== null
          && equalBytes(
            requiredBytes(current, "candidate_provider_state_hash"),
            transition.nextHead.stateHash,
          )
          && nullableBytes(current, "candidate_roster_bytes") !== null
          && equalBytes(
            requiredBytes(current, "candidate_roster_bytes"),
            transition.rosterBytes,
          )
          && nullableBytes(current, "candidate_transition_digest") !== null
          && equalBytes(
            requiredBytes(current, "candidate_transition_digest"),
            input.providerSubmission.transitionDigest,
          )
          && nullableCounter(current, "candidate_target_leaf_index")
            === target?.leafIndex;
        const replayNamespacesMatch =
          namespaceRows.length === namespaceVerified.candidates.length
          && namespaceRows.every((row, index) => {
            const candidate = namespaceVerified.candidates[index]!;
            const candidateHash = nullableBytes(
              row,
              "candidate_binding_hash",
            );
            return requiredString(row, "namespace_state") === "prepared"
              && candidateHash !== null
              && equalBytes(candidateHash, candidate.nextHead.bindingHash)
              && requiredCounter(row, "head_access_revision")
                === candidate.expectedHead.accessRevision
              && equalBytes(
                requiredBytes(row, "head_binding_hash"),
                candidate.expectedHead.bindingHash,
              )
              && requiredString(row, "head_domain_id")
                === claim.domainId
              && requiredCounter(row, "head_domain_epoch")
                === domainPlan.expectedEpoch
              && nullableBytes(
                row,
                "candidate_signed_binding_bytes",
              ) !== null
              && equalBytes(
                requiredBytes(row, "candidate_signed_binding_bytes"),
                candidate.binding.signedBindingBytes,
              )
              && nullableBytes(
                row,
                "candidate_human_keyring_envelope_bytes",
              ) !== null
              && equalBytes(
                requiredBytes(
                  row,
                  "candidate_human_keyring_envelope_bytes",
                ),
                candidate.binding.humanKeyringEnvelopeBytes,
              )
              && nullableBytes(
                row,
                "candidate_ai_keyring_envelope_bytes",
              ) !== null
              && equalBytes(
                requiredBytes(
                  row,
                  "candidate_ai_keyring_envelope_bytes",
                ),
                candidate.binding.aiKeyringEnvelopeBytes,
              );
          });
        const replayCoordinatesMatch =
          replaySubmissionMatches
          && replayAuthoritativeHeadsMatch
          && replayProofMatches
          && replayMappingsMatch
          && replayStoredCandidateMatches
          && replayNamespacesMatch;
        if (!replayCoordinatesMatch || target === undefined) {
          return { status: "stale_state" };
        }
        const replayDelivery = createDomainTransitionDelivery({
          crypto: this.crypto,
          providerSubmission: input.providerSubmission,
          verifiedProvider: {
            operationId: input.providerSubmission.operationId,
            committerDeviceId: input.providerSubmission.committerDeviceId,
            expectedAuthorizationRevision:
              input.providerSubmission.expectedAuthorizationRevision,
            expectedParticipantDigest:
              input.providerSubmission.expectedParticipantDigest,
            transitionDigest: input.providerSubmission.transitionDigest,
            transition,
            previousRoster: replayPreviousRoster,
            nextRoster,
            targetLeafIndex: target.leafIndex,
          },
          namespaceSubmission: input.namespaceSubmission,
          verifiedNamespaces: namespaceVerified,
          now: input.submittedAt,
        });
        const persistedMessages = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            message_id: cryptoDeliveryMessages.messageId,
            domain_sequence: cryptoDeliveryMessages.domainSequence,
            recipient_sequence: cryptoDeliveryMessages.recipientSequence,
            recipient_device_id: cryptoDeliveryMessages.recipientDeviceId,
            format_version: cryptoDeliveryMessages.formatVersion,
            payload_hash: cryptoDeliveryMessages.payloadHash,
            payload_bytes: cryptoDeliveryMessages.payloadBytes,
            delivery_sequence_high_watermark:
              humanCryptoDevices.deliverySequenceHighWatermark,
          }).from(cryptoDeliveryMessages).innerJoin(
            humanCryptoDevices,
            eq(
              humanCryptoDevices.deviceId,
              cryptoDeliveryMessages.recipientDeviceId,
            ),
          ).where(and(
            eq(cryptoDeliveryMessages.operationId, claim.operationId),
            eq(cryptoDeliveryMessages.domainId, claim.domainId),
            eq(cryptoDeliveryMessages.kind, "public_state"),
          )).orderBy(
            asc(cryptoDeliveryMessages.recipientDeviceId),
            asc(cryptoDeliveryMessages.messageId),
          ),
        );
        const replaySequenceByMessageId = new Map(
          replayDelivery.messages.map((message, index) => [
            message.messageId,
            index,
          ]),
        );
        const expectedMessages = [...replayDelivery.messages].sort(
          (left, right) =>
            left.recipientDeviceId.localeCompare(right.recipientDeviceId)
            || left.messageId.localeCompare(right.messageId),
        );
        const replaySequenceBase =
          (domainPlan.targetEpoch - 1) * MAX_FANOUT_ROWS_PER_OPERATION;
        if (
          !Number.isSafeInteger(replaySequenceBase)
          || replaySequenceBase < 0
          || replaySequenceBase + expectedMessages.length
            > Number.MAX_SAFE_INTEGER
        ) {
          throw new RangeError(
            "Domain transition replay sequence is unsafe",
          );
        }
        const seenRecipientSequences = new Set<string>();
        if (
          persistedMessages.length !== expectedMessages.length
          || persistedMessages.some((row, index) => {
            const expected = expectedMessages[index]!;
            const recipientSequence = requiredCounter(
              row,
              "recipient_sequence",
            );
            const recipientSequenceKey =
              `${expected.recipientDeviceId}/${recipientSequence}`;
            if (
              recipientSequence < 1
              || recipientSequence
                > requiredCounter(
                  row,
                  "delivery_sequence_high_watermark",
                )
              || seenRecipientSequences.has(recipientSequenceKey)
            ) return true;
            seenRecipientSequences.add(recipientSequenceKey);
            return requiredString(row, "message_id") !== expected.messageId
              || requiredCounter(row, "domain_sequence")
                !== replaySequenceBase
                  + replaySequenceByMessageId.get(expected.messageId)!
              || requiredString(row, "recipient_device_id")
                !== expected.recipientDeviceId
              || requiredCounter(row, "format_version")
                !== expected.formatVersion
              || !equalBytes(
                requiredBytes(row, "payload_hash"),
                expected.payloadHash,
              )
              || !equalBytes(
                requiredBytes(row, "payload_bytes"),
                expected.payloadBytes,
              );
          })
        ) return { status: "stale_state" };
        return {
          status: "duplicate",
          messageCount: replayDelivery.fanoutRowCount,
          aggregatePayloadBytes: replayDelivery.aggregatePayloadBytes,
        };
      }
      if (!exactLease(current, claim, input.submittedAt)) {
        return { status: "lost_lease" };
      }
      if (
        !["device_add", "device_recovery", "device_revoke"].includes(
          operationKind,
        )
        || requiredString(current, "operation_state") !== "awaiting_committer"
        || !["awaiting_committer", "preparing"].includes(claim.state)
        || requiredCounter(current, "domain_epoch")
          !== requiredCounter(current, "expected_epoch")
        || requiredCounter(current, "domain_authorization_revision")
          !== requiredCounter(current, "expected_authorization_revision")
        || !equalBytes(
          requiredBytes(current, "domain_participant_digest"),
          requiredBytes(current, "expected_participant_digest"),
        )
        || !requiredStringArray(current, "domain_participants").includes(
          requiredString(current, "target_human_id"),
        )
        || !equalBytes(
          requiredBytes(current, "domain_roster_bytes"),
          requiredBytes(current, "provider_roster_bytes"),
        )
        || (
          isRevocation
            ? !requiredBoolean(current, "domain_writes_paused")
              || nullableString(current, "domain_pause_operation_id")
                !== claim.operationId
            : requiredBoolean(current, "domain_writes_paused")
              || nullableString(current, "domain_pause_operation_id") !== null
        )
        || requiredString(current, "committer_state") !== "active"
        || requiredString(current, "committer_device_id")
          === requiredString(current, "target_device_id")
        || requiredString(current, "target_state")
          !== (isRevocation ? "revoked" : "pending")
        || requiredString(current, "target_human_owner_id")
          !== requiredString(current, "target_human_id")
        || (
          isRevocation
            ? nullableString(current, "mapped_device_id")
                !== requiredString(current, "target_device_id")
              || nullableString(current, "mapped_human_id")
                !== requiredString(current, "target_human_id")
              || nullableCounter(current, "mapped_removed_epoch") !== null
              || nullableCounter(current, "mapped_removed_at_ms") !== null
            : nullableString(current, "mapped_device_id") !== null
        )
      ) {
        return { status: "stale_state" };
      }

      if (
        namespaceRows.some((row) =>
          requiredString(row, "namespace_state") !== "pending"
          || requiredString(row, "head_domain_id") !== claim.domainId
          || requiredCounter(row, "head_domain_epoch")
            !== requiredCounter(current, "expected_epoch")
          || requiredCounter(row, "head_access_revision")
            !== requiredCounter(row, "expected_access_revision")
          || !equalBytes(
            requiredBytes(row, "head_binding_hash"),
            requiredBytes(row, "expected_binding_hash"),
          )
          || (
            isRevocation
              ? !requiredBoolean(row, "head_writes_paused")
                || nullableString(row, "head_pause_operation_id")
                  !== claim.operationId
              : requiredBoolean(row, "head_writes_paused")
                || nullableString(row, "head_pause_operation_id") !== null
          )
        )
      ) {
        return { status: "stale_state" };
      }
      const provider = verifyProviderTransitionSubmission({
        crypto: this.crypto,
        submission: input.providerSubmission,
        expectation: {
          operationId: claim.operationId,
          operationKind: requiredString(
            current,
            "operation_kind",
          ) as "device_add" | "device_recovery" | "device_revoke",
          domainId: claim.domainId,
          targetHumanId: requiredString(current, "target_human_id"),
          targetDeviceId: requiredString(current, "target_device_id"),
          expectedEpoch: domainPlan.expectedEpoch,
          targetEpoch: domainPlan.targetEpoch,
          expectedAuthorizationRevision:
            domainPlan.expectedAuthorizationRevision,
          expectedParticipantDigest: domainPlan.expectedParticipantDigest,
          committerDeviceId: domainPlan.committerDeviceId!,
        },
        currentProviderState: {
          head: {
            providerId: requiredString(current, "provider_id"),
            domainId: cryptoDomainId(claim.domainId),
            epoch: domainEpoch(requiredCounter(current, "provider_epoch")),
            stateHash: requiredBytes(current, "provider_state_hash"),
          },
          rosterBytes: requiredBytes(current, "provider_roster_bytes"),
        },
        resolveActiveCommitter,
      });
      const currentMappings = await transaction.query(
        `SELECT dd.device_id, dd.human_id, dd.leaf_index,
                dd.removed_epoch,
                floor(extract(epoch from dd.removed_at) * 1000)::bigint
                  AS removed_at_ms,
                device.state AS device_state,
                device.human_id AS device_human_id
           FROM crypto_domain_devices dd
           JOIN human_crypto_devices device
             ON device.device_id = dd.device_id
          WHERE dd.domain_id = $1
            AND (dd.removed_at IS NULL OR dd.device_id = $2)
          ORDER BY dd.leaf_index
          FOR UPDATE OF dd, device`,
        [claim.domainId, requiredString(current, "target_device_id")],
      );
      if (
        currentMappings.length !== provider.previousRoster.length
        || currentMappings.some((row, index) => {
          const expected = provider.previousRoster[index]!;
          return requiredString(row, "device_id") !== expected.deviceId
            || requiredString(row, "human_id") !== expected.humanId
            || requiredString(row, "device_human_id") !== expected.humanId
            || requiredCounter(row, "leaf_index") !== expected.leafIndex
            || requiredString(row, "device_state") !== (
              isRevocation
                && expected.deviceId
                  === requiredString(current, "target_device_id")
                ? "revoked"
                : "active"
            )
            || nullableCounter(row, "removed_epoch") !== null
            || nullableCounter(row, "removed_at_ms") !== null;
        })
        || (
          isRevocation
          && requiredCounter(current, "mapped_leaf_index")
            !== provider.targetLeafIndex
        )
      ) return { status: "stale_state" };
      const namespaces = verifyNamespaceTransitionSubmission({
        crypto: this.crypto,
        submission: input.namespaceSubmission,
        operationId: claim.operationId,
        domainPlan,
        providerTransitionDigest: provider.transitionDigest,
        resolveActiveCommitter,
      });
      const delivery = createDomainTransitionDelivery({
        crypto: this.crypto,
        providerSubmission: input.providerSubmission,
        verifiedProvider: provider,
        namespaceSubmission: input.namespaceSubmission,
        verifiedNamespaces: namespaces,
        now: input.submittedAt,
      });
      const priorRows = requiredCounter(
        current,
        "operation_fanout_row_count",
      );
      const priorBytes = requiredCounter(
        current,
        "operation_aggregate_payload_bytes",
      );
      const nextRows = priorRows + delivery.fanoutRowCount;
      const nextBytes = priorBytes + delivery.aggregatePayloadBytes;
      if (
        nextRows > MAX_FANOUT_ROWS_PER_OPERATION
        || nextBytes > MAX_FANOUT_PAYLOAD_BYTES
      ) {
        throw new RangeError(
          "Domain transition exceeds aggregate operation fanout bounds",
        );
      }

      const namespaceById = new Map(
        namespaceRows.map((row) => [
          requiredString(row, "namespace_id"),
          row,
        ]),
      );
      for (const candidate of namespaces.candidates) {
        const locked = namespaceById.get(candidate.nextHead.namespaceId);
        if (locked === undefined) {
          throw new Error("Domain transition Namespace lock set changed");
        }
        const status = await persistNamespaceBinding({
          crypto: this.crypto,
          storage: {
            compareAndSwapNamespaceBindingAndHead: async (authorized) => {
              const write =
                storageAdapterSupportV2.consumeNamespaceBindingWrite(
                  authorized,
                );
              const expected = write.expected;
              const authorization = write.authorization;
              if (
                expected === null
                || expected.namespaceId
                  !== requiredString(locked, "namespace_id")
                || expected.accessRevision
                  !== requiredCounter(locked, "expected_access_revision")
                || !equalBytes(
                  expected.bindingHash,
                  requiredBytes(locked, "expected_binding_hash"),
                )
                || authorization.bindingCommitter.committerDeviceId
                  !== domainPlan.committerDeviceId
                || authorization.keyringCommitter.committerDeviceId
                  !== domainPlan.committerDeviceId
                || !equalBytes(
                  authorization.committerSigningPublicKeyHash,
                  this.crypto.hash(signingPublicKey),
                )
              ) return "stale";
              await expectSingleMutation(
                transaction,
                `UPDATE crypto_domain_transition_namespaces
                    SET candidate_binding_hash = $4,
                        candidate_signed_binding_bytes = $5,
                        candidate_human_keyring_envelope_bytes = $6,
                        candidate_ai_keyring_envelope_bytes = $7,
                        state = 'prepared', failure_code = NULL,
                        updated_at = $8::timestamptz
                  WHERE operation_id = $1
                    AND domain_id = $2
                    AND namespace_id = $3
                    AND state = 'pending'
                    AND candidate_binding_hash IS NULL
                 RETURNING namespace_id`,
                [
                  claim.operationId,
                  claim.domainId,
                  write.binding.namespaceId,
                  write.binding.bindingHash,
                  write.binding.signedBindingBytes,
                  write.binding.humanKeyringEnvelope.ciphertext,
                  write.binding.aiKeyringEnvelope.ciphertext,
                  isoTime(input.submittedAt),
                ],
                "Domain transition Namespace candidate staging",
              );
              return "applied";
            },
          },
          prepared: {
            expectedHead: candidate.expectedHead,
            nextHead: candidate.nextHead,
            signedBindingBytes: candidate.binding.signedBindingBytes,
            humanKeyringEnvelopeBytes:
              candidate.binding.humanKeyringEnvelopeBytes,
            aiKeyringEnvelopeBytes:
              candidate.binding.aiKeyringEnvelopeBytes,
          },
          resolveCurrentCommitter: () => signingPublicKey,
        });
        if (status !== "applied") {
          throw new Error(
            "Domain transition Namespace binding lost its atomic CAS",
          );
        }
      }

      const sequenceBase =
        (domainPlan.targetEpoch - 1) * MAX_FANOUT_ROWS_PER_OPERATION;
      if (
        !Number.isSafeInteger(sequenceBase)
        || sequenceBase < 0
        || sequenceBase + delivery.messages.length
          > Number.MAX_SAFE_INTEGER
      ) {
        throw new RangeError(
          "Domain transition delivery sequence is unsafe",
        );
      }
      let sequence = sequenceBase;
      const recipientSequences = await reserveRecipientDeliverySequences(
        transaction,
        delivery.messages.map((message) => message.recipientDeviceId),
        input.submittedAt,
      );
      for (const [index, message] of delivery.messages.entries()) {
        await expectSingleMutation(
          transaction,
          `INSERT INTO crypto_delivery_messages (
             message_id, operation_id, domain_id, domain_sequence,
             recipient_sequence, kind, recipient_device_id, format_version,
             payload_hash, payload_bytes, created_at, expires_at
           ) VALUES (
             $1, $2, $3, $4, $5, 'public_state', $6, $7, $8, $9,
             $10::timestamptz, $11::timestamptz
           )
           RETURNING message_id`,
          [
            message.messageId,
            message.operationId,
            message.domainId,
            sequence++,
            recipientSequences[index]!,
            message.recipientDeviceId,
            message.formatVersion,
            message.payloadHash,
            message.payloadBytes,
            isoTime(message.createdAt),
            isoTime(message.expiresAt),
          ],
          "Domain transition delivery-message insert",
        );
      }
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_domain_transition_steps
            SET state = 'awaiting_delivery',
                lease_owner = NULL, lease_expires_at = NULL,
                expected_provider_state_hash = $6,
                candidate_provider_id = $7,
                candidate_provider_state_hash = $8,
                candidate_roster_bytes = $9,
                candidate_transition_digest = $10,
                candidate_target_leaf_index = $11,
                failure_code = NULL, updated_at = $12::timestamptz
          WHERE operation_id = $1
            AND domain_id = $2
            AND state = $3
            AND lease_owner = $4
            AND lease_expires_at = $5::timestamptz
          RETURNING operation_id`,
        [
          claim.operationId,
          claim.domainId,
          claim.state,
          claim.workerId,
          isoTime(claim.leaseExpiresAt),
          provider.transition.expectedHead.stateHash,
          provider.transition.providerId,
          provider.transition.nextHead.stateHash,
          provider.transition.rosterBytes,
          provider.transitionDigest,
          provider.targetLeafIndex,
          isoTime(input.submittedAt),
        ],
        "Domain transition step update",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_delivery_operations
            SET state = CASE
                  WHEN EXISTS (
                    SELECT 1
                      FROM crypto_domain_transition_steps remaining
                     WHERE remaining.operation_id = $1
                       AND remaining.state IN (
                         'awaiting_committer', 'preparing'
                       )
                  ) THEN 'awaiting_committer'
                  ELSE 'awaiting_delivery'
                END,
                fanout_row_count = $2,
                aggregate_payload_bytes = $3,
                updated_at = $4::timestamptz
          WHERE operation_id = $1
            AND state = 'awaiting_committer'
            AND fanout_row_count = $5
            AND aggregate_payload_bytes = $6
          RETURNING operation_id`,
        [
          claim.operationId,
          nextRows,
          nextBytes,
          isoTime(input.submittedAt),
          priorRows,
          priorBytes,
        ],
        "Domain transition operation accounting update",
      );
      return {
        status: "submitted",
        messageCount: delivery.fanoutRowCount,
        aggregatePayloadBytes: delivery.aggregatePayloadBytes,
      };
    });
  }
}
