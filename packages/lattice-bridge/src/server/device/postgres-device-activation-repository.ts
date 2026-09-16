import {
  and,
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  cryptoDomainTransitionNamespaces,
  cryptoDomainTransitionSteps,
  eq,
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

export type DeviceActivationResult =
  | {
    readonly status: "activated" | "duplicate";
    readonly deviceId: string;
    readonly deviceRevision: number;
    readonly custodyRevision: number;
  }
  | { readonly status: "not_ready" | "stale_state" };

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

function custodyInventoryMatches(row: DatabaseRow): boolean {
  const expectedRevision = requiredCounter(row, "expected_inventory_revision");
  const expectedCount = requiredCounter(row, "expected_inventory_count");
  const expectedDigest = requiredBytes(row, "expected_inventory_digest");
  const revision = nullableCounter(row, "custody_inventory_revision");
  const count = nullableCounter(row, "custody_inventory_count");
  const digest = row["custody_inventory_digest"] === null
    ? null
    : requiredBytes(row, "custody_inventory_digest");
  return revision === null && count === null && digest === null
    ? expectedRevision === 0 && expectedCount === 0
    : revision === expectedRevision
      && count === expectedCount
      && digest !== null
      && equalBytes(digest, expectedDigest);
}

function requiredBoolean(row: DatabaseRow, name: string): boolean {
  const value = row[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`Crypto delivery column ${name} must be boolean`);
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function isoTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Crypto delivery timestamp must be nonnegative");
  }
  return new Date(milliseconds).toISOString();
}

function portable(label: string, value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
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

export class PostgresDeviceActivationRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  activate(input: {
    readonly operationId: string;
    readonly activatedAt: number;
    readonly auditRef: string;
    readonly outboxId: string;
  }): Promise<DeviceActivationResult> {
    portable("Device activation operation id", input.operationId);
    portable("Device activation audit ref", input.auditRef);
    portable("Device activation outbox id", input.outboxId);
    return this.handle.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`device-activation/${input.operationId}`],
      );
      const rows = await transaction.query(
        `SELECT o.operation_id, o.kind AS operation_kind,
                o.state AS operation_state, o.human_id,
                o.target_device_id, o.expected_custody_revision,
                o.expected_recovery_generation,
                e.expected_device_revision, o.audit_ref,
                e.expected_inventory_revision,
                e.expected_inventory_count, e.expected_inventory_digest,
                d.state AS device_state, d.revision AS device_revision,
                h.state AS custody_state, h.revision AS custody_revision,
                h.current_recovery_generation
                  AS custody_recovery_generation,
                h.current_inventory_revision AS custody_inventory_revision,
                h.current_inventory_count AS custody_inventory_count,
                h.current_inventory_digest AS custody_inventory_digest,
                c.challenge_id, c.consumed_at AS challenge_consumed_at,
                c.invalidated_at AS challenge_invalidated_at,
                c.receipt_audit_ref,
                (
                  SELECT count(*) FROM crypto_domain_transition_steps s
                   WHERE s.operation_id = o.operation_id
                )::bigint AS domain_required_count,
                (
                  SELECT count(*) FROM crypto_domain_transition_steps s
                   WHERE s.operation_id = o.operation_id
                     AND s.state = 'ready_to_activate'
                )::bigint AS domain_ready_count,
                (
                  SELECT count(*)
                    FROM crypto_domain_transition_namespaces n
                   WHERE n.operation_id = o.operation_id
                )::bigint AS namespace_required_count,
                (
                  SELECT count(*)
                    FROM crypto_domain_transition_namespaces n
                   WHERE n.operation_id = o.operation_id
                     AND n.state = 'prepared'
                )::bigint AS namespace_prepared_count,
                (
                  SELECT count(*)
                    FROM crypto_domain_transition_steps s
                    JOIN crypto_domain_devices dd
                      ON dd.domain_id = s.domain_id
                     AND dd.device_id = o.target_device_id
                     AND dd.removed_at IS NULL
                   WHERE s.operation_id = o.operation_id
                )::bigint AS existing_target_mapping_count,
                (
                  SELECT count(*) FROM crypto_delivery_messages m
                   WHERE m.operation_id = o.operation_id
                     AND m.recipient_device_id = o.target_device_id
                     AND m.kind <> 'recovery_challenge'
                )::bigint AS delivery_required_count,
                (
                  SELECT count(*)
                    FROM crypto_delivery_messages m
                    JOIN crypto_delivery_acknowledgements a
                      ON a.message_id = m.message_id
                     AND a.device_id = m.recipient_device_id
                   WHERE m.operation_id = o.operation_id
                     AND m.recipient_device_id = o.target_device_id
                     AND m.kind <> 'recovery_challenge'
                )::bigint AS delivery_acknowledged_count,
                (
                  SELECT count(*) FROM human_crypto_devices active_device
                   WHERE active_device.human_id = o.human_id
                     AND active_device.state = 'active'
                )::bigint AS active_device_count
           FROM crypto_delivery_operations o
           JOIN crypto_device_epoch_operations e
             ON e.operation_id = o.operation_id
           JOIN human_crypto_devices d
             ON d.device_id = o.target_device_id
           JOIN human_crypto_custodies h ON h.human_id = o.human_id
           JOIN human_crypto_device_challenges c
             ON c.human_id = o.human_id
            AND c.pending_device_id = o.target_device_id
            AND c.idempotency_key = o.idempotency_key
          WHERE o.operation_id = $1
            AND (
              o.lease_owner IS NULL
              OR o.lease_expires_at <= $2::timestamptz
            )
          LIMIT 2
          FOR UPDATE OF o, e, d, h, c`,
        [input.operationId, isoTime(input.activatedAt)],
      );
      if (rows.length !== 1) return { status: "stale_state" };
      const row = rows[0]!;
      const expectedDeviceRevision = requiredCounter(
        row,
        "expected_device_revision",
      );
      const expectedCustodyRevision = requiredCounter(
        row,
        "expected_custody_revision",
      );
      const deviceId = requiredString(row, "target_device_id");
      const domainRows = await transaction.query(
        `SELECT s.domain_id, s.state AS step_state,
                s.expected_epoch, s.target_epoch,
                s.expected_authorization_revision,
                s.expected_participant_digest,
                s.expected_provider_state_hash,
                s.candidate_provider_id,
                s.candidate_provider_state_hash,
                s.candidate_roster_bytes,
                s.candidate_transition_digest,
                s.candidate_target_leaf_index,
                d.epoch AS domain_epoch,
                d.authorization_revision AS domain_authorization_revision,
                d.participant_digest AS domain_participant_digest,
                d.roster_bytes AS domain_roster_bytes,
                d.writes_paused AS domain_writes_paused,
                d.pause_operation_id AS domain_pause_operation_id,
                p.provider_id, p.epoch AS provider_epoch,
                p.state_hash AS provider_state_hash,
                p.roster_bytes AS provider_roster_bytes,
                mapped.device_id AS mapped_device_id,
                mapped.human_id AS mapped_human_id,
                mapped.leaf_index AS mapped_leaf_index,
                mapped.joined_epoch AS mapped_joined_epoch,
                mapped.removed_epoch AS mapped_removed_epoch,
                floor(extract(epoch from mapped.removed_at) * 1000)::bigint
                  AS mapped_removed_at_ms
           FROM crypto_domain_transition_steps s
           JOIN crypto_domains d ON d.id = s.domain_id
           JOIN crypto_domain_provider_heads p ON p.domain_id = s.domain_id
           LEFT JOIN crypto_domain_devices mapped
             ON mapped.domain_id = s.domain_id
            AND mapped.device_id = $2
          WHERE s.operation_id = $1
          ORDER BY s.domain_id
          FOR UPDATE OF s, d, p`,
        [input.operationId, deviceId],
      );
      const namespaceRows = await transaction.query(
        `SELECT n.domain_id, n.namespace_id,
                n.state AS namespace_state,
                n.expected_access_revision, n.expected_binding_hash,
                n.candidate_binding_hash,
                n.candidate_signed_binding_bytes,
                n.candidate_human_keyring_envelope_bytes,
                n.candidate_ai_keyring_envelope_bytes,
                s.expected_epoch, s.target_epoch,
                h.access_revision AS head_access_revision,
                h.binding_hash AS head_binding_hash,
                h.domain_id AS head_domain_id,
                h.domain_epoch AS head_domain_epoch,
                h.writes_paused AS head_writes_paused,
                h.pause_operation_id AS head_pause_operation_id,
                candidate.revision AS candidate_revision,
                candidate.binding_hash
                  AS persisted_candidate_binding_hash,
                candidate.previous_binding_hash
                  AS persisted_candidate_previous_hash,
                candidate.signed_binding_bytes
                  AS persisted_candidate_signed_bytes,
                candidate.human_keyring_envelope_bytes
                  AS persisted_candidate_human_keyring_bytes,
                candidate.ai_keyring_envelope_bytes
                  AS persisted_candidate_ai_keyring_bytes
           FROM crypto_domain_transition_namespaces n
           JOIN crypto_domain_transition_steps s
             ON s.operation_id = n.operation_id
            AND s.domain_id = n.domain_id
           JOIN namespace_crypto_heads h
             ON h.namespace_id = n.namespace_id
           LEFT JOIN namespace_crypto_bindings candidate
             ON candidate.namespace_id = n.namespace_id
            AND candidate.revision = n.expected_access_revision + 1
            AND candidate.binding_hash = n.candidate_binding_hash
          WHERE n.operation_id = $1
          ORDER BY n.domain_id, n.namespace_id
          FOR UPDATE OF n, h`,
        [input.operationId],
      );
      const domainRequired = requiredCounter(row, "domain_required_count");
      const namespaceRequired = requiredCounter(
        row,
        "namespace_required_count",
      );
      if (
        domainRows.length !== domainRequired
        || namespaceRows.length !== namespaceRequired
      ) return { status: "stale_state" };
      if (requiredString(row, "operation_state") === "active") {
        const terminalDomainsExact = domainRows.every((domain) =>
          requiredString(domain, "step_state") === "active"
          && requiredCounter(domain, "domain_epoch")
            === requiredCounter(domain, "target_epoch")
          && requiredCounter(domain, "domain_authorization_revision")
            === requiredCounter(
              domain,
              "expected_authorization_revision",
            )
          && equalBytes(
            requiredBytes(domain, "domain_participant_digest"),
            requiredBytes(domain, "expected_participant_digest"),
          )
          && equalBytes(
            requiredBytes(domain, "domain_roster_bytes"),
            requiredBytes(domain, "candidate_roster_bytes"),
          )
          && !requiredBoolean(domain, "domain_writes_paused")
          && nullableString(domain, "domain_pause_operation_id") === null
          && requiredString(domain, "provider_id")
            === requiredString(domain, "candidate_provider_id")
          && requiredCounter(domain, "provider_epoch")
            === requiredCounter(domain, "target_epoch")
          && equalBytes(
            requiredBytes(domain, "provider_state_hash"),
            requiredBytes(domain, "candidate_provider_state_hash"),
          )
          && equalBytes(
            requiredBytes(domain, "provider_roster_bytes"),
            requiredBytes(domain, "candidate_roster_bytes"),
          )
          && nullableString(domain, "mapped_device_id") === deviceId
          && nullableString(domain, "mapped_human_id")
            === requiredString(row, "human_id")
          && nullableCounter(domain, "mapped_leaf_index")
            === requiredCounter(domain, "candidate_target_leaf_index")
          && nullableCounter(domain, "mapped_joined_epoch")
            === requiredCounter(domain, "target_epoch")
          && nullableCounter(domain, "mapped_removed_epoch") === null
          && nullableCounter(domain, "mapped_removed_at_ms") === null
        );
        const terminalNamespacesExact = namespaceRows.every((namespace) =>
          requiredString(namespace, "namespace_state") === "active"
          && requiredCounter(namespace, "candidate_revision")
            === requiredCounter(namespace, "expected_access_revision") + 1
          && equalBytes(
            requiredBytes(namespace, "persisted_candidate_binding_hash"),
            requiredBytes(namespace, "candidate_binding_hash"),
          )
          && equalBytes(
            requiredBytes(namespace, "persisted_candidate_previous_hash"),
            requiredBytes(namespace, "expected_binding_hash"),
          )
          && equalBytes(
            requiredBytes(namespace, "candidate_signed_binding_bytes"),
            requiredBytes(namespace, "persisted_candidate_signed_bytes"),
          )
          && equalBytes(
            requiredBytes(
              namespace,
              "candidate_human_keyring_envelope_bytes",
            ),
            requiredBytes(
              namespace,
              "persisted_candidate_human_keyring_bytes",
            ),
          )
          && equalBytes(
            requiredBytes(
              namespace,
              "candidate_ai_keyring_envelope_bytes",
            ),
            requiredBytes(
              namespace,
              "persisted_candidate_ai_keyring_bytes",
            ),
          )
          && requiredCounter(namespace, "head_access_revision")
            === requiredCounter(namespace, "candidate_revision")
          && equalBytes(
            requiredBytes(namespace, "head_binding_hash"),
            requiredBytes(namespace, "candidate_binding_hash"),
          )
          && requiredString(namespace, "head_domain_id")
            === requiredString(namespace, "domain_id")
          && requiredCounter(namespace, "head_domain_epoch")
            === requiredCounter(namespace, "target_epoch")
          && !requiredBoolean(namespace, "head_writes_paused")
          && nullableString(namespace, "head_pause_operation_id") === null
        );
        return terminalDomainsExact
            && terminalNamespacesExact
            && requiredString(row, "device_state") === "active"
            && requiredCounter(row, "device_revision")
              === expectedDeviceRevision + 1
            && requiredCounter(row, "custody_revision")
              === expectedCustodyRevision + 1
            && row["challenge_consumed_at"] !== null
            && row["challenge_invalidated_at"] === null
            && requiredString(row, "audit_ref") === input.auditRef
            && requiredString(row, "receipt_audit_ref") === input.auditRef
          ? {
            status: "duplicate",
            deviceId,
            deviceRevision: expectedDeviceRevision + 1,
            custodyRevision: expectedCustodyRevision + 1,
          }
          : { status: "stale_state" };
      }
      const operationKind = requiredString(row, "operation_kind");
      const custodyState = requiredString(row, "custody_state");
      const stagedDomainsExact = domainRows.every((domain) =>
        requiredString(domain, "step_state") === "ready_to_activate"
        && requiredCounter(domain, "domain_epoch")
          === requiredCounter(domain, "expected_epoch")
        && requiredCounter(domain, "domain_authorization_revision")
          === requiredCounter(domain, "expected_authorization_revision")
        && equalBytes(
          requiredBytes(domain, "domain_participant_digest"),
          requiredBytes(domain, "expected_participant_digest"),
        )
        && equalBytes(
          requiredBytes(domain, "domain_roster_bytes"),
          requiredBytes(domain, "provider_roster_bytes"),
        )
        && !requiredBoolean(domain, "domain_writes_paused")
        && nullableString(domain, "domain_pause_operation_id") === null
        && requiredString(domain, "provider_id")
          === requiredString(domain, "candidate_provider_id")
        && requiredCounter(domain, "provider_epoch")
          === requiredCounter(domain, "expected_epoch")
        && equalBytes(
          requiredBytes(domain, "provider_state_hash"),
          requiredBytes(domain, "expected_provider_state_hash"),
        )
        && requiredBytes(domain, "candidate_provider_state_hash").length > 0
        && requiredBytes(domain, "candidate_roster_bytes").length > 0
        && requiredBytes(domain, "candidate_transition_digest").length > 0
        && nullableString(domain, "mapped_device_id") === null
        && nullableString(domain, "mapped_human_id") === null
        && nullableCounter(domain, "mapped_leaf_index") === null
        && nullableCounter(domain, "mapped_joined_epoch") === null
        && nullableCounter(domain, "mapped_removed_epoch") === null
        && nullableCounter(domain, "mapped_removed_at_ms") === null
      );
      const stagedNamespacesExact = namespaceRows.every((namespace) =>
        requiredString(namespace, "namespace_state") === "prepared"
        && namespace["candidate_revision"] === null
        && requiredBytes(
            namespace,
            "candidate_signed_binding_bytes",
          ).length > 0
        && requiredBytes(
            namespace,
            "candidate_human_keyring_envelope_bytes",
          ).length > 0
        && requiredBytes(
            namespace,
            "candidate_ai_keyring_envelope_bytes",
          ).length > 0
        && namespace["persisted_candidate_binding_hash"] === null
        && namespace["persisted_candidate_previous_hash"] === null
        && requiredCounter(namespace, "head_access_revision")
          === requiredCounter(namespace, "expected_access_revision")
        && equalBytes(
          requiredBytes(namespace, "head_binding_hash"),
          requiredBytes(namespace, "expected_binding_hash"),
        )
        && requiredString(namespace, "head_domain_id")
          === requiredString(namespace, "domain_id")
        && requiredCounter(namespace, "head_domain_epoch")
          === requiredCounter(namespace, "expected_epoch")
        && !requiredBoolean(namespace, "head_writes_paused")
        && nullableString(namespace, "head_pause_operation_id") === null
      );
      const ready = ["device_add", "device_recovery"].includes(operationKind)
        && requiredString(row, "operation_state") === "ready_to_activate"
        && requiredString(row, "device_state") === "pending"
        && requiredCounter(row, "device_revision") === expectedDeviceRevision
        && (
          custodyState === "active"
          || (
            operationKind === "device_recovery"
            && custodyState === "recovery_required"
          )
        )
        && requiredCounter(row, "custody_revision")
          === expectedCustodyRevision
        && requiredCounter(row, "custody_recovery_generation")
          === requiredCounter(row, "expected_recovery_generation")
        && custodyInventoryMatches(row)
        && row["challenge_consumed_at"] === null
        && row["challenge_invalidated_at"] === null
        && requiredCounter(row, "domain_ready_count") === domainRequired
        && requiredCounter(row, "namespace_prepared_count")
          === requiredCounter(row, "namespace_required_count")
        && requiredCounter(row, "existing_target_mapping_count") === 0
        && requiredCounter(row, "delivery_acknowledged_count")
          === requiredCounter(row, "delivery_required_count")
        && requiredCounter(row, "active_device_count")
          < CRYPTO_DELIVERY_COLLECTION_LIMITS.activeDevicesPerHuman;
      if (!ready) return { status: "not_ready" };
      if (!stagedDomainsExact || !stagedNamespacesExact) {
        return { status: "stale_state" };
      }

      const nextDeviceRevision = expectedDeviceRevision + 1;
      const nextCustodyRevision = expectedCustodyRevision + 1;
      const activatedAt = isoTime(input.activatedAt);
      for (const namespace of namespaceRows) {
        await expectSingleMutation(
          transaction,
          `INSERT INTO namespace_crypto_bindings (
             namespace_id, revision, binding_hash, previous_binding_hash,
             signed_binding_bytes, human_keyring_envelope_bytes,
             ai_keyring_envelope_bytes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING namespace_id`,
          [
            requiredString(namespace, "namespace_id"),
            requiredCounter(namespace, "expected_access_revision") + 1,
            requiredBytes(namespace, "candidate_binding_hash"),
            requiredBytes(namespace, "expected_binding_hash"),
            requiredBytes(namespace, "candidate_signed_binding_bytes"),
            requiredBytes(
              namespace,
              "candidate_human_keyring_envelope_bytes",
            ),
            requiredBytes(
              namespace,
              "candidate_ai_keyring_envelope_bytes",
            ),
          ],
          "Additional-device canonical Namespace binding append",
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
              AND writes_paused = false
              AND pause_operation_id IS NULL
            RETURNING namespace_id`,
          [
            requiredString(namespace, "namespace_id"),
            requiredCounter(namespace, "expected_access_revision") + 1,
            requiredBytes(namespace, "candidate_binding_hash"),
            requiredCounter(namespace, "expected_access_revision"),
            requiredCounter(namespace, "target_epoch"),
            requiredBytes(namespace, "expected_binding_hash"),
            requiredString(namespace, "domain_id"),
            requiredCounter(namespace, "expected_epoch"),
          ],
          "Additional-device Namespace head activation",
        );
      }
      for (const domain of domainRows) {
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
            requiredString(domain, "domain_id"),
            requiredCounter(domain, "expected_epoch"),
            requiredCounter(domain, "target_epoch"),
            requiredBytes(domain, "candidate_provider_state_hash"),
            requiredBytes(domain, "candidate_roster_bytes"),
            requiredString(domain, "candidate_provider_id"),
            requiredBytes(domain, "expected_provider_state_hash"),
            requiredBytes(domain, "provider_roster_bytes"),
          ],
          "Additional-device provider head activation",
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
              AND writes_paused = false
              AND pause_operation_id IS NULL
            RETURNING id`,
          [
            requiredString(domain, "domain_id"),
            requiredCounter(domain, "expected_epoch"),
            requiredCounter(domain, "target_epoch"),
            requiredBytes(domain, "candidate_roster_bytes"),
            requiredCounter(domain, "expected_authorization_revision"),
            requiredBytes(domain, "expected_participant_digest"),
            requiredBytes(domain, "domain_roster_bytes"),
          ],
          "Additional-device Domain head activation",
        );
        await expectSingleMutation(
          transaction,
          `INSERT INTO crypto_domain_devices (
             domain_id, device_id, human_id, leaf_index,
             joined_epoch, removed_epoch, removed_at
           ) VALUES ($1, $2, $3, $4, $5, NULL, NULL)
           RETURNING device_id`,
          [
            requiredString(domain, "domain_id"),
            deviceId,
            requiredString(row, "human_id"),
            requiredCounter(domain, "candidate_target_leaf_index"),
            requiredCounter(domain, "target_epoch"),
          ],
          "Additional-device Domain membership activation",
        );
      }
      const activatedNamespaces = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDomainTransitionNamespaces).set({
          state: "active",
          failureCode: null,
          updatedAt: sql`${activatedAt}::timestamptz`,
        }).where(and(
          eq(
            cryptoDomainTransitionNamespaces.operationId,
            input.operationId,
          ),
          eq(cryptoDomainTransitionNamespaces.state, "prepared"),
        )).returning({
          namespace_id: cryptoDomainTransitionNamespaces.namespaceId,
        }),
      );
      if (
        activatedNamespaces.length
          !== requiredCounter(row, "namespace_required_count")
      ) {
        throw new Error(
          "Additional-device Namespace activation lost its compare-and-swap",
        );
      }
      const activatedDomains = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDomainTransitionSteps).set({
          state: "active",
          failureCode: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: sql`${activatedAt}::timestamptz`,
        }).where(and(
          eq(cryptoDomainTransitionSteps.operationId, input.operationId),
          eq(cryptoDomainTransitionSteps.state, "ready_to_activate"),
        )).returning({
          domain_id: cryptoDomainTransitionSteps.domainId,
        }),
      );
      if (activatedDomains.length !== domainRequired) {
        throw new Error(
          "Additional-device Domain activation lost its compare-and-swap",
        );
      }
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_devices
            SET state = 'active', revision = $3,
                activated_at = $4::timestamptz,
                last_seen_at = $4::timestamptz
          WHERE device_id = $1
            AND state = 'pending'
            AND revision = $2
          RETURNING device_id`,
        [
          deviceId,
          expectedDeviceRevision,
          nextDeviceRevision,
          activatedAt,
        ],
        "Additional-device activation registry update",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_device_challenges
            SET consumed_at = $3::timestamptz,
                terminal_result_code = 'active',
                receipt_audit_ref = $4,
                revision = revision + 1
          WHERE challenge_id = $1
            AND pending_device_id = $2
            AND consumed_at IS NULL
            AND invalidated_at IS NULL
          RETURNING challenge_id`,
        [
          requiredString(row, "challenge_id"),
          deviceId,
          activatedAt,
          input.auditRef,
        ],
        "Additional-device activation challenge update",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE crypto_delivery_operations
            SET state = 'active', audit_ref = $2,
                updated_at = $3::timestamptz,
                terminal_at = $3::timestamptz,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE operation_id = $1
            AND state = 'ready_to_activate'
          RETURNING operation_id`,
        [input.operationId, input.auditRef, activatedAt],
        "Additional-device activation operation update",
      );
      await expectSingleMutation(
        transaction,
        `UPDATE human_crypto_custodies
            SET state = 'active', revision = $3,
                last_transition_audit_ref = $4
          WHERE human_id = $1
            AND revision = $2
            AND state = $5
          RETURNING human_id`,
        [
          requiredString(row, "human_id"),
          expectedCustodyRevision,
          nextCustodyRevision,
          input.auditRef,
          custodyState,
        ],
        "Additional-device activation custody update",
      );
      const payload = new TextEncoder().encode(JSON.stringify({
        formatVersion: 1,
        eventType: "device_activated",
        operationId: input.operationId,
        deviceId,
        deviceRevision: nextDeviceRevision,
        custodyRevision: nextCustodyRevision,
      }));
      await expectSingleMutation(
        transaction,
        `INSERT INTO crypto_operation_outbox (
           outbox_id, operation_id, sequence, event_type, payload_bytes,
           idempotency_key, claimed_by, claim_expires_at, attempts,
           maximum_attempts, delivered_at, terminal_at, failure_code,
           created_at
         ) VALUES (
           $1, $3, $2 + 2, 'device_activated', $4, $1,
           NULL, NULL, 0, $5, NULL, NULL, NULL, $6::timestamptz
         )
         RETURNING outbox_id`,
        [
          input.outboxId,
          domainRequired,
          input.operationId,
          payload,
          CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
          activatedAt,
        ],
        "Additional-device activation outbox insert",
      );
      return {
        status: "activated",
        deviceId,
        deviceRevision: nextDeviceRevision,
        custodyRevision: nextCustodyRevision,
      };
    });
  }
}
