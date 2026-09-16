import {
  and,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDeliveryMessages,
  cryptoDomainDevices,
  cryptoDomainProviderHeads,
  cryptoDomains,
  cryptoHumanMembershipTransitions,
  eq,
  isNull,
  sql,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeProviderRosterV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createHumanMembershipTargetDomainDelivery,
} from "../../delivery/human-membership-target-domain-delivery.ts";
import {
  verifyHumanMembershipTargetDomainSubmission,
  type HumanMembershipTargetDomainSubmission,
} from "../../delivery/human-membership-target-domain.ts";
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

export type HumanMembershipTargetDomainResult =
  | {
    readonly status: "created" | "duplicate" | "reused";
    readonly targetDomainId: string;
    readonly targetEpoch: number;
    readonly recipientCount: number;
    readonly messageCount: number;
  }
  | { readonly status: "stale_state" | "conflicting_state" };

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Target Domain column ${name} must be text`);
  }
  return value;
}

function nullableString(row: DatabaseRow, name: string): string | null {
  return row[name] === null ? null : requiredString(row, name);
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Target Domain column ${name} must be bytea`);
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
    throw new TypeError(`Target Domain column ${name} must be a counter`);
  }
  return normalized;
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  if (typeof row[name] !== "boolean") {
    throw new TypeError(`Target Domain column ${name} must be boolean`);
  }
  return row[name];
}

function requiredStrings(row: DatabaseRow, name: string): readonly string[] {
  const value = row[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`Target Domain column ${name} must be text[]`);
  }
  return value as readonly string[];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
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
    throw new RangeError("Target Domain timestamp must be nonnegative");
  }
  return new Date(milliseconds).toISOString();
}

async function expectOne(
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

async function membershipNamespace(
  executor: CryptoPostgresExecutor,
  operationId: string,
): Promise<string | null> {
  const rows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      namespace_id: cryptoHumanMembershipTransitions.namespaceId,
    }).from(cryptoHumanMembershipTransitions).where(eq(
      cryptoHumanMembershipTransitions.operationId,
      operationId,
    )).limit(2),
  );
  return rows.length === 1 ? requiredString(rows[0]!, "namespace_id") : null;
}

export class PostgresHumanMembershipTargetDomainRepository {
  constructor(private readonly input: {
    readonly handle: CryptoPostgresHandle;
    readonly crypto: LatticeCrypto;
  }) {
    assertVerifiedCryptoPostgresHandle(input.handle);
  }

  create(input: {
    readonly submission: HumanMembershipTargetDomainSubmission;
    readonly preparedAt: number;
  }): Promise<HumanMembershipTargetDomainResult> {
    const preparedAt = isoTime(input.preparedAt);
    return this.input.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const namespaceId = await membershipNamespace(
        transaction,
        input.submission.operationId,
      );
      if (namespaceId === null) return { status: "stale_state" };
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [namespaceId],
      );
      const rows = await transaction.query(
        `SELECT o.operation_id, o.kind, o.state,
                o.target_human_id, o.target_device_id,
                o.fanout_row_count, o.aggregate_payload_bytes,
                o.deadline_at > $3::timestamptz AS deadline_live,
                h.namespace_id, h.target_human_actor_id::text
                  AS target_human_actor_id,
                h.admitted_bootstrap_device_id, h.bootstrap_device_id,
                h.old_participants, h.old_participant_digest,
                h.new_participants, h.new_participant_digest,
                h.old_domain_id, h.admitted_target_domain_id,
                h.target_domain_id, h.expected_access_revision,
                h.expected_binding_hash, h.committer_device_id,
                h.candidate_submitted_at, h.activated_at, h.released_at,
                head.access_revision AS head_access_revision,
                head.binding_hash AS head_binding_hash,
                head.domain_id AS head_domain_id,
                head.writes_paused AS head_writes_paused,
                head.pause_operation_id AS head_pause_operation_id,
                source.participants AS source_participants,
                source.participant_digest AS source_participant_digest,
                committer.human_id AS committer_human_id,
                committer.state AS committer_state,
                committer.signing_public_key,
                source_map.human_id AS source_mapping_human_id,
                source_map.removed_at AS source_mapping_removed_at
           FROM crypto_delivery_operations o
           JOIN crypto_human_membership_transitions h
             ON h.operation_id = o.operation_id
           JOIN namespace_crypto_heads head
             ON head.namespace_id = h.namespace_id
           JOIN crypto_domains source ON source.id = h.old_domain_id
           JOIN human_crypto_devices committer
             ON committer.device_id = $2
           JOIN crypto_domain_devices source_map
             ON source_map.domain_id = source.id
            AND source_map.device_id = committer.device_id
          WHERE o.operation_id = $1
          LIMIT 2
          FOR UPDATE OF o, h, head, source, committer, source_map`,
        [
          input.submission.operationId,
          input.submission.committerDeviceId,
          preparedAt,
        ],
      );
      if (rows.length !== 1) return { status: "stale_state" };
      const row = rows[0]!;
      const newParticipants = requiredStrings(row, "new_participants");
      const state = requiredString(row, "state");
      const kind = requiredString(row, "kind");
      const isAdd = kind === "human_add";
      const isRemove = kind === "human_remove";
      const progressed = [
        "awaiting_committer",
        "awaiting_delivery",
        "ready_to_activate",
        "activating",
        "active",
      ].includes(state);
      if (
        (!isAdd && !isRemove)
        || requiredString(row, "namespace_id") !== namespaceId
        || nullableString(row, "admitted_target_domain_id") !== null
        || nullableString(row, "admitted_bootstrap_device_id") !== null
        || (
          isAdd
            ? nullableString(row, "bootstrap_device_id") === null
            : nullableString(row, "bootstrap_device_id") !== null
        )
        || !sameStrings(newParticipants, input.submission.participants)
        || !equalBytes(
          requiredBytes(row, "new_participant_digest"),
          input.submission.participantDigest,
        )
        || requiredString(row, "committer_human_id")
          !== input.submission.committerHumanId
        || requiredString(row, "committer_state") !== "active"
        || !requiredStrings(row, "old_participants").includes(
          input.submission.committerHumanId,
        )
        || !newParticipants.includes(input.submission.committerHumanId)
        || nullableString(row, "source_mapping_human_id")
          !== input.submission.committerHumanId
        || row["source_mapping_removed_at"] !== null
        || (
          !progressed
          && (
            row["candidate_submitted_at"] !== null
            || row["activated_at"] !== null
            || row["released_at"] !== null
            || !requiredBoolean(row, "deadline_live")
            || requiredCounter(row, "head_access_revision")
              !== requiredCounter(row, "expected_access_revision")
            || !equalBytes(
              requiredBytes(row, "head_binding_hash"),
              requiredBytes(row, "expected_binding_hash"),
            )
            || requiredString(row, "head_domain_id")
              !== requiredString(row, "old_domain_id")
            || requiredBoolean(row, "head_writes_paused") !== isRemove
            || (
              isRemove
                ? nullableString(row, "head_pause_operation_id")
                  !== input.submission.operationId
                : row["head_pause_operation_id"] !== null
            )
            || !sameStrings(
              requiredStrings(row, "source_participants"),
              requiredStrings(row, "old_participants"),
            )
            || !equalBytes(
              requiredBytes(row, "source_participant_digest"),
              requiredBytes(row, "old_participant_digest"),
            )
          )
        )
      ) return { status: "stale_state" };

      await transaction.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended(encode($1::bytea, 'hex'), 0)
         )`,
        [input.submission.participantDigest],
      );
      const existingDomains = await transaction.query(
        `SELECT id
           FROM crypto_domains
          WHERE id = $1
             OR (
               participant_digest = $2
               AND participants = $3::text[]
             )
          ORDER BY convert_to(id, 'UTF8')
          LIMIT 2
          FOR UPDATE`,
        [
          input.submission.targetDomainId,
          input.submission.participantDigest,
          input.submission.participants,
        ],
      );
      if (progressed) {
        if (
          existingDomains.length !== 1
          || requiredString(existingDomains[0]!, "id")
            !== input.submission.targetDomainId
          || nullableString(row, "target_domain_id")
            !== input.submission.targetDomainId
        ) return { status: "conflicting_state" };
      } else if (
        existingDomains.length !== 0
        || state !== "preparing_domain"
        || nullableString(row, "target_domain_id") !== null
      ) return { status: "conflicting_state" };

      const inventory = await transaction.query(
        `SELECT d.device_id, d.human_id, d.device_generation,
                d.signing_public_key, d.state, d.human_actor_id::text
                  AS human_actor_id,
                custody.state AS custody_state,
                custody.current_recovery_generation,
                recovery.state AS recovery_state
           FROM human_crypto_devices d
           JOIN human_crypto_custodies custody
             ON custody.human_id = d.human_id
           JOIN human_crypto_recovery_keys recovery
             ON recovery.human_id = custody.human_id
            AND recovery.generation = custody.current_recovery_generation
          WHERE d.human_id = ANY($1::text[])
            AND d.state = 'active'
          ORDER BY convert_to(d.device_id, 'UTF8')
          LIMIT $2
          FOR UPDATE OF d, custody, recovery`,
        [
          newParticipants,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.currentDeviceLeavesPerDomain + 1,
        ],
      );
      if (
        inventory.length < 1
        || inventory.length
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.currentDeviceLeavesPerDomain
        || newParticipants.some((human) =>
          !inventory.some((device) =>
            requiredString(device, "human_id") === human
          )
        )
        || inventory.some((device) =>
          requiredString(device, "human_id")
            !== requiredString(device, "human_actor_id")
          || requiredString(device, "custody_state") !== "active"
          || device["current_recovery_generation"] === null
          || requiredString(device, "recovery_state") !== "current"
        )
        || (
          isAdd
          && !inventory.some((device) =>
            requiredString(device, "device_id")
              === nullableString(row, "bootstrap_device_id")
            && requiredString(device, "human_id")
              === requiredString(row, "target_human_actor_id")
          )
        )
      ) return { status: "stale_state" };

      let verified;
      try {
        verified = verifyHumanMembershipTargetDomainSubmission({
          crypto: this.input.crypto,
          submission: input.submission,
          expected: {
            operationId: requiredString(row, "operation_id"),
            targetDomainId: input.submission.targetDomainId,
            participants: newParticipants,
            participantDigest: requiredBytes(row, "new_participant_digest"),
            committerDeviceId: input.submission.committerDeviceId,
            committerHumanId: input.submission.committerHumanId,
            activeDevices: inventory.map((device) => ({
              deviceId: requiredString(device, "device_id"),
              humanId: requiredString(device, "human_id"),
              generation: requiredCounter(device, "device_generation"),
              signingPublicKey: requiredBytes(device, "signing_public_key"),
            })),
          },
          now: progressed
            ? input.submission.additions.length === 0
              ? input.preparedAt
              : Math.max(...input.submission.additions.map(
                ({ joinPackage }) => joinPackage.createdAt,
              ))
            : input.preparedAt,
        });
      } catch {
        return { status: "conflicting_state" };
      }
      if (existingDomains.length !== 0) {
        const durable = await this.exactCreatedState(
          transaction,
          input.submission,
        );
        return durable ?? { status: "conflicting_state" };
      }
      const messages = createHumanMembershipTargetDomainDelivery({
        crypto: this.input.crypto,
        verified,
        now: input.preparedAt,
      });
      const aggregatePayloadBytes = messages.reduce(
        (total, message) => total + message.payloadBytes.length,
        0,
      );
      const recipientSequences = messages.length === 0
        ? []
        : await reserveRecipientDeliverySequences(
          transaction,
          messages.map((message) => message.recipientDeviceId),
          input.preparedAt,
        );
      await expectOne(
        transaction,
        `INSERT INTO crypto_domains (
           id, participant_digest, participants, epoch,
           authorization_revision, roster_bytes, writes_paused,
           pause_operation_id
         ) VALUES ($1, $2, $3::text[], $4, 0, $5, FALSE, NULL)
         RETURNING id`,
        [
          input.submission.targetDomainId,
          input.submission.participantDigest,
          input.submission.participants,
          verified.finalHead.epoch,
          input.submission.additions.at(-1)?.providerSubmission.transition
            .rosterBytes ?? input.submission.initialRosterBytes,
        ],
        "Target Domain insert",
      );
      await expectOne(
        transaction,
        `INSERT INTO crypto_domain_provider_heads (
           domain_id, provider_id, epoch, state_hash, roster_bytes
         ) VALUES ($1, $2, $3, $4, $5)
         RETURNING domain_id`,
        [
          input.submission.targetDomainId,
          verified.finalHead.providerId,
          verified.finalHead.epoch,
          verified.finalHead.stateHash,
          input.submission.additions.at(-1)?.providerSubmission.transition
            .rosterBytes ?? input.submission.initialRosterBytes,
        ],
        "Target Domain provider-head insert",
      );
      for (const rosterEntry of verified.finalRoster) {
        const joinedEpoch = rosterEntry.deviceId
            === input.submission.committerDeviceId
          ? 0
          : verified.additions.find(({ provider }) =>
            provider.transition.targetDeviceId === rosterEntry.deviceId
          )!.provider.transition.nextHead.epoch;
        await expectOne(
          transaction,
          `INSERT INTO crypto_domain_devices (
             domain_id, device_id, human_id, leaf_index, joined_epoch,
             removed_epoch, removed_at
           ) VALUES ($1, $2, $3, $4, $5, NULL, NULL)
           RETURNING device_id`,
          [
            input.submission.targetDomainId,
            rosterEntry.deviceId,
            rosterEntry.humanId,
            rosterEntry.leafIndex,
            joinedEpoch,
          ],
          "Target Domain device mapping insert",
        );
      }
      for (const [index, message] of messages.entries()) {
        await expectOne(
          transaction,
          `INSERT INTO crypto_delivery_messages (
             message_id, operation_id, domain_id, domain_sequence,
             recipient_sequence, kind, recipient_device_id, format_version,
             payload_hash, payload_bytes, created_at, expires_at
           ) VALUES (
             $1, $2, NULL, NULL, $3, 'public_state', $4, 1, $5, $6,
             $7::timestamptz, $8::timestamptz
           )
           RETURNING message_id`,
          [
            message.messageId,
            message.operationId,
            recipientSequences[index]!,
            message.recipientDeviceId,
            message.payloadHash,
            message.payloadBytes,
            isoTime(message.createdAt),
            isoTime(message.expiresAt),
          ],
          "Target Domain delivery insert",
        );
      }
      await expectOne(
        transaction,
        `UPDATE crypto_human_membership_transitions
            SET target_domain_id = $2
          WHERE operation_id = $1
            AND admitted_target_domain_id IS NULL
            AND target_domain_id IS NULL
            AND (
              ($3 = 'human_add' AND bootstrap_device_id IS NOT NULL)
              OR ($3 = 'human_remove' AND bootstrap_device_id IS NULL)
            )
            AND candidate_submitted_at IS NULL
            AND activated_at IS NULL AND released_at IS NULL
          RETURNING operation_id`,
        [
          input.submission.operationId,
          input.submission.targetDomainId,
          kind,
        ],
        "Target Domain membership attachment",
      );
      await expectOne(
        transaction,
        `UPDATE crypto_delivery_operations
            SET state = 'awaiting_committer', fanout_row_count = $2,
                aggregate_payload_bytes = $3, updated_at = $4
          WHERE operation_id = $1
            AND kind IN ('human_add', 'human_remove')
            AND kind = $5
            AND state = 'preparing_domain'
            AND deadline_at > $4
          RETURNING operation_id`,
        [
          input.submission.operationId,
          messages.length,
          aggregatePayloadBytes,
          preparedAt,
          kind,
        ],
        "Target Domain membership readiness",
      );
      return {
        status: "created",
        targetDomainId: input.submission.targetDomainId,
        targetEpoch: verified.finalHead.epoch,
        recipientCount: verified.finalRoster.length,
        messageCount: messages.length,
      };
    });
  }

  reuse(input: {
    readonly operationId: string;
    readonly targetDomainId: string;
    readonly resolvedAt: number;
  }): Promise<HumanMembershipTargetDomainResult> {
    const resolvedAt = isoTime(input.resolvedAt);
    return this.input.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const namespaceId = await membershipNamespace(
        transaction,
        input.operationId,
      );
      if (namespaceId === null) return { status: "stale_state" };
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [namespaceId],
      );
      const rows = await transaction.query(
        `SELECT o.operation_id, o.kind, o.state,
                o.deadline_at > $3::timestamptz AS deadline_live,
                h.namespace_id, h.target_human_actor_id::text
                  AS target_human_actor_id,
                h.admitted_bootstrap_device_id, h.bootstrap_device_id,
                h.new_participants, h.new_participant_digest,
                h.old_domain_id, h.admitted_target_domain_id,
                h.target_domain_id, h.candidate_submitted_at,
                h.activated_at, h.released_at,
                head.domain_id AS head_domain_id,
                head.writes_paused AS head_writes_paused,
                head.pause_operation_id AS head_pause_operation_id,
                target.participants AS target_participants,
                target.participant_digest AS target_participant_digest,
                target.epoch AS target_epoch,
                target.roster_bytes AS target_roster_bytes,
                target.authorization_revision,
                target.writes_paused AS target_writes_paused,
                provider.provider_id, provider.epoch AS provider_epoch,
                provider.roster_bytes AS provider_roster_bytes,
                bootstrap.state AS bootstrap_state,
                bootstrap.human_id AS bootstrap_human_id,
                bootstrap.human_actor_id::text AS bootstrap_human_actor_id,
                bootstrap_map.human_id AS bootstrap_mapping_human_id,
                bootstrap_map.removed_at AS bootstrap_mapping_removed_at
           FROM crypto_delivery_operations o
           JOIN crypto_human_membership_transitions h
             ON h.operation_id = o.operation_id
           JOIN namespace_crypto_heads head
             ON head.namespace_id = h.namespace_id
           JOIN crypto_domains target ON target.id = $2
           JOIN crypto_domain_provider_heads provider
             ON provider.domain_id = target.id
           LEFT JOIN human_crypto_devices bootstrap
             ON bootstrap.device_id = h.bootstrap_device_id
           LEFT JOIN crypto_domain_devices bootstrap_map
             ON bootstrap_map.domain_id = target.id
            AND bootstrap_map.device_id = bootstrap.device_id
          WHERE o.operation_id = $1
          LIMIT 2
          FOR UPDATE OF o, h, head, target, provider`,
        [input.operationId, input.targetDomainId, resolvedAt],
      );
      if (rows.length !== 1) return { status: "stale_state" };
      const row = rows[0]!;
      const participants = requiredStrings(row, "new_participants");
      const state = requiredString(row, "state");
      const kind = requiredString(row, "kind");
      const isAdd = kind === "human_add";
      const isRemove = kind === "human_remove";
      const progressed = [
        "awaiting_committer",
        "awaiting_delivery",
        "ready_to_activate",
        "activating",
        "active",
      ].includes(state);
      const membershipTerminal = row["activated_at"] !== null
        && row["released_at"] !== null;
      if (
        (!isAdd && !isRemove)
        || requiredString(row, "namespace_id") !== namespaceId
        || nullableString(row, "admitted_target_domain_id") !== null
        || nullableString(row, "admitted_bootstrap_device_id") !== null
        || (!progressed && row["candidate_submitted_at"] !== null)
        || (
          state === "active"
            ? !membershipTerminal
            : row["activated_at"] !== null || row["released_at"] !== null
        )
        || (!progressed && !requiredBoolean(row, "deadline_live"))
        || requiredString(row, "head_domain_id")
          !== (
            state === "active"
              ? input.targetDomainId
              : requiredString(row, "old_domain_id")
          )
        || requiredBoolean(row, "head_writes_paused")
          !== (isRemove && state !== "active")
        || (
          isRemove && state !== "active"
            ? nullableString(row, "head_pause_operation_id")
              !== input.operationId
            : row["head_pause_operation_id"] !== null
        )
        || !sameStrings(
          requiredStrings(row, "target_participants"),
          participants,
        )
        || !equalBytes(
          requiredBytes(row, "target_participant_digest"),
          requiredBytes(row, "new_participant_digest"),
        )
        || requiredBoolean(row, "target_writes_paused")
        || requiredCounter(row, "target_epoch")
          !== requiredCounter(row, "provider_epoch")
        || !equalBytes(
          requiredBytes(row, "target_roster_bytes"),
          requiredBytes(row, "provider_roster_bytes"),
        )
        || (
          isAdd
          && (
            requiredString(row, "bootstrap_state") !== "active"
            || requiredString(row, "bootstrap_human_id")
              !== requiredString(row, "target_human_actor_id")
            || requiredString(row, "bootstrap_human_actor_id")
              !== requiredString(row, "target_human_actor_id")
            || nullableString(row, "bootstrap_mapping_human_id")
              !== requiredString(row, "target_human_actor_id")
            || row["bootstrap_mapping_removed_at"] !== null
          )
        )
        || (
          isRemove
          && (
            nullableString(row, "bootstrap_device_id") !== null
            || row["bootstrap_state"] !== null
            || row["bootstrap_human_id"] !== null
            || row["bootstrap_human_actor_id"] !== null
            || row["bootstrap_mapping_human_id"] !== null
            || row["bootstrap_mapping_removed_at"] !== null
          )
        )
      ) return { status: "stale_state" };
      if (
        progressed
          ? nullableString(row, "target_domain_id") !== input.targetDomainId
          : state !== "preparing_domain"
            || nullableString(row, "target_domain_id") !== null
      ) return { status: "conflicting_state" };

      const inventory = await transaction.query(
        `SELECT d.device_id, d.human_id, d.state,
                map.leaf_index, map.joined_epoch, map.removed_at,
                custody.state AS custody_state,
                custody.current_recovery_generation,
                recovery.state AS recovery_state
           FROM human_crypto_devices d
           JOIN human_crypto_custodies custody
             ON custody.human_id = d.human_id
           JOIN human_crypto_recovery_keys recovery
             ON recovery.human_id = custody.human_id
            AND recovery.generation = custody.current_recovery_generation
           JOIN crypto_domain_devices map
             ON map.domain_id = $2 AND map.device_id = d.device_id
          WHERE d.human_id = ANY($1::text[])
            AND d.state = 'active'
          ORDER BY convert_to(d.device_id, 'UTF8')
          LIMIT $3
          FOR UPDATE OF d, custody, recovery, map`,
        [
          participants,
          input.targetDomainId,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.currentDeviceLeavesPerDomain + 1,
        ],
      );
      const roster = decodeProviderRosterV2(
        requiredString(row, "provider_id"),
        requiredBytes(row, "provider_roster_bytes"),
      );
      if (
        inventory.length < 1
        || inventory.length !== roster.length
        || inventory.length
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.currentDeviceLeavesPerDomain
        || participants.some((human) =>
          !inventory.some((device) =>
            requiredString(device, "human_id") === human
          )
        )
        || inventory.some((device) => {
          const rosterEntry = roster.find((entry) =>
            entry.deviceId === requiredString(device, "device_id")
          );
          return rosterEntry === undefined
            || rosterEntry.humanId !== requiredString(device, "human_id")
            || rosterEntry.leafIndex !== requiredCounter(device, "leaf_index")
            || requiredCounter(device, "joined_epoch")
              > requiredCounter(row, "target_epoch")
            || device["removed_at"] !== null
            || requiredString(device, "custody_state") !== "active"
            || device["current_recovery_generation"] === null
          || requiredString(device, "recovery_state") !== "current";
        })
      ) return { status: "stale_state" };
      const currentMappings = await transaction.query(
        `SELECT device_id, human_id, leaf_index, joined_epoch
           FROM crypto_domain_devices
          WHERE domain_id = $1
            AND removed_epoch IS NULL AND removed_at IS NULL
          ORDER BY leaf_index
          LIMIT $2
          FOR UPDATE`,
        [
          input.targetDomainId,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.currentDeviceLeavesPerDomain + 1,
        ],
      );
      if (
        currentMappings.length !== roster.length
        || currentMappings.some((mapping, index) => {
          const rosterEntry = roster[index];
          return rosterEntry === undefined
            || requiredString(mapping, "device_id") !== rosterEntry.deviceId
            || requiredString(mapping, "human_id") !== rosterEntry.humanId
            || requiredCounter(mapping, "leaf_index") !== rosterEntry.leafIndex
            || requiredCounter(mapping, "joined_epoch")
              > requiredCounter(row, "target_epoch");
        })
      ) return { status: "stale_state" };
      const commonCommitter = await transaction.query(
        `SELECT source.device_id
           FROM crypto_domain_devices source
           JOIN crypto_domain_devices target
             ON target.device_id = source.device_id
            AND target.domain_id = $2
            AND target.removed_at IS NULL
           JOIN human_crypto_devices d ON d.device_id = source.device_id
          WHERE source.domain_id = $1
            AND source.removed_at IS NULL
            AND d.state = 'active'
          ORDER BY convert_to(source.device_id, 'UTF8')
          LIMIT 1
          FOR UPDATE OF source, target, d`,
        [requiredString(row, "old_domain_id"), input.targetDomainId],
      );
      if (commonCommitter.length !== 1) return { status: "stale_state" };
      if (!progressed) {
        await expectOne(
          transaction,
          `UPDATE crypto_human_membership_transitions
              SET target_domain_id = $2
            WHERE operation_id = $1
              AND admitted_target_domain_id IS NULL
              AND target_domain_id IS NULL
              AND (
                ($3 = 'human_add' AND bootstrap_device_id IS NOT NULL)
                OR ($3 = 'human_remove' AND bootstrap_device_id IS NULL)
              )
              AND candidate_submitted_at IS NULL
              AND activated_at IS NULL AND released_at IS NULL
          RETURNING operation_id`,
          [input.operationId, input.targetDomainId, kind],
          "Existing target Domain membership attachment",
        );
        await expectOne(
          transaction,
          `UPDATE crypto_delivery_operations
              SET state = 'awaiting_committer', updated_at = $2
            WHERE operation_id = $1
              AND kind IN ('human_add', 'human_remove')
              AND kind = $3
              AND state = 'preparing_domain' AND deadline_at > $2
          RETURNING operation_id`,
          [input.operationId, resolvedAt, kind],
          "Existing target Domain readiness",
        );
      }
      return {
        status: progressed ? "duplicate" : "reused",
        targetDomainId: input.targetDomainId,
        targetEpoch: requiredCounter(row, "target_epoch"),
        recipientCount: inventory.length,
        messageCount: 0,
      };
    });
  }

  private async exactCreatedState(
    executor: CryptoPostgresExecutor,
    submission: HumanMembershipTargetDomainSubmission,
  ): Promise<HumanMembershipTargetDomainResult | null> {
    const rows = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        id: cryptoDomains.id,
        participants: cryptoDomains.participants,
        participant_digest: cryptoDomains.participantDigest,
        epoch: cryptoDomains.epoch,
        authorization_revision: cryptoDomains.authorizationRevision,
        roster_bytes: cryptoDomains.rosterBytes,
        writes_paused: cryptoDomains.writesPaused,
        pause_operation_id: cryptoDomains.pauseOperationId,
        provider_id: cryptoDomainProviderHeads.providerId,
        provider_epoch: sql<number>`${cryptoDomainProviderHeads.epoch}`
          .as("provider_epoch"),
        state_hash: cryptoDomainProviderHeads.stateHash,
        provider_roster_bytes: sql<Uint8Array>`${
          cryptoDomainProviderHeads.rosterBytes
        }`.as("provider_roster_bytes"),
      }).from(cryptoDomains).innerJoin(
        cryptoDomainProviderHeads,
        eq(cryptoDomainProviderHeads.domainId, cryptoDomains.id),
      ).where(eq(cryptoDomains.id, submission.targetDomainId)).limit(2),
    );
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    const lastTransition = submission.additions.at(-1)?.providerSubmission
      .transition;
    const finalHead = lastTransition?.nextHead
      ?? submission.initialProviderHead;
    const finalRosterBytes = lastTransition?.rosterBytes
      ?? submission.initialRosterBytes;
    const roster = decodeProviderRosterV2(
      finalHead.providerId,
      finalRosterBytes,
    );
    const mappings = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        device_id: cryptoDomainDevices.deviceId,
        human_id: cryptoDomainDevices.humanId,
        leaf_index: cryptoDomainDevices.leafIndex,
        joined_epoch: cryptoDomainDevices.joinedEpoch,
      }).from(cryptoDomainDevices).where(and(
        eq(cryptoDomainDevices.domainId, submission.targetDomainId),
        isNull(cryptoDomainDevices.removedEpoch),
        isNull(cryptoDomainDevices.removedAt),
      )).orderBy(cryptoDomainDevices.leafIndex).limit(
        CRYPTO_DELIVERY_COLLECTION_LIMITS.currentDeviceLeavesPerDomain + 1,
      ),
    );
    const deliveries = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        message_count: sql<number>`count(*)::bigint`.as("message_count"),
      }).from(cryptoDeliveryMessages).where(eq(
        cryptoDeliveryMessages.operationId,
        submission.operationId,
      )),
    );
    if (
      !sameStrings(requiredStrings(row, "participants"), submission.participants)
      || !equalBytes(
        requiredBytes(row, "participant_digest"),
        submission.participantDigest,
      )
      || requiredCounter(row, "epoch") !== finalHead.epoch
      || requiredCounter(row, "authorization_revision") !== 0
      || !equalBytes(requiredBytes(row, "roster_bytes"), finalRosterBytes)
      || requiredBoolean(row, "writes_paused")
      || row["pause_operation_id"] !== null
      || requiredString(row, "provider_id") !== finalHead.providerId
      || requiredCounter(row, "provider_epoch") !== finalHead.epoch
      || !equalBytes(requiredBytes(row, "state_hash"), finalHead.stateHash)
      || !equalBytes(
        requiredBytes(row, "provider_roster_bytes"),
        finalRosterBytes,
      )
      || mappings.length !== roster.length
      || mappings.some((mapping, index) => {
        const entry = roster[index];
        return entry === undefined
          || requiredString(mapping, "device_id") !== entry.deviceId
          || requiredString(mapping, "human_id") !== entry.humanId
          || requiredCounter(mapping, "leaf_index") !== entry.leafIndex
          || requiredCounter(mapping, "joined_epoch") > finalHead.epoch;
      })
      || deliveries.length !== 1
      || (
        submission.additions.length > 0
        && requiredCounter(deliveries[0]!, "message_count") < 1
      )
    ) return null;
    return {
      status: "duplicate",
      targetDomainId: submission.targetDomainId,
      targetEpoch: finalHead.epoch,
      recipientCount: mappings.length,
      messageCount: requiredCounter(deliveries[0]!, "message_count"),
    };
  }
}
