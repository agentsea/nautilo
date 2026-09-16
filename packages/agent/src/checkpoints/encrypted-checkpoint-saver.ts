import { isDeepStrictEqual } from "node:util";

import {
  BaseCheckpointSaver,
  MemorySaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { RunnableConfig } from "@langchain/core/runnables";
import type pg from "pg";
import { buildCompactionQueries } from "./checkpoint-compaction.js";

const INLINE_CELL_TYPE = "nautilo.encrypted-checkpoint-cell.v1";
const INLINE_CELL_MARKER = "$nautiloCheckpointCell";
const INLINE_CELL_VERSION = 1;
const ENVELOPE_VERSION = 1;
const MAX_INLINE_CIPHERTEXT_BYTES = 64 * 1024 * 1024;
const SERIALIZED_VALUE_MAGIC = 0x4e435031;
const SERIALIZED_VALUE_HEADER_BYTES = 12;
const MAX_SERIALIZER_TYPE_BYTES = 1_024;
const MAX_POSTGRES_STATEMENT_TIMEOUT_MS = 2_147_483_647;
export const ENCRYPTED_CHECKPOINT_LIST_DEFAULT_LIMIT = 20;
export const ENCRYPTED_CHECKPOINT_LIST_MAX_LIMIT = 100;

const SHADOW_THREAD_PREFIX = "nautilo:encrypted-checkpoint-shadow:v1:";
const SHADOW_NAMESPACE_PREFIX = "nautilo:encrypted-checkpoint-shadow:v1:";

const CHECKPOINT_FIELDS = [
  "channel_values",
  "channel_versions",
  "id",
  "ts",
  "v",
  "versions_seen",
] as const;

const RESERVED_WRITE_INDICES: Readonly<Record<string, number>> = Object.freeze({
  __error__: -1,
  __scheduled__: -2,
  __interrupt__: -3,
  __resume__: -4,
});

type CheckpointListOptions = Parameters<PostgresSaver["list"]>[1];
type ChannelVersions = Parameters<PostgresSaver["put"]>[3];
type PendingWrite = Parameters<PostgresSaver["putWrites"]>[1][number];

export type CheckpointCellCoordinate =
  | Readonly<{
      kind: "metadata";
      threadId: string;
      checkpointNs: string;
      checkpointId: string;
      parentCheckpointId: string | null;
    }>
  | Readonly<{
      kind: "channel";
      threadId: string;
      checkpointNs: string;
      channel: string;
      version: string;
    }>
  | Readonly<{
      kind: "write";
      threadId: string;
      checkpointNs: string;
      checkpointId: string;
      taskId: string;
      index: number;
      channel: string;
    }>;

/**
 * Invocation-bound authorization context. The opaque session is a live
 * process-local capability/view, never persisted as checkpoint state.
 */
export type CheckpointInvocationScope = Readonly<{
  logicalThreadId: string;
  namespaceId: string;
  keyClass: "ai";
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  authorizationSession: unknown;
}>;

export type CheckpointAuthorizationOperation =
  | "read"
  | "write"
  | "delete"
  | "cleanup";

export type CheckpointAuthorizedOperationContext = Readonly<{
  /**
   * Aborts on any mid-operation authority loss, including cancellation,
   * revocation, revision/policy drift, or the authority-owned deadline.
   */
  signal: AbortSignal;
  /**
   * Authority-owned live check. Agent must not compare a foreign wall clock.
   * This throws after cancellation, expiry, revision drift, or policy loss.
   */
  assertActive(): void;
  /**
   * Fresh authority/head fence executed inside the still-open PostgreSQL
   * transaction immediately before COMMIT. Success means authority was valid
   * at that fresh observation point; because product authority and checkpoint
   * storage use separate transactions, it does not claim atomic ordering
   * against a revocation committed after the observation.
   */
  assertCommitAllowed(): Promise<void>;
  /**
   * Authority-owned remaining operation time. It must be a positive bounded
   * integer and may shrink between calls.
   */
  remainingMs(): number;
}>;

/**
 * Bridge-owned authorization and byte-cryptography boundary.
 *
 * Agent owns the official LangGraph serialization/revival step. Bridge
 * receives only bytes plus the explicit live invocation scope and exact
 * physical Postgres coordinate.
 */
export interface CheckpointCellCrypto {
  /**
   * Run one operation under Bridge-owned authority. The implementation must
   * call context.assertActive() after `execute` resolves and before it records
   * or returns successful completion.
   */
  executeAuthorizedOperation<Value>(input: Readonly<{
    operation: CheckpointAuthorizationOperation;
    scope: CheckpointInvocationScope;
    execute: (
      context: CheckpointAuthorizedOperationContext,
    ) => Promise<Value>;
  }>): Promise<Value>;
  seal(input: Readonly<{
    scope: CheckpointInvocationScope;
    coordinate: CheckpointCellCoordinate;
    plaintext: Uint8Array;
    signal: AbortSignal;
  }>): Promise<Uint8Array>;
  open(input: Readonly<{
    scope: CheckpointInvocationScope;
    coordinate: CheckpointCellCoordinate;
    ciphertext: Uint8Array;
    signal: AbortSignal;
  }>): Promise<Uint8Array>;
}

type InlineCheckpointCell = Readonly<{
  $nautiloCheckpointCell: 1;
  ciphertext: string;
}>;

type SerializerProtocol = Readonly<{
  dumpsTyped(data: unknown): Promise<[string, Uint8Array]>;
  loadsTyped(type: string, data: Uint8Array | string): Promise<unknown>;
}>;

type StorageCoordinate = Readonly<{
  threadId: string;
  checkpointNs: string;
  checkpointId?: string;
}>;

export type CheckpointWriteCoordinate = Readonly<{
  taskId: string;
  index: number;
  channel: string;
}>;

export interface CheckpointWriteCoordinateReader {
  readPendingWriteCoordinates(input: Readonly<{
    threadId: string;
    checkpointNs: string;
    checkpointId: string;
  }>): Promise<readonly CheckpointWriteCoordinate[]>;
}

type MetadataStructure = Readonly<{
  v: number;
  id: string;
  ts: string;
  channelVersions: Record<string, number | string>;
  versionsSeen: Record<string, Record<string, number | string>>;
  parentCheckpointId: string | null;
}>;

type MetadataEnvelope = Readonly<{
  version: 1;
  metadata: unknown;
  structure: MetadataStructure;
}>;

type ChannelEnvelope =
  | Readonly<{ version: 1; state: "empty" }>
  | Readonly<{ version: 1; state: "value"; value: unknown }>;

type WriteEnvelope = Readonly<{
  version: 1;
  value: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function decodeStrictBase64(value: string): Uint8Array {
  if (
    value.length === 0
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("malformed encrypted checkpoint cell");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength === 0
    || decoded.byteLength > MAX_INLINE_CIPHERTEXT_BYTES
    || decoded.toString("base64") !== value
  ) {
    throw new Error("malformed encrypted checkpoint cell");
  }
  return new Uint8Array(decoded);
}

function parseInlineCell(value: unknown): InlineCheckpointCell {
  if (!isRecord(value)) {
    throw new Error("expected an opaque encrypted checkpoint cell");
  }
  if (
    !hasExactKeys(value, [INLINE_CELL_MARKER, "ciphertext"])
    || value[INLINE_CELL_MARKER] !== INLINE_CELL_VERSION
    || typeof value["ciphertext"] !== "string"
  ) {
    throw new Error("malformed encrypted checkpoint cell");
  }
  decodeStrictBase64(value["ciphertext"]);
  return value as InlineCheckpointCell;
}

/**
 * Strict serializer for the pinned PostgresSaver.
 *
 * It intentionally understands only the already-encrypted inline cell. Any
 * accidental plaintext value reaching the saver is rejected before SQL.
 */
export class InlineCheckpointCellSerializer implements SerializerProtocol {
  dumpsTyped(data: unknown): Promise<[string, Uint8Array]> {
    let cell: InlineCheckpointCell;
    try {
      cell = parseInlineCell(data);
    } catch {
      return Promise.reject(
        new Error(
          "PostgresSaver received a value that is not an opaque encrypted checkpoint cell",
        ),
      );
    }
    return Promise.resolve([
      INLINE_CELL_TYPE,
      new TextEncoder().encode(JSON.stringify(cell)),
    ]);
  }

  loadsTyped(
    type: string,
    data: Uint8Array | string,
  ): Promise<unknown> {
    if (type !== INLINE_CELL_TYPE) {
      return Promise.reject(
        new Error(`unexpected encrypted checkpoint cell type: ${type}`),
      );
    }
    let parsed: unknown;
    try {
      const json = typeof data === "string"
        ? data
        : new TextDecoder("utf-8", { fatal: true }).decode(data);
      parsed = JSON.parse(json);
    } catch {
      return Promise.reject(
        new Error("malformed encrypted checkpoint cell"),
      );
    }
    try {
      return Promise.resolve(parseInlineCell(parsed));
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("malformed encrypted checkpoint cell"),
      );
    }
  }
}

function createLangGraphValueSerializer(): SerializerProtocol {
  return new MemorySaver().serde;
}

async function serializeLangGraphValue(
  serializer: SerializerProtocol,
  value: unknown,
): Promise<Uint8Array> {
  let payload: Uint8Array | undefined;
  let typeBytes: Uint8Array | undefined;
  try {
    const [type, dumped] = await serializer.dumpsTyped(value);
    payload = dumped;
    typeBytes = new TextEncoder().encode(type);
    if (
      typeBytes.byteLength === 0
      || typeBytes.byteLength > MAX_SERIALIZER_TYPE_BYTES
      || payload.byteLength > MAX_INLINE_CIPHERTEXT_BYTES
    ) {
      throw new Error("LangGraph checkpoint serialization is malformed");
    }
    const framed = new Uint8Array(
      SERIALIZED_VALUE_HEADER_BYTES
      + typeBytes.byteLength
      + payload.byteLength,
    );
    const header = new DataView(
      framed.buffer,
      framed.byteOffset,
      SERIALIZED_VALUE_HEADER_BYTES,
    );
    header.setUint32(0, SERIALIZED_VALUE_MAGIC);
    header.setUint32(4, typeBytes.byteLength);
    header.setUint32(8, payload.byteLength);
    framed.set(typeBytes, SERIALIZED_VALUE_HEADER_BYTES);
    framed.set(
      payload,
      SERIALIZED_VALUE_HEADER_BYTES + typeBytes.byteLength,
    );
    return framed;
  } finally {
    typeBytes?.fill(0);
    payload?.fill(0);
  }
}

async function deserializeLangGraphValue(
  serializer: SerializerProtocol,
  plaintext: Uint8Array,
): Promise<unknown> {
  if (plaintext.byteLength < SERIALIZED_VALUE_HEADER_BYTES) {
    throw new Error("encrypted LangGraph checkpoint value is malformed");
  }
  const header = new DataView(
    plaintext.buffer,
    plaintext.byteOffset,
    SERIALIZED_VALUE_HEADER_BYTES,
  );
  const typeLength = header.getUint32(4);
  const payloadLength = header.getUint32(8);
  if (
    header.getUint32(0) !== SERIALIZED_VALUE_MAGIC
    || typeLength === 0
    || typeLength > MAX_SERIALIZER_TYPE_BYTES
    || payloadLength > MAX_INLINE_CIPHERTEXT_BYTES
    || SERIALIZED_VALUE_HEADER_BYTES + typeLength + payloadLength
      !== plaintext.byteLength
  ) {
    throw new Error("encrypted LangGraph checkpoint value is malformed");
  }
  const typeBytes = plaintext.slice(
    SERIALIZED_VALUE_HEADER_BYTES,
    SERIALIZED_VALUE_HEADER_BYTES + typeLength,
  );
  const payload = plaintext.slice(
    SERIALIZED_VALUE_HEADER_BYTES + typeLength,
  );
  try {
    const type = new TextDecoder("utf-8", { fatal: true }).decode(typeBytes);
    return await serializer.loadsTyped(type, payload);
  } catch {
    throw new Error("encrypted LangGraph checkpoint value is malformed");
  } finally {
    typeBytes.fill(0);
    payload.fill(0);
  }
}

function encodeShadowPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeShadowPart(value: string, prefix: string): string {
  if (!value.startsWith(prefix)) {
    throw new Error("checkpoint row is outside the encrypted shadow coordinate");
  }
  const encoded = value.slice(prefix.length);
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("encrypted checkpoint shadow coordinate is malformed");
  }
  if (encodeShadowPart(decoded) !== encoded) {
    throw new Error("encrypted checkpoint shadow coordinate is malformed");
  }
  return decoded;
}

function shadowThreadId(threadId: string): string {
  return `${SHADOW_THREAD_PREFIX}${encodeShadowPart(threadId)}`;
}

function shadowCheckpointNs(checkpointNs: string): string {
  return `${SHADOW_NAMESPACE_PREFIX}${encodeShadowPart(checkpointNs)}`;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`encrypted checkpoint config requires ${name}`);
  }
  return value;
}

function assertAuthorizedOperationIsActive(
  context: CheckpointAuthorizedOperationContext,
): number {
  if (
    !isRecord(context)
    || !isRecord(context.signal)
    || typeof context.signal.addEventListener !== "function"
    || typeof context.signal.removeEventListener !== "function"
    || typeof context.assertActive !== "function"
    || typeof context.assertCommitAllowed !== "function"
    || typeof context.remainingMs !== "function"
  ) {
    throw new Error("checkpoint authorization context is malformed");
  }
  context.assertActive();
  const remainingMs = context.remainingMs();
  if (
    !Number.isSafeInteger(remainingMs)
    || remainingMs <= 0
    || remainingMs > MAX_POSTGRES_STATEMENT_TIMEOUT_MS
  ) {
    throw new Error(
      "checkpoint authorization remaining time is malformed",
    );
  }
  context.assertActive();
  return remainingMs;
}

function authorizedOperationInactiveError(
  context: CheckpointAuthorizedOperationContext,
): Error {
  try {
    context.assertActive();
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error("authorized checkpoint operation is no longer active");
  }
  return new Error("authorized checkpoint operation is no longer active");
}

async function raceAuthorizedWork<Value>(
  context: CheckpointAuthorizedOperationContext,
  start: () => Promise<Value>,
  options: Readonly<{
    onAuthorityLoss?: () => void;
    onLateSuccess?: (value: Value) => void;
  }> = {},
): Promise<Value> {
  const remainingMs = assertAuthorizedOperationIsActive(context);
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const rejectionError = (error: unknown): Error =>
      error instanceof Error
        ? error
        : new Error("authorized checkpoint operation failed");

    const cleanup = (): void => {
      context.signal.removeEventListener("abort", loseAuthority);
      clearTimeout(timer);
    };
    const loseAuthority = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        options.onAuthorityLoss?.();
      } catch {
        // The authority failure remains the primary error.
      }
      reject(authorizedOperationInactiveError(context));
    };

    context.signal.addEventListener("abort", loseAuthority, { once: true });
    const timer = setTimeout(loseAuthority, remainingMs);

    let work: Promise<Value>;
    try {
      work = start();
    } catch (error) {
      settled = true;
      cleanup();
      reject(rejectionError(error));
      return;
    }
    void work.then(
      (value) => {
        if (settled) {
          try {
            options.onLateSuccess?.(value);
          } catch {
            // Late work is contained and never re-enters the operation.
          }
          return;
        }
        try {
          context.assertActive();
        } catch {
          try {
            options.onLateSuccess?.(value);
          } catch {
            // Authority loss remains the primary error.
          }
          loseAuthority();
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(rejectionError(error));
      },
    );
  });
}

function readLogicalCoordinate(
  config: RunnableConfig,
  options: { checkpointId?: "required" | "optional" } = {},
): StorageCoordinate {
  if (!isRecord(config.configurable)) {
    throw new Error("encrypted checkpoint config requires configurable");
  }
  const threadId = requireNonEmptyString(
    config.configurable["thread_id"],
    "thread_id",
  );
  const checkpointNs = config.configurable["checkpoint_ns"] ?? "";
  if (typeof checkpointNs !== "string") {
    throw new Error("encrypted checkpoint config requires string checkpoint_ns");
  }
  const checkpointId = config.configurable["checkpoint_id"];
  if (
    checkpointId !== undefined
    && (typeof checkpointId !== "string" || checkpointId.length === 0)
  ) {
    throw new Error(
      "encrypted checkpoint config requires string checkpoint_id",
    );
  }
  if (options.checkpointId === "required" && checkpointId === undefined) {
    throw new Error("encrypted checkpoint config requires checkpoint_id");
  }
  return {
    threadId,
    checkpointNs,
    ...(checkpointId === undefined ? {} : { checkpointId }),
  };
}

function readShadowCoordinate(
  config: RunnableConfig,
  options: { checkpointId?: "required" | "optional" } = {},
): StorageCoordinate {
  const shadow = readLogicalCoordinate(config, options);
  return {
    threadId: shadow.threadId,
    checkpointNs: shadow.checkpointNs,
    ...(shadow.checkpointId === undefined
      ? {}
      : { checkpointId: shadow.checkpointId }),
  };
}

function toShadowConfig(config: RunnableConfig): RunnableConfig {
  const logical = readLogicalCoordinate(config);
  return {
    ...config,
    configurable: {
      ...config.configurable,
      thread_id: shadowThreadId(logical.threadId),
      checkpoint_ns: shadowCheckpointNs(logical.checkpointNs),
      ...(logical.checkpointId === undefined
        ? {}
        : { checkpoint_id: logical.checkpointId }),
    },
  };
}

function fromShadowConfig(config: RunnableConfig): RunnableConfig {
  const storage = readShadowCoordinate(config);
  return {
    ...config,
    configurable: {
      ...config.configurable,
      thread_id: decodeShadowPart(storage.threadId, SHADOW_THREAD_PREFIX),
      checkpoint_ns: decodeShadowPart(
        storage.checkpointNs,
        SHADOW_NAMESPACE_PREFIX,
      ),
      ...(storage.checkpointId === undefined
        ? {}
        : { checkpoint_id: storage.checkpointId }),
    },
  };
}

function isChannelVersion(value: unknown): value is number | string {
  return (
    typeof value === "string" && value.length > 0
  ) || (
    typeof value === "number" && Number.isFinite(value)
  );
}

function validateVersionMap(
  value: unknown,
  label: string,
): asserts value is Record<string, number | string> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a record`);
  }
  for (const [key, version] of Object.entries(value)) {
    if (key.length === 0 || !isChannelVersion(version)) {
      throw new Error(`${label} contains an invalid channel version`);
    }
  }
}

function validateCheckpoint(
  checkpoint: Checkpoint,
  options: Readonly<{ allowUnversionedValues?: true }> = {},
): asserts checkpoint is Checkpoint {
  if (
    !isRecord(checkpoint)
    || !hasExactKeys(checkpoint, CHECKPOINT_FIELDS)
  ) {
    throw new Error(
      "encrypted checkpoints require the exact v4 field allowlist",
    );
  }
  if (
    checkpoint.v !== 4
    || typeof checkpoint.id !== "string"
    || checkpoint.id.length === 0
    || typeof checkpoint.ts !== "string"
    || checkpoint.ts.length === 0
    || !isRecord(checkpoint.channel_values)
  ) {
    throw new Error("encrypted checkpoint v4 structure is malformed");
  }
  validateVersionMap(
    checkpoint.channel_versions,
    "checkpoint.channel_versions",
  );
  if (!isRecord(checkpoint.versions_seen)) {
    throw new Error("checkpoint.versions_seen must be a record");
  }
  for (const versions of Object.values(checkpoint.versions_seen)) {
    validateVersionMap(versions, "checkpoint.versions_seen");
  }
  for (const channel of Object.keys(checkpoint.channel_values)) {
    if (
      !options.allowUnversionedValues
      && !Object.hasOwn(checkpoint.channel_versions, channel)
    ) {
      throw new Error(
        "checkpoint.channel_values contains a channel without a version",
      );
    }
  }
}

function validateNewVersions(
  checkpoint: Checkpoint,
  newVersions: ChannelVersions,
): void {
  validateVersionMap(newVersions, "newVersions");
  for (const [channel, version] of Object.entries(newVersions)) {
    if (
      !Object.hasOwn(checkpoint.channel_versions, channel)
      || checkpoint.channel_versions[channel] !== version
    ) {
      throw new Error(
        "newVersions must exactly match checkpoint.channel_versions",
      );
    }
  }
}

function validatePendingWrites(writes: unknown): asserts writes is PendingWrite[] {
  if (!Array.isArray(writes)) {
    throw new Error("encrypted checkpoint writes must be an array");
  }
  for (const write of writes) {
    if (
      !Array.isArray(write)
      || write.length !== 2
      || typeof write[0] !== "string"
      || write[0].length === 0
    ) {
      throw new Error("encrypted checkpoint writes require a channel");
    }
  }
}

function metadataStructure(
  checkpoint: Checkpoint,
  parentCheckpointId: string | null,
): MetadataStructure {
  return {
    v: checkpoint.v,
    id: checkpoint.id,
    ts: checkpoint.ts,
    channelVersions: checkpoint.channel_versions,
    versionsSeen: checkpoint.versions_seen,
    parentCheckpointId,
  };
}

function inlineCell(
  ciphertext: Uint8Array,
): InlineCheckpointCell {
  if (
    ciphertext.byteLength === 0
    || ciphertext.byteLength > MAX_INLINE_CIPHERTEXT_BYTES
  ) {
    throw new Error("checkpoint crypto returned invalid ciphertext");
  }
  return {
    $nautiloCheckpointCell: INLINE_CELL_VERSION,
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  };
}

function ciphertextFromCell(cell: InlineCheckpointCell): Uint8Array {
  return decodeStrictBase64(cell.ciphertext);
}

function parseMetadataEnvelope(value: unknown): MetadataEnvelope {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["version", "metadata", "structure"])
    || value["version"] !== ENVELOPE_VERSION
    || !isRecord(value["structure"])
  ) {
    throw new Error("encrypted checkpoint metadata envelope is malformed");
  }
  return value as MetadataEnvelope;
}

function parseChannelEnvelope(value: unknown): ChannelEnvelope {
  if (
    !isRecord(value)
    || value["version"] !== ENVELOPE_VERSION
    || (
      value["state"] === "empty"
        ? !hasExactKeys(value, ["version", "state"])
        : (
            value["state"] !== "value"
            || !hasExactKeys(value, ["version", "state", "value"])
          )
    )
  ) {
    throw new Error("encrypted checkpoint channel envelope is malformed");
  }
  return value as ChannelEnvelope;
}

function parseWriteEnvelope(value: unknown): WriteEnvelope {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["version", "value"])
    || value["version"] !== ENVELOPE_VERSION
  ) {
    throw new Error("encrypted checkpoint write envelope is malformed");
  }
  return value as WriteEnvelope;
}

function writeIndex(channel: string, arrayIndex: number): number {
  return RESERVED_WRITE_INDICES[channel] ?? arrayIndex;
}

const READ_PENDING_WRITE_COORDINATES_SQL = `
SELECT task_id, idx, channel
FROM langchain.checkpoint_writes
WHERE thread_id = $1
  AND checkpoint_ns = $2
  AND checkpoint_id = $3
ORDER BY task_id, idx`;

/** @internal Exported for direct fixed-schema query characterization. */
export class PostgresCheckpointWriteCoordinateReader
implements CheckpointWriteCoordinateReader {
  constructor(readonly pool: pg.Pool) {}

  async readPendingWriteCoordinates(input: {
    threadId: string;
    checkpointNs: string;
    checkpointId: string;
  }): Promise<readonly CheckpointWriteCoordinate[]> {
    const result = await this.pool.query(
      READ_PENDING_WRITE_COORDINATES_SQL,
      [input.threadId, input.checkpointNs, input.checkpointId],
    );
    const coordinates: CheckpointWriteCoordinate[] = [];
    const seen = new Set<string>();
    for (const row of result.rows as unknown[]) {
      if (
        !isRecord(row)
        || typeof row["task_id"] !== "string"
        || row["task_id"].length === 0
        || typeof row["idx"] !== "number"
        || !Number.isSafeInteger(row["idx"])
        || typeof row["channel"] !== "string"
        || row["channel"].length === 0
      ) {
        throw new Error(
          "physical checkpoint write coordinate row is malformed",
        );
      }
      const uniquenessKey = `${row["task_id"]}\0${row["idx"]}`;
      if (seen.has(uniquenessKey)) {
        throw new Error(
          "physical checkpoint write coordinates contain a duplicate",
        );
      }
      seen.add(uniquenessKey);
      coordinates.push({
        taskId: row["task_id"],
        index: row["idx"],
        channel: row["channel"],
      });
    }
    return coordinates;
  }
}

type CheckpointPgResult = Readonly<{ rows: unknown[] }>;

interface CheckpointPgClient {
  query(text: string, params?: unknown[]): Promise<CheckpointPgResult>;
  release(error?: Error | boolean): void;
}

interface CheckpointPgPool {
  connect(): Promise<CheckpointPgClient>;
}

type TransactionState =
  | "idle"
  | "active"
  | "rollback-pending"
  | "rolled-back"
  | "committed"
  | "destroyed";

class OperationBoundCheckpointClient {
  readonly #client: CheckpointPgClient;
  readonly #context: CheckpointAuthorizedOperationContext;
  #state: TransactionState = "idle";
  #rollback: Promise<CheckpointPgResult> | undefined;
  #released = false;

  constructor(
    client: CheckpointPgClient,
    context: CheckpointAuthorizedOperationContext,
  ) {
    this.#client = client;
    this.#context = context;
    this.#context.signal.addEventListener("abort", this.#onAbort, {
      once: true,
    });
  }

  readonly #onAbort = (): void => {
    this.#destroy();
  };

  #assertActive(): number {
    return assertAuthorizedOperationIsActive(this.#context);
  }

  async #setLocalStatementTimeout(): Promise<void> {
    const remainingMs = this.#assertActive();
    await this.#rawQuery(
      `SET LOCAL statement_timeout = ${remainingMs}`,
    );
    this.#assertActive();
  }

  #destroy(): void {
    if (this.#released) return;
    this.#state = "destroyed";
    this.#released = true;
    this.#context.signal.removeEventListener("abort", this.#onAbort);
    this.#client.release(true);
  }

  #rawQuery(
    text: string,
    params?: unknown[],
  ): Promise<CheckpointPgResult> {
    if (this.#state === "destroyed") {
      return Promise.reject(
        new Error("authorized checkpoint operation is no longer active"),
      );
    }
    return raceAuthorizedWork(
      this.#context,
      () => this.#client.query(text, params),
      {
      onAuthorityLoss: () => this.#destroy(),
      },
    );
  }

  #forceRollback(): Promise<CheckpointPgResult> {
    if (this.#rollback !== undefined) return this.#rollback;
    if (
      this.#state === "committed"
      || this.#state === "rolled-back"
      || this.#state === "destroyed"
    ) {
      return Promise.resolve({ rows: [] });
    }
    this.#state = "rollback-pending";
    this.#rollback = this.#rawQuery("ROLLBACK").then(
      (result) => {
        if (this.#state !== "destroyed") this.#state = "rolled-back";
        return result;
      },
      (error: unknown) => {
        if (this.#state !== "destroyed") this.#state = "rolled-back";
        throw error;
      },
    );
    return this.#rollback;
  }

  async query(
    text: string,
    params?: unknown[],
  ): Promise<CheckpointPgResult> {
    const command = text.trim().toUpperCase();
    if (command === "ROLLBACK") {
      return this.#forceRollback();
    }
    if (command === "BEGIN") {
      this.#assertActive();
      if (this.#state !== "idle") {
        throw new Error("checkpoint transaction has already started");
      }
      const result = await this.#rawQuery(text, params);
      this.#state = "active";
      try {
        this.#assertActive();
      } catch (error) {
        await this.#forceRollback().catch(() => undefined);
        throw error;
      }
      return result;
    }
    if (command === "COMMIT") {
      if (this.#state !== "active") {
        await this.#forceRollback().catch(() => undefined);
        this.#assertActive();
        throw new Error("checkpoint transaction is no longer committable");
      }
      try {
        await this.#setLocalStatementTimeout();
        this.#assertActive();
        await raceAuthorizedWork(
          this.#context,
          () => this.#context.assertCommitAllowed(),
        );
        this.#assertActive();
      } catch (error) {
        await this.#forceRollback().catch(() => undefined);
        throw error;
      }
      const result = await this.#rawQuery(text, params);
      this.#state = "committed";
      return result;
    }
    if (this.#state !== "active") {
      throw new Error(
        "checkpoint query requires an operation-bound transaction",
      );
    }
    await this.#setLocalStatementTimeout();
    this.#assertActive();
    const result = await this.#rawQuery(text, params);
    this.#assertActive();
    return result;
  }

  release(error?: Error | boolean): void {
    if (this.#released) return;
    this.#released = true;
    this.#context.signal.removeEventListener("abort", this.#onAbort);
    if (
      this.#state === "active"
      || this.#state === "rollback-pending"
    ) {
      this.#state = "destroyed";
      this.#client.release(error ?? true);
      return;
    }
    this.#client.release(error);
  }
}

/**
 * Operation-local pool façade for the pinned PostgresSaver.
 *
 * Every direct read becomes a checked transaction. Every saver transaction
 * receives a server-side statement timeout from the authority-owned remaining
 * duration. Authority loss races both checkout and every socket query,
 * immediately evicts the physical client (letting PostgreSQL roll back its
 * open transaction), and refuses every later COMMIT. Late driver settlement
 * is contained. It deliberately owns no global/AsyncLocalStorage state.
 */
export class OperationBoundCheckpointPool {
  readonly #pool: CheckpointPgPool;
  readonly #context: CheckpointAuthorizedOperationContext;

  constructor(
    pool: pg.Pool,
    context: CheckpointAuthorizedOperationContext,
  ) {
    this.#pool = pool as unknown as CheckpointPgPool;
    this.#context = context;
  }

  async connect(): Promise<OperationBoundCheckpointClient> {
    const client = await raceAuthorizedWork(
      this.#context,
      () => this.#pool.connect(),
      {
        onLateSuccess: (lateClient) => lateClient.release(true),
      },
    );
    return new OperationBoundCheckpointClient(client, this.#context);
  }

  async query(
    text: string,
    params?: unknown[],
  ): Promise<CheckpointPgResult> {
    const client = await this.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(text, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Operation savers never own or close the shared dedicated pool. */
  end(): Promise<void> {
    return Promise.resolve();
  }
}

function validateInvocationScope(
  scope: CheckpointInvocationScope,
): CheckpointInvocationScope {
  if (
    !isRecord(scope)
    || typeof scope.logicalThreadId !== "string"
    || scope.logicalThreadId.length === 0
    || typeof scope.namespaceId !== "string"
    || scope.namespaceId.length === 0
    || scope.keyClass !== "ai"
    || !Number.isSafeInteger(scope.expectedAccessRevision)
    || scope.expectedAccessRevision < 0
    || !Number.isSafeInteger(scope.expectedPolicyRevision)
    || scope.expectedPolicyRevision < 0
    || scope.authorizationSession === undefined
    || scope.authorizationSession === null
  ) {
    throw new Error("encrypted checkpoint invocation scope is malformed");
  }
  return Object.freeze({
    logicalThreadId: scope.logicalThreadId,
    namespaceId: scope.namespaceId,
    keyClass: "ai",
    expectedAccessRevision: scope.expectedAccessRevision,
    expectedPolicyRevision: scope.expectedPolicyRevision,
    authorizationSession: scope.authorizationSession,
  });
}

export type CheckpointOperationStore = Readonly<{
  checkpointStore: PostgresSaver;
  writeCoordinateReader: CheckpointWriteCoordinateReader;
  compact(storageConfig: RunnableConfig): Promise<void>;
}>;

export interface CheckpointOperationStoreFactory {
  readonly serializer: unknown;
  readonly schema: string;
  create(
    context: CheckpointAuthorizedOperationContext,
  ): CheckpointOperationStore;
  end(): Promise<void>;
}

export interface EncryptedCheckpointSaverOptions {
  operationStoreFactory: CheckpointOperationStoreFactory;
  crypto: CheckpointCellCrypto;
  scope: CheckpointInvocationScope;
}

export type EncryptedCheckpointMaintenanceAttempt =
  | "post_put"
  | "explicit_retry";

export type EncryptedCheckpointMaintenanceCoordinate = Readonly<{
  threadId: string;
  checkpointNs: string;
  retainedCheckpointId: string;
}>;

export class EncryptedCheckpointMaintenanceError extends Error {
  readonly code = "encrypted_checkpoint_compaction_failed";
  readonly attempt: EncryptedCheckpointMaintenanceAttempt;
  readonly coordinate: EncryptedCheckpointMaintenanceCoordinate;

  constructor(input: Readonly<{
    attempt: EncryptedCheckpointMaintenanceAttempt;
    coordinate: EncryptedCheckpointMaintenanceCoordinate;
    cause: unknown;
  }>) {
    super("encrypted checkpoint compaction failed", {
      cause: input.cause,
    });
    this.name = "EncryptedCheckpointMaintenanceError";
    this.attempt = input.attempt;
    this.coordinate = input.coordinate;
  }
}

export type EncryptedCheckpointMaintenanceOutcome =
  | Readonly<{
      status: "failed";
      error: EncryptedCheckpointMaintenanceError;
    }>
  | Readonly<{
      status: "recovered";
      attempt: EncryptedCheckpointMaintenanceAttempt;
      coordinate: EncryptedCheckpointMaintenanceCoordinate;
    }>;

export type EncryptedCheckpointSaverCloseOutcome =
  | Readonly<{
      status: "closed";
      pendingMaintenanceCount: number;
    }>
  | Readonly<{
      status: "close_failed";
      pendingMaintenanceCount: number;
      error: Error;
    }>;

/**
 * Fail-closed encrypted façade around the pinned PostgresSaver.
 *
 * It writes encrypted inline cells to deterministic shadow thread/namespace
 * coordinates. This keeps the dormant protected writer physically isolated
 * from the existing plaintext authority, including deleteThread().
 */
export class EncryptedCheckpointSaver extends BaseCheckpointSaver {
  readonly #operationStoreFactory: CheckpointOperationStoreFactory;
  readonly #crypto: CheckpointCellCrypto;
  readonly #scope: CheckpointInvocationScope;
  readonly #valueSerializer: SerializerProtocol;
  readonly #liveOperations = new Set<Promise<unknown>>();
  readonly #pendingMaintenance = new Map<string, RunnableConfig>();
  readonly #maintenanceOutcomes:
    EncryptedCheckpointMaintenanceOutcome[] = [];
  #ending: Promise<EncryptedCheckpointSaverCloseOutcome> | null = null;

  constructor(options: EncryptedCheckpointSaverOptions) {
    super(new InlineCheckpointCellSerializer());
    if (
      !(
        options.operationStoreFactory.serializer
        instanceof InlineCheckpointCellSerializer
      )
    ) {
      throw new Error(
        "EncryptedCheckpointSaver requires the strict inline-cell serializer",
      );
    }
    if (options.operationStoreFactory.schema !== "langchain") {
      throw new Error(
        "EncryptedCheckpointSaver requires the fixed langchain schema",
      );
    }
    this.#operationStoreFactory = options.operationStoreFactory;
    this.#crypto = options.crypto;
    this.#scope = validateInvocationScope(options.scope);
    this.#valueSerializer = createLangGraphValueSerializer();
  }

  #assertScopedThread(logicalThreadId: string): void {
    if (logicalThreadId !== this.#scope.logicalThreadId) {
      throw new Error(
        "checkpoint thread does not match invocation scope",
      );
    }
  }

  #executeAuthorizedOperation<Value>(
    operation: CheckpointAuthorizationOperation,
    execute: (
      context: CheckpointAuthorizedOperationContext,
      operationStore: CheckpointOperationStore,
    ) => Promise<Value>,
    allowWhileEnding = false,
  ): Promise<Value> {
    if (this.#ending !== null && !allowWhileEnding) {
      return Promise.reject(
        new Error("encrypted checkpoint saver is closing"),
      );
    }
    const operationPromise = this.#crypto.executeAuthorizedOperation({
      operation,
      scope: this.#scope,
      execute: async (context) => {
        assertAuthorizedOperationIsActive(context);
        const operationStore = this.#operationStoreFactory.create(context);
        if (
          !(
            operationStore.checkpointStore.serde
            instanceof InlineCheckpointCellSerializer
          )
          || (
            operationStore.checkpointStore as unknown as {
              options?: { schema?: unknown };
            }
          ).options?.schema !== "langchain"
        ) {
          throw new Error(
            "checkpoint operation store violates serializer/schema invariants",
          );
        }
        return execute(context, operationStore);
      },
    });
    this.#liveOperations.add(operationPromise);
    void operationPromise.then(
      () => this.#liveOperations.delete(operationPromise),
      () => this.#liveOperations.delete(operationPromise),
    );
    return operationPromise;
  }

  #compact(
    storageConfig: RunnableConfig,
    allowWhileEnding = false,
  ): Promise<void> {
    return this.#executeAuthorizedOperation(
      "cleanup",
      async (context, operationStore) => {
        assertAuthorizedOperationIsActive(context);
        await raceAuthorizedWork(
          context,
          () => operationStore.compact(storageConfig),
        );
        assertAuthorizedOperationIsActive(context);
      },
      allowWhileEnding,
    );
  }

  #maintenanceCoordinate(
    storageConfig: RunnableConfig,
  ): EncryptedCheckpointMaintenanceCoordinate {
    const storage = readShadowCoordinate(storageConfig, {
      checkpointId: "required",
    });
    return Object.freeze({
      threadId: storage.threadId,
      checkpointNs: storage.checkpointNs,
      retainedCheckpointId: storage.checkpointId!,
    });
  }

  #maintenanceKey(
    coordinate: EncryptedCheckpointMaintenanceCoordinate,
  ): string {
    return `${coordinate.threadId}\0${coordinate.checkpointNs}`;
  }

  #recordMaintenanceFailure(
    storageConfig: RunnableConfig,
    attempt: EncryptedCheckpointMaintenanceAttempt,
    cause: unknown,
  ): EncryptedCheckpointMaintenanceOutcome {
    const coordinate = this.#maintenanceCoordinate(storageConfig);
    const key = this.#maintenanceKey(coordinate);
    const error = new EncryptedCheckpointMaintenanceError({
      attempt,
      coordinate,
      cause,
    });
    const outcome = Object.freeze({
      status: "failed" as const,
      error,
    });
    // A later retained checkpoint supersedes an older cleanup target for the
    // same physical thread/namespace. This keeps retry state bounded without
    // losing cleanup coverage.
    this.#pendingMaintenance.delete(key);
    this.#pendingMaintenance.set(key, structuredClone(storageConfig));
    this.#maintenanceOutcomes.push(outcome);
    return outcome;
  }

  #recordMaintenanceRecovery(
    storageConfig: RunnableConfig,
    attempt: EncryptedCheckpointMaintenanceAttempt,
  ): EncryptedCheckpointMaintenanceOutcome {
    const coordinate = this.#maintenanceCoordinate(storageConfig);
    const key = this.#maintenanceKey(coordinate);
    const outcome = Object.freeze({
      status: "recovered" as const,
      attempt,
      coordinate,
    });
    this.#pendingMaintenance.delete(key);
    this.#maintenanceOutcomes.push(outcome);
    return outcome;
  }

  #recordSupersedingMaintenanceRecovery(
    storageConfig: RunnableConfig,
  ): void {
    const coordinate = this.#maintenanceCoordinate(storageConfig);
    if (!this.#pendingMaintenance.has(this.#maintenanceKey(coordinate))) {
      return;
    }
    this.#recordMaintenanceRecovery(storageConfig, "post_put");
  }

  /**
   * Drain the coalesced, invocation-local maintenance channel. Durable `put`
   * success and post-commit cleanup status are intentionally separate facts.
   */
  takeMaintenanceOutcomes():
    readonly EncryptedCheckpointMaintenanceOutcome[]
  {
    const outcomes = Object.freeze(this.#maintenanceOutcomes.splice(0));
    return outcomes;
  }

  get pendingMaintenanceCount(): number {
    return this.#pendingMaintenance.size;
  }

  /**
   * Explicitly retry every exact failed compaction coordinate under fresh
   * operation authority. Each result is also published to the maintenance
   * channel; no cleanup failure is converted into checkpoint-write failure.
   */
  async retryPendingMaintenance():
    Promise<readonly EncryptedCheckpointMaintenanceOutcome[]>
  {
    if (this.#ending !== null) {
      throw new Error("encrypted checkpoint saver is closing");
    }
    const outcomes: EncryptedCheckpointMaintenanceOutcome[] = [];
    for (const storageConfig of [...this.#pendingMaintenance.values()]) {
      try {
        await this.#compact(storageConfig);
        outcomes.push(this.#recordMaintenanceRecovery(
          storageConfig,
          "explicit_retry",
        ));
      } catch (error) {
        outcomes.push(this.#recordMaintenanceFailure(
          storageConfig,
          "explicit_retry",
          error,
        ));
      }
    }
    return Object.freeze(outcomes);
  }

  async #sealValue(
    coordinate: CheckpointCellCoordinate,
    value: unknown,
    context: CheckpointAuthorizedOperationContext,
  ): Promise<InlineCheckpointCell> {
    assertAuthorizedOperationIsActive(context);
    const plaintext = await serializeLangGraphValue(
      this.#valueSerializer,
      value,
    );
    try {
      assertAuthorizedOperationIsActive(context);
      return inlineCell(await raceAuthorizedWork(
        context,
        () => this.#crypto.seal({
          scope: this.#scope,
          coordinate,
          plaintext,
          signal: context.signal,
        }),
      ));
    } finally {
      plaintext.fill(0);
    }
  }

  async #openValue(
    coordinate: CheckpointCellCoordinate,
    cell: InlineCheckpointCell,
    context: CheckpointAuthorizedOperationContext,
  ): Promise<unknown> {
    assertAuthorizedOperationIsActive(context);
    const plaintext = await raceAuthorizedWork(
      context,
      () => this.#crypto.open({
        scope: this.#scope,
        coordinate,
        ciphertext: ciphertextFromCell(cell),
        signal: context.signal,
      }),
      {
        onLateSuccess: (latePlaintext) => {
          if (latePlaintext instanceof Uint8Array) latePlaintext.fill(0);
        },
      },
    );
    if (!(plaintext instanceof Uint8Array)) {
      throw new Error("checkpoint crypto returned malformed plaintext");
    }
    try {
      assertAuthorizedOperationIsActive(context);
      return await deserializeLangGraphValue(
        this.#valueSerializer,
        plaintext,
      );
    } finally {
      plaintext.fill(0);
    }
  }

  override async getTuple(
    config: RunnableConfig,
  ): Promise<CheckpointTuple | undefined> {
    const logical = readLogicalCoordinate(config);
    this.#assertScopedThread(logical.threadId);
    const storageConfig = toShadowConfig(config);
    const expected = readShadowCoordinate(storageConfig);
    return this.#executeAuthorizedOperation("read", async (
      context,
      { checkpointStore, writeCoordinateReader },
    ) => {
      assertAuthorizedOperationIsActive(context);
      const tuple = await checkpointStore.getTuple(storageConfig);
      return tuple === undefined
        ? undefined
        : this.#decodeTuple(
            tuple,
            expected,
            context,
            writeCoordinateReader,
          );
    });
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const logical = readLogicalCoordinate(config);
    this.#assertScopedThread(logical.threadId);
    const limit = options?.limit ?? ENCRYPTED_CHECKPOINT_LIST_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(
        "encrypted checkpoint list limit must be a positive safe integer",
      );
    }
    if (limit > ENCRYPTED_CHECKPOINT_LIST_MAX_LIMIT) {
      throw new Error(
        `encrypted checkpoint list limit must be at most ${ENCRYPTED_CHECKPOINT_LIST_MAX_LIMIT}`,
      );
    }
    if (options?.before !== undefined) {
      const beforeLogical = readLogicalCoordinate(options.before, {
        checkpointId: "required",
      });
      if (
        beforeLogical.threadId !== logical.threadId
        || beforeLogical.checkpointNs !== logical.checkpointNs
      ) {
        throw new Error(
          "checkpoint list cursor does not match invocation scope",
        );
      }
    }
    if (
      options?.filter !== undefined
      && Object.keys(options.filter).length > 0
    ) {
      throw new Error(
        "metadata filters are unavailable for encrypted checkpoints",
      );
    }
    const storageOptions: CheckpointListOptions = {
      limit,
      ...(options?.before === undefined
        ? {}
        : { before: toShadowConfig(options.before) }),
    };
    const storageConfig = toShadowConfig(config);
    const expected = readShadowCoordinate(storageConfig);
    const page = await this.#executeAuthorizedOperation(
      "read",
      async (
        context,
        { checkpointStore, writeCoordinateReader },
      ) => {
        assertAuthorizedOperationIsActive(context);
        const materialized: CheckpointTuple[] = [];
        for await (
          const tuple of checkpointStore.list(
            storageConfig,
            storageOptions,
          )
        ) {
          assertAuthorizedOperationIsActive(context);
          if (materialized.length >= limit) {
            throw new Error(
              "encrypted checkpoint store exceeded the requested page limit",
            );
          }
          materialized.push(
            await this.#decodeTuple(
              tuple,
              expected,
              context,
              writeCoordinateReader,
            ),
          );
        }
        return materialized;
      },
    );
    for (const tuple of page) {
      yield tuple;
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const logical = readLogicalCoordinate(config);
    this.#assertScopedThread(logical.threadId);
    // LangGraph includes initialized reducer defaults before their first write
    // assigns a channel version. Like PostgresSaver, persist only newVersions;
    // do not invent versions or serialize these ephemeral defaults elsewhere.
    // Stored checkpoint decoding retains the strict versioned-cell contract.
    validateCheckpoint(checkpoint, { allowUnversionedValues: true });
    validateNewVersions(checkpoint, newVersions);
    if (this.#ending !== null) {
      throw new Error("encrypted checkpoint saver is closing");
    }
    const storageConfig = toShadowConfig(config);
    const storage = readShadowCoordinate(storageConfig);
    const parentCheckpointId = storage.checkpointId ?? null;
    const lifecycle = Promise.withResolvers<void>();
    this.#liveOperations.add(lifecycle.promise);

    try {
      const result = await this.#executeAuthorizedOperation("write", async (
        context,
        { checkpointStore },
      ) => {
        const encryptedValues: Record<string, InlineCheckpointCell> = {};
        for (const [channel, version] of Object.entries(newVersions)) {
          const value: ChannelEnvelope = Object.hasOwn(
            checkpoint.channel_values,
            channel,
          )
            ? {
                version: ENVELOPE_VERSION,
                state: "value",
                value: checkpoint.channel_values[channel],
              }
            : {
                version: ENVELOPE_VERSION,
                state: "empty",
              };
          encryptedValues[channel] = await this.#sealValue(
            {
              kind: "channel",
              threadId: storage.threadId,
              checkpointNs: storage.checkpointNs,
              channel,
              version: String(version),
            },
            value,
            context,
          );
        }

        const encryptedMetadata = await this.#sealValue(
          {
            kind: "metadata",
            threadId: storage.threadId,
            checkpointNs: storage.checkpointNs,
            checkpointId: checkpoint.id,
            parentCheckpointId,
          },
          {
            version: ENVELOPE_VERSION,
            metadata,
            structure: metadataStructure(checkpoint, parentCheckpointId),
          } satisfies MetadataEnvelope,
          context,
        );

        const protectedCheckpoint: Checkpoint = {
          v: checkpoint.v,
          id: checkpoint.id,
          ts: checkpoint.ts,
          channel_values: encryptedValues,
          channel_versions: structuredClone(checkpoint.channel_versions),
          versions_seen: structuredClone(checkpoint.versions_seen),
        };

        // Deliberately no resilience wrapper or catch here: a failed durable
        // write remains a failed graph operation.
        assertAuthorizedOperationIsActive(context);
        const storedResult = await checkpointStore.put(
          storageConfig,
          protectedCheckpoint,
          encryptedMetadata as never,
          structuredClone(newVersions),
        );
        const resultStorage = readShadowCoordinate(storedResult, {
          checkpointId: "required",
        });
        if (
          resultStorage.threadId !== storage.threadId
          || resultStorage.checkpointNs !== storage.checkpointNs
          || resultStorage.checkpointId !== checkpoint.id
        ) {
          throw new Error(
            "encrypted checkpoint store returned a different storage coordinate",
          );
        }
        return {
          logical: fromShadowConfig(storedResult),
          storage: storedResult,
        };
      });
      try {
        await this.#compact(result.storage, true);
        this.#recordSupersedingMaintenanceRecovery(result.storage);
      } catch (error) {
        this.#recordMaintenanceFailure(
          result.storage,
          "post_put",
          error,
        );
      }
      return result.logical;
    } finally {
      this.#liveOperations.delete(lifecycle.promise);
      lifecycle.resolve();
    }
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const logical = readLogicalCoordinate(config, {
      checkpointId: "required",
    });
    this.#assertScopedThread(logical.threadId);
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("encrypted checkpoint writes require taskId");
    }
    validatePendingWrites(writes);
    const storageConfig = toShadowConfig(config);
    const storage = readShadowCoordinate(storageConfig, {
      checkpointId: "required",
    });
    return this.#executeAuthorizedOperation("write", async (
      context,
      { checkpointStore },
    ) => {
      const encryptedWrites: PendingWrite[] = [];
      for (const [arrayIndex, [channel, value]] of writes.entries()) {
        const index = writeIndex(channel, arrayIndex);
        encryptedWrites.push([
          channel,
          await this.#sealValue(
            {
              kind: "write",
              threadId: storage.threadId,
              checkpointNs: storage.checkpointNs,
              checkpointId: storage.checkpointId!,
              taskId,
              index,
              channel,
            },
            {
              version: ENVELOPE_VERSION,
              value,
            } satisfies WriteEnvelope,
            context,
          ),
        ]);
      }

      // Deliberately rethrow the final store error. Silent write loss makes a
      // later resume both incorrect and impossible to diagnose safely.
      assertAuthorizedOperationIsActive(context);
      await checkpointStore.putWrites(
        storageConfig,
        encryptedWrites,
        taskId,
      );
    });
  }

  override async deleteThread(threadId: string): Promise<void> {
    requireNonEmptyString(threadId, "thread_id");
    this.#assertScopedThread(threadId);
    return this.#executeAuthorizedOperation("delete", async (
      context,
      { checkpointStore },
    ) => {
      assertAuthorizedOperationIsActive(context);
      await checkpointStore.deleteThread(shadowThreadId(threadId));
    });
  }

  /** Close the separately-owned PostgresSaver/pool when used by integration. */
  async end(): Promise<EncryptedCheckpointSaverCloseOutcome> {
    this.#ending ??= (async () => {
      await Promise.allSettled([...this.#liveOperations]);
      try {
        await this.#operationStoreFactory.end();
        return Object.freeze({
          status: "closed" as const,
          pendingMaintenanceCount: this.#pendingMaintenance.size,
        });
      } catch (cause) {
        return Object.freeze({
          status: "close_failed" as const,
          pendingMaintenanceCount: this.#pendingMaintenance.size,
          error: new Error("encrypted checkpoint saver close failed", {
            cause,
          }),
        });
      }
    })();
    return this.#ending;
  }

  async #decodeTuple(
    tuple: CheckpointTuple,
    expected: StorageCoordinate,
    context: CheckpointAuthorizedOperationContext,
    writeCoordinateReader: CheckpointWriteCoordinateReader,
  ): Promise<CheckpointTuple> {
    assertAuthorizedOperationIsActive(context);
    const storage = readShadowCoordinate(tuple.config, {
      checkpointId: "required",
    });
    if (
      storage.threadId !== expected.threadId
      || storage.checkpointNs !== expected.checkpointNs
      || (
        expected.checkpointId !== undefined
        && storage.checkpointId !== expected.checkpointId
      )
    ) {
      throw new Error(
        "encrypted checkpoint store returned a cross-coordinate row",
      );
    }
    validateCheckpoint(tuple.checkpoint);
    if (tuple.checkpoint.id !== storage.checkpointId) {
      throw new Error(
        "encrypted checkpoint row id does not match its storage coordinate",
      );
    }

    let parentCheckpointId: string | null = null;
    let logicalParentConfig: RunnableConfig | undefined;
    if (tuple.parentConfig !== undefined) {
      const parentStorage = readShadowCoordinate(tuple.parentConfig, {
        checkpointId: "required",
      });
      if (
        parentStorage.threadId !== storage.threadId
        || parentStorage.checkpointNs !== storage.checkpointNs
      ) {
        throw new Error(
          "encrypted checkpoint parent crosses its storage coordinate",
        );
      }
      parentCheckpointId = parentStorage.checkpointId!;
      logicalParentConfig = fromShadowConfig(tuple.parentConfig);
    }

    const metadataCell = parseInlineCell(tuple.metadata);
    const metadataValue = parseMetadataEnvelope(await this.#openValue(
      {
        kind: "metadata",
        threadId: storage.threadId,
        checkpointNs: storage.checkpointNs,
        checkpointId: storage.checkpointId,
        parentCheckpointId,
      },
      metadataCell,
      context,
    ));
    if (
      !isDeepStrictEqual(
        metadataValue.structure,
        metadataStructure(tuple.checkpoint, parentCheckpointId),
      )
    ) {
      throw new Error(
        "encrypted checkpoint structure does not match authenticated metadata",
      );
    }

    const versionedChannels = Object.keys(tuple.checkpoint.channel_versions);
    if (
      !isDeepStrictEqual(
        Object.keys(tuple.checkpoint.channel_values).sort(),
        [...versionedChannels].sort(),
      )
    ) {
      throw new Error(
        "encrypted checkpoint is missing a protected channel cell",
      );
    }

    const channelValues: Record<string, unknown> = {};
    for (const channel of versionedChannels) {
      const cell = parseInlineCell(tuple.checkpoint.channel_values[channel]);
      const envelope = parseChannelEnvelope(await this.#openValue(
        {
          kind: "channel",
          threadId: storage.threadId,
          checkpointNs: storage.checkpointNs,
          channel,
          version: String(tuple.checkpoint.channel_versions[channel]),
        },
        cell,
        context,
      ));
      if (envelope.state === "value") {
        channelValues[channel] = envelope.value;
      }
    }

    const storedWrites = tuple.pendingWrites ?? [];
    assertAuthorizedOperationIsActive(context);
    const physicalWriteCoordinates =
      await writeCoordinateReader.readPendingWriteCoordinates({
        threadId: storage.threadId,
        checkpointNs: storage.checkpointNs,
        checkpointId: storage.checkpointId,
      });
    if (storedWrites.length !== physicalWriteCoordinates.length) {
      throw new Error(
        "encrypted checkpoint pending writes disagree with physical rows",
      );
    }
    const seenWriteCoordinates = new Set<string>();
    const pendingWrites: [string, string, unknown][] = [];
    for (const [position, storedWrite] of storedWrites.entries()) {
      const [taskId, channel, value] = storedWrite;
      const physical = physicalWriteCoordinates[position];
      if (
        physical === undefined
        || typeof physical.taskId !== "string"
        || physical.taskId.length === 0
        || typeof physical.channel !== "string"
        || physical.channel.length === 0
        || !Number.isSafeInteger(physical.index)
        || physical.taskId !== taskId
        || physical.channel !== channel
      ) {
        throw new Error(
          "encrypted checkpoint pending writes disagree with physical rows",
        );
      }
      const reservedIndex = RESERVED_WRITE_INDICES[channel];
      if (
        (reservedIndex !== undefined && physical.index !== reservedIndex)
        || (reservedIndex === undefined && physical.index < 0)
      ) {
        throw new Error(
          "physical checkpoint write index is malformed",
        );
      }
      const uniquenessKey = `${taskId}\0${physical.index}`;
      if (seenWriteCoordinates.has(uniquenessKey)) {
        throw new Error(
          "encrypted checkpoint contains duplicate pending write coordinates",
        );
      }
      seenWriteCoordinates.add(uniquenessKey);
      const cell = parseInlineCell(value);
      const envelope = parseWriteEnvelope(await this.#openValue(
        {
          kind: "write",
          threadId: storage.threadId,
          checkpointNs: storage.checkpointNs,
          checkpointId: storage.checkpointId,
          taskId,
          index: physical.index,
          channel,
        },
        cell,
        context,
      ));
      pendingWrites.push([taskId, channel, envelope.value]);
    }

    return {
      config: fromShadowConfig(tuple.config),
      checkpoint: {
        v: tuple.checkpoint.v,
        id: tuple.checkpoint.id,
        ts: tuple.checkpoint.ts,
        channel_values: channelValues,
        channel_versions: structuredClone(
          tuple.checkpoint.channel_versions,
        ),
        versions_seen: structuredClone(tuple.checkpoint.versions_seen),
      },
      metadata: metadataValue.metadata as CheckpointMetadata,
      ...(logicalParentConfig === undefined
        ? {}
        : { parentConfig: logicalParentConfig }),
      pendingWrites,
    };
  }
}

export interface CreateEncryptedCheckpointSaverOptions {
  dedicatedPool: pg.Pool;
  crypto: CheckpointCellCrypto;
  scope: CheckpointInvocationScope;
}

/**
 * Constructs the protected saver with its own pinned PostgresSaver and strict
 * serializer. The dedicated pool is also the authority for physical pending
 * write coordinates. The schema is deliberately fixed to `langchain` because
 * the owned compactor is fixed to that schema too.
 */
export function createEncryptedCheckpointSaver(
  options: CreateEncryptedCheckpointSaverOptions,
): EncryptedCheckpointSaver {
  const serializer = new InlineCheckpointCellSerializer();
  const operationStoreFactory: CheckpointOperationStoreFactory = {
    serializer,
    schema: "langchain",
    create: (context) => {
      const operationPool = new OperationBoundCheckpointPool(
        options.dedicatedPool,
        context,
      );
      return {
        checkpointStore: new PostgresSaver(
          operationPool as unknown as pg.Pool,
          serializer,
          { schema: "langchain" },
        ),
        writeCoordinateReader: new PostgresCheckpointWriteCoordinateReader(
          operationPool as unknown as pg.Pool,
        ),
        compact: async (storageConfig) => {
          const storage = readShadowCoordinate(storageConfig, {
            checkpointId: "required",
          });
          const client = await operationPool.connect();
          try {
            await client.query("BEGIN");
            for (
              const statement of buildCompactionQueries(
                storage.threadId,
                storage.checkpointNs,
                storage.checkpointId!,
              )
            ) {
              await client.query(statement.sql, statement.params);
            }
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        },
      };
    },
    end: () => options.dedicatedPool.end(),
  };
  return new EncryptedCheckpointSaver({
    operationStoreFactory,
    crypto: options.crypto,
    scope: options.scope,
  });
}
