import {
  cryptoDeviceId,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  and,
  asc,
  CRYPTO_DELIVERY_BYTE_LIMITS,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDeliveryMessages,
  cryptoDomainTransitionNamespaces,
  cryptoDomainTransitionSteps,
  cryptoOperationOutbox,
  eq,
} from "@nautilo/db";
import {
  verifyDeviceRevocationManifest,
  type DeviceRevocationDomainHead,
  type DeviceRevocationManifest,
  type DeviceRevocationRegistryDevice,
} from "../../device/device-revocation.ts";
import {
  MAX_ACTIVE_DOMAINS_PER_DEVICE,
  MAX_NAMESPACES_PER_DOMAIN_TRANSITION,
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
  humanHasOperationCapacity,
} from "../delivery/postgres-human-operation-capacity.ts";

const OPERATION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const textEncoder = new TextEncoder();

export type DeviceRevocationAdmissionResult =
  | {
    readonly status: "admitted" | "duplicate";
    readonly domainCount: number;
    readonly blockedDomainCount: number;
    readonly custodyState: "active" | "recovery_required";
  }
  | {
    readonly status:
      | "stale_state"
      | "conflicting_state"
      | "operation_limit_reached";
  };

interface DomainPlan extends DeviceRevocationDomainHead {
  readonly targetEpoch: number;
  readonly committerDeviceId: string | null;
}

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
    throw new TypeError(`Device revocation column ${name} must be text`);
  }
  return value;
}

function nullableString(row: DatabaseRow, name: string): string | null {
  return row[name] === null ? null : requiredString(row, name);
}

function requiredBytes(row: DatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Device revocation column ${name} must be bytea`);
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
      `Device revocation column ${name} must be a safe counter`,
    );
  }
  return normalized;
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Device revocation column ${name} must be boolean`);
  }
  return value;
}

function requiredStringArray(
  row: DatabaseRow,
  name: string,
): readonly string[] {
  const value = row[name];
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string")
  ) {
    throw new TypeError(`Device revocation column ${name} must be text[]`);
  }
  return value as readonly string[];
}

function oneOrNull(
  rows: readonly DatabaseRow[],
  label: string,
): DatabaseRow | null {
  if (rows.length > 1) {
    throw new Error(`${label} returned duplicate rows`);
  }
  return rows[0] ?? null;
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      "Device revocation timestamp must be a nonnegative safe integer",
    );
  }
  return new Date(milliseconds).toISOString();
}

function hex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function planArtifactHash(
  crypto: Pick<LatticeCrypto, "hash">,
  manifestArtifactHash: Uint8Array,
  domains: readonly DomainPlan[],
  custodyState: "active" | "recovery_required",
): Uint8Array {
  return crypto.hash(textEncoder.encode(JSON.stringify({
    formatVersion: 1,
    domain: "nautilo/lattice-bridge/device-revocation-admission/v1",
    manifestArtifactHash: hex(manifestArtifactHash),
    custodyState,
    domains: domains.map((domain) => ({
      domainId: domain.domainId,
      expectedEpoch: domain.expectedEpoch,
      targetEpoch: domain.targetEpoch,
      expectedAuthorizationRevision:
        domain.expectedAuthorizationRevision,
      expectedParticipantDigest: hex(domain.expectedParticipantDigest),
      committerDeviceId: domain.committerDeviceId,
      namespaces: domain.namespaces.map((namespace) => ({
        namespaceId: namespace.namespaceId,
        expectedAccessRevision: namespace.expectedAccessRevision,
        expectedBindingHash: hex(namespace.expectedBindingHash),
      })),
    })),
  })));
}

function inventoryCoordinates(
  crypto: Pick<LatticeCrypto, "hash">,
  manifest: DeviceRevocationManifest,
): {
  readonly revision: number;
  readonly count: number;
  readonly digest: Uint8Array;
  readonly absent: boolean;
} {
  if (
    manifest.expectedInventoryRevision === null
    && manifest.expectedInventoryCount === null
    && manifest.expectedInventoryDigest === null
  ) {
    return {
      revision: 0,
      count: 0,
      digest: crypto.hash(textEncoder.encode(
        "nautilo/lattice-bridge/device-revocation/absent-inventory/v1",
      )),
      absent: true,
    };
  }
  if (
    manifest.expectedInventoryRevision === null
    || manifest.expectedInventoryCount === null
    || manifest.expectedInventoryDigest === null
  ) {
    throw new TypeError(
      "Device revocation inventory coordinates are incomplete",
    );
  }
  return {
    revision: manifest.expectedInventoryRevision,
    count: manifest.expectedInventoryCount,
    digest: manifest.expectedInventoryDigest,
    absent: false,
  };
}

function registryDevice(
  row: DatabaseRow,
  prefix: "issuer" | "target",
  revision: number,
): DeviceRevocationRegistryDevice {
  return {
    state: "active",
    humanId: requiredString(row, `${prefix}_human_id`),
    revision,
    signingPublicKey: requiredBytes(row, `${prefix}_signing_public_key`),
    encryptionPublicKey: requiredBytes(
      row,
      `${prefix}_encryption_public_key`,
    ),
    publicFingerprint: requiredBytes(row, `${prefix}_public_fingerprint`),
  };
}

function sameNamespacePlan(
  expected: DeviceRevocationDomainHead["namespaces"],
  actual: DeviceRevocationDomainHead["namespaces"],
): boolean {
  return expected.length === actual.length
    && expected.every((namespace, index) => {
      const candidate = actual[index]!;
      return namespace.namespaceId === candidate.namespaceId
        && namespace.expectedAccessRevision
          === candidate.expectedAccessRevision
        && equalBytes(
          namespace.expectedBindingHash,
          candidate.expectedBindingHash,
        );
    });
}

function sameSignedPlan(
  expected: readonly DeviceRevocationDomainHead[],
  actual: readonly DomainPlan[],
): boolean {
  return expected.length === actual.length
    && expected.every((domain, index) => {
      const candidate = actual[index]!;
      return domain.domainId === candidate.domainId
        && domain.expectedEpoch === candidate.expectedEpoch
        && domain.expectedAuthorizationRevision
          === candidate.expectedAuthorizationRevision
        && equalBytes(
          domain.expectedParticipantDigest,
          candidate.expectedParticipantDigest,
        )
        && sameNamespacePlan(domain.namespaces, candidate.namespaces);
    });
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

export class PostgresDeviceRevocationAdmissionRepository {
  readonly #handle: CryptoPostgresHandle;
  readonly #crypto: Pick<LatticeCrypto, "hash" | "verify">;

  constructor(input: {
    readonly handle: CryptoPostgresHandle;
    readonly crypto: Pick<LatticeCrypto, "hash" | "verify">;
  }) {
    assertVerifiedCryptoPostgresHandle(input.handle);
    this.#handle = input.handle;
    this.#crypto = input.crypto;
  }

  admit(input: {
    readonly manifest: DeviceRevocationManifest;
    readonly revokedAt: number;
    readonly auditRef?: string;
  }): Promise<DeviceRevocationAdmissionResult> {
    const revokedAt = isoTime(input.revokedAt);
    const deadlineAt = isoTime(input.revokedAt + OPERATION_TTL_MS);
    const manifestHumanId = humanId(input.manifest.humanId);
    const manifestOperationId = input.manifest.operationId;
    const manifestTargetDeviceId = cryptoDeviceId(
      input.manifest.targetDeviceId,
    );
    const auditRef = input.auditRef ?? null;
    const inventory = inventoryCoordinates(this.#crypto, input.manifest);

    return this.#handle.transaction(async (transaction) => {
      await transaction.query(
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      );
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`device-revocation/${manifestHumanId}`],
      );

      const priorRows = await transaction.query(
        `SELECT o.operation_id, o.idempotency_key, o.kind, o.state,
                o.human_id, o.target_human_id, o.target_device_id,
                o.expected_custody_revision,
                o.expected_recovery_generation,
                o.expected_device_revision, o.fanout_row_count,
                o.aggregate_payload_bytes, o.failure_code,
                e.owner_human_id, e.source_device_id,
                e.expected_device_revision AS epoch_device_revision,
                e.expected_inventory_revision,
                e.expected_inventory_count, e.expected_inventory_digest,
                e.authorization_artifact_hash
           FROM crypto_delivery_operations o
           LEFT JOIN crypto_device_epoch_operations e
             ON e.operation_id = o.operation_id
          WHERE o.operation_id = $1 OR o.idempotency_key = $2
          ORDER BY convert_to(o.operation_id, 'UTF8')
          LIMIT 2
          FOR UPDATE OF o`,
        [manifestOperationId, input.manifest.idempotencyKey],
      );
      if (priorRows.length > 1) return { status: "conflicting_state" };

      const registry = oneOrNull(
        await transaction.query(
          `SELECT i.device_id AS issuer_device_id,
                  i.human_id AS issuer_human_id,
                  i.state AS issuer_state, i.revision AS issuer_revision,
                  i.signing_public_key AS issuer_signing_public_key,
                  i.encryption_public_key AS issuer_encryption_public_key,
                  i.public_fingerprint AS issuer_public_fingerprint,
                  i.revoked_at AS issuer_revoked_at,
                  t.device_id AS target_device_id,
                  t.human_id AS target_human_id,
                  t.state AS target_state, t.revision AS target_revision,
                  t.signing_public_key AS target_signing_public_key,
                  t.encryption_public_key AS target_encryption_public_key,
                  t.public_fingerprint AS target_public_fingerprint,
                  t.revoked_at AS target_revoked_at,
                  c.human_id AS custody_human_id,
                  c.state AS custody_state, c.revision AS custody_revision,
                  c.current_recovery_generation,
                  c.current_inventory_revision,
                  c.current_inventory_count, c.current_inventory_digest
             FROM human_crypto_devices i
             JOIN human_crypto_devices t ON t.device_id = $2
             JOIN human_crypto_custodies c ON c.human_id = $3
            WHERE i.device_id = $1
            LIMIT 2
            FOR UPDATE OF i, t, c`,
          [
            input.manifest.issuerDeviceId,
            manifestTargetDeviceId,
            manifestHumanId,
          ],
        ),
        "Device revocation registry lookup",
      );
      if (registry === null) return { status: "stale_state" };

      const verifyManifest = () =>
        verifyDeviceRevocationManifest({
          crypto: this.#crypto,
          manifest: input.manifest,
          resolveDevice: (deviceId) => {
            if (deviceId === input.manifest.issuerDeviceId) {
              return registryDevice(
                registry,
                "issuer",
                input.manifest.expectedIssuerDeviceRevision,
              );
            }
            if (deviceId === manifestTargetDeviceId) {
              return registryDevice(
                registry,
                "target",
                input.manifest.expectedTargetDeviceRevision,
              );
            }
            return null;
          },
        });

      if (priorRows.length === 1) {
        const prior = priorRows[0]!;
        let verified: ReturnType<typeof verifyManifest>;
        try {
          verified = verifyManifest();
        } catch {
          return { status: "conflicting_state" };
        }
        const steps = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            domain_id: cryptoDomainTransitionSteps.domainId,
            expected_epoch: cryptoDomainTransitionSteps.expectedEpoch,
            expected_authorization_revision:
              cryptoDomainTransitionSteps.expectedAuthorizationRevision,
            expected_participant_digest:
              cryptoDomainTransitionSteps.expectedParticipantDigest,
            target_epoch: cryptoDomainTransitionSteps.targetEpoch,
            committer_device_id: cryptoDomainTransitionSteps.committerDeviceId,
            state: cryptoDomainTransitionSteps.state,
            failure_code: cryptoDomainTransitionSteps.failureCode,
          }).from(cryptoDomainTransitionSteps).where(
            eq(cryptoDomainTransitionSteps.operationId, manifestOperationId),
          ).orderBy(asc(cryptoDomainTransitionSteps.domainId)),
        );
        const namespaceRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            domain_id: cryptoDomainTransitionNamespaces.domainId,
            namespace_id: cryptoDomainTransitionNamespaces.namespaceId,
            expected_access_revision:
              cryptoDomainTransitionNamespaces.expectedAccessRevision,
            expected_binding_hash:
              cryptoDomainTransitionNamespaces.expectedBindingHash,
          }).from(cryptoDomainTransitionNamespaces).where(
            eq(
              cryptoDomainTransitionNamespaces.operationId,
              manifestOperationId,
            ),
          ).orderBy(asc(cryptoDomainTransitionNamespaces.namespaceId)),
        );
        const blockedDomainIds = steps
          .filter((row) => nullableString(row, "committer_device_id") === null)
          .map((row) => requiredString(row, "domain_id"));
        const blockedNamespaces = blockedDomainIds.length === 0
          ? []
          : await transaction.query(
            `SELECT domain_id, namespace_id, access_revision,
                    binding_hash, writes_paused, pause_operation_id
               FROM namespace_crypto_heads
              WHERE domain_id = ANY($1::text[])
              ORDER BY convert_to(namespace_id, 'UTF8')
              LIMIT $2`,
            [
              blockedDomainIds,
              CRYPTO_DELIVERY_COLLECTION_LIMITS
                .fanoutRowsPerOperation + 1,
            ],
          );
        const deliveryRows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            message_id: cryptoDeliveryMessages.messageId,
            payload_bytes: cryptoDeliveryMessages.payloadBytes,
          }).from(cryptoDeliveryMessages).where(
            eq(cryptoDeliveryMessages.operationId, manifestOperationId),
          ).orderBy(asc(cryptoDeliveryMessages.messageId)).limit(
            CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation + 1,
          ),
        );
        const deliveryPayloadBytes = deliveryRows.reduce(
          (total, row) => total + requiredBytes(row, "payload_bytes").length,
          0,
        );
        const persistedPlan: DomainPlan[] = steps.map((step) => {
          const domainId = requiredString(step, "domain_id");
          const committerDeviceId = nullableString(
            step,
            "committer_device_id",
          );
          const rows = committerDeviceId === null
            ? blockedNamespaces.filter((row) =>
              requiredString(row, "domain_id") === domainId
            )
            : namespaceRows.filter((row) =>
              requiredString(row, "domain_id") === domainId
            );
          return {
            domainId,
            expectedEpoch: requiredCounter(step, "expected_epoch"),
            targetEpoch: requiredCounter(step, "target_epoch"),
            expectedAuthorizationRevision: requiredCounter(
              step,
              "expected_authorization_revision",
            ),
            expectedParticipantDigest: requiredBytes(
              step,
              "expected_participant_digest",
            ),
            committerDeviceId,
            namespaces: rows.map((row) => ({
              namespaceId: requiredString(row, "namespace_id"),
              expectedAccessRevision: requiredCounter(
                row,
                committerDeviceId === null
                  ? "access_revision"
                  : "expected_access_revision",
              ),
              expectedBindingHash: requiredBytes(
                row,
                committerDeviceId === null
                  ? "binding_hash"
                  : "expected_binding_hash",
              ),
            })),
          };
        });
        const blockedDomainCount = persistedPlan.filter(
          (domain) => domain.committerDeviceId === null,
        ).length;
        const orphanedNamespaceStep = namespaceRows.some((row) => {
          const domainId = requiredString(row, "domain_id");
          return !steps.some((step) =>
            requiredString(step, "domain_id") === domainId
            && nullableString(step, "committer_device_id") !== null
          );
        });
        const blockedNamespaceOverflow = blockedNamespaces.length
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation;
        const storedArtifactHash = requiredBytes(
          prior,
          "authorization_artifact_hash",
        );
        const artifactForActiveCustody = planArtifactHash(
          this.#crypto,
          verified.authorizationArtifactHash,
          persistedPlan,
          "active",
        );
        const artifactForRecoveryCustody = planArtifactHash(
          this.#crypto,
          verified.authorizationArtifactHash,
          persistedPlan,
          "recovery_required",
        );
        const admittedCustodyState = equalBytes(
            storedArtifactHash,
            artifactForActiveCustody,
          )
          ? "active"
          : equalBytes(storedArtifactHash, artifactForRecoveryCustody)
          ? "recovery_required"
          : null;
        const blockedNamespaceConflict = blockedNamespaces.some((row) =>
          !requiredBoolean(row, "writes_paused")
          || nullableString(row, "pause_operation_id") !== manifestOperationId
        );
        if (
          requiredString(prior, "operation_id") !== manifestOperationId
          || requiredString(prior, "idempotency_key")
            !== input.manifest.idempotencyKey
          || requiredString(prior, "kind") !== "device_revoke"
          || requiredString(prior, "human_id") !== manifestHumanId
          || requiredString(prior, "target_human_id") !== manifestHumanId
          || requiredString(prior, "target_device_id")
            !== manifestTargetDeviceId
          || requiredCounter(prior, "expected_custody_revision")
            !== input.manifest.expectedCustodyRevision
          || requiredCounter(prior, "expected_recovery_generation")
            !== input.manifest.expectedRecoveryGeneration
          || requiredCounter(prior, "expected_device_revision")
            !== input.manifest.expectedTargetDeviceRevision
          || requiredString(prior, "owner_human_id") !== manifestHumanId
          || requiredString(prior, "source_device_id")
            !== input.manifest.issuerDeviceId
          || requiredCounter(prior, "epoch_device_revision")
            !== input.manifest.expectedTargetDeviceRevision
          || requiredCounter(prior, "expected_inventory_revision")
            !== inventory.revision
          || requiredCounter(prior, "expected_inventory_count")
            !== inventory.count
          || !equalBytes(
            requiredBytes(prior, "expected_inventory_digest"),
            inventory.digest,
          )
          || requiredString(registry, "target_state") !== "revoked"
          || requiredCounter(registry, "target_revision")
            !== input.manifest.expectedTargetDeviceRevision + 1
          || registry["target_revoked_at"] === null
          || requiredCounter(registry, "custody_revision")
            < input.manifest.expectedCustodyRevision + 1
          || !sameSignedPlan(input.manifest.domains, persistedPlan)
          || blockedNamespaceConflict
          || orphanedNamespaceStep
          || blockedNamespaceOverflow
          || deliveryRows.length
            > CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation
          || deliveryPayloadBytes
            > CRYPTO_DELIVERY_BYTE_LIMITS.aggregateOpaquePayload
          || requiredCounter(prior, "fanout_row_count")
            !== deliveryRows.length
          || requiredCounter(prior, "aggregate_payload_bytes")
            !== deliveryPayloadBytes
          || admittedCustodyState === null
          || steps.some((step) =>
            nullableString(step, "committer_device_id") === null
              ? requiredString(step, "state") !== "failed"
                || nullableString(step, "failure_code")
                  !== "domain_rebootstrap_required"
              : false
          )
        ) return { status: "conflicting_state" };
        const outbox = oneOrNull(
          await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              outbox_id: cryptoOperationOutbox.outboxId,
              event_type: cryptoOperationOutbox.eventType,
              payload_bytes: cryptoOperationOutbox.payloadBytes,
              idempotency_key: cryptoOperationOutbox.idempotencyKey,
            }).from(cryptoOperationOutbox).where(and(
              eq(cryptoOperationOutbox.operationId, manifestOperationId),
              eq(cryptoOperationOutbox.sequence, 0),
            )).limit(2),
          ),
          "Device revocation replay outbox lookup",
        );
        if (outbox !== null) {
          const payload = textEncoder.encode(JSON.stringify({
            formatVersion: 1,
            eventType: "crypto_device_revoked",
            operationId: manifestOperationId,
            humanId: manifestHumanId,
            targetDeviceId: manifestTargetDeviceId,
            deviceRevision:
              input.manifest.expectedTargetDeviceRevision + 1,
            custodyRevision: input.manifest.expectedCustodyRevision + 1,
          }));
          const token = hex(this.#crypto.hash(payload));
          if (
            requiredString(outbox, "outbox_id")
              !== `outbox_device_revoked_${token}`
            || requiredString(outbox, "event_type")
              !== "crypto_device_revoked"
            || requiredString(outbox, "idempotency_key")
              !== `device_revoked_${token}`
            || !equalBytes(requiredBytes(outbox, "payload_bytes"), payload)
          ) return { status: "conflicting_state" };
        }
        return {
          status: "duplicate",
          domainCount: persistedPlan.length,
          blockedDomainCount,
          custodyState: admittedCustodyState,
        };
      }
      if (
        !(await humanHasOperationCapacity(transaction, manifestHumanId))
      ) {
        return { status: "operation_limit_reached" };
      }

      if (
        requiredString(registry, "issuer_state") !== "active"
        || requiredString(registry, "target_state") !== "active"
        || registry["target_revoked_at"] !== null
        || requiredString(registry, "issuer_human_id") !== manifestHumanId
        || requiredString(registry, "target_human_id") !== manifestHumanId
        || requiredString(registry, "custody_human_id") !== manifestHumanId
        || requiredString(registry, "custody_state") !== "active"
        || requiredCounter(registry, "issuer_revision")
          !== input.manifest.expectedIssuerDeviceRevision
        || requiredCounter(registry, "target_revision")
          !== input.manifest.expectedTargetDeviceRevision
        || requiredCounter(registry, "custody_revision")
          !== input.manifest.expectedCustodyRevision
        || requiredCounter(registry, "current_recovery_generation")
          !== input.manifest.expectedRecoveryGeneration
        || (inventory.absent
          ? registry["current_inventory_revision"] !== null
            || registry["current_inventory_count"] !== null
            || registry["current_inventory_digest"] !== null
          : requiredCounter(registry, "current_inventory_revision")
              !== inventory.revision
            || requiredCounter(registry, "current_inventory_count")
              !== inventory.count
            || !equalBytes(
              requiredBytes(registry, "current_inventory_digest"),
              inventory.digest,
            ))
      ) return { status: "stale_state" };

      let verified: ReturnType<typeof verifyManifest>;
      try {
        verified = verifyManifest();
      } catch {
        return { status: "stale_state" };
      }

      const domainRows = await transaction.query(
        `SELECT d.id AS domain_id, d.epoch, d.authorization_revision,
                d.participant_digest, d.participants, d.writes_paused,
                d.pause_operation_id,
                target.human_id AS target_mapping_human_id,
                (
                  SELECT member.device_id
                    FROM crypto_domain_devices member
                    JOIN human_crypto_devices candidate
                      ON candidate.device_id = member.device_id
                   WHERE member.domain_id = d.id
                     AND member.removed_at IS NULL
                     AND member.device_id <> $1
                     AND member.human_id = candidate.human_id
                     AND member.human_id = ANY(d.participants)
                     AND candidate.state = 'active'
                   ORDER BY convert_to(member.device_id, 'UTF8')
                   LIMIT 1
                ) AS committer_device_id
           FROM crypto_domain_devices target
           JOIN crypto_domains d ON d.id = target.domain_id
          WHERE target.device_id = $1
            AND target.removed_at IS NULL
          ORDER BY convert_to(d.id, 'UTF8')
          LIMIT $2
          FOR UPDATE OF target, d`,
        [manifestTargetDeviceId, MAX_ACTIVE_DOMAINS_PER_DEVICE + 1],
      );
      if (domainRows.length > MAX_ACTIVE_DOMAINS_PER_DEVICE) {
        return { status: "stale_state" };
      }
      const domainIds = domainRows.map((row) =>
        requiredString(row, "domain_id")
      );
      const namespaceRows = domainIds.length === 0
        ? []
        : await transaction.query(
          `SELECT namespace_id, domain_id, domain_epoch, access_revision,
                  binding_hash, writes_paused, pause_operation_id
             FROM namespace_crypto_heads
            WHERE domain_id = ANY($1::text[])
            ORDER BY convert_to(namespace_id, 'UTF8')
            LIMIT $2
            FOR UPDATE`,
          [
            domainIds,
            CRYPTO_DELIVERY_COLLECTION_LIMITS
              .fanoutRowsPerOperation + 1,
          ],
        );
      if (
        namespaceRows.length
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation
      ) return { status: "stale_state" };

      let authoritativeStateIsStale = false;
      const plan: DomainPlan[] = domainRows.map((row) => {
        const domainId = requiredString(row, "domain_id");
        const participants = requiredStringArray(row, "participants");
        const targetMappingHuman = requiredString(
          row,
          "target_mapping_human_id",
        );
        if (
          targetMappingHuman !== manifestHumanId
          || !participants.includes(targetMappingHuman)
          || requiredBoolean(row, "writes_paused")
          || row["pause_operation_id"] !== null
        ) authoritativeStateIsStale = true;
        const expectedEpoch = requiredCounter(row, "epoch");
        if (expectedEpoch === Number.MAX_SAFE_INTEGER) {
          authoritativeStateIsStale = true;
        }
        const namespaces = namespaceRows
          .filter((namespace) =>
            requiredString(namespace, "domain_id") === domainId
          )
          .map((namespace) => {
            if (
              requiredCounter(namespace, "domain_epoch") !== expectedEpoch
              || requiredBoolean(namespace, "writes_paused")
              || namespace["pause_operation_id"] !== null
            ) authoritativeStateIsStale = true;
            return {
              namespaceId: requiredString(namespace, "namespace_id"),
              expectedAccessRevision: requiredCounter(
                namespace,
                "access_revision",
              ),
              expectedBindingHash: requiredBytes(namespace, "binding_hash"),
            };
          });
        if (namespaces.length > MAX_NAMESPACES_PER_DOMAIN_TRANSITION) {
          authoritativeStateIsStale = true;
        }
        return {
          domainId,
          expectedEpoch,
          targetEpoch: expectedEpoch + 1,
          expectedAuthorizationRevision: requiredCounter(
            row,
            "authorization_revision",
          ),
          expectedParticipantDigest: requiredBytes(
            row,
            "participant_digest",
          ),
          committerDeviceId: nullableString(row, "committer_device_id"),
          namespaces,
        };
      });
      if (
        authoritativeStateIsStale
        || !sameSignedPlan(verified.manifest.domains, plan)
      ) {
        return { status: "stale_state" };
      }

      const committerIds = plan.flatMap((domain) =>
        domain.committerDeviceId === null ? [] : [domain.committerDeviceId]
      );
      if (committerIds.length > 0) {
        const committers = await transaction.query(
          `SELECT device_id, human_id, state
             FROM human_crypto_devices
            WHERE device_id = ANY($1::text[])
            ORDER BY convert_to(device_id, 'UTF8')
            FOR UPDATE`,
          [committerIds],
        );
        if (
          committers.length !== new Set(committerIds).size
          || committers.some((committer) =>
            requiredString(committer, "state") !== "active"
            || requiredString(committer, "device_id")
              === manifestTargetDeviceId
          )
        ) return { status: "stale_state" };
      }
      const activeDevices = await transaction.query(
        `SELECT device_id
           FROM human_crypto_devices
          WHERE human_id = $1 AND state = 'active'
          ORDER BY convert_to(device_id, 'UTF8')
          FOR UPDATE`,
        [manifestHumanId],
      );
      if (
        !activeDevices.some((row) =>
          requiredString(row, "device_id") === manifestTargetDeviceId
        )
      ) return { status: "stale_state" };
      const custodyState = activeDevices.length === 1
        ? "recovery_required"
        : "active";
      const blockedDomainCount = plan.filter(
        (domain) => domain.committerDeviceId === null,
      ).length;
      const runnableDomains = plan.filter(
        (domain) => domain.committerDeviceId !== null,
      );
      const fanoutRowCount = runnableDomains.reduce(
        (count, domain) => count + 1 + domain.namespaces.length,
        0,
      );
      if (
        fanoutRowCount
          > CRYPTO_DELIVERY_COLLECTION_LIMITS.fanoutRowsPerOperation
      ) return { status: "stale_state" };
      const operationState = plan.length === 0
        ? "active"
        : blockedDomainCount === plan.length
        ? "failed"
        : "awaiting_committer";
      const failureCode = operationState === "failed"
        ? "domain_rebootstrap_required"
        : null;
      const terminalAt = operationState === "active"
        || operationState === "failed"
        ? revokedAt
        : null;
      const authorizationArtifactHash = planArtifactHash(
        this.#crypto,
        verified.authorizationArtifactHash,
        plan,
        custodyState,
      );

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
           $1, $2, 'device_revoke', $3, $4, $4, $5, $6, $7, $8,
           NULL, 0, $9, NULL, NULL, 0, $10, $11, $12,
           $13::timestamptz, $13::timestamptz, $14::timestamptz,
           $15::timestamptz
         )
         RETURNING operation_id`,
        [
          manifestOperationId,
          input.manifest.idempotencyKey,
          operationState,
          manifestHumanId,
          manifestTargetDeviceId,
          input.manifest.expectedCustodyRevision,
          input.manifest.expectedRecoveryGeneration,
          input.manifest.expectedTargetDeviceRevision,
          0,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          failureCode,
          auditRef,
          revokedAt,
          deadlineAt,
          terminalAt,
        ],
        "Device revocation operation insert",
      );
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_device_epoch_operations (
           operation_id, target_device_id, owner_human_id,
           source_device_id, expected_device_revision,
           expected_inventory_revision, expected_inventory_count,
           expected_inventory_digest, authorization_artifact_hash,
           recovery_readiness_digest
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL
         )
         RETURNING operation_id`,
        [
          manifestOperationId,
          manifestTargetDeviceId,
          manifestHumanId,
          input.manifest.issuerDeviceId,
          input.manifest.expectedTargetDeviceRevision,
          inventory.revision,
          inventory.count,
          inventory.digest,
          authorizationArtifactHash,
        ],
        "Device revocation epoch operation insert",
      );
      for (const domain of plan) {
        const blocked = domain.committerDeviceId === null;
        await expectSingleMutation(
          transaction,
          `INSERT INTO crypto_domain_transition_steps (
             operation_id, domain_id, expected_epoch,
             expected_authorization_revision,
             expected_participant_digest, target_epoch,
             committer_device_id, state, lease_owner, lease_expires_at,
             retry_count, failure_code, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             NULL, NULL, 0, $9, $10::timestamptz, $10::timestamptz
           )
           RETURNING domain_id`,
          [
            manifestOperationId,
            domain.domainId,
            domain.expectedEpoch,
            domain.expectedAuthorizationRevision,
            domain.expectedParticipantDigest,
            domain.targetEpoch,
            domain.committerDeviceId,
            blocked ? "failed" : "awaiting_committer",
            blocked ? "domain_rebootstrap_required" : null,
            revokedAt,
          ],
          "Device revocation Domain step insert",
        );
        if (!blocked) {
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
                manifestOperationId,
                domain.domainId,
                namespace.namespaceId,
                namespace.expectedAccessRevision,
                namespace.expectedBindingHash,
                revokedAt,
              ],
              "Device revocation Namespace step insert",
            );
          }
        }
      }
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_devices
            SET state = 'revoked', revision = revision + 1,
                revoked_at = $3::timestamptz
          WHERE device_id = $1 AND human_id = $2
            AND state = 'active' AND revision = $4
            AND revoked_at IS NULL AND rejected_at IS NULL
          RETURNING device_id`,
        [
          manifestTargetDeviceId,
          manifestHumanId,
          revokedAt,
          input.manifest.expectedTargetDeviceRevision,
        ],
        "Device revocation tombstone",
      );
      for (const domain of plan) {
        await expectSingleMutation(
          transaction,
          `UPDATE crypto_domains
              SET writes_paused = true, pause_operation_id = $2
            WHERE id = $1 AND epoch = $3
              AND authorization_revision = $4
              AND participant_digest = $5
              AND writes_paused = false AND pause_operation_id IS NULL
            RETURNING id`,
          [
            domain.domainId,
            manifestOperationId,
            domain.expectedEpoch,
            domain.expectedAuthorizationRevision,
            domain.expectedParticipantDigest,
          ],
          "Device revocation Domain pause",
        );
        for (const namespace of domain.namespaces) {
          await expectSingleMutation(
            transaction,
            `UPDATE namespace_crypto_heads
                SET writes_paused = true, pause_operation_id = $2
              WHERE namespace_id = $1 AND domain_id = $3
                AND domain_epoch = $4 AND access_revision = $5
                AND binding_hash = $6
                AND writes_paused = false AND pause_operation_id IS NULL
              RETURNING namespace_id`,
            [
              namespace.namespaceId,
              manifestOperationId,
              domain.domainId,
              domain.expectedEpoch,
              namespace.expectedAccessRevision,
              namespace.expectedBindingHash,
            ],
            "Device revocation Namespace pause",
          );
        }
      }
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_custodies
            SET state = $2, revision = revision + 1,
                last_transition_audit_ref = $3,
                updated_at = $4::timestamptz
          WHERE human_id = $1 AND state = 'active'
            AND revision = $5
            AND current_recovery_generation = $6
            AND current_inventory_revision IS NOT DISTINCT FROM $7
            AND current_inventory_count IS NOT DISTINCT FROM $8
            AND current_inventory_digest IS NOT DISTINCT FROM $9
          RETURNING human_id`,
        [
          manifestHumanId,
          custodyState,
          auditRef,
          revokedAt,
          input.manifest.expectedCustodyRevision,
          input.manifest.expectedRecoveryGeneration,
          inventory.absent ? null : inventory.revision,
          inventory.absent ? null : inventory.count,
          inventory.absent ? null : inventory.digest,
        ],
        "Device revocation custody update",
      );
      const payload = textEncoder.encode(JSON.stringify({
        formatVersion: 1,
        eventType: "crypto_device_revoked",
        operationId: manifestOperationId,
        humanId: manifestHumanId,
        targetDeviceId: manifestTargetDeviceId,
        deviceRevision: input.manifest.expectedTargetDeviceRevision + 1,
        custodyRevision: input.manifest.expectedCustodyRevision + 1,
      }));
      const token = hex(this.#crypto.hash(payload));
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_operation_outbox (
           outbox_id, operation_id, sequence, event_type, payload_bytes,
           idempotency_key, claimed_by, claim_expires_at, attempts,
           maximum_attempts, delivered_at, terminal_at, failure_code,
           created_at
         ) VALUES (
           $1, $2, 0, 'crypto_device_revoked', $3, $4,
           NULL, NULL, 0, $5, NULL, NULL, NULL, $6::timestamptz
         )
         RETURNING outbox_id`,
        [
          `outbox_device_revoked_${token}`,
          manifestOperationId,
          payload,
          `device_revoked_${token}`,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          revokedAt,
        ],
        "Device revocation outbox insert",
      );
      return {
        status: "admitted",
        domainCount: plan.length,
        blockedDomainCount,
        custodyState,
      };
    });
  }
}
