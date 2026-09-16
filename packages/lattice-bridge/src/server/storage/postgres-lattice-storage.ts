import { createHash } from "node:crypto";
import {
  agentCryptoRuntimeChallenges,
  agentCryptoRuntimeConfigObjects,
  agentCryptoRuntimeDomainEnvelopes,
  agentCryptoRuntimeSigners,
  agentCryptoRuntimeStates,
  and,
  asc,
  compileOfflineDirectQuery,
  createOfflineDirectDb,
  cryptoDomainProviderHeads,
  cryptoDomains,
  cryptoGrants,
  cryptoObjects,
  eq,
  humanCryptoRecoveryArchives,
  namespaceCryptoBindings,
  namespaceCryptoHeads,
  namespaceDomainKeyBindings,
  namespaceDomainKeyHeads,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
  sql,
  type OfflineDirectQuery,
  type OfflineDirectQueryRow,
} from "@nautilo/db";
import {
  CRYPTO_STORAGE_COLLECTION_LIMITS,
  LATTICE_STORAGE_ADAPTER_TABLE_NAMES,
} from "@nautilo/db/schema";
import {
  agentId,
  agentRuntimeGeneration,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  decodeAgentRuntimeSignerPublicationV1,
  decodeObjectAccessManifestV2,
  decodeObjectAccessStorageManifestV5,
  encodeAgentRuntimeSignerPublicationV1,
  parseGrantV2,
  parseNamespaceBindingV2,
  storageAdapterSupportV2,
  type AgentRuntimeAtomicStorageWireV2,
  type AgentRuntimeSignerPublicationV1,
  type CryptoDomainPublicRecordV2,
  type EncryptedObjectWireRecordV2,
  type GrantWireRecordV2,
  type NamespaceBindingWireRecordV2,
  type NamespaceHeadV2,
  type ObjectAccessStorageWireStateV2,
  type ProviderPublicHeadV2,
  type RecoveryArchiveWireRecordV2,
} from "@nautilo/lattice-crypto/wire";
import {
  bindingFromRow,
  domainFromRow,
  grantFromRow,
  namespaceHeadFromRow,
  objectAccessFromRows,
  objectFromRow,
  providerHeadFromRow,
  recoveryFromRow,
  runtimeFromRows,
  type DatabaseRow,
  type DatabaseScalar,
} from "./postgres-record-codecs.ts";
import {
  AgentRuntimeSignerHistoryUnavailableError,
} from "./agent-runtime-signer-history.ts";

export {
  AgentRuntimeSignerHistoryUnavailableError,
} from "./agent-runtime-signer-history.ts";

export interface CryptoPostgresExecutor {
  query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    parameters?: readonly DatabaseScalar[],
  ): Promise<readonly Row[]>;
}

export const cryptoTypedDb = createOfflineDirectDb();

export type CompiledCryptoQuery<Result = unknown> = OfflineDirectQuery<Result>;

function typedCryptoQueryParameters(
  values: readonly unknown[],
): readonly DatabaseScalar[] {
  return values.map((value) => {
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "bigint"
      || typeof value === "boolean"
      || value instanceof Date
      || value instanceof Uint8Array
      || (Array.isArray(value) && value.every((entry) =>
        typeof entry === "string"
      ))
    ) return value as DatabaseScalar;
    throw new TypeError("typed crypto query emitted an unsupported parameter");
  });
}

/** Compile a schema-typed builder and execute it on an already verified role. */
export function executeTypedCryptoQuery<Query extends CompiledCryptoQuery>(
  executor: CryptoPostgresExecutor,
  query: Query,
): Promise<readonly OfflineDirectQueryRow<Query, DatabaseScalar>[]> {
  const compiled = compileOfflineDirectQuery(query);
  return executor.query(
    compiled.sql,
    typedCryptoQueryParameters(compiled.params),
  ) as unknown as Promise<readonly OfflineDirectQueryRow<
    Query,
    DatabaseScalar
  >[]>;
}

export type CryptoPostgresTransaction = CryptoPostgresExecutor;

export interface CryptoPostgresConnection extends CryptoPostgresExecutor {
  transaction<Result>(
    callback: (transaction: CryptoPostgresTransaction) => Promise<Result>,
  ): Promise<Result>;
}

declare const verifiedCryptoPostgresHandleBrand: unique symbol;

/**
 * Explicit credential boundary for Wave 6. The adapter cannot be constructed
 * from an application URL, environment object, or process-global pool.
 */
export interface CryptoPostgresHandle extends CryptoPostgresConnection {
  /**
   * The verified handle may replay a callback up to three times after
   * PostgreSQL aborts it with SQLSTATE 40001. Callbacks must keep every
   * side effect inside the supplied database transaction.
   */
  readonly [verifiedCryptoPostgresHandleBrand]: true;
  /**
   * Run exactly one database transaction attempt. Use this when a callback
   * contains a deliberately one-shot external authorization check that must
   * never be replayed after SQLSTATE 40001.
   */
  transactionOnce<Result>(
    callback: (transaction: CryptoPostgresTransaction) => Promise<Result>,
  ): Promise<Result>;
}

const verifiedCryptoPostgresHandles = new WeakSet<object>();
const SERIALIZATION_FAILURE_CODE = "40001";
const MAXIMUM_SERIALIZABLE_TRANSACTION_ATTEMPTS = 3;

function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === SERIALIZATION_FAILURE_CODE
  );
}

async function runRetryableTransaction<Result>(
  connection: CryptoPostgresConnection,
  callback: (transaction: CryptoPostgresTransaction) => Promise<Result>,
): Promise<Result> {
  for (
    let attempt = 1;
    attempt <= MAXIMUM_SERIALIZABLE_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await connection.transaction(callback);
    } catch (error) {
      if (
        !isSerializationFailure(error)
        || attempt === MAXIMUM_SERIALIZABLE_TRANSACTION_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  throw new Error("Unreachable Postgres transaction retry state");
}

export function assertVerifiedCryptoPostgresHandle(
  handle: CryptoPostgresHandle,
): void {
  if (!verifiedCryptoPostgresHandles.has(handle)) {
    throw new TypeError(
      "Crypto Postgres operation requires a verified nautilo_crypto handle",
    );
  }
}

function verifiedTransactionScopedHandle(
  transaction: CryptoPostgresTransaction,
): CryptoPostgresHandle {
  const scoped = Object.freeze({
    query: <Row extends DatabaseRow = DatabaseRow>(
      statement: string,
      parameters?: readonly DatabaseScalar[],
    ) => transaction.query<Row>(statement, parameters),
    transaction: <Result>(
      callback: (
        transaction: CryptoPostgresTransaction,
      ) => Promise<Result>,
    ) => callback(transaction),
    transactionOnce: <Result>(
      callback: (
        transaction: CryptoPostgresTransaction,
      ) => Promise<Result>,
    ) => callback(transaction),
  }) as CryptoPostgresHandle;
  verifiedCryptoPostgresHandles.add(scoped);
  return scoped;
}

/**
 * Composes several existing PostgresLatticeStorage operations into one
 * verified nautilo_crypto transaction. The scoped handle is branded only for
 * the callback lifetime and is revoked in finally before control returns.
 */
export function withVerifiedCryptoPostgresTransaction<Result>(
  handle: CryptoPostgresHandle,
  callback: (scopedHandle: CryptoPostgresHandle) => Promise<Result>,
): Promise<Result> {
  assertVerifiedCryptoPostgresHandle(handle);
  return handle.transaction(async (transaction) => {
    const scoped = verifiedTransactionScopedHandle(transaction);
    try {
      return await callback(scoped);
    } finally {
      verifiedCryptoPostgresHandles.delete(scoped);
    }
  });
}

/**
 * Verify an injected connection's database identity and mint the only handle
 * accepted by the adapter. Requiring both identities rejects an app-role
 * session that merely executes `SET ROLE nautilo_crypto`.
 */
export async function verifyCryptoPostgresHandle(
  connection: CryptoPostgresConnection,
): Promise<CryptoPostgresHandle> {
  const rows = await connection.query(
    `SELECT current_user::text AS current_user,
            session_user::text AS session_user
       LIMIT 2`,
  );
  if (
    rows.length !== 1
    || rows[0]?.["current_user"] !== "nautilo_crypto"
    || rows[0]?.["session_user"] !== "nautilo_crypto"
  ) {
    throw new TypeError(
      "Crypto Postgres connection must authenticate directly as nautilo_crypto",
    );
  }
  const verified = Object.freeze({
    query: <Row extends DatabaseRow = DatabaseRow>(
      statement: string,
      parameters?: readonly DatabaseScalar[],
    ) => connection.query<Row>(statement, parameters),
    transaction: <Result>(
      callback: (transaction: CryptoPostgresTransaction) => Promise<Result>,
    ) => runRetryableTransaction(connection, callback),
    transactionOnce: <Result>(
      callback: (
        transaction: CryptoPostgresTransaction,
      ) => Promise<Result>,
    ) => connection.transaction(callback),
  }) as CryptoPostgresHandle;
  verifiedCryptoPostgresHandles.add(verified);
  return verified;
}

export const LATTICE_STORAGE_NATIVE_V2_TABLE_NAMES = Object.freeze([
  "namespace_domain_key_bindings",
  "namespace_domain_key_heads",
] as const);

const TABLES = new Set<string>([
  ...LATTICE_STORAGE_ADAPTER_TABLE_NAMES,
  ...LATTICE_STORAGE_NATIVE_V2_TABLE_NAMES,
]);
if (TABLES.size !== 17) {
  throw new Error("Crypto storage adapter requires the exact durable schema");
}

/**
 * Reviewable operation-to-schema/atomicity map. All queries below are bounded
 * by a unique key, a declared collection ceiling, or LIMIT 2.
 */
export const POSTGRES_LATTICE_STORAGE_OPERATION_MAP = Object.freeze({
  findDomain: {
    tables: ["crypto_domains"],
    transaction: false,
  },
  createDomainIfAbsent: {
    tables: ["crypto_domains"],
    transaction: true,
  },
  putDomainProviderHeadIfAbsent: {
    tables: ["crypto_domains", "crypto_domain_provider_heads"],
    transaction: true,
  },
  getDomainProviderHead: {
    tables: ["crypto_domain_provider_heads"],
    transaction: false,
  },
  compareAndSwapDomainProviderHead: {
    tables: ["crypto_domains", "crypto_domain_provider_heads"],
    transaction: true,
  },
  getBinding: {
    tables: ["namespace_crypto_bindings"],
    transaction: false,
  },
  getNamespaceHead: {
    tables: ["namespace_crypto_heads"],
    transaction: false,
  },
  compareAndSwapNamespaceBindingAndHead: {
    tables: ["namespace_crypto_bindings", "namespace_crypto_heads"],
    transaction: true,
  },
  putObject: {
    tables: ["crypto_objects"],
    transaction: true,
  },
  getObject: {
    tables: ["crypto_objects"],
    transaction: false,
  },
  getObjectAccessState: {
    tables: [
      "object_crypto_access_manifests",
      "object_crypto_namespace_envelopes",
      "object_crypto_access_heads",
    ],
    transaction: true,
  },
  compareAndSwapObjectAccessState: {
    tables: [
      "crypto_objects",
      "crypto_grants",
      "crypto_domains",
      "namespace_crypto_bindings",
      "namespace_crypto_heads",
      "namespace_domain_key_bindings",
      "namespace_domain_key_heads",
      "object_crypto_access_manifests",
      "object_crypto_namespace_envelopes",
      "object_crypto_access_heads",
      "agent_crypto_runtime_states",
      "agent_crypto_runtime_config_objects",
      "agent_crypto_runtime_domain_envelopes",
      "agent_crypto_runtime_challenges",
      "agent_crypto_runtime_signers",
    ],
    transaction: true,
  },
  putAgentRuntimeAtomicStateIfAbsent: {
    tables: [
      "agent_crypto_runtime_states",
      "agent_crypto_runtime_config_objects",
      "agent_crypto_runtime_domain_envelopes",
      "agent_crypto_runtime_challenges",
      "agent_crypto_runtime_signers",
    ],
    transaction: true,
  },
  getAgentRuntimeAtomicState: {
    tables: [
      "agent_crypto_runtime_states",
      "agent_crypto_runtime_config_objects",
      "agent_crypto_runtime_domain_envelopes",
      "agent_crypto_runtime_challenges",
    ],
    transaction: true,
  },
  getAgentRuntimeSignerPublication: {
    tables: ["agent_crypto_runtime_signers"],
    transaction: false,
  },
  compareAndSwapAgentRuntimeChallengeReservations: {
    tables: [
      "agent_crypto_runtime_states",
      "agent_crypto_runtime_config_objects",
      "agent_crypto_runtime_domain_envelopes",
      "agent_crypto_runtime_challenges",
    ],
    transaction: true,
  },
  compareAndSwapAgentRuntimeRotation: {
    tables: [
      "agent_crypto_runtime_states",
      "agent_crypto_runtime_config_objects",
      "agent_crypto_runtime_domain_envelopes",
      "agent_crypto_runtime_challenges",
      "agent_crypto_runtime_signers",
    ],
    transaction: true,
  },
  compareAndSwapAgentRuntimeAuthorizationTransition: {
    tables: [
      "agent_crypto_runtime_states",
      "agent_crypto_runtime_config_objects",
      "agent_crypto_runtime_domain_envelopes",
      "agent_crypto_runtime_challenges",
      "agent_crypto_runtime_signers",
    ],
    transaction: true,
  },
  putGrant: {
    tables: ["crypto_grants"],
    transaction: true,
  },
  getGrant: {
    tables: ["crypto_grants"],
    transaction: false,
  },
  consumeGrant: {
    tables: ["crypto_grants"],
    transaction: false,
  },
  compareAndSwapRecoveryArchive: {
    tables: ["human_crypto_recovery_archives"],
    transaction: true,
  },
  getRecoveryArchive: {
    tables: ["human_crypto_recovery_archives"],
    transaction: false,
  },
} as const satisfies Readonly<
  Record<
    keyof LatticeStorage,
    Readonly<{
      readonly tables:
        readonly (
          | (typeof LATTICE_STORAGE_ADAPTER_TABLE_NAMES)[number]
          | (typeof LATTICE_STORAGE_NATIVE_V2_TABLE_NAMES)[number]
        )[];
      readonly transaction: boolean;
    }>
  >
>);

function oneOrNull<Row extends DatabaseRow>(
  rows: readonly Row[],
  label: string,
): Row | null {
  if (rows.length > 1) {
    throw new Error(`${label} returned more than one durable row`);
  }
  return rows[0] ?? null;
}

function bytesEqual(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function stringsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function valueEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return left instanceof Uint8Array
      && right instanceof Uint8Array
      && bytesEqual(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => valueEqual(value, right[index]));
  }
  if (
    typeof left === "object"
    || typeof right === "object"
  ) {
    if (left === null || right === null) return left === right;
    if (typeof left !== "object" || typeof right !== "object") return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return keys.length === Object.keys(rightRecord).length
      && keys.every((key) => valueEqual(leftRecord[key], rightRecord[key]));
  }
  return left === right;
}

function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function rowNumber(row: DatabaseRow, field: string): number {
  const value = row[field];
  let normalized: number;
  if (typeof value === "bigint") {
    normalized =
      value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : Number.NaN;
  } else if (
    typeof value === "string"
    && /^(0|[1-9][0-9]*)$/.test(value)
  ) {
    normalized = Number(value);
  } else {
    normalized = typeof value === "number" ? value : Number.NaN;
  }
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`Crypto storage column ${field} must be a safe integer`);
  }
  return normalized;
}

function rowString(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new TypeError(`Crypto storage column ${field} must be text`);
  }
  return value;
}

function rowBytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Crypto storage column ${field} must be bytea`);
  }
  return new Uint8Array(value);
}

function nullableRowBytes(
  row: DatabaseRow,
  field: string,
): Uint8Array | null {
  if (row[field] === null) return null;
  return rowBytes(row, field);
}

async function lockEntity(
  executor: CryptoPostgresExecutor,
  kind: "grant" | "object",
  id: string,
): Promise<void> {
  await executor.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`${kind}:${id}`],
  );
}

function validatedRecoveryFromRow(
  row: DatabaseRow,
): RecoveryArchiveWireRecordV2 {
  const archive = recoveryFromRow(row);
  if (
    !bytesEqual(
      rowBytes(row, "archive_hash"),
      sha256(archive.archiveBytes),
    )
  ) {
    throw new Error(
      "Recovery archive durable hash does not match canonical archive bytes",
    );
  }
  return archive;
}

async function getDomainById(
  executor: CryptoPostgresExecutor,
  domainId: string,
  lock = false,
): Promise<CryptoDomainPublicRecordV2 | null> {
  const query = cryptoTypedDb.select({
    id: cryptoDomains.id,
    participant_digest: cryptoDomains.participantDigest,
    participants: cryptoDomains.participants,
    epoch: cryptoDomains.epoch,
    authorization_revision: cryptoDomains.authorizationRevision,
    roster_bytes: cryptoDomains.rosterBytes,
  }).from(cryptoDomains).where(eq(cryptoDomains.id, domainId)).limit(2);
  const rows = await executeTypedCryptoQuery(
    executor,
    lock ? query.for("update") : query,
  );
  const row = oneOrNull(rows, "Crypto Domain lookup");
  return row === null ? null : domainFromRow(row);
}

async function getProviderState(
  executor: CryptoPostgresExecutor,
  domainId: string,
  lock = false,
): Promise<
  Readonly<{ head: ProviderPublicHeadV2; rosterBytes: Uint8Array }> | null
> {
  const query = cryptoTypedDb.select({
    domain_id: cryptoDomainProviderHeads.domainId,
    provider_id: cryptoDomainProviderHeads.providerId,
    epoch: cryptoDomainProviderHeads.epoch,
    state_hash: cryptoDomainProviderHeads.stateHash,
    roster_bytes: cryptoDomainProviderHeads.rosterBytes,
    domain_epoch: sql<number>`${cryptoDomains.epoch}`.as("domain_epoch"),
    domain_roster_bytes: sql<Uint8Array>`${cryptoDomains.rosterBytes}`.as(
      "domain_roster_bytes",
    ),
  }).from(cryptoDomainProviderHeads).innerJoin(
    cryptoDomains,
    eq(cryptoDomains.id, cryptoDomainProviderHeads.domainId),
  ).where(eq(cryptoDomainProviderHeads.domainId, domainId)).limit(2);
  const rows = await executeTypedCryptoQuery(
    executor,
    lock ? query.for("update", { of: cryptoDomainProviderHeads }) : query,
  );
  const row = oneOrNull(rows, "Domain provider head lookup");
  if (row === null) return null;
  const state = storageAdapterSupportV2.validateProviderState({
    head: providerHeadFromRow(row),
    rosterBytes: rowBytes(row, "roster_bytes"),
  });
  if (
    rowNumber(row, "domain_epoch") !== state.head.epoch
    || !bytesEqual(
      rowBytes(row, "domain_roster_bytes"),
      state.rosterBytes,
    )
  ) {
    throw new Error(
      "Domain provider durable state does not match its Domain public state",
    );
  }
  return state;
}

async function getNamespaceHeadRow(
  executor: CryptoPostgresExecutor,
  namespaceId: string,
  lock = false,
): Promise<NamespaceHeadV2 | null> {
  const query = cryptoTypedDb.select({
    namespace_id: namespaceCryptoHeads.namespaceId,
    access_revision: namespaceCryptoHeads.accessRevision,
    binding_hash: namespaceCryptoHeads.bindingHash,
    domain_id: namespaceCryptoHeads.domainId,
    domain_epoch: namespaceCryptoHeads.domainEpoch,
    revision: namespaceCryptoBindings.revision,
    previous_binding_hash: namespaceCryptoBindings.previousBindingHash,
    signed_binding_bytes: namespaceCryptoBindings.signedBindingBytes,
    human_keyring_envelope_bytes:
      namespaceCryptoBindings.humanKeyringEnvelopeBytes,
    ai_keyring_envelope_bytes:
      namespaceCryptoBindings.aiKeyringEnvelopeBytes,
  }).from(namespaceCryptoHeads).innerJoin(
    namespaceCryptoBindings,
    and(
      eq(namespaceCryptoBindings.namespaceId, namespaceCryptoHeads.namespaceId),
      eq(namespaceCryptoBindings.revision, namespaceCryptoHeads.accessRevision),
      eq(namespaceCryptoBindings.bindingHash, namespaceCryptoHeads.bindingHash),
    ),
  ).where(eq(namespaceCryptoHeads.namespaceId, namespaceId)).limit(2);
  const rows = await executeTypedCryptoQuery(
    executor,
    lock ? query.for("update", { of: namespaceCryptoHeads }) : query,
  );
  const row = oneOrNull(rows, "Namespace head lookup");
  if (row === null) return null;
  const head = namespaceHeadFromRow(row);
  const durableBinding = bindingFromRow(row);
  const binding = parseNamespaceBindingV2(
    durableBinding.signedBindingBytes,
  );
  if (
    durableBinding.namespaceId !== head.namespaceId
    || durableBinding.revision !== head.accessRevision
    || binding.namespaceId !== head.namespaceId
    || binding.accessRevision !== head.accessRevision
    || binding.domainId !== head.domainId
    || binding.domainEpoch !== head.domainEpoch
  ) {
    throw new Error(
      "Namespace head durable coordinates do not match its canonical binding",
    );
  }
  return head;
}

async function getBindingRow(
  executor: CryptoPostgresExecutor,
  namespaceId: string,
  revision: number,
): Promise<NamespaceBindingWireRecordV2 | null> {
  const rows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      namespace_id: namespaceCryptoBindings.namespaceId,
      revision: namespaceCryptoBindings.revision,
      binding_hash: namespaceCryptoBindings.bindingHash,
      previous_binding_hash: namespaceCryptoBindings.previousBindingHash,
      signed_binding_bytes: namespaceCryptoBindings.signedBindingBytes,
      human_keyring_envelope_bytes:
        namespaceCryptoBindings.humanKeyringEnvelopeBytes,
      ai_keyring_envelope_bytes:
        namespaceCryptoBindings.aiKeyringEnvelopeBytes,
    }).from(namespaceCryptoBindings).where(and(
      eq(namespaceCryptoBindings.namespaceId, namespaceId),
      eq(namespaceCryptoBindings.revision, revision),
    )).limit(2),
  );
  const row = oneOrNull(rows, "Namespace binding lookup");
  return row === null ? null : bindingFromRow(row);
}

async function getObjectRow(
  executor: CryptoPostgresExecutor,
  objectId: string,
): Promise<EncryptedObjectWireRecordV2 | null> {
  const rows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      object_id: cryptoObjects.objectId,
      payload_hash: cryptoObjects.payloadHash,
      payload_bytes: cryptoObjects.payloadBytes,
    }).from(cryptoObjects).where(eq(cryptoObjects.objectId, objectId)).limit(2),
  );
  const row = oneOrNull(rows, "Encrypted object lookup");
  if (row === null) return null;
  const object = objectFromRow(row);
  if (!bytesEqual(rowBytes(row, "payload_hash"), sha256(object.payloadBytes))) {
    throw new Error(
      "Encrypted object durable payload hash does not match canonical payload bytes",
    );
  }
  return object;
}

async function getObjectAccess(
  executor: CryptoPostgresExecutor,
  objectId: string,
  lock = false,
): Promise<ObjectAccessStorageWireStateV2 | null> {
  const headQuery = cryptoTypedDb.select({
    object_id: objectCryptoAccessHeads.objectId,
    access_revision: objectCryptoAccessHeads.accessRevision,
    manifest_hash: objectCryptoAccessHeads.manifestHash,
    previous_manifest_hash: objectCryptoAccessManifests.previousManifestHash,
    payload_hash: objectCryptoAccessManifests.payloadHash,
    manifest_bytes: objectCryptoAccessManifests.manifestBytes,
  }).from(objectCryptoAccessHeads).innerJoin(
    objectCryptoAccessManifests,
    and(
      eq(objectCryptoAccessManifests.objectId, objectCryptoAccessHeads.objectId),
      eq(
        objectCryptoAccessManifests.accessRevision,
        objectCryptoAccessHeads.accessRevision,
      ),
      eq(
        objectCryptoAccessManifests.manifestHash,
        objectCryptoAccessHeads.manifestHash,
      ),
    ),
  ).where(eq(objectCryptoAccessHeads.objectId, objectId)).limit(2);
  const headRows = await executeTypedCryptoQuery(
    executor,
    lock ? headQuery.for("update", { of: objectCryptoAccessHeads }) : headQuery,
  );
  const head = oneOrNull(headRows, "Object access head lookup");
  if (head === null) return null;
  const manifest = decodeObjectAccessStorageManifestV5(
    rowBytes(head, "manifest_bytes"),
  );
  if (
    !bytesEqual(rowBytes(head, "payload_hash"), manifest.payloadHash)
    || !bytesEqual(
      nullableRowBytes(head, "previous_manifest_hash"),
      manifest.previousManifestHash,
    )
  ) {
    throw new Error(
      "Object access durable metadata does not match canonical manifest bytes",
    );
  }
  const envelopes = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
      envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
      envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    }).from(objectCryptoNamespaceEnvelopes).where(and(
      eq(objectCryptoNamespaceEnvelopes.objectId, objectId),
      eq(
        objectCryptoNamespaceEnvelopes.accessRevision,
        rowNumber(head, "access_revision"),
      ),
    )).orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal)).limit(
      CRYPTO_STORAGE_COLLECTION_LIMITS.objectAccessEnvelopes + 1,
    ),
  );
  if (
    envelopes.length
      > CRYPTO_STORAGE_COLLECTION_LIMITS.objectAccessEnvelopes
  ) {
    throw new Error("Object access envelope collection exceeds its bound");
  }
  return objectAccessFromRows(head, envelopes);
}

async function getRuntime(
  executor: CryptoPostgresExecutor,
  agentId: string,
  lock = false,
): Promise<AgentRuntimeAtomicStorageWireV2 | null> {
  const stateQuery = cryptoTypedDb.select({
    agent_id: agentCryptoRuntimeStates.agentId,
    authorization_revision: agentCryptoRuntimeStates.authorizationRevision,
    runtime_generation: agentCryptoRuntimeStates.runtimeGeneration,
    config_object_count: agentCryptoRuntimeStates.configObjectCount,
    config_inventory_digest: agentCryptoRuntimeStates.configInventoryDigest,
  }).from(agentCryptoRuntimeStates).where(
    eq(agentCryptoRuntimeStates.agentId, agentId),
  ).limit(2);
  const stateRows = await executeTypedCryptoQuery(
    executor,
    lock ? stateQuery.for("update") : stateQuery,
  );
  const state = oneOrNull(stateRows, "Agent Runtime state lookup");
  if (state === null) return null;
  const limit = CRYPTO_STORAGE_COLLECTION_LIMITS.maximumOrdinal + 2;
  const [configObjects, domainEnvelopes, challenges] = await Promise.all([
    executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        agent_id: agentCryptoRuntimeConfigObjects.agentId,
        object_id: agentCryptoRuntimeConfigObjects.objectId,
        config_revision: agentCryptoRuntimeConfigObjects.configRevision,
        runtime_generation: agentCryptoRuntimeConfigObjects.runtimeGeneration,
        wrapped_dek_hash: agentCryptoRuntimeConfigObjects.wrappedDekHash,
        wrapped_dek_bytes: agentCryptoRuntimeConfigObjects.wrappedDekBytes,
      }).from(agentCryptoRuntimeConfigObjects).where(
        eq(agentCryptoRuntimeConfigObjects.agentId, agentId),
      ).orderBy(asc(agentCryptoRuntimeConfigObjects.ordinal)).limit(limit),
    ),
    executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        agent_id: agentCryptoRuntimeDomainEnvelopes.agentId,
        domain_id: agentCryptoRuntimeDomainEnvelopes.domainId,
        domain_epoch: agentCryptoRuntimeDomainEnvelopes.domainEpoch,
        agent_authorization_revision:
          agentCryptoRuntimeDomainEnvelopes.agentAuthorizationRevision,
        runtime_generation:
          agentCryptoRuntimeDomainEnvelopes.runtimeGeneration,
        committer_device_id:
          agentCryptoRuntimeDomainEnvelopes.committerDeviceId,
        envelope_hash: agentCryptoRuntimeDomainEnvelopes.envelopeHash,
        envelope_bytes: agentCryptoRuntimeDomainEnvelopes.envelopeBytes,
      }).from(agentCryptoRuntimeDomainEnvelopes).where(
        eq(agentCryptoRuntimeDomainEnvelopes.agentId, agentId),
      ).orderBy(asc(agentCryptoRuntimeDomainEnvelopes.ordinal)).limit(limit),
    ),
    executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        challenge_hash: agentCryptoRuntimeChallenges.challengeHash,
        consumed: agentCryptoRuntimeChallenges.consumed,
      }).from(agentCryptoRuntimeChallenges).where(
        eq(agentCryptoRuntimeChallenges.agentId, agentId),
      ).orderBy(asc(agentCryptoRuntimeChallenges.ordinal)).limit(limit),
    ),
  ]);
  if (
    configObjects.length >= limit
    || domainEnvelopes.length >= limit
    || challenges.length >= limit
  ) {
    throw new Error("Agent Runtime durable collection exceeds its bound");
  }
  return runtimeFromRows(state, configObjects, domainEnvelopes, challenges);
}

function canonicalSignerPublication(
  publication: AgentRuntimeSignerPublicationV1,
): Readonly<{
  readonly publication: AgentRuntimeSignerPublicationV1;
  readonly bytes: Uint8Array;
}> {
  const bytes = encodeAgentRuntimeSignerPublicationV1(publication);
  return Object.freeze({
    publication: decodeAgentRuntimeSignerPublicationV1(bytes),
    bytes,
  });
}

function signerPublicationFromRow(
  row: DatabaseRow,
): AgentRuntimeSignerPublicationV1 {
  const publication = decodeAgentRuntimeSignerPublicationV1(
    rowBytes(row, "publication_bytes"),
  );
  if (
    publication.agentId !== rowString(row, "agent_id")
    || publication.runtimeGeneration
      !== rowNumber(row, "runtime_generation")
    || publication.authorizationRevision
      !== rowNumber(row, "authorization_revision")
    || publication.transitionKind !== rowString(row, "transition_kind")
    || publication.operationId !== rowString(row, "operation_id")
    || publication.signerKeyId !== rowString(row, "signer_key_id")
    || !bytesEqual(
      publication.signerPublicKey,
      rowBytes(row, "signer_public_key"),
    )
  ) {
    throw new Error(
      "Agent Runtime signer publication columns do not match canonical evidence",
    );
  }
  return publication;
}

async function getRuntimeSignerPublication(
  executor: CryptoPostgresExecutor,
  agentIdValue: string,
  runtimeGenerationValue: number,
): Promise<AgentRuntimeSignerPublicationV1 | null> {
  const rows = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      agent_id: agentCryptoRuntimeSigners.agentId,
      runtime_generation: agentCryptoRuntimeSigners.runtimeGeneration,
      authorization_revision: agentCryptoRuntimeSigners.authorizationRevision,
      transition_kind: agentCryptoRuntimeSigners.transitionKind,
      operation_id: agentCryptoRuntimeSigners.operationId,
      signer_key_id: agentCryptoRuntimeSigners.signerKeyId,
      signer_public_key: agentCryptoRuntimeSigners.signerPublicKey,
      publication_bytes: agentCryptoRuntimeSigners.publicationBytes,
    }).from(agentCryptoRuntimeSigners).where(and(
      eq(agentCryptoRuntimeSigners.agentId, agentIdValue),
      eq(
        agentCryptoRuntimeSigners.runtimeGeneration,
        runtimeGenerationValue,
      ),
    )).limit(2),
  );
  const row = oneOrNull(rows, "Agent Runtime signer publication lookup");
  return row === null ? null : signerPublicationFromRow(row);
}

async function insertRuntimeSignerPublication(
  executor: CryptoPostgresExecutor,
  publicationValue: AgentRuntimeSignerPublicationV1,
): Promise<void> {
  const { publication, bytes } =
    canonicalSignerPublication(publicationValue);
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(agentCryptoRuntimeSigners).values({
      agentId: publication.agentId,
      runtimeGeneration: publication.runtimeGeneration,
      authorizationRevision: publication.authorizationRevision,
      transitionKind: publication.transitionKind,
      operationId: publication.operationId,
      signerKeyId: publication.signerKeyId,
      signerPublicKey: publication.signerPublicKey,
      publicationBytes: bytes,
    }),
  );
}

function signerPublicationsEqual(
  left: AgentRuntimeSignerPublicationV1,
  right: AgentRuntimeSignerPublicationV1,
): boolean {
  return bytesEqual(
    encodeAgentRuntimeSignerPublicationV1(left),
    encodeAgentRuntimeSignerPublicationV1(right),
  );
}

async function replaceRuntimeChildren(
  executor: CryptoPostgresExecutor,
  state: AgentRuntimeAtomicStorageWireV2,
): Promise<void> {
  const agentId = state.runtime.agentId;
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.delete(agentCryptoRuntimeConfigObjects).where(
      eq(agentCryptoRuntimeConfigObjects.agentId, agentId),
    ),
  );
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.delete(agentCryptoRuntimeDomainEnvelopes).where(
      eq(agentCryptoRuntimeDomainEnvelopes.agentId, agentId),
    ),
  );
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.delete(agentCryptoRuntimeChallenges).where(
      eq(agentCryptoRuntimeChallenges.agentId, agentId),
    ),
  );
  for (const [ordinal, object] of state.configObjects.entries()) {
    await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.insert(agentCryptoRuntimeConfigObjects).values({
        agentId: object.agentId,
        objectId: object.objectId,
        ordinal,
        configRevision: object.configRevision,
        runtimeGeneration: object.runtimeGeneration,
        wrappedDekHash: object.wrappedDekHash,
        wrappedDekBytes: object.wrappedDekBytes,
      }),
    );
  }
  for (const [ordinal, envelope] of state.domainEnvelopes.entries()) {
    await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.insert(agentCryptoRuntimeDomainEnvelopes).values({
        agentId: envelope.agentId,
        domainId: envelope.domainId,
        ordinal,
        domainEpoch: envelope.domainEpoch,
        agentAuthorizationRevision: envelope.agentAuthorizationRevision,
        runtimeGeneration: envelope.runtimeGeneration,
        committerDeviceId: envelope.committerDeviceId,
        envelopeHash: envelope.envelopeHash,
        envelopeBytes: envelope.envelopeBytes,
      }),
    );
  }
  for (const [ordinal, challenge] of state.challengeConsumptions.entries()) {
    await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.insert(agentCryptoRuntimeChallenges).values({
        agentId,
        challengeHash: challenge.challengeHash,
        ordinal,
        consumed: challenge.consumed,
      }),
    );
  }
}

async function insertRuntime(
  executor: CryptoPostgresExecutor,
  state: AgentRuntimeAtomicStorageWireV2,
): Promise<void> {
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(agentCryptoRuntimeStates).values({
      agentId: state.runtime.agentId,
      authorizationRevision: state.runtime.authorizationRevision,
      runtimeGeneration: state.runtime.runtimeGeneration,
      configObjectCount: state.configInventory.objectCount,
      configInventoryDigest: state.configInventory.digest,
    }),
  );
  await replaceRuntimeChildren(executor, state);
}

/**
 * Complete, dark Wave 6 durable adapter. It owns no pool and catches no
 * transaction/commit errors, so an ambiguous driver outcome remains an
 * explicit rejection rather than being rewritten into apparent success.
 */
export class PostgresLatticeStorage implements LatticeStorage {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  async findDomain(
    participantDigest: Uint8Array,
    exactParticipants: readonly string[],
  ): Promise<CryptoDomainPublicRecordV2 | null> {
    const lookup = storageAdapterSupportV2.validateDomain({
      id: "lookup",
      participantDigest,
      participants: exactParticipants,
      epoch: 0,
      authorizationRevision: 0,
      rosterBytes: new Uint8Array(),
    });
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        id: cryptoDomains.id,
        participant_digest: cryptoDomains.participantDigest,
        participants: cryptoDomains.participants,
        epoch: cryptoDomains.epoch,
        authorization_revision: cryptoDomains.authorizationRevision,
        roster_bytes: cryptoDomains.rosterBytes,
      }).from(cryptoDomains).where(and(
        eq(cryptoDomains.participantDigest, lookup.participantDigest),
        eq(cryptoDomains.participants, [...lookup.participants]),
      )).limit(2),
    );
    const row = oneOrNull(rows, "Exact Crypto Domain lookup");
    return row === null ? null : domainFromRow(row);
  }

  async createDomainIfAbsent(
    input: CryptoDomainPublicRecordV2,
  ): Promise<Readonly<{
    status: "created" | "existing";
    domain: CryptoDomainPublicRecordV2;
  }>> {
    const domain = storageAdapterSupportV2.validateDomain(input);
    return this.handle.transaction(async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended(encode($1::bytea, 'hex'), 0)
         )`,
        [domain.participantDigest],
      );
      const existingById = await getDomainById(
        transaction,
        domain.id,
        true,
      );
      if (
        existingById !== null
        && (
          !bytesEqual(
            existingById.participantDigest,
            domain.participantDigest,
          )
          || !stringsEqual(existingById.participants, domain.participants)
        )
      ) {
        throw new Error(
          "Domain id is already bound to another participant set",
        );
      }
      const exactRows = await transaction.query<
        DatabaseRow & { participants: string[] }
      >(
        `SELECT id, participant_digest, participants, epoch,
                authorization_revision, roster_bytes
           FROM crypto_domains
          WHERE participant_digest = $1 AND participants = $2::text[]
          LIMIT 2
          FOR UPDATE`,
        [domain.participantDigest, [...domain.participants] as never],
      );
      const exact = oneOrNull(exactRows, "Exact Crypto Domain create lookup");
      if (exact !== null) {
        return { status: "existing", domain: domainFromRow(exact) };
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(cryptoDomains).values({
          id: domain.id,
          participantDigest: domain.participantDigest,
          participants: [...domain.participants],
          epoch: domain.epoch,
          authorizationRevision: domain.authorizationRevision,
          rosterBytes: domain.rosterBytes,
        }),
      );
      return { status: "created", domain };
    });
  }

  async putDomainProviderHeadIfAbsent(
    headInput: ProviderPublicHeadV2,
    rosterBytes: Uint8Array,
  ): Promise<"inserted" | "existing"> {
    const state = storageAdapterSupportV2.validateProviderState({
      head: headInput,
      rosterBytes,
    });
    return this.handle.transaction(async (transaction) => {
      const domain = await getDomainById(
        transaction,
        state.head.domainId,
        true,
      );
      if (
        domain === null
        || domain.epoch !== state.head.epoch
        || !bytesEqual(domain.rosterBytes, state.rosterBytes)
      ) {
        throw new Error(
          "Domain provider head does not match the current Domain public state",
        );
      }
      const existing = await getProviderState(
        transaction,
        state.head.domainId,
        true,
      );
      if (existing !== null) {
        if (!valueEqual(existing, state)) {
          throw new Error(
            "Domain provider head is already initialized with different public state",
          );
        }
        return "existing";
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(cryptoDomainProviderHeads).values({
          domainId: state.head.domainId,
          providerId: state.head.providerId,
          epoch: state.head.epoch,
          stateHash: state.head.stateHash,
          rosterBytes: state.rosterBytes,
        }),
      );
      return "inserted";
    });
  }

  async getDomainProviderHead(
    domainId: string,
  ): Promise<ProviderPublicHeadV2 | null> {
    return (await getProviderState(this.handle, domainId))?.head ?? null;
  }

  async compareAndSwapDomainProviderHead(
    authorized: Parameters<
      LatticeStorage["compareAndSwapDomainProviderHead"]
    >[0],
  ): Promise<"applied" | "duplicate" | "stale"> {
    const write = storageAdapterSupportV2.consumeProviderHeadWrite(authorized);
    const expected = storageAdapterSupportV2.validateProviderState({
      head: write.expected,
      rosterBytes: new Uint8Array(),
    }).head;
    const next = storageAdapterSupportV2.validateProviderState({
      head: write.next,
      rosterBytes: write.nextRosterBytes,
    });
    if (
      expected.providerId !== next.head.providerId
      || expected.domainId !== next.head.domainId
      || next.head.epoch !== expected.epoch + 1
    ) {
      throw new Error(
        "Domain provider CAS requires one exact same-provider epoch advance",
      );
    }
    return this.handle.transaction(async (transaction) => {
      const domain = await getDomainById(
        transaction,
        expected.domainId,
        true,
      );
      const current = await getProviderState(
        transaction,
        expected.domainId,
        true,
      );
      if (
        domain === null
        || current === null
        || domain.authorizationRevision
          !== write.authorization.authorizationRevision
      ) {
        return "stale";
      }
      if (valueEqual(current.head, next.head)) {
        return bytesEqual(current.rosterBytes, next.rosterBytes)
          ? "duplicate"
          : "stale";
      }
      if (
        !valueEqual(current.head, expected)
        || !bytesEqual(domain.rosterBytes, current.rosterBytes)
      ) {
        return "stale";
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDomains).set({
          epoch: next.head.epoch,
          rosterBytes: next.rosterBytes,
        }).where(eq(cryptoDomains.id, next.head.domainId)),
      );
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDomainProviderHeads).set({
          epoch: next.head.epoch,
          stateHash: next.head.stateHash,
          rosterBytes: next.rosterBytes,
        }).where(eq(
          cryptoDomainProviderHeads.domainId,
          next.head.domainId,
        )),
      );
      return "applied";
    });
  }

  getBinding(
    namespaceId: string,
    revision: number,
  ): Promise<NamespaceBindingWireRecordV2 | null> {
    return getBindingRow(this.handle, namespaceId, revision);
  }

  getNamespaceHead(namespaceId: string): Promise<NamespaceHeadV2 | null> {
    return getNamespaceHeadRow(this.handle, namespaceId);
  }

  async compareAndSwapNamespaceBindingAndHead(
    authorized: Parameters<
      LatticeStorage["compareAndSwapNamespaceBindingAndHead"]
    >[0],
  ): Promise<"applied" | "duplicate" | "stale"> {
    const write =
      storageAdapterSupportV2.consumeNamespaceBindingWrite(authorized);
    const binding = storageAdapterSupportV2.validateNamespaceBinding(
      write.binding,
    );
    const next = storageAdapterSupportV2.validateNamespaceHead(write.next);
    const signedBinding = parseNamespaceBindingV2(binding.signedBindingBytes);
    if (
      binding.namespaceId !== next.namespaceId
      || binding.revision !== next.accessRevision
      || !bytesEqual(binding.bindingHash, next.bindingHash)
      || signedBinding.domainId !== next.domainId
      || signedBinding.domainEpoch !== next.domainEpoch
    ) {
      throw new Error(
        "Namespace atomic CAS binding and head coordinates differ",
      );
    }
    return this.handle.transaction(async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [next.namespaceId],
      );
      const current = await getNamespaceHeadRow(
        transaction,
        next.namespaceId,
        true,
      );
      const existing = await getBindingRow(
        transaction,
        next.namespaceId,
        next.accessRevision,
      );
      if (
        current !== null
        && bytesEqual(current.bindingHash, next.bindingHash)
        && existing !== null
      ) {
        return valueEqual(existing, binding) ? "duplicate" : "stale";
      }
      if (write.expected === null) {
        if (current !== null || next.accessRevision !== 0) return "stale";
      } else if (
        write.expected.namespaceId !== next.namespaceId
        || current === null
        || current.accessRevision !== write.expected.accessRevision
        || !bytesEqual(current.bindingHash, write.expected.bindingHash)
        || next.accessRevision !== write.expected.accessRevision + 1
        || !bytesEqual(
          binding.previousBindingHash,
          write.expected.bindingHash,
        )
      ) {
        return "stale";
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(namespaceCryptoBindings).values({
          namespaceId: binding.namespaceId,
          revision: binding.revision,
          bindingHash: binding.bindingHash,
          previousBindingHash: binding.previousBindingHash,
          signedBindingBytes: binding.signedBindingBytes,
          humanKeyringEnvelopeBytes: binding.humanKeyringEnvelopeBytes,
          aiKeyringEnvelopeBytes: binding.aiKeyringEnvelopeBytes,
        }),
      );
      if (current === null) {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.insert(namespaceCryptoHeads).values({
            namespaceId: next.namespaceId,
            accessRevision: next.accessRevision,
            bindingHash: next.bindingHash,
            domainId: next.domainId,
            domainEpoch: next.domainEpoch,
          }),
        );
      } else {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(namespaceCryptoHeads).set({
            accessRevision: next.accessRevision,
            bindingHash: next.bindingHash,
            domainId: next.domainId,
            domainEpoch: next.domainEpoch,
          }).where(eq(namespaceCryptoHeads.namespaceId, next.namespaceId)),
        );
      }
      return "applied";
    });
  }

  async putObject(
    input: Parameters<LatticeStorage["putObject"]>[0],
  ): Promise<void> {
    const object = storageAdapterSupportV2.validateEncryptedObject(input);
    await this.handle.transaction(async (transaction) => {
      await lockEntity(transaction, "object", object.objectId);
      const existing = await getObjectRow(
        transaction,
        object.objectId,
      );
      if (existing !== null) {
        if (!bytesEqual(existing.payloadBytes, object.payloadBytes)) {
          throw new Error(
            "Encrypted object is already initialized with different payload bytes",
          );
        }
        return;
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(cryptoObjects).values({
          objectId: object.objectId,
          payloadHash: sha256(object.payloadBytes),
          payloadBytes: object.payloadBytes,
        }),
      );
    });
  }

  getObject(objectId: string): Promise<EncryptedObjectWireRecordV2 | null> {
    return getObjectRow(this.handle, objectId);
  }

  getObjectAccessState(
    objectId: string,
  ): Promise<ObjectAccessStorageWireStateV2 | null> {
    return this.handle.transaction((transaction) =>
      getObjectAccess(transaction, objectId, true)
    );
  }

  async compareAndSwapObjectAccessState(
    authorized: Parameters<
      LatticeStorage["compareAndSwapObjectAccessState"]
    >[0],
  ): Promise<"applied" | "duplicate" | "stale"> {
    const write = storageAdapterSupportV2.consumeObjectAccessWrite(authorized);
    const expected = write.expected === null
      ? null
      : storageAdapterSupportV2.validateObjectAccessHead(write.expected);
    const intended = storageAdapterSupportV2.validateObjectAccessState(
      write.intended,
    );
    if (
      expected !== null
      && expected.objectId !== intended.head.objectId
    ) {
      throw new Error(
        "Object access CAS expected and intended object ids differ",
      );
    }
    const authorization =
      storageAdapterSupportV2.validateObjectAccessAuthorizationExpectation(
        write.authorization,
      );
    const manifest = decodeObjectAccessStorageManifestV5(
      intended.head.manifestBytes,
    );
    return this.handle.transaction(async (transaction) => {
      await lockEntity(transaction, "object", intended.head.objectId);
      const payload = await getObjectRow(
        transaction,
        intended.head.objectId,
      );
      if (
        payload === null
        || !bytesEqual(sha256(payload.payloadBytes), manifest.payloadHash)
      ) {
        return "stale";
      }
      const current = await getObjectAccess(
        transaction,
        intended.head.objectId,
        true,
      );
      if (expected === null) {
        if (authorization.kind === "agent-genesis") {
          const context = authorization.context;
          const grantRows = await transaction.query(
            `SELECT grant_id, grant_bytes, consumed
               FROM crypto_grants
              WHERE grant_id = $1
              LIMIT 2
              FOR UPDATE`,
            [context.grantId],
          );
          const grantRow = oneOrNull(
            grantRows,
            "Agent object Grant lookup",
          );
          const grant = grantRow === null ? null : grantFromRow(grantRow);
          const parsedGrant = grant === null
            ? null
            : parseGrantV2(grant.grantBytes);
          const namespaceHead = await getNamespaceHeadRow(
            transaction,
            context.namespaceId,
            true,
          );
          const domainRows = await transaction.query<
            DatabaseRow & { participants: string[] }
          >(
            `SELECT id, participant_digest, participants, epoch,
                    authorization_revision, roster_bytes
               FROM crypto_domains
              WHERE id = $1
              LIMIT 2
              FOR SHARE`,
            [context.domainId],
          );
          const domainRow = oneOrNull(
            domainRows,
            "Agent object Domain lookup",
          );
          const domain = domainRow === null
            ? null
            : domainFromRow(domainRow);
          const runtime = await getRuntime(
            transaction,
            context.agentId,
            true,
          );
          const signer = await getRuntimeSignerPublication(
            transaction,
            context.agentId,
            context.runtimeGeneration,
          );
          const matchingRuntimeDomains =
            runtime?.domainEnvelopes.filter((record) =>
              record.agentId === context.agentId
              && record.domainId === context.domainId
              && record.domainEpoch === context.domainEpoch
              && record.agentAuthorizationRevision
                === context.agentAuthorizationRevision
              && record.runtimeGeneration === context.runtimeGeneration
            ) ?? [];
          if (
            manifest.formatVersion !== 3
            || intended.head.accessRevision !== 0
            || manifest.objectId !== context.objectId
            || !bytesEqual(manifest.payloadHash, context.payloadHash)
            || manifest.hostAuthorizationRevision
              !== context.agentAuthorizationRevision
            || manifest.signer.agentId !== context.agentId
            || manifest.signer.runtimeGeneration
              !== context.runtimeGeneration
            || manifest.signer.signerKeyId !== context.signerKeyId
            || context.envelope.objectId !== context.objectId
            || context.envelope.namespaceId !== context.namespaceId
            || context.envelope.keyClass !== "ai"
            || context.envelope.bindingRevisionAtWrap
              !== context.namespaceAccessRevision
            || grant === null
            || parsedGrant === null
            || parsedGrant.id !== context.grantId
            || !bytesEqual(sha256(grant.grantBytes), context.grantHash)
            || parsedGrant.recipientAgentId !== context.agentId
            || !parsedGrant.operations.includes("encrypt")
            || !parsedGrant.coveredDomains.some((covered) =>
              covered.domainId === context.domainId
              && covered.domainEpoch === context.domainEpoch
              && covered.agentAuthorizationRevision
                === context.agentAuthorizationRevision
            )
            || (
              context.grantUseStatus === "reusable"
                ? parsedGrant.singleUse || grant.consumed
                : !parsedGrant.singleUse || !grant.consumed
            )
            || namespaceHead === null
            || namespaceHead.accessRevision
              !== context.namespaceAccessRevision
            || !bytesEqual(
              namespaceHead.bindingHash,
              context.namespaceBindingHash,
            )
            || namespaceHead.domainId !== context.domainId
            || namespaceHead.domainEpoch !== context.domainEpoch
            || domain === null
            || domain.id !== context.domainId
            || domain.epoch !== context.domainEpoch
            || runtime === null
            || runtime.runtime.agentId !== context.agentId
            || runtime.runtime.authorizationRevision
              !== context.agentAuthorizationRevision
            || runtime.runtime.runtimeGeneration
              !== context.runtimeGeneration
            || matchingRuntimeDomains.length !== 1
            || signer === null
            || !signerPublicationsEqual(
              signer,
              authorization.signerPublication,
            )
          ) return "stale";
        } else if (
          authorization.kind
            === "device-wrapped-live-shadow-agent-genesis-set"
        ) {
          const context = authorization.context;
          // Foreground admission and runtime signers are ephemeral, validated
          // by the live resolver and branded coordinator write above. Recheck
          // its exact native authority heads at CAS, not legacy Grant/runtime
          // registry rows (which belong to background agent-genesis).
          const currentDomains = new Map<string, Readonly<{
            generation: number;
            authorizationRevision: number;
            headDigest: Uint8Array;
          }>>();
          let namespacesCurrent = true;
          for (const namespace of context.namespaces) {
            const rows = await executeTypedCryptoQuery(
              transaction,
              cryptoTypedDb.select({
                domain_id: namespaceDomainKeyHeads.domainId,
                domain_key_generation:
                  namespaceDomainKeyHeads.domainKeyGeneration,
                domain_authorization_revision:
                  namespaceDomainKeyHeads.domainAuthorizationRevision,
                domain_head_digest:
                  namespaceDomainKeyHeads.domainHeadDigest,
                namespace_current_generation:
                  namespaceDomainKeyHeads.namespaceCurrentGeneration,
                namespace_access_revision:
                  namespaceDomainKeyHeads.namespaceAccessRevision,
                retained_authority_set_digest:
                  namespaceDomainKeyHeads.retainedAuthoritySetDigest,
                state: namespaceDomainKeyBindings.state,
              }).from(namespaceDomainKeyHeads).innerJoin(
                namespaceDomainKeyBindings,
                eq(
                  namespaceDomainKeyBindings.operationId,
                  namespaceDomainKeyHeads.bindingOperationId,
                ),
              ).where(and(
                eq(namespaceDomainKeyHeads.namespaceId, namespace.namespaceId),
                eq(namespaceDomainKeyHeads.keyClass, "ai"),
              )).limit(2).for("share", {
                of: [namespaceDomainKeyHeads, namespaceDomainKeyBindings],
              }),
            );
            const row = oneOrNull(
              rows,
              "Device-wrapped Namespace set head lookup",
            );
            if (
              row === null
              || rowString(row, "domain_id") !== namespace.domainId
              || rowNumber(row, "domain_key_generation")
                !== namespace.domainKeyGeneration
              || rowNumber(row, "domain_authorization_revision")
                !== namespace.domainAuthorizationRevision
              || !bytesEqual(
                rowBytes(row, "domain_head_digest"),
                namespace.domainHeadDigest,
              )
              || rowNumber(row, "namespace_current_generation")
                !== namespace.keyGeneration
              || rowNumber(row, "namespace_access_revision")
                !== namespace.accessRevision
              || !bytesEqual(
                rowBytes(row, "retained_authority_set_digest"),
                namespace.audienceFingerprint,
              )
              || !bytesEqual(
                rowBytes(row, "retained_authority_set_digest"),
                namespace.headDigest,
              )
              || !bytesEqual(
                rowBytes(row, "retained_authority_set_digest"),
                namespace.publicationDigest,
              )
              || !bytesEqual(
                rowBytes(row, "retained_authority_set_digest"),
                namespace.publicationSetDigest,
              )
              || rowString(row, "state") !== "active"
            ) {
              namespacesCurrent = false;
              break;
            }
            const existingDomain = currentDomains.get(namespace.domainId);
            if (
              existingDomain !== undefined
              && (
                existingDomain.generation !== namespace.domainKeyGeneration
                || existingDomain.authorizationRevision
                  !== namespace.domainAuthorizationRevision
                || !bytesEqual(
                  existingDomain.headDigest,
                  namespace.domainHeadDigest,
                )
              )
            ) {
              namespacesCurrent = false;
              break;
            }
            currentDomains.set(namespace.domainId, Object.freeze({
              generation: namespace.domainKeyGeneration,
              authorizationRevision: namespace.domainAuthorizationRevision,
              headDigest: namespace.domainHeadDigest,
            }));
          }
          if (
            manifest.formatVersion !== 5
            || intended.head.accessRevision !== 0
            || manifest.previousManifestHash !== null
            || manifest.objectId !== context.objectId
            || !bytesEqual(manifest.payloadHash, context.payloadHash)
            || manifest.hostAuthorizationRevision
              !== context.agentAuthorizationRevision
            || manifest.signer.kind !== "agent_runtime"
            || manifest.signer.agentId !== context.agentId
            || manifest.signer.runtimeGeneration !== context.runtimeGeneration
            || manifest.signer.signerKeyId !== context.signerKeyId
            || context.envelopes.length !== context.namespaces.length
            || context.envelopes.some((envelope, index) => {
              const namespace = context.namespaces[index]!;
              return envelope.objectId !== context.objectId
                || envelope.namespaceId !== namespace.namespaceId
                || envelope.keyClass !== "ai"
                || envelope.keyGeneration !== namespace.keyGeneration
                || envelope.bindingRevisionAtWrap !== namespace.accessRevision;
            })
            || !namespacesCurrent
          ) return "stale";
        } else if (
          authorization.kind
            === "device-wrapped-live-shadow-agent-genesis"
        ) {
          const context = authorization.context;
          const rows = await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              namespace_current_generation:
                namespaceDomainKeyHeads.namespaceCurrentGeneration,
              namespace_access_revision:
                namespaceDomainKeyHeads.namespaceAccessRevision,
              retained_authority_set_digest:
                namespaceDomainKeyHeads.retainedAuthoritySetDigest,
              state: namespaceDomainKeyBindings.state,
            }).from(namespaceDomainKeyHeads).innerJoin(
              namespaceDomainKeyBindings,
              eq(
                namespaceDomainKeyBindings.operationId,
                namespaceDomainKeyHeads.bindingOperationId,
              ),
            ).where(and(
              eq(namespaceDomainKeyHeads.namespaceId, context.namespaceId),
              eq(namespaceDomainKeyHeads.keyClass, "ai"),
            )).for("share", {
              of: [namespaceDomainKeyHeads, namespaceDomainKeyBindings],
            }),
          );
          const row = oneOrNull(rows, "Device-wrapped Namespace head lookup");
          if (
            manifest.formatVersion !== 3
            || intended.head.accessRevision !== 0
            || manifest.objectId !== context.objectId
            || !bytesEqual(manifest.payloadHash, context.payloadHash)
            || manifest.hostAuthorizationRevision
              !== context.agentAuthorizationRevision
            || manifest.signer.agentId !== context.agentId
            || manifest.signer.runtimeGeneration
              !== context.runtimeGeneration
            || manifest.signer.signerKeyId !== context.signerKeyId
            || context.envelope.objectId !== context.objectId
            || context.envelope.namespaceId !== context.namespaceId
            || context.envelope.keyClass !== "ai"
            || context.envelope.bindingRevisionAtWrap
              !== context.namespaceAccessRevision
            || row === null
            || rowNumber(row, "namespace_current_generation")
              !== context.envelope.keyGeneration
            || rowNumber(row, "namespace_access_revision")
              !== context.namespaceAccessRevision
            || !bytesEqual(
              rowBytes(row, "retained_authority_set_digest"),
              context.namespaceAudienceFingerprint,
            )
            || !bytesEqual(
              rowBytes(row, "retained_authority_set_digest"),
              context.namespaceHeadDigest,
            )
            || !bytesEqual(
              rowBytes(row, "retained_authority_set_digest"),
              context.namespacePublicationDigest,
            )
            || !bytesEqual(
              rowBytes(row, "retained_authority_set_digest"),
              context.namespacePublicationSetDigest,
            )
            || rowString(row, "state") !== "active"
          ) return "stale";
        } else if (authorization.kind === "human-v5-genesis") {
          const context = authorization.context;
          if (
            manifest.formatVersion !== 5
            || manifest.signer.kind !== "human_device"
            || intended.head.accessRevision !== 0
            || manifest.previousManifestHash !== null
            || manifest.objectId !== context.objectId
            || !bytesEqual(manifest.payloadHash, context.payloadHash)
            || manifest.signer.subjectHumanId !== context.subjectHumanId
            || manifest.signer.committerDeviceId
              !== context.committerDeviceId
            || manifest.hostAuthorizationRevision
              !== authorization.currentHostAuthorizationRevision
            || context.hostAuthorizationRevision
              !== authorization.currentHostAuthorizationRevision
            || !storageAdapterSupportV2
              .humanV5GenesisAuthorizationMatchesState(
                authorization,
                intended,
              )
          ) return "stale";
        } else if (
          authorization.kind !== "genesis"
          || manifest.formatVersion !== 2
          || intended.head.accessRevision !== 0
          || authorization.context.objectId !== intended.head.objectId
          || !bytesEqual(
            authorization.context.payloadHash,
            manifest.payloadHash,
          )
          || authorization.context.hostAuthorizationRevision
            !== authorization.currentHostAuthorizationRevision
          || manifest.hostAuthorizationRevision
            !== authorization.currentHostAuthorizationRevision
        ) return "stale";
      } else {
        if (manifest.formatVersion !== 2) return "stale";
        const expectedManifest = decodeObjectAccessManifestV2(
          expected.manifestBytes,
        );
        if (
          authorization.kind !== "update"
          || intended.head.accessRevision
            !== expected.accessRevision + 1
          || !bytesEqual(
            manifest.previousManifestHash,
            expected.manifestHash,
          )
          || authorization.context.objectId !== intended.head.objectId
          || !valueEqual(
            authorization.context.currentHead,
            expected,
          )
          || !valueEqual(
            authorization.context.nextHead,
            intended.head,
          )
          || !bytesEqual(
            authorization.context.payloadHash,
            manifest.payloadHash,
          )
          || authorization.context
            .currentManifestHostAuthorizationRevision
            !== authorization.currentManifestHostAuthorizationRevision
          || authorization.context.hostAuthorizationRevision
            !== authorization.currentHostAuthorizationRevision
          || expectedManifest.hostAuthorizationRevision
            !== authorization.currentManifestHostAuthorizationRevision
          || manifest.hostAuthorizationRevision
            !== authorization.currentHostAuthorizationRevision
        ) {
          return "stale";
        }
      }
      if (current !== null && valueEqual(current, intended)) {
        return "duplicate";
      }
      if (
        expected === null
          ? current !== null
          : current === null || !valueEqual(current.head, expected)
      ) {
        return "stale";
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(objectCryptoAccessManifests).values({
          objectId: intended.head.objectId,
          accessRevision: intended.head.accessRevision,
          manifestHash: intended.head.manifestHash,
          previousManifestHash: manifest.previousManifestHash,
          payloadHash: manifest.payloadHash,
          manifestBytes: intended.head.manifestBytes,
        }),
      );
      for (
        const [ordinal, envelope] of intended.namespaceEnvelopes.entries()
      ) {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.insert(objectCryptoNamespaceEnvelopes).values({
            objectId: intended.head.objectId,
            accessRevision: intended.head.accessRevision,
            namespaceId: envelope.namespaceId,
            ordinal,
            envelopeHash: envelope.envelopeHash,
            envelopeBytes: envelope.envelopeBytes,
          }),
        );
      }
      if (current === null) {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.insert(objectCryptoAccessHeads).values({
            objectId: intended.head.objectId,
            accessRevision: intended.head.accessRevision,
            manifestHash: intended.head.manifestHash,
          }),
        );
      } else {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(objectCryptoAccessHeads).set({
            accessRevision: intended.head.accessRevision,
            manifestHash: intended.head.manifestHash,
          }).where(eq(
            objectCryptoAccessHeads.objectId,
            intended.head.objectId,
          )),
        );
      }
      return "applied";
    });
  }

  async putAgentRuntimeAtomicStateIfAbsent(
    authorized: Parameters<
      LatticeStorage["putAgentRuntimeAtomicStateIfAbsent"]
    >[0],
  ): Promise<"inserted" | "existing" | "stale"> {
    const write =
      storageAdapterSupportV2.consumeAgentRuntimeInitializationWrite(
        authorized,
      );
    const intended = storageAdapterSupportV2.validateAgentRuntimeAtomicState(
      write.state,
    );
    const signerPublication =
      canonicalSignerPublication(write.signerPublication).publication;
    if (
      signerPublication.agentId !== intended.runtime.agentId
      || signerPublication.runtimeGeneration
        !== intended.runtime.runtimeGeneration
      || signerPublication.authorizationRevision
        !== intended.runtime.authorizationRevision
      || signerPublication.transitionKind !== "initialization"
    ) {
      throw new Error(
        "Agent Runtime initialization signer publication does not match its state",
      );
    }
    return this.handle.transaction(async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [intended.runtime.agentId],
      );
      const current = await getRuntime(
        transaction,
        intended.runtime.agentId,
        true,
      );
      if (current !== null) {
        if (!valueEqual(current, intended)) {
          throw new Error(
            "Agent Runtime atomic state is already initialized with different bytes",
          );
        }
        const currentPublication = await getRuntimeSignerPublication(
          transaction,
          intended.runtime.agentId,
          intended.runtime.runtimeGeneration,
        );
        if (
          currentPublication === null
          || !signerPublicationsEqual(
            currentPublication,
            signerPublication,
          )
        ) {
          throw new Error(
            "Agent Runtime signer publication history does not match initialized state",
          );
        }
        return "existing";
      }
      await insertRuntime(transaction, intended);
      await insertRuntimeSignerPublication(
        transaction,
        signerPublication,
      );
      return "inserted";
    });
  }

  getAgentRuntimeAtomicState(
    agentId: string,
  ): Promise<AgentRuntimeAtomicStorageWireV2 | null> {
    return this.handle.transaction((transaction) =>
      getRuntime(transaction, agentId, true)
    );
  }

  async getAgentRuntimeSignerPublication(
    agentIdValue: string,
    runtimeGenerationValue: number,
  ): Promise<AgentRuntimeSignerPublicationV1 | null> {
    const checkedAgentId = agentId(agentIdValue);
    const checkedGeneration =
      agentRuntimeGeneration(runtimeGenerationValue);
    try {
      return await getRuntimeSignerPublication(
        this.handle,
        checkedAgentId,
        checkedGeneration,
      );
    } catch (cause) {
      throw new AgentRuntimeSignerHistoryUnavailableError(cause);
    }
  }

  async compareAndSwapAgentRuntimeChallengeReservations(
    authorized: Parameters<
      LatticeStorage["compareAndSwapAgentRuntimeChallengeReservations"]
    >[0],
  ): Promise<"applied" | "duplicate" | "stale"> {
    const write =
      storageAdapterSupportV2.consumeAgentRuntimeChallengeReservationWrite(
        authorized,
      );
    const expected =
      storageAdapterSupportV2
        .validateAgentRuntimeChallengeReservationExpectation(
          write.expected,
        );
    if (write.additions.length
      > CRYPTO_STORAGE_COLLECTION_LIMITS.agentRuntimeChallenges) {
      throw new RangeError(
        "Agent Runtime challenge reservation additions exceed their bound",
      );
    }
    let priorAddition: Uint8Array | null = null;
    for (const addition of write.additions) {
      if (
        !(addition.challengeHash instanceof Uint8Array)
        || addition.challengeHash.length !== 32
        || addition.consumed !== false
        || (
          priorAddition !== null
          && compareBytes(priorAddition, addition.challengeHash) >= 0
        )
      ) {
        throw new Error(
          "Agent Runtime challenge reservation additions must be unconsumed, sorted, unique hashes",
        );
      }
      priorAddition = addition.challengeHash;
    }
    return this.handle.transaction(async (transaction) => {
      const current = await getRuntime(
        transaction,
        expected.runtime.agentId,
        true,
      );
      if (
        current === null
        || current.runtime.authorizationRevision
          !== expected.runtime.authorizationRevision
        || current.runtime.runtimeGeneration
          !== expected.runtime.runtimeGeneration
      ) {
        return "stale";
      }
      if (
        write.additions.length > 0
        && write.additions.every((addition) =>
          current.challengeConsumptions.some((challenge) =>
            !challenge.consumed
            && bytesEqual(challenge.challengeHash, addition.challengeHash)
          )
        )
      ) {
        return "duplicate";
      }
      if (
        !valueEqual(
          current.challengeConsumptions,
          expected.challengeConsumptions,
        )
        || write.additions.some((addition) =>
          current.challengeConsumptions.some((challenge) =>
            bytesEqual(challenge.challengeHash, addition.challengeHash)
          )
        )
      ) {
        return "stale";
      }
      const merged = [
        ...current.challengeConsumptions.filter(
          (challenge) => !challenge.consumed,
        ),
        ...write.additions,
      ].sort((left, right) =>
        compareBytes(left.challengeHash, right.challengeHash)
      );
      if (
        merged.length
          > CRYPTO_STORAGE_COLLECTION_LIMITS.agentRuntimeChallenges
      ) {
        throw new RangeError(
          "Agent Runtime pending challenge reservation count exceeds its bound",
        );
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.delete(agentCryptoRuntimeChallenges).where(eq(
          agentCryptoRuntimeChallenges.agentId,
          expected.runtime.agentId,
        )),
      );
      for (const [ordinal, challenge] of merged.entries()) {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.insert(agentCryptoRuntimeChallenges).values({
            agentId: expected.runtime.agentId,
            challengeHash: challenge.challengeHash,
            ordinal,
            consumed: challenge.consumed,
          }),
        );
      }
      return "applied";
    });
  }

  async compareAndSwapAgentRuntimeRotation(
    authorized: Parameters<
      LatticeStorage["compareAndSwapAgentRuntimeRotation"]
    >[0],
  ): Promise<"applied" | "duplicate" | "stale"> {
    const write =
      storageAdapterSupportV2.consumeAgentRuntimeRotationWrite(authorized);
    const expected =
      storageAdapterSupportV2.validateAgentRuntimeRotationExpectation(
        write.expected,
      );
    const intended = storageAdapterSupportV2.validateAgentRuntimeAtomicState(
      write.intended,
    );
    const signerPublication =
      canonicalSignerPublication(write.signerPublication).publication;
    if (
      intended.runtime.agentId !== expected.runtime.agentId
      || intended.runtime.authorizationRevision
        !== expected.runtime.authorizationRevision + 1
      || intended.runtime.runtimeGeneration
        !== expected.runtime.runtimeGeneration + 1
    ) {
      throw new Error(
        "Agent Runtime CAS requires one exact authorization and generation advance",
      );
    }
    if (
      signerPublication.transitionKind !== "rotation"
      || signerPublication.agentId !== intended.runtime.agentId
      || signerPublication.authorizationRevision
        !== intended.runtime.authorizationRevision
      || signerPublication.runtimeGeneration
        !== intended.runtime.runtimeGeneration
    ) {
      throw new Error(
        "Agent Runtime rotation signer publication does not match its state",
      );
    }
    if (expected.configObjects.length !== intended.configObjects.length) {
      throw new Error(
        "Agent Runtime CAS write set does not exactly rewrap config",
      );
    }
    for (const [index, object] of expected.configObjects.entries()) {
      const nextObject = intended.configObjects[index]!;
      if (
        object.objectId !== nextObject.objectId
        || object.configRevision !== nextObject.configRevision
      ) {
        throw new Error(
          "Agent Runtime CAS write set does not exactly rewrap config",
        );
      }
    }
    const newlyConsumedChallenges =
      expected.challengeConsumptions.reduce((count, challenge, index) => {
        const nextChallenge = intended.challengeConsumptions[index];
        return count + (
            nextChallenge !== undefined
            && !challenge.consumed
            && nextChallenge.consumed
          ? 1
          : 0
        );
      }, 0);
    if (
      expected.challengeConsumptions.length
        !== intended.challengeConsumptions.length
      || intended.domainEnvelopes.length !== newlyConsumedChallenges
      || expected.challengeConsumptions.some((challenge, index) => {
        const nextChallenge = intended.challengeConsumptions[index]!;
        return !bytesEqual(
          challenge.challengeHash,
          nextChallenge.challengeHash,
        ) || (challenge.consumed && !nextChallenge.consumed);
      })
    ) {
      throw new Error(
        "Agent Runtime CAS write set does not consume exactly its challenges",
      );
    }
    return this.handle.transaction(async (transaction) => {
      const current = await getRuntime(
        transaction,
        expected.runtime.agentId,
        true,
      );
      if (
        current === null
        || !valueEqual(
          current.runtime,
          write.authorization.currentState,
        )
      ) {
        return "stale";
      }
      if (current !== null && valueEqual(current, intended)) {
        const existingPublication = await getRuntimeSignerPublication(
          transaction,
          intended.runtime.agentId,
          intended.runtime.runtimeGeneration,
        );
        return existingPublication !== null
            && signerPublicationsEqual(
              existingPublication,
              signerPublication,
            )
          ? "duplicate"
          : "stale";
      }
      if (
        current === null
        || current.runtime.authorizationRevision
          !== expected.runtime.authorizationRevision
        || current.runtime.runtimeGeneration
          !== expected.runtime.runtimeGeneration
        || !bytesEqual(
          current.configInventory.digest,
          expected.configInventory.digest,
        )
        || !valueEqual(
          current.configObjects.map((object) => ({
            agentId: object.agentId,
            objectId: object.objectId,
            configRevision: object.configRevision,
            runtimeGeneration: object.runtimeGeneration,
            wrappedDekHash: object.wrappedDekHash,
          })),
          expected.configObjects,
        )
        || !valueEqual(
          current.challengeConsumptions,
          expected.challengeConsumptions,
        )
      ) {
        return "stale";
      }
      const conflictingPublication = await getRuntimeSignerPublication(
        transaction,
        intended.runtime.agentId,
        intended.runtime.runtimeGeneration,
      );
      if (conflictingPublication !== null) return "stale";
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(agentCryptoRuntimeStates).set({
          authorizationRevision: intended.runtime.authorizationRevision,
          runtimeGeneration: intended.runtime.runtimeGeneration,
          configObjectCount: intended.configInventory.objectCount,
          configInventoryDigest: intended.configInventory.digest,
        }).where(eq(
          agentCryptoRuntimeStates.agentId,
          intended.runtime.agentId,
        )),
      );
      await replaceRuntimeChildren(transaction, intended);
      await insertRuntimeSignerPublication(
        transaction,
        signerPublication,
      );
      return "applied";
    });
  }

  async compareAndSwapAgentRuntimeAuthorizationTransition(
    authorized: Parameters<
      LatticeStorage[
        "compareAndSwapAgentRuntimeAuthorizationTransition"
      ]
    >[0],
  ): Promise<"applied" | "duplicate" | "stale"> {
    const write =
      storageAdapterSupportV2
        .consumeAgentRuntimeAuthorizationTransitionWrite(authorized);
    const expected =
      storageAdapterSupportV2.validateAgentRuntimeAtomicState(
        write.expected,
      );
    const intended =
      storageAdapterSupportV2.validateAgentRuntimeAtomicState(
        write.intended,
      );
    const signerPublication =
      canonicalSignerPublication(write.signerPublication).publication;
    if (
      intended.runtime.agentId !== expected.runtime.agentId
      || intended.runtime.authorizationRevision
        !== expected.runtime.authorizationRevision + 1
      || intended.runtime.runtimeGeneration
        !== expected.runtime.runtimeGeneration
    ) {
      throw new Error(
        "Agent Runtime authorization transition requires one exact authorization advance and no generation change",
      );
    }
    if (
      !valueEqual(expected.configInventory, intended.configInventory)
      || !valueEqual(expected.configObjects, intended.configObjects)
    ) {
      throw new Error(
        "Agent Runtime authorization transition must preserve exact config",
      );
    }
    const refreshed = new Set(write.authorization.refreshedDomainIds);
    const expectedByDomain = new Map(
      expected.domainEnvelopes.map((entry) => [entry.domainId, entry]),
    );
    if (
      refreshed.size !== write.authorization.refreshedDomainIds.length
      || intended.domainEnvelopes.some((entry) => {
        const prior = expectedByDomain.get(entry.domainId);
        return (
          prior === undefined || !valueEqual(prior, entry)
        ) !== refreshed.has(entry.domainId);
      })
      || write.authorization.refreshedDomainIds.some((domainId) =>
        !intended.domainEnvelopes.some((entry) =>
          entry.domainId === domainId
        )
      )
    ) {
      throw new Error(
        "Agent Runtime authorization transition refresh set is not exact",
      );
    }
    const newlyConsumed =
      expected.challengeConsumptions.reduce((count, challenge, index) => {
        const next = intended.challengeConsumptions[index];
        return count + (
            next !== undefined
            && !challenge.consumed
            && next.consumed
          ? 1
          : 0
        );
      }, 0);
    if (
      expected.challengeConsumptions.length
        !== intended.challengeConsumptions.length
      || newlyConsumed !== write.authorization.refreshedDomainIds.length
      || expected.challengeConsumptions.some((challenge, index) => {
        const next = intended.challengeConsumptions[index]!;
        return !bytesEqual(challenge.challengeHash, next.challengeHash)
          || (challenge.consumed && !next.consumed);
      })
    ) {
      throw new Error(
        "Agent Runtime authorization transition challenge set is not exact",
      );
    }
    return this.handle.transaction(async (transaction) => {
      const current = await getRuntime(
        transaction,
        expected.runtime.agentId,
        true,
      );
      const currentSignerPublication =
        await getRuntimeSignerPublication(
          transaction,
          expected.runtime.agentId,
          expected.runtime.runtimeGeneration,
        );
      if (
        currentSignerPublication === null
        || !signerPublicationsEqual(
          currentSignerPublication,
          signerPublication,
        )
      ) {
        return "stale";
      }
      if (current !== null && valueEqual(current, intended)) {
        return "duplicate";
      }
      if (current === null || !valueEqual(current, expected)) {
        return "stale";
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(agentCryptoRuntimeStates).set({
          authorizationRevision: intended.runtime.authorizationRevision,
          runtimeGeneration: intended.runtime.runtimeGeneration,
          configObjectCount: intended.configInventory.objectCount,
          configInventoryDigest: intended.configInventory.digest,
        }).where(eq(
          agentCryptoRuntimeStates.agentId,
          intended.runtime.agentId,
        )),
      );
      await replaceRuntimeChildren(transaction, intended);
      return "applied";
    });
  }

  async putGrant(input: Parameters<LatticeStorage["putGrant"]>[0]): Promise<void> {
    const grant = storageAdapterSupportV2.validateGrant(input);
    if (grant.consumed) {
      throw new Error("A newly persisted Grant must be unconsumed");
    }
    await this.handle.transaction(async (transaction) => {
      await lockEntity(transaction, "grant", grant.grantId);
      const rows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          grant_id: cryptoGrants.grantId,
          grant_bytes: cryptoGrants.grantBytes,
          consumed: cryptoGrants.consumed,
        }).from(cryptoGrants).where(eq(
          cryptoGrants.grantId,
          grant.grantId,
        )).limit(2).for("update"),
      );
      const row = oneOrNull(rows, "Grant insert lookup");
      if (row !== null) {
        const existing = grantFromRow(row);
        if (existing.consumed || !valueEqual(existing, grant)) {
          throw new Error(
            "Grant record is already initialized with different or consumed state",
          );
        }
        return;
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(cryptoGrants).values({
          grantId: grant.grantId,
          grantBytes: grant.grantBytes,
          consumed: false,
        }),
      );
    });
  }

  async getGrant(grantId: string): Promise<GrantWireRecordV2 | null> {
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        grant_id: cryptoGrants.grantId,
        grant_bytes: cryptoGrants.grantBytes,
        consumed: cryptoGrants.consumed,
      }).from(cryptoGrants).where(eq(cryptoGrants.grantId, grantId)).limit(2),
    );
    const row = oneOrNull(rows, "Grant lookup");
    return row === null ? null : grantFromRow(row);
  }

  async consumeGrant(grantId: string): Promise<GrantWireRecordV2 | null> {
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.update(cryptoGrants).set({ consumed: true }).where(and(
        eq(cryptoGrants.grantId, grantId),
        eq(cryptoGrants.consumed, false),
      )).returning({
        grant_id: cryptoGrants.grantId,
        grant_bytes: cryptoGrants.grantBytes,
        consumed: cryptoGrants.consumed,
      }),
    );
    const row = oneOrNull(rows, "Grant consumption");
    return row === null ? null : grantFromRow(row);
  }

  async compareAndSwapRecoveryArchive(
    expected: Parameters<
      LatticeStorage["compareAndSwapRecoveryArchive"]
    >[0],
    intendedInput: Parameters<
      LatticeStorage["compareAndSwapRecoveryArchive"]
    >[1],
  ): Promise<"applied" | "duplicate" | "stale"> {
    const intended =
      storageAdapterSupportV2.validateRecoveryArchive(intendedInput);
    const detachedExpected = expected === null
      ? null
      : storageAdapterSupportV2.validateRecoveryArchiveExpectation(expected);
    return this.handle.transaction(async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [intended.humanId],
      );
      const rows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          human_id: humanCryptoRecoveryArchives.humanId,
          recovery_key_generation:
            humanCryptoRecoveryArchives.recoveryKeyGeneration,
          archive_hash: humanCryptoRecoveryArchives.archiveHash,
          archive_bytes: humanCryptoRecoveryArchives.archiveBytes,
        }).from(humanCryptoRecoveryArchives).where(eq(
          humanCryptoRecoveryArchives.humanId,
          intended.humanId,
        )).limit(2).for("update"),
      );
      const row = oneOrNull(rows, "Recovery archive CAS lookup");
      const current = row === null ? null : validatedRecoveryFromRow(row);
      if (
        current !== null
        && bytesEqual(current.archiveBytes, intended.archiveBytes)
      ) {
        return "duplicate";
      }
      if (detachedExpected === null) {
        if (current !== null) return "stale";
      } else if (
        detachedExpected.humanId !== intended.humanId
        || current === null
        || current.recoveryKeyGeneration
          !== detachedExpected.recoveryKeyGeneration
        || !bytesEqual(
          sha256(current.archiveBytes),
          detachedExpected.archiveHash,
        )
        || intended.recoveryKeyGeneration
          !== detachedExpected.recoveryKeyGeneration + 1
      ) {
        return "stale";
      }
      if (current === null) {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.insert(humanCryptoRecoveryArchives).values({
            humanId: intended.humanId,
            recoveryKeyGeneration: intended.recoveryKeyGeneration,
            archiveHash: sha256(intended.archiveBytes),
            archiveBytes: intended.archiveBytes,
          }),
        );
      } else {
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(humanCryptoRecoveryArchives).set({
            recoveryKeyGeneration: intended.recoveryKeyGeneration,
            archiveHash: sha256(intended.archiveBytes),
            archiveBytes: intended.archiveBytes,
          }).where(eq(
            humanCryptoRecoveryArchives.humanId,
            intended.humanId,
          )),
        );
      }
      return "applied";
    });
  }

  async getRecoveryArchive(
    humanId: string,
  ): Promise<RecoveryArchiveWireRecordV2 | null> {
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        human_id: humanCryptoRecoveryArchives.humanId,
        recovery_key_generation:
          humanCryptoRecoveryArchives.recoveryKeyGeneration,
        archive_hash: humanCryptoRecoveryArchives.archiveHash,
        archive_bytes: humanCryptoRecoveryArchives.archiveBytes,
      }).from(humanCryptoRecoveryArchives).where(eq(
        humanCryptoRecoveryArchives.humanId,
        humanId,
      )).limit(2),
    );
    const row = oneOrNull(rows, "Recovery archive lookup");
    return row === null ? null : validatedRecoveryFromRow(row);
  }
}

export function createPostgresLatticeStorage(
  handle: CryptoPostgresHandle,
): LatticeStorage {
  return new PostgresLatticeStorage(handle);
}
