import { CRYPTO_DELIVERY_COLLECTION_LIMITS } from "@nautilo/db";
import {
  humanId,
  participantDigest,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import { decodeProviderRosterV2 } from "@nautilo/lattice-crypto/wire";

import type {
  InitialHumanDomainServerReceipt,
} from "../../device/initial-human-domain-client-ceremony.ts";
import {
  humanMembershipTargetDomainSubmissionDigest,
  verifyHumanMembershipTargetDomainSubmission,
  type HumanMembershipTargetDomainSubmission,
} from "../../delivery/human-membership-target-domain.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../storage/postgres-record-codecs.ts";

const TERMINAL_DEADLINE_MS = 5 * 60 * 1_000;

export interface InitialHumanDomainAuthority {
  readonly userId: string;
  readonly humanActorId: string;
  readonly humanId: string;
  readonly deviceId: string;
}

export type InitialHumanDomainActivationResult =
  | Readonly<{
    status: "active" | "replayed";
    receipt: InitialHumanDomainServerReceipt;
  }>
  | Readonly<{
    status:
      | "existing_domain"
      | "multiple_active_devices"
      | "stale_state"
      | "conflicting_state";
  }>;

export type InitialHumanDomainPlanResult =
  | Readonly<{
    status: "available";
    humanId: string;
    deviceId: string;
    activeDeviceIds: readonly string[];
    trustedDeviceRevision: number;
    trustedHostAuthorizationRevision: number;
    deliveryHighWatermark: number;
  }>
  | Readonly<{
    status: "active";
    humanId: string;
    deviceId: string;
    domainId: string;
    providerId: string;
    epoch: number;
    stateHash: Uint8Array;
    trustedDeviceRevision: number;
    trustedHostAuthorizationRevision: number;
    deliveryHighWatermark: number;
  }>
  | Readonly<{
    status:
      | "device_unavailable"
      | "existing_domain"
      | "multiple_active_devices"
      | "stale_identity";
    migration?: Readonly<{
      trustedDeviceRevision: number;
      trustedHostAuthorizationRevision: number;
      deliveryHighWatermark: number;
    }>;
  }>;

function requiredString(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new TypeError(`Initial Human Domain column ${name} must be text`);
  }
  return value;
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Initial Human Domain column ${name} must be bytea`);
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
    throw new TypeError(`Initial Human Domain column ${name} must be a counter`);
  }
  return normalized;
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Initial Human Domain column ${name} must be boolean`);
  }
  return value;
}

function requiredStrings(row: DatabaseRow, name: string): readonly string[] {
  const value = row[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`Initial Human Domain column ${name} must be text[]`);
  }
  return value as readonly string[];
}

function requiredTimestamp(row: DatabaseRow, name: string): number {
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
      `Initial Human Domain column ${name} must be a millisecond timestamp`,
    );
  }
  return normalized;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function stringsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Initial Human Domain timestamp must be nonnegative");
  }
  return new Date(milliseconds).toISOString();
}

function idempotencyKey(digest: Uint8Array): string {
  return `domain_bootstrap/${Buffer.from(digest).toString("base64url")}`;
}

async function expectOne(
  executor: CryptoPostgresExecutor,
  statement: string,
  parameters: readonly DatabaseScalar[],
  label: string,
): Promise<void> {
  const rows = await executor.query(statement, parameters);
  if (rows.length !== 1) throw new Error(`${label} lost its compare-and-swap`);
}

function receiptFromDurable(input: {
  readonly crypto: Pick<LatticeCrypto, "hash">;
  readonly row: DatabaseRow;
  readonly operationId: string;
  readonly humanId: string;
  readonly deviceId: string;
  readonly domainId: string;
  readonly submissionDigest: Uint8Array;
  readonly submission: HumanMembershipTargetDomainSubmission;
}): InitialHumanDomainServerReceipt | null {
  const { row } = input;
  const participants = requiredStrings(row, "participants");
  if (
    requiredString(row, "operation_id") !== input.operationId
    || requiredString(row, "kind") !== "domain_bootstrap"
    || requiredString(row, "state") !== "active"
    || requiredString(row, "idempotency_key")
      !== idempotencyKey(input.submissionDigest)
    || requiredString(row, "human_id") !== input.humanId
    || requiredString(row, "target_human_id") !== input.humanId
    || requiredString(row, "target_device_id") !== input.deviceId
    || requiredCounter(row, "expected_custody_revision") < 1
    || requiredCounter(row, "expected_recovery_generation") < 1
    || requiredCounter(row, "expected_device_revision") < 1
    || !bytesEqual(
      requiredBytes(row, "expected_participant_digest"),
      participantDigest([humanId(input.humanId)]),
    )
    || requiredCounter(row, "aggregate_payload_bytes") !== 0
    || requiredCounter(row, "fanout_row_count") !== 0
    || row["failure_code"] !== null
    || requiredString(row, "audit_ref") !== input.domainId
    || requiredString(row, "domain_id") !== input.domainId
    || !stringsEqual(participants, [input.humanId])
    || !bytesEqual(
      requiredBytes(row, "participant_digest"),
      participantDigest([humanId(input.humanId)]),
    )
    || requiredCounter(row, "domain_epoch") !== 0
    || requiredCounter(row, "authorization_revision") !== 0
    || requiredBoolean(row, "writes_paused")
    || row["pause_operation_id"] !== null
    || requiredString(row, "provider_domain_id") !== input.domainId
    || requiredString(row, "provider_id")
      !== input.submission.initialProviderHead.providerId
    || requiredCounter(row, "provider_epoch") !== 0
    || !bytesEqual(
      requiredBytes(row, "state_hash"),
      input.submission.initialProviderHead.stateHash,
    )
    || requiredString(row, "mapping_domain_id") !== input.domainId
    || requiredString(row, "mapping_device_id") !== input.deviceId
    || requiredString(row, "mapping_human_id") !== input.humanId
    || requiredCounter(row, "leaf_index") !== 0
    || requiredCounter(row, "joined_epoch") !== 0
    || row["removed_epoch"] !== null
    || row["removed_at"] !== null
  ) return null;
  const domainRosterBytes = requiredBytes(row, "domain_roster_bytes");
  const providerRosterBytes = requiredBytes(row, "provider_roster_bytes");
  if (
    !bytesEqual(domainRosterBytes, providerRosterBytes)
    || !bytesEqual(providerRosterBytes, input.submission.initialRosterBytes)
  ) return null;
  const roster = decodeProviderRosterV2(
    requiredString(row, "provider_id"),
    providerRosterBytes,
  );
  if (
    roster.length !== 1
    || roster[0]?.deviceId !== input.deviceId
    || roster[0]?.humanId !== input.humanId
    || roster[0]?.leafIndex !== 0
  ) return null;
  return Object.freeze({
    formatVersion: 1,
    status: "active",
    operationId: input.operationId,
    humanId: input.humanId,
    deviceId: input.deviceId,
    domainId: input.domainId,
    providerId: requiredString(row, "provider_id"),
    epoch: 0,
    stateHash: requiredBytes(row, "state_hash").slice(),
    rosterHash: input.crypto.hash(providerRosterBytes),
    submissionDigest: input.submissionDigest.slice(),
    committedAt: requiredTimestamp(row, "terminal_at_ms"),
  });
}

export class PostgresInitialHumanDomainRepository {
  constructor(private readonly input: {
    readonly handle: CryptoPostgresHandle;
    readonly crypto: LatticeCrypto;
  }) {
    assertVerifiedCryptoPostgresHandle(input.handle);
  }

  async planSingleton(
    authority: InitialHumanDomainAuthority,
  ): Promise<InitialHumanDomainPlanResult> {
    const rows = await this.input.handle.query(
      `SELECT custody.human_id,
              custody.state AS custody_state,
              custody.current_inventory_revision,
              custody.current_inventory_count,
              custody.current_inventory_digest,
              device.device_id,
              device.state AS device_state,
              device.revision AS device_revision,
              device.delivery_sequence_high_watermark,
              ARRAY(
                SELECT active.device_id
                  FROM human_crypto_devices active
                 WHERE active.human_id = custody.human_id
                   AND active.state = 'active'
                 ORDER BY convert_to(active.device_id, 'UTF8')
                 LIMIT $4
              ) AS active_device_ids,
              (
                SELECT count(*)::bigint
                  FROM crypto_domains domain_row
                 WHERE $2 = ANY(domain_row.participants)
              ) AS containing_domain_count
         FROM human_crypto_custodies custody
         LEFT JOIN human_crypto_devices device
           ON device.human_id = custody.human_id
          AND device.device_id = $3
        WHERE custody.user_id = $1::uuid
          AND custody.human_actor_id = $2::uuid
          AND custody.human_id = $2
        LIMIT 2`,
      [
        authority.userId,
        authority.humanActorId,
        authority.deviceId,
        CRYPTO_DELIVERY_COLLECTION_LIMITS.activeDevicesPerHuman + 1,
      ],
    );
    if (rows.length !== 1) return Object.freeze({ status: "stale_identity" });
    const row = rows[0]!;
    if (
      requiredString(row, "human_id") !== authority.humanId
      || requiredString(row, "custody_state") !== "active"
    ) return Object.freeze({ status: "stale_identity" });
    const activeDeviceIds = requiredStrings(row, "active_device_ids");
    const containingDomainCount = requiredCounter(
      row,
      "containing_domain_count",
    );
    if (
      row["device_id"] !== authority.deviceId
      || row["device_state"] !== "active"
    ) {
      return Object.freeze({
        status: containingDomainCount > 0 && activeDeviceIds.length > 0
          ? "existing_domain" as const
          : "device_unavailable" as const,
      });
    }
    const deviceRevision = requiredCounter(row, "device_revision");
    const deliveryHighWatermark = requiredCounter(
      row,
      "delivery_sequence_high_watermark",
    );
    const migration = Object.freeze({
      trustedDeviceRevision: deviceRevision,
      trustedHostAuthorizationRevision: deviceRevision,
      deliveryHighWatermark,
    });
    if (containingDomainCount !== 0) {
      const activeDomains = await this.input.handle.query(
        `SELECT domain_row.id AS domain_id,
                domain_row.epoch AS domain_epoch,
                provider.provider_id,
                provider.epoch AS provider_epoch,
                provider.state_hash,
                mapping.human_id AS mapping_human_id,
                mapping.device_id AS mapping_device_id
           FROM crypto_domains domain_row
           JOIN crypto_domain_provider_heads provider
             ON provider.domain_id = domain_row.id
            AND provider.epoch = domain_row.epoch
           JOIN crypto_domain_devices mapping
             ON mapping.domain_id = domain_row.id
            AND mapping.human_id = $1
            AND mapping.device_id = $2
            AND mapping.removed_at IS NULL
          WHERE $1 = ANY(domain_row.participants)
          ORDER BY convert_to(domain_row.id, 'UTF8')
          LIMIT 2`,
        [authority.humanId, authority.deviceId],
      );
      if (activeDomains.length !== 1) {
        return Object.freeze({ status: "existing_domain", migration });
      }
      const active = activeDomains[0]!;
      const epoch = requiredCounter(active, "domain_epoch");
      if (
        requiredString(active, "mapping_human_id") !== authority.humanId
        || requiredString(active, "mapping_device_id") !== authority.deviceId
        || requiredCounter(active, "provider_epoch") !== epoch
      ) return Object.freeze({ status: "stale_identity" });
      return Object.freeze({
        status: "active" as const,
        humanId: authority.humanId,
        deviceId: authority.deviceId,
        domainId: requiredString(active, "domain_id"),
        providerId: requiredString(active, "provider_id"),
        epoch,
        stateHash: requiredBytes(active, "state_hash").slice(),
        trustedDeviceRevision: deviceRevision,
        trustedHostAuthorizationRevision: deviceRevision,
        deliveryHighWatermark,
      });
    }
    if (activeDeviceIds.length !== 1) {
      return Object.freeze({ status: "multiple_active_devices", migration });
    }
    if (activeDeviceIds[0] !== authority.deviceId) {
      return Object.freeze({ status: "stale_identity" });
    }
    if (
      row["current_inventory_revision"] !== null
      || row["current_inventory_count"] !== null
      || row["current_inventory_digest"] !== null
    ) return Object.freeze({ status: "stale_identity" });
    return Object.freeze({
      status: "available" as const,
      humanId: authority.humanId,
      deviceId: authority.deviceId,
      activeDeviceIds: Object.freeze([...activeDeviceIds]),
      trustedDeviceRevision: deviceRevision,
      trustedHostAuthorizationRevision: deviceRevision,
      deliveryHighWatermark,
    });
  }

  activate(input: {
    readonly authority: InitialHumanDomainAuthority;
    readonly submission: HumanMembershipTargetDomainSubmission;
    readonly committedAt: number;
  }): Promise<InitialHumanDomainActivationResult> {
    const submissionDigest = humanMembershipTargetDomainSubmissionDigest({
      crypto: this.input.crypto,
      submission: input.submission,
    });
    const canonicalParticipantDigest = participantDigest([
      humanId(input.authority.humanId),
    ]);
    const committedAt = isoTime(input.committedAt);
    const deadlineAt = isoTime(input.committedAt + TERMINAL_DEADLINE_MS);
    return this.input.handle.transaction<InitialHumanDomainActivationResult>(
      async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`domain-bootstrap/${input.authority.humanId}`],
      );
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [input.submission.targetDomainId],
      );

      const replayRows = await transaction.query(
        `SELECT o.operation_id, o.idempotency_key, o.kind, o.state,
                o.human_id, o.target_human_id, o.target_device_id,
                o.expected_custody_revision,
                o.expected_recovery_generation,
                o.expected_device_revision,
                o.expected_participant_digest,
                o.aggregate_payload_bytes, o.fanout_row_count,
                o.failure_code, o.audit_ref,
                floor(extract(epoch from o.terminal_at) * 1000)::bigint
                  AS terminal_at_ms,
                d.id AS domain_id, d.participants, d.participant_digest,
                d.epoch AS domain_epoch, d.authorization_revision,
                d.roster_bytes AS domain_roster_bytes,
                d.writes_paused, d.pause_operation_id,
                p.domain_id AS provider_domain_id, p.provider_id,
                p.epoch AS provider_epoch, p.state_hash,
                p.roster_bytes AS provider_roster_bytes,
                m.domain_id AS mapping_domain_id,
                m.device_id AS mapping_device_id,
                m.human_id AS mapping_human_id,
                m.leaf_index, m.joined_epoch, m.removed_epoch, m.removed_at
           FROM crypto_delivery_operations o
           LEFT JOIN crypto_domains d ON d.id = o.audit_ref
           LEFT JOIN crypto_domain_provider_heads p
             ON p.domain_id = d.id AND p.epoch = 0
           LEFT JOIN crypto_domain_devices m
             ON m.domain_id = d.id
            AND m.device_id = o.target_device_id
            AND m.joined_epoch = 0
          WHERE o.operation_id = $1 OR o.idempotency_key = $2
          ORDER BY convert_to(o.operation_id, 'UTF8')
          LIMIT 2
          FOR UPDATE OF o`,
        [input.submission.operationId, idempotencyKey(submissionDigest)],
      );
      if (replayRows.length > 1) return { status: "conflicting_state" };
      if (replayRows.length === 1) {
        const row = replayRows[0]!;
        const receipt = receiptFromDurable({
          crypto: this.input.crypto,
          row,
          operationId: input.submission.operationId,
          humanId: input.authority.humanId,
          deviceId: input.authority.deviceId,
          domainId: input.submission.targetDomainId,
          submissionDigest,
          submission: input.submission,
        });
        return receipt === null
          ? { status: "conflicting_state" }
          : { status: "replayed", receipt };
      }

      const inventory = await transaction.query(
        `SELECT custody.human_id, custody.user_id::text AS user_id,
                custody.human_actor_id::text AS human_actor_id,
                custody.state AS custody_state,
                custody.current_recovery_generation,
                custody.current_inventory_revision,
                custody.current_inventory_count,
                custody.current_inventory_digest,
                custody.revision AS custody_revision,
                device.device_id, device.device_generation,
                device.signing_public_key, device.state AS device_state,
                device.revision AS device_revision
           FROM human_crypto_custodies custody
           JOIN human_crypto_devices device
             ON device.human_id = custody.human_id
          WHERE custody.user_id = $1::uuid
            AND custody.human_actor_id = $2::uuid
            AND custody.human_id = $3
            AND device.state = 'active'
          ORDER BY convert_to(device.device_id, 'UTF8')
          LIMIT $4
          FOR UPDATE OF custody, device`,
        [
          input.authority.userId,
          input.authority.humanActorId,
          input.authority.humanId,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.activeDevicesPerHuman + 1,
        ],
      );
      if (inventory.length > 1) return { status: "multiple_active_devices" };
      if (inventory.length !== 1) return { status: "stale_state" };
      const authorityRow = inventory[0]!;
      if (
        requiredString(authorityRow, "human_id") !== input.authority.humanId
        || requiredString(authorityRow, "user_id") !== input.authority.userId
        || requiredString(authorityRow, "human_actor_id")
          !== input.authority.humanActorId
        || requiredString(authorityRow, "custody_state") !== "active"
        || requiredString(authorityRow, "device_id") !== input.authority.deviceId
        || requiredString(authorityRow, "device_state") !== "active"
        || authorityRow["current_inventory_revision"] !== null
        || authorityRow["current_inventory_count"] !== null
        || authorityRow["current_inventory_digest"] !== null
        || authorityRow["current_recovery_generation"] === null
      ) return { status: "stale_state" };
      if (
        input.submission.additions.length !== 0
        || !stringsEqual(input.submission.participants, [input.authority.humanId])
        || !bytesEqual(
          input.submission.participantDigest,
          canonicalParticipantDigest,
        )
        || input.submission.committerHumanId !== input.authority.humanId
        || input.submission.committerDeviceId !== input.authority.deviceId
      ) return { status: "conflicting_state" };
      try {
        verifyHumanMembershipTargetDomainSubmission({
          crypto: this.input.crypto,
          submission: input.submission,
          expected: {
            operationId: input.submission.operationId,
            targetDomainId: input.submission.targetDomainId,
            participants: [input.authority.humanId],
            participantDigest: canonicalParticipantDigest,
            committerDeviceId: input.authority.deviceId,
            committerHumanId: input.authority.humanId,
            activeDevices: [{
              deviceId: input.authority.deviceId,
              humanId: input.authority.humanId,
              generation: requiredCounter(authorityRow, "device_generation"),
              signingPublicKey: requiredBytes(
                authorityRow,
                "signing_public_key",
              ),
            }],
          },
          now: input.committedAt,
        });
      } catch {
        return { status: "conflicting_state" };
      }

      const existingDomains = await transaction.query(
        `SELECT id, participants, participant_digest
           FROM crypto_domains
          WHERE id = $1
             OR (participant_digest = $2 AND participants = $3::text[])
          ORDER BY convert_to(id, 'UTF8')
          LIMIT 2
          FOR UPDATE`,
        [
          input.submission.targetDomainId,
          canonicalParticipantDigest,
          [input.authority.humanId],
        ],
      );
      if (existingDomains.length !== 0) {
        return existingDomains.length === 1
          && requiredString(existingDomains[0]!, "id")
            !== input.submission.targetDomainId
          && stringsEqual(
            requiredStrings(existingDomains[0]!, "participants"),
            [input.authority.humanId],
          )
          && bytesEqual(
            requiredBytes(existingDomains[0]!, "participant_digest"),
            canonicalParticipantDigest,
          )
          ? { status: "existing_domain" }
          : { status: "conflicting_state" };
      }

      const verified = verifyHumanMembershipTargetDomainSubmission({
        crypto: this.input.crypto,
        submission: input.submission,
        expected: {
          operationId: input.submission.operationId,
          targetDomainId: input.submission.targetDomainId,
          participants: [input.authority.humanId],
          participantDigest: canonicalParticipantDigest,
          committerDeviceId: input.authority.deviceId,
          committerHumanId: input.authority.humanId,
          activeDevices: [{
            deviceId: input.authority.deviceId,
            humanId: input.authority.humanId,
            generation: requiredCounter(authorityRow, "device_generation"),
            signingPublicKey: requiredBytes(authorityRow, "signing_public_key"),
          }],
        },
        now: input.committedAt,
      });
      if (
        verified.finalHead.epoch !== 0
        || verified.finalRoster.length !== 1
        || verified.finalRoster[0]?.leafIndex !== 0
      ) return { status: "conflicting_state" };
      const rosterHash = this.input.crypto.hash(
        input.submission.initialRosterBytes,
      );
      await expectOne(
        transaction,
        `INSERT INTO crypto_domains (
           id, participant_digest, participants, epoch,
           authorization_revision, roster_bytes, writes_paused,
           pause_operation_id
         ) VALUES ($1, $2, $3::text[], 0, 0, $4, FALSE, NULL)
         RETURNING id`,
        [
          input.submission.targetDomainId,
          canonicalParticipantDigest,
          [input.authority.humanId],
          input.submission.initialRosterBytes,
        ],
        "Initial Human Domain insert",
      );
      await expectOne(
        transaction,
        `INSERT INTO crypto_domain_provider_heads (
           domain_id, provider_id, epoch, state_hash, roster_bytes
         ) VALUES ($1, $2, 0, $3, $4)
         RETURNING domain_id`,
        [
          input.submission.targetDomainId,
          input.submission.initialProviderHead.providerId,
          input.submission.initialProviderHead.stateHash,
          input.submission.initialRosterBytes,
        ],
        "Initial Human Domain provider head insert",
      );
      await expectOne(
        transaction,
        `INSERT INTO crypto_domain_devices (
           domain_id, device_id, human_id, leaf_index, joined_epoch,
           removed_epoch, removed_at
         ) VALUES ($1, $2, $3, 0, 0, NULL, NULL)
         RETURNING device_id`,
        [
          input.submission.targetDomainId,
          input.authority.deviceId,
          input.authority.humanId,
        ],
        "Initial Human Domain device mapping insert",
      );
      await expectOne(
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
           $1, $2, 'domain_bootstrap', 'active', $3, $3, $4,
           $5, $6, $7, $8, 0, 0, NULL, NULL, 0, $9, NULL, $10,
           $11, $11, $12, $11
         )
         RETURNING operation_id`,
        [
          input.submission.operationId,
          idempotencyKey(submissionDigest),
          input.authority.humanId,
          input.authority.deviceId,
          requiredCounter(authorityRow, "custody_revision"),
          requiredCounter(authorityRow, "current_recovery_generation"),
          requiredCounter(authorityRow, "device_revision"),
          canonicalParticipantDigest,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          input.submission.targetDomainId,
          committedAt,
          deadlineAt,
        ],
        "Initial Human Domain operation insert",
      );
      return {
        status: "active",
        receipt: Object.freeze({
          formatVersion: 1,
          status: "active",
          operationId: input.submission.operationId,
          humanId: input.authority.humanId,
          deviceId: input.authority.deviceId,
          domainId: input.submission.targetDomainId,
          providerId: input.submission.initialProviderHead.providerId,
          epoch: 0,
          stateHash: input.submission.initialProviderHead.stateHash.slice(),
          rosterHash,
          submissionDigest: submissionDigest.slice(),
          committedAt: input.committedAt,
        }),
      };
      },
    ).finally(() => {
      submissionDigest.fill(0);
      canonicalParticipantDigest.fill(0);
    });
  }
}
