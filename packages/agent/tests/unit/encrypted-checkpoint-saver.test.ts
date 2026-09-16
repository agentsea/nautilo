import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from "@langchain/langgraph";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createProtectedCheckpointCellCrypto,
  type ProtectedCheckpointCellAuthorityPort,
} from "@nautilo/lattice-bridge";
import { HumanMessage } from "@langchain/core/messages";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { describe, expect, it } from "bun:test";

import {
  EncryptedCheckpointSaver,
  InlineCheckpointCellSerializer,
  OperationBoundCheckpointPool,
  PostgresCheckpointWriteCoordinateReader,
  type CheckpointCellCoordinate,
  type CheckpointCellCrypto,
  type CheckpointAuthorizedOperationContext,
  type CheckpointInvocationScope,
  type CheckpointOperationStoreFactory,
  type CheckpointWriteCoordinate,
  type CheckpointWriteCoordinateReader,
} from "../../src/checkpoints/encrypted-checkpoint-saver";
import {
  buildCompactionQueries,
} from "../../src/checkpoints/checkpoint-compaction";

type TestConfigurable = {
  thread_id?: string;
  checkpoint_ns?: string;
  checkpoint_id?: string;
  [key: string]: unknown;
};

type Config = {
  configurable?: TestConfigurable;
};

type RequiredTestConfigurable = TestConfigurable & {
  thread_id: string;
  checkpoint_ns: string;
};

type PutWritesValue = [string, unknown];

type Deferred<Value> = Readonly<{
  promise: Promise<Value>;
  resolve(value: Value | PromiseLike<Value>): void;
  reject(reason?: unknown): void;
}>;

type ListOptions = {
  limit?: number;
  before?: Config;
  filter?: Record<string, unknown>;
};

interface CapturedPut {
  config: Config;
  checkpoint: Checkpoint;
  metadata: CheckpointMetadata;
  newVersions: Record<string, number | string>;
}

class InMemoryOpaqueCheckpointStore {
  serde = new InlineCheckpointCellSerializer();
  options = { schema: "langchain" };
  putCalls: CapturedPut[] = [];
  putWritesCalls: Array<{
    config: Config;
    writes: PutWritesValue[];
    taskId: string;
  }> = [];
  getCalls: Config[] = [];
  listCalls: Array<{ config: Config; options?: ListOptions }> = [];
  deleteCalls: string[] = [];
  tuple: CheckpointTuple | undefined;
  putError: Error | undefined;
  putWritesError: Error | undefined;
  compactionError: Error | undefined;
  pool: {
    connect: () => Promise<{
      query: (text: string, params?: unknown[]) => Promise<void>;
      release: () => void;
    }>;
  } | undefined;
  compactionQueries: Array<{ text: string; params?: unknown[] }> = [];
  compactionCalls: Config[] = [];
  readonly blobs = new Map<string, unknown>();
  writeCoordinates: CheckpointWriteCoordinate[] = [];

  captureCompaction(): void {
    this.pool = {
      connect: async () => ({
        query: async (text, params) => {
          this.compactionQueries.push({
            text,
            ...(params === undefined ? {} : { params }),
          });
        },
        release: () => undefined,
      }),
    };
  }

  async compact(config: Config): Promise<void> {
    this.compactionCalls.push(structuredClone(config));
    if (this.compactionError !== undefined) {
      throw this.compactionError;
    }
    if (this.pool === undefined) return;
    const coordinate = requiredConfigurable(config);
    if (typeof coordinate.checkpoint_id !== "string") {
      throw new Error("test compaction requires checkpoint_id");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (
        const statement of buildCompactionQueries(
          coordinate.thread_id,
          coordinate.checkpoint_ns,
          coordinate.checkpoint_id,
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
  }

  async put(
    config: Config,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: Record<string, number | string>,
  ): Promise<Config> {
    if (this.putError) throw this.putError;
    this.putCalls.push({ config, checkpoint, metadata, newVersions });
    const configurable = requiredConfigurable(config);
    for (const [channel, version] of Object.entries(newVersions)) {
      this.blobs.set(
        `${channel}\0${String(version)}`,
        structuredClone(checkpoint.channel_values[channel]),
      );
    }
    const loadedValues = Object.fromEntries(
      Object.entries(checkpoint.channel_versions).map(([channel, version]) => {
        const value = this.blobs.get(`${channel}\0${String(version)}`);
        if (value === undefined) {
          throw new Error(`test store is missing blob ${channel}/${version}`);
        }
        return [channel, structuredClone(value)];
      }),
    );
    const result = {
      configurable: {
        thread_id: configurable.thread_id,
        checkpoint_ns: configurable.checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
    this.tuple = {
      config: result,
      checkpoint: {
        ...structuredClone(checkpoint),
        channel_values: loadedValues,
      },
      metadata: structuredClone(metadata),
      ...(typeof configurable.checkpoint_id === "string"
        ? { parentConfig: {
            configurable: {
              thread_id: configurable.thread_id,
              checkpoint_ns: configurable.checkpoint_ns,
              checkpoint_id: configurable.checkpoint_id,
            },
          } }
        : {}),
      pendingWrites: [],
    };
    this.writeCoordinates = [];
    return result;
  }

  async putWrites(
    config: Config,
    writes: PutWritesValue[],
    taskId: string,
  ): Promise<void> {
    if (this.putWritesError) throw this.putWritesError;
    this.putWritesCalls.push({ config, writes, taskId });
    if (!this.tuple) throw new Error("test store has no checkpoint");
    this.writeCoordinates = writes.map(([channel], arrayIndex) => ({
      taskId,
      index: writeIndex(channel, arrayIndex),
      channel,
    }));
    const order = this.writeCoordinates
      .map((coordinate, arrayIndex) => ({ coordinate, arrayIndex }))
      .sort((left, right) =>
        left.coordinate.taskId.localeCompare(right.coordinate.taskId)
        || left.coordinate.index - right.coordinate.index
      );
    this.writeCoordinates = order.map(({ coordinate }) => coordinate);
    this.tuple.pendingWrites = order.map(({ coordinate, arrayIndex }) => [
      coordinate.taskId,
      coordinate.channel,
      writes[arrayIndex]![1],
    ]);
  }

  async getTuple(config: Config): Promise<CheckpointTuple | undefined> {
    this.getCalls.push(config);
    return this.tuple ? structuredClone(this.tuple) : undefined;
  }

  async *list(
    config: Config,
    options?: ListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    this.listCalls.push({
      config,
      ...(options === undefined ? {} : { options }),
    });
    if (this.tuple) yield structuredClone(this.tuple);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.deleteCalls.push(threadId);
  }
}

class InMemoryWriteCoordinateReader
implements CheckpointWriteCoordinateReader {
  readonly calls: Array<{
    threadId: string;
    checkpointNs: string;
    checkpointId: string;
  }> = [];

  constructor(readonly store: InMemoryOpaqueCheckpointStore) {}

  async readPendingWriteCoordinates(input: {
    threadId: string;
    checkpointNs: string;
    checkpointId: string;
  }): Promise<readonly CheckpointWriteCoordinate[]> {
    this.calls.push(structuredClone(input));
    return structuredClone(this.store.writeCoordinates);
  }
}

class CoordinateCheckingCrypto implements CheckpointCellCrypto {
  readonly seals: Array<{
    scope: CheckpointInvocationScope;
    coordinate: CheckpointCellCoordinate;
    plaintextBeforeWipe: Uint8Array;
    signal: AbortSignal;
  }> = [];
  readonly opens: Array<{
    scope: CheckpointInvocationScope;
    coordinate: CheckpointCellCoordinate;
    signal: AbortSignal;
  }> = [];
  readonly operations: Array<{
    operation: "read" | "write" | "delete" | "cleanup";
    scope: CheckpointInvocationScope;
  }> = [];
  readonly sealPlaintextReferences: Uint8Array[] = [];
  readonly openPlaintextReferences: Uint8Array[] = [];
  authorized = true;
  readonly deniedOperations = new Set<
    "read" | "write" | "delete" | "cleanup"
  >();
  successfulOperations = 0;
  failedOperations = 0;
  readonly operationController = new AbortController();
  operationRemainingMs = 60_000;
  operationActive = true;
  abortAfterOpen: number | undefined;
  sealGate: Deferred<void> | undefined;
  openGate: Deferred<void> | undefined;
  readonly sealStarted = Promise.withResolvers<void>();
  readonly openStarted = Promise.withResolvers<void>();
  readonly #cells = new Map<string, {
    scope: CheckpointInvocationScope;
    coordinate: CheckpointCellCoordinate;
    plaintext: Uint8Array;
  }>();
  #nextId = 0;

  async executeAuthorizedOperation<Value>(input: {
    operation: "read" | "write" | "delete" | "cleanup";
    scope: CheckpointInvocationScope;
    execute: (
      context: CheckpointAuthorizedOperationContext,
    ) => Promise<Value>;
  }): Promise<Value> {
    this.operations.push({
      operation: input.operation,
      scope: input.scope,
    });
    if (!this.authorized || this.deniedOperations.has(input.operation)) {
      this.failedOperations += 1;
      throw new Error("checkpoint authorization is unavailable");
    }
    try {
      const context: CheckpointAuthorizedOperationContext = {
        signal: this.operationController.signal,
        assertActive: () => {
          if (
            !this.operationActive
            || this.operationController.signal.aborted
            || this.operationRemainingMs <= 0
          ) {
            throw new Error(
              "authorized checkpoint operation is no longer active",
            );
          }
        },
        assertCommitAllowed: () => Promise.resolve(),
        remainingMs: () => this.operationRemainingMs,
      };
      const value = await input.execute(context);
      context.assertActive();
      this.successfulOperations += 1;
      return value;
    } catch (error) {
      this.failedOperations += 1;
      throw error;
    }
  }

  async seal(input: {
    scope: CheckpointInvocationScope;
    coordinate: CheckpointCellCoordinate;
    plaintext: Uint8Array;
    signal: AbortSignal;
  }): Promise<Uint8Array> {
    const token = `sealed-${++this.#nextId}`;
    this.sealPlaintextReferences.push(input.plaintext);
    const stored = {
      scope: input.scope,
      coordinate: structuredClone(input.coordinate),
      plaintext: input.plaintext.slice(),
    };
    this.seals.push({
      scope: input.scope,
      coordinate: structuredClone(input.coordinate),
      plaintextBeforeWipe: input.plaintext.slice(),
      signal: input.signal,
    });
    this.#cells.set(token, stored);
    if (this.sealGate !== undefined) {
      this.sealStarted.resolve();
      await this.sealGate.promise;
    }
    return new TextEncoder().encode(token);
  }

  async open(input: {
    scope: CheckpointInvocationScope;
    coordinate: CheckpointCellCoordinate;
    ciphertext: Uint8Array;
    signal: AbortSignal;
  }): Promise<Uint8Array> {
    this.opens.push({
      scope: input.scope,
      coordinate: structuredClone(input.coordinate),
      signal: input.signal,
    });
    const token = new TextDecoder().decode(input.ciphertext);
    const stored = this.#cells.get(token);
    if (!stored) throw new Error("checkpoint ciphertext is corrupt");
    expect(input.coordinate).toEqual(stored.coordinate);
    expect(input.scope).toBe(stored.scope);
    const plaintext = stored.plaintext.slice();
    this.openPlaintextReferences.push(plaintext);
    if (this.openGate !== undefined) {
      this.openStarted.resolve();
      await this.openGate.promise;
    }
    if (
      this.abortAfterOpen !== undefined
      && this.opens.length >= this.abortAfterOpen
    ) {
      this.operationController.abort();
    }
    return plaintext;
  }
}

class BlockingPgClient {
  readonly queries: Array<{ text: string; params?: unknown[] }> = [];
  releaseCalls = 0;
  readonly releaseErrors: Array<Error | boolean | undefined> = [];
  destroyed = false;
  readonly blocked = Promise.withResolvers<void>();
  #blockedOnce = false;
  #result = Promise.withResolvers<{ rows: unknown[] }>();

  async query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[] }> {
    this.queries.push({
      text,
      ...(params === undefined ? {} : { params }),
    });
    const command = text.trim().toUpperCase();
    const isControl = command === "BEGIN"
      || command === "COMMIT"
      || command === "ROLLBACK"
      || command.startsWith("SET LOCAL STATEMENT_TIMEOUT");
    if (!isControl && !this.#blockedOnce) {
      this.#blockedOnce = true;
      this.blocked.resolve();
      return this.#result.promise;
    }
    return { rows: [] };
  }

  unblock(rows: unknown[] = []): void {
    this.#result.resolve({ rows });
  }

  release(error?: Error | boolean): void {
    this.releaseCalls += 1;
    this.releaseErrors.push(error);
    if (error) this.destroyed = true;
  }
}

class BlockingPgPool {
  readonly client = new BlockingPgClient();
  connectCalls = 0;
  directQueryCalls = 0;

  async connect(): Promise<BlockingPgClient> {
    this.connectCalls += 1;
    if (this.client.destroyed) {
      throw new Error("test pool refused a destroyed client");
    }
    return this.client;
  }

  query(): Promise<never> {
    this.directQueryCalls += 1;
    return Promise.reject(
      new Error("operation-bound reads must not use raw pool.query"),
    );
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

class BlockingCheckoutPool {
  readonly checkout = Promise.withResolvers<BlockingPgClient>();
  connectCalls = 0;

  connect(): Promise<BlockingPgClient> {
    this.connectCalls += 1;
    return this.checkout.promise;
  }
}

class DurableTransactionPgClient {
  readonly queries: string[] = [];
  releaseCalls = 0;
  staged = false;
  durable = false;

  query(text: string): Promise<{ rows: unknown[] }> {
    const command = text.trim().toUpperCase();
    this.queries.push(command);
    if (command.startsWith("INSERT") || command.startsWith("DELETE")) {
      this.staged = true;
    } else if (command === "COMMIT") {
      this.durable = this.staged;
      this.staged = false;
    } else if (command === "ROLLBACK") {
      this.staged = false;
    }
    return Promise.resolve({ rows: [] });
  }

  release(): void {
    this.releaseCalls += 1;
  }
}

class DurableTransactionPgPool {
  readonly client = new DurableTransactionPgClient();

  connect(): Promise<DurableTransactionPgClient> {
    return Promise.resolve(this.client);
  }
}

async function settlePromptly(
  pending: Promise<unknown>,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Error>((resolve) => {
    timer = setTimeout(
      () => resolve(new Error("test timed out waiting for prompt rejection")),
      100,
    );
  });
  try {
    return await Promise.race([
      pending.then(
        () => undefined,
        (error: unknown) => error,
      ),
      timedOut,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function operationContext(
  crypto: CoordinateCheckingCrypto,
): CheckpointAuthorizedOperationContext {
  return {
    signal: crypto.operationController.signal,
    assertActive: () => {
      if (
        !crypto.operationActive
        || crypto.operationController.signal.aborted
        || crypto.operationRemainingMs <= 0
      ) {
        throw new Error(
          "authorized checkpoint operation is no longer active",
        );
      }
    },
    assertCommitAllowed: () => Promise.resolve(),
    remainingMs: () => crypto.operationRemainingMs,
  };
}

function pinnedSaver(
  pool: BlockingPgPool,
  context: CheckpointAuthorizedOperationContext,
): PostgresSaver {
  return new PostgresSaver(
    new OperationBoundCheckpointPool(
      pool as never,
      context,
    ) as never,
    new InlineCheckpointCellSerializer(),
    { schema: "langchain" },
  );
}

class InspectableInlinePostgresSaver extends PostgresSaver {
  dumpMetadata(metadata: unknown): Promise<unknown> {
    return this._dumpMetadata(metadata as never);
  }

  dumpBlobs(
    values: Record<string, unknown>,
    versions: Record<string, number | string> = { messages: 2 },
  ) {
    return this._dumpBlobs(
      "shadow-thread",
      "shadow-namespace",
      values,
      versions,
    );
  }

  dumpWrites(writes: [string, unknown][]) {
    return this._dumpWrites(
      "shadow-thread",
      "shadow-namespace",
      "checkpoint-2",
      "task-1",
      writes,
    );
  }

  loadMetadata(metadata: Record<string, unknown>): Promise<unknown> {
    return this._loadMetadata(metadata);
  }

  loadBlobs(values: [Uint8Array, Uint8Array, Uint8Array][]) {
    return this._loadBlobs(values);
  }

  loadWrites(values: [Uint8Array, Uint8Array, Uint8Array, Uint8Array][]) {
    return this._loadWrites(values);
  }
}

function requiredConfigurable(config: Config): RequiredTestConfigurable {
  if (
    !config.configurable
    || typeof config.configurable.thread_id !== "string"
    || typeof config.configurable.checkpoint_ns !== "string"
  ) {
    throw new Error("missing configurable");
  }
  return config.configurable as RequiredTestConfigurable;
}

function writeIndex(channel: string, arrayIndex: number): number {
  return ({
    __error__: -1,
    __scheduled__: -2,
    __interrupt__: -3,
    __resume__: -4,
  } as Record<string, number>)[channel] ?? arrayIndex;
}

function checkpoint(): Checkpoint {
  return {
    v: 4,
    id: "checkpoint-2",
    ts: "2026-08-03T12:34:56.000Z",
    channel_values: {
      messages: [{ role: "user", content: "M237_SECRET" }],
    },
    channel_versions: {
      messages: 2,
      optional_state: 1,
    },
    versions_seen: {
      agent: {
        messages: 2,
        optional_state: 1,
      },
    },
  };
}

function metadata(): CheckpointMetadata<Record<string, unknown>> {
  return {
    source: "loop",
    step: 2,
    parents: {},
    writes: {
      agent: {
        private: "M237_METADATA_SECRET",
      },
    },
  };
}

function config(): Config {
  return {
    configurable: {
      thread_id: "room:room-1:bot:agent-1",
      checkpoint_ns: "foreground",
      checkpoint_id: "checkpoint-1",
    },
  };
}

function checkpointConfig(): Config {
  return {
    configurable: {
      thread_id: "room:room-1:bot:agent-1",
      checkpoint_ns: "foreground",
      checkpoint_id: "checkpoint-2",
    },
  };
}

const authorizationSession = Object.freeze({ sessionId: "opaque-session-1" });

function invocationScope(
  logicalThreadId = "room:room-1:bot:agent-1",
): CheckpointInvocationScope {
  return {
    logicalThreadId,
    namespaceId: "namespace-1",
    keyClass: "ai",
    expectedAccessRevision: 7,
    expectedPolicyRevision: 11,
    authorizationSession,
  };
}

function saverHarness(
  end: () => Promise<void> = () => Promise.resolve(),
  protectedCrypto?: CheckpointCellCrypto,
  logicalThreadId?: string,
) {
  const store = new InMemoryOpaqueCheckpointStore();
  const crypto = new CoordinateCheckingCrypto();
  const writeCoordinateReader = new InMemoryWriteCoordinateReader(store);
  const operationStoreFactory: CheckpointOperationStoreFactory = {
    serializer: store.serde,
    schema: "langchain",
    create: () => ({
      checkpointStore: store as never,
      writeCoordinateReader,
      compact: (storageConfig) => store.compact(storageConfig),
    }),
    end,
  };
  const saver = new EncryptedCheckpointSaver({
    operationStoreFactory,
    crypto: protectedCrypto ?? crypto,
    scope: invocationScope(logicalThreadId),
  });
  return { store, crypto, saver, writeCoordinateReader };
}

describe("EncryptedCheckpointSaver", () => {
  it.each([
    { label: "state write", terminalNoOp: false, logicalThreadId: "room:room-1:bot:agent-1" },
    { label: "terminal no-op", terminalNoOp: true, logicalThreadId: "room:room-1:bot:agent-1" },
    { label: "UUID Room and Agent", terminalNoOp: false, logicalThreadId: "room:10000000-0000-4000-8000-000000000001:bot:10000000-0000-4000-8000-000000000002" },
  ])("runs and reloads a real StateGraph through protected crypto ($label)", async ({ terminalNoOp, logicalThreadId }) => {
    const authority: ProtectedCheckpointCellAuthorityPort = {
      execute: async ({ execute }) => {
        const key = new Uint8Array(32).fill(0x31);
        const controller = new AbortController();
        try {
          return await execute({
            signal: controller.signal,
            assertActive: () => undefined,
            assertCommitAllowed: () => Promise.resolve(),
            remainingMs: () => 5_000,
            material: {
              namespaceId: "namespace-1",
              domainId: "domain-1",
              accessRevision: 7,
              agentAuthorizationRevision: 11,
              currentGeneration: 1,
              generations: [{ generation: 1, key }],
            },
          });
        } finally {
          key.fill(0);
        }
      },
    };
    const protectedCrypto = createProtectedCheckpointCellCrypto({
      crypto: new LatticeCrypto(),
      authority,
      domainId: "domain-1",
      entrypointId: "foreground.main",
    });
    const { saver, store } = saverHarness(undefined, protectedCrypto, logicalThreadId);
    const state = Annotation.Root({
      value: Annotation<string>(),
      defaultValue: Annotation<string>({
        reducer: (_old, value) => value,
        default: () => "DEFAULT_PRIVATE_VALUE",
      }),
    });
    const graph = new StateGraph(state)
      .addNode("echo", (value) => terminalNoOp ? {} : ({ value: value.value }))
      .addEdge(START, "echo")
      .addConditionalEdges("echo", () => END)
      .compile({ checkpointer: saver });
    const graphConfig = {
      configurable: { thread_id: logicalThreadId },
    };
    const expected = {
      value: "GRAPH_PRIVATE_VALUE", defaultValue: "DEFAULT_PRIVATE_VALUE",
    };
    expect(await graph.invoke({ value: "GRAPH_PRIVATE_VALUE" }, graphConfig))
      .toEqual(expected);
    expect((await graph.getState(graphConfig)).values).toEqual(expected);
    expect(store.putCalls.some(({ checkpoint }) =>
      Object.hasOwn(checkpoint.channel_values, "__start__")
    )).toBeTrue();
    if (terminalNoOp) expect(store.putWritesCalls.some(({ writes }) =>
      writes.some(([channel]) => channel === "__no_writes__")
    )).toBeTrue();
    expect(JSON.stringify(store.putCalls)).not.toContain("GRAPH_PRIVATE_VALUE");
    expect(JSON.stringify(store.putCalls)).not.toContain("DEFAULT_PRIVATE_VALUE");
  });

  it("accepts real LangGraph reducer defaults with ordinary Postgres version semantics", async () => {
    const { saver, store } = saverHarness();
    const captured: Array<{
      checkpoint: Checkpoint;
      versions: Record<string, number | string>;
    }> = [];
    const originalPut = saver.put.bind(saver);
    saver.put = (...args) => {
      captured.push({
        checkpoint: structuredClone(args[1]),
        versions: structuredClone(args[3]),
      });
      return originalPut(...args);
    };
    const state = Annotation.Root({
      count: Annotation<number>({ reducer: (_old, value) => value, default: () => 0 }),
      untouched: Annotation<string>({
        reducer: (_old, value) => value,
        default: () => "UNVERSIONED_DEFAULT_SECRET",
      }),
    });
    const graph = new StateGraph(state)
      .addNode("increment", (value) => ({ count: value.count + 1 }))
      .addEdge(START, "increment")
      .addEdge("increment", END)
      .compile({ checkpointer: saver });
    const result = await graph.invoke({ count: 1 }, {
      configurable: { thread_id: "room:room-1:bot:agent-1" },
    });
    expect(result).toEqual({ count: 2, untouched: "UNVERSIONED_DEFAULT_SECRET" });
    expect(captured.some(({ checkpoint: value }) =>
      Object.hasOwn(value.channel_values, "untouched")
      && !Object.hasOwn(value.channel_versions, "untouched")
    )).toBeTrue();
    const ordinary = new InspectableInlinePostgresSaver({} as never);
    for (const [index, entry] of captured.entries()) {
      const ordinaryBlobs = await ordinary.dumpBlobs(
        entry.checkpoint.channel_values, entry.versions,
      );
      expect(Object.keys(store.putCalls[index]!.checkpoint.channel_values).sort())
        .toEqual(ordinaryBlobs.map((blob) => blob[2]).sort());
      expect(store.putCalls[index]!.checkpoint.channel_versions)
        .toEqual(entry.checkpoint.channel_versions);
    }
    expect(JSON.stringify(store.putCalls)).not.toContain("UNVERSIONED_DEFAULT_SECRET");
  });

  it("still rejects an unversioned cell injected into stored ciphertext", async () => {
    const { saver, store } = saverHarness();
    const result = await saver.put(config(), checkpoint(), metadata(), {
      messages: 2, optional_state: 1,
    });
    store.tuple!.checkpoint.channel_values["injected_default"] =
      store.tuple!.checkpoint.channel_values["messages"];
    expect(saver.getTuple(result)).rejects.toThrow("channel without a version");
  });

  it("projects the exact checkpoint shape and seals inline cells at shadow storage coordinates", async () => {
    const { store, crypto, saver } = saverHarness();

    const result = await saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );

    expect(result).toEqual({
      configurable: {
        thread_id: "room:room-1:bot:agent-1",
        checkpoint_ns: "foreground",
        checkpoint_id: "checkpoint-2",
      },
    });
    expect(store.putCalls).toHaveLength(1);
    const captured = store.putCalls[0]!;
    const storedConfig = requiredConfigurable(captured.config);
    expect(storedConfig.thread_id).not.toBe("room:room-1:bot:agent-1");
    expect(storedConfig.checkpoint_ns).not.toBe("foreground");
    expect(Object.keys(captured.checkpoint).sort()).toEqual([
      "channel_values",
      "channel_versions",
      "id",
      "ts",
      "v",
      "versions_seen",
    ]);
    expect(JSON.stringify(captured)).not.toContain("M237_SECRET");
    expect(JSON.stringify(captured)).not.toContain("M237_METADATA_SECRET");

    expect(crypto.seals.map(({ coordinate }) => coordinate)).toEqual([
      {
        kind: "channel",
        threadId: storedConfig.thread_id,
        checkpointNs: storedConfig.checkpoint_ns,
        channel: "messages",
        version: "2",
      },
      {
        kind: "channel",
        threadId: storedConfig.thread_id,
        checkpointNs: storedConfig.checkpoint_ns,
        channel: "optional_state",
        version: "1",
      },
      {
        kind: "metadata",
        threadId: storedConfig.thread_id,
        checkpointNs: storedConfig.checkpoint_ns,
        checkpointId: "checkpoint-2",
        parentCheckpointId: "checkpoint-1",
      },
    ]);

    const tuple = await saver.getTuple(result);
    expect(tuple?.checkpoint).toEqual(checkpoint());
    expect(tuple?.metadata).toEqual(metadata());
    expect(tuple?.config).toEqual(result);
    expect(tuple?.parentConfig).toEqual(config());
    expect(crypto.operations.map(({ operation }) => operation)).toEqual([
      "write",
      "cleanup",
      "read",
    ]);
    expect(crypto.operations.every(({ scope }) =>
      scope.authorizationSession === authorizationSession
      && scope.namespaceId === "namespace-1"
      && scope.keyClass === "ai"
      && scope.expectedAccessRevision === 7
      && scope.expectedPolicyRevision === 11
    )).toBeTrue();
  });

  it("reuses an unchanged physical channel blob across a later checkpoint", async () => {
    const { crypto, saver } = saverHarness();
    const first: Checkpoint = {
      v: 4,
      id: "checkpoint-1",
      ts: "2026-08-03T12:00:00.000Z",
      channel_values: {
        messages: [{ role: "user", content: "one physical blob" }],
      },
      channel_versions: { messages: 1 },
      versions_seen: { agent: { messages: 1 } },
    };
    const firstResult = await saver.put(
      {
        configurable: {
          thread_id: "room:room-1:bot:agent-1",
          checkpoint_ns: "foreground",
        },
      },
      first,
      metadata(),
      { messages: 1 },
    );
    const second: Checkpoint = {
      ...first,
      id: "checkpoint-2",
      ts: "2026-08-03T12:01:00.000Z",
      channel_values: structuredClone(first.channel_values),
    };
    const secondResult = await saver.put(
      firstResult,
      second,
      metadata(),
      {},
    );

    const channelSeals = crypto.seals.filter(
      ({ coordinate }) => coordinate.kind === "channel",
    );
    expect(channelSeals).toHaveLength(1);
    expect(channelSeals[0]?.coordinate).toMatchObject({
      kind: "channel",
      channel: "messages",
      version: "1",
    });
    expect(channelSeals[0]?.coordinate).not.toHaveProperty("checkpointId");
    expect((await saver.getTuple(secondResult))?.checkpoint).toEqual(second);
  });

  it("revives official LangChain message classes and wipes serialized plaintext buffers", async () => {
    const { crypto, saver } = saverHarness();
    const messageCheckpoint: Checkpoint = {
      v: 4,
      id: "checkpoint-message",
      ts: "2026-08-03T12:02:00.000Z",
      channel_values: {
        messages: [new HumanMessage("classified message")],
      },
      channel_versions: { messages: 1 },
      versions_seen: { agent: { messages: 1 } },
    };
    const result = await saver.put(
      {
        configurable: {
          thread_id: "room:room-1:bot:agent-1",
          checkpoint_ns: "foreground",
        },
      },
      messageCheckpoint,
      metadata(),
      { messages: 1 },
    );
    expect(crypto.sealPlaintextReferences.length).toBeGreaterThan(0);
    expect(crypto.sealPlaintextReferences.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBeTrue();

    const tuple = await saver.getTuple(result);
    const messages = tuple?.checkpoint.channel_values["messages"];
    expect(Array.isArray(messages)).toBeTrue();
    expect((messages as unknown[])[0]).toBeInstanceOf(HumanMessage);
    expect((messages as HumanMessage[])[0]?.content).toBe(
      "classified message",
    );
    expect(crypto.openPlaintextReferences.length).toBeGreaterThan(0);
    expect(crypto.openPlaintextReferences.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBeTrue();
  });

  it("rejects unexpected or missing raw checkpoint fields before sealing", async () => {
    const { store, crypto, saver } = saverHarness();
    const unexpected = {
      ...checkpoint(),
      private_extension: "must-never-reach-postgres",
    };

    expect(saver.put(
      config(),
      unexpected as Checkpoint,
      metadata(),
      { messages: 2 },
    )).rejects.toThrow("exact v4 field allowlist");
    const missing = { ...checkpoint() } as Partial<Checkpoint>;
    delete missing.versions_seen;
    expect(saver.put(
      config(),
      missing as Checkpoint,
      metadata(),
      { messages: 2 },
    )).rejects.toThrow("exact v4 field allowlist");
    expect(crypto.seals).toHaveLength(0);
    expect(crypto.operations).toHaveLength(0);
    expect(store.putCalls).toHaveLength(0);
  });

  it("binds pending writes to their exact persisted task, index, and channel", async () => {
    const { store, crypto, saver, writeCoordinateReader } = saverHarness();
    await saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );

    await saver.putWrites(
      {
        configurable: {
          thread_id: "room:room-1:bot:agent-1",
          checkpoint_ns: "foreground",
          checkpoint_id: "checkpoint-2",
        },
      },
      [
        ["normal-a", { secret: "M237_WRITE_ONE_SECRET" }],
        ["__error__", { secret: "M237_WRITE_ERROR_SECRET" }],
        ["normal-b", { secret: "M237_WRITE_TWO_SECRET" }],
      ],
      "task-7",
    );

    const storedConfig = requiredConfigurable(store.putWritesCalls[0]!.config);
    expect(crypto.seals.slice(-3).map(({ coordinate }) => coordinate)).toEqual([
      {
        kind: "write",
        threadId: storedConfig.thread_id,
        checkpointNs: storedConfig.checkpoint_ns,
        checkpointId: "checkpoint-2",
        taskId: "task-7",
        index: 0,
        channel: "normal-a",
      },
      {
        kind: "write",
        threadId: storedConfig.thread_id,
        checkpointNs: storedConfig.checkpoint_ns,
        checkpointId: "checkpoint-2",
        taskId: "task-7",
        index: -1,
        channel: "__error__",
      },
      {
        kind: "write",
        threadId: storedConfig.thread_id,
        checkpointNs: storedConfig.checkpoint_ns,
        checkpointId: "checkpoint-2",
        taskId: "task-7",
        index: 2,
        channel: "normal-b",
      },
    ]);
    expect(JSON.stringify(store.putWritesCalls)).not.toContain(
      "M237_WRITE_ONE_SECRET",
    );
    expect(JSON.stringify(store.putWritesCalls)).not.toContain(
      "M237_WRITE_ERROR_SECRET",
    );
    expect(JSON.stringify(store.putWritesCalls)).not.toContain(
      "M237_WRITE_TWO_SECRET",
    );

    const tuple = await saver.getTuple({
      configurable: {
        thread_id: "room:room-1:bot:agent-1",
        checkpoint_ns: "foreground",
        checkpoint_id: "checkpoint-2",
      },
    });
    expect(tuple?.pendingWrites).toEqual([
      ["task-7", "__error__", { secret: "M237_WRITE_ERROR_SECRET" }],
      ["task-7", "normal-a", { secret: "M237_WRITE_ONE_SECRET" }],
      ["task-7", "normal-b", { secret: "M237_WRITE_TWO_SECRET" }],
    ]);
    expect(writeCoordinateReader.calls).toHaveLength(1);
    expect(writeCoordinateReader.calls[0]).toEqual({
      threadId: storedConfig.thread_id,
      checkpointNs: storedConfig.checkpoint_ns,
      checkpointId: "checkpoint-2",
    });
  });

  it("rejects pending-write relocation, row substitution, and coordinate disagreement", async () => {
    for (const mutation of ["relocate", "substitute", "disagree"] as const) {
      const { store, saver } = saverHarness();
      await saver.put(
        config(),
        checkpoint(),
        metadata(),
        { messages: 2, optional_state: 1 },
      );
      await saver.putWrites(
        checkpointConfig(),
        [
          ["normal-a", { secret: "one" }],
          ["normal-b", { secret: "two" }],
        ],
        "task-7",
      );
      if (mutation === "relocate") {
        store.writeCoordinates[0] = {
          ...store.writeCoordinates[0]!,
          index: 9,
        };
      } else if (mutation === "substitute") {
        const writes = store.tuple!.pendingWrites!;
        [writes[0]![2], writes[1]![2]] = [writes[1]![2], writes[0]![2]];
      } else {
        store.tuple!.pendingWrites![0]![1] = "other-channel";
      }

      expect(saver.getTuple(checkpointConfig())).rejects.toThrow();
    }
  });

  it("fails closed for missing, plaintext, swapped, and corrupt protected cells", async () => {
    const cases = [
      {
        name: "missing",
        mutate(tuple: CheckpointTuple) {
          delete tuple.checkpoint.channel_values["messages"];
        },
      },
      {
        name: "plaintext",
        mutate(tuple: CheckpointTuple) {
          tuple.checkpoint.channel_values["messages"] = { plaintext: true };
        },
      },
      {
        name: "swapped",
        mutate(tuple: CheckpointTuple) {
          const values = tuple.checkpoint.channel_values;
          [values["messages"], values["optional_state"]] = [
            values["optional_state"],
            values["messages"],
          ];
        },
      },
      {
        name: "corrupt",
        mutate(tuple: CheckpointTuple) {
          const cell = tuple.checkpoint.channel_values["messages"] as Record<
            string,
            unknown
          >;
          cell["ciphertext"] = Buffer.from("not-a-sealed-token").toString(
            "base64",
          );
        },
      },
    ] as const;

    for (const testCase of cases) {
      const { store, saver } = saverHarness();
      await saver.put(
        config(),
        checkpoint(),
        metadata(),
        { messages: 2, optional_state: 1 },
      );
      testCase.mutate(store.tuple!);
      expect(saver.getTuple(checkpointConfig())).rejects.toThrow();
    }
  });

  it("rejects a valid protected row returned for another logical thread", async () => {
    const { store, saver } = saverHarness();
    await saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );
    store.tuple!.config.configurable!["thread_id"] =
      "nautilo:encrypted-checkpoint-shadow:v1:"
      + Buffer.from("room:other:bot:agent-1").toString("base64url");

    expect(saver.getTuple(checkpointConfig())).rejects.toThrow(
      "cross-coordinate row",
    );
  });

  it("rejects wrong-thread reads and deletes before authorization or storage", () => {
    const { store, crypto, saver } = saverHarness();
    const wrongThread = {
      configurable: {
        thread_id: "room:other:bot:agent-1",
        checkpoint_ns: "foreground",
      },
    };

    expect(saver.getTuple(wrongThread)).rejects.toThrow(
      "does not match invocation scope",
    );
    expect(saver.deleteThread("room:other:bot:agent-1")).rejects.toThrow(
      "does not match invocation scope",
    );
    expect(crypto.operations).toHaveLength(0);
    expect(store.getCalls).toHaveLength(0);
    expect(store.deleteCalls).toHaveLength(0);
  });

  it("fails closed when current authorization is revoked for read, write, or delete", () => {
    const { store, crypto, saver } = saverHarness();
    crypto.authorized = false;

    expect(saver.getTuple(checkpointConfig())).rejects.toThrow(
      "checkpoint authorization is unavailable",
    );
    expect(saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    )).rejects.toThrow("checkpoint authorization is unavailable");
    expect(saver.deleteThread("room:room-1:bot:agent-1")).rejects.toThrow(
      "checkpoint authorization is unavailable",
    );
    expect(crypto.operations.map(({ operation }) => operation)).toEqual([
      "read",
      "write",
      "delete",
    ]);
    expect(store.getCalls).toHaveLength(0);
    expect(store.putCalls).toHaveLength(0);
    expect(store.deleteCalls).toHaveLength(0);
    expect(crypto.successfulOperations).toBe(0);
    expect(crypto.failedOperations).toBe(3);
  });

  it("keeps SQL and each decrypt inside one abortable operation callback", async () => {
    const beforeSql = saverHarness();
    beforeSql.crypto.operationController.abort();
    expect(beforeSql.saver.getTuple(checkpointConfig())).rejects.toThrow(
      "authorized checkpoint operation is no longer active",
    );
    expect(beforeSql.store.getCalls).toHaveLength(0);
    expect(beforeSql.crypto.successfulOperations).toBe(0);

    const beforeDeadline = saverHarness();
    beforeDeadline.crypto.operationRemainingMs = 0;
    expect(beforeDeadline.saver.deleteThread(
      "room:room-1:bot:agent-1",
    )).rejects.toThrow(
      "authorized checkpoint operation is no longer active",
    );
    expect(beforeDeadline.store.deleteCalls).toHaveLength(0);

    const duringDecrypt = saverHarness();
    await duringDecrypt.saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(duringDecrypt.crypto.seals.every(({ signal }) =>
      signal === duringDecrypt.crypto.operationController.signal
    )).toBeTrue();
    const beforeReadSuccesses = duringDecrypt.crypto.successfulOperations;
    duringDecrypt.crypto.abortAfterOpen = 1;
    expect(duringDecrypt.saver.getTuple(checkpointConfig())).rejects.toThrow(
      "authorized checkpoint operation is no longer active",
    );
    expect(duringDecrypt.crypto.opens).toHaveLength(1);
    expect(duringDecrypt.crypto.opens[0]?.signal).toBe(
      duringDecrypt.crypto.operationController.signal,
    );
    expect(duringDecrypt.crypto.successfulOperations).toBe(
      beforeReadSuccesses,
    );
    expect(duringDecrypt.crypto.failedOperations).toBe(1);
  });

  it("rejects hanging crypto promptly and contains late plaintext completion", async () => {
    const sealing = saverHarness();
    sealing.crypto.sealGate = Promise.withResolvers<void>();
    const pendingPut = sealing.saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );
    await sealing.crypto.sealStarted.promise;
    sealing.crypto.operationController.abort();
    const putError = await settlePromptly(pendingPut);
    expect((putError as Error).message).toContain(
      "authorized checkpoint operation is no longer active",
    );
    expect(sealing.store.putCalls).toHaveLength(0);
    expect(sealing.crypto.sealPlaintextReferences[0]?.every(
      (byte) => byte === 0,
    )).toBeTrue();
    sealing.crypto.sealGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(sealing.store.putCalls).toHaveLength(0);

    const opening = saverHarness();
    await opening.saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    opening.crypto.openGate = Promise.withResolvers<void>();
    const pendingGet = opening.saver.getTuple(checkpointConfig());
    await opening.crypto.openStarted.promise;
    opening.crypto.operationController.abort();
    const getError = await settlePromptly(pendingGet);
    expect((getError as Error).message).toContain(
      "authorized checkpoint operation is no longer active",
    );
    opening.crypto.openGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(opening.crypto.openPlaintextReferences[0]?.every(
      (byte) => byte === 0,
    )).toBeTrue();
  });

  it("rejects protected metadata filters instead of forwarding plaintext", async () => {
    const { store, crypto, saver } = saverHarness();
    const consume = async () => {
      for await (const _tuple of saver.list(config(), {
        filter: { private: "M237_FILTER_SECRET" },
      })) {
        // no-op
      }
    };

    expect(consume()).rejects.toThrow(
      "metadata filters are unavailable for encrypted checkpoints",
    );
    expect(store.listCalls).toHaveLength(0);
    expect(crypto.operations).toHaveLength(0);
  });

  it("materializes one bounded default list page before authorization completes", async () => {
    const { store, crypto, saver } = saverHarness();
    await saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeListSuccesses = crypto.successfulOperations;
    const listed: CheckpointTuple[] = [];
    for await (const tuple of saver.list({
      configurable: {
        thread_id: "room:room-1:bot:agent-1",
        checkpoint_ns: "foreground",
      },
    })) {
      // The operation callback has already completed before the first yield.
      expect(crypto.successfulOperations).toBe(beforeListSuccesses + 1);
      listed.push(tuple);
    }

    expect(listed).toHaveLength(1);
    expect(store.listCalls[0]?.options?.limit).toBe(20);
  });

  it("reports separately authorized cleanup without falsifying durable put failure", async () => {
    const { crypto, saver, store } = saverHarness();
    crypto.deniedOperations.add("cleanup");

    const result = await saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );

    expect(result.configurable?.["checkpoint_id"]).toBe("checkpoint-2");
    expect(store.putCalls).toHaveLength(1);
    expect(crypto.operations.map(({ operation }) => operation)).toEqual([
      "write",
      "cleanup",
    ]);
    expect(crypto.successfulOperations).toBe(1);
    expect(crypto.failedOperations).toBe(1);
    expect(saver.pendingMaintenanceCount).toBe(1);
    const [outcome] = saver.takeMaintenanceOutcomes();
    expect(outcome?.status).toBe("failed");
    if (outcome?.status !== "failed") {
      throw new Error("expected typed maintenance failure");
    }
    expect(outcome.error.code).toBe(
      "encrypted_checkpoint_compaction_failed",
    );
    expect(outcome.error.attempt).toBe("post_put");
    expect(outcome.error.cause).toBeInstanceOf(Error);
  });

  it("accepts and compacts the first checkpoint without a parent checkpoint id", async () => {
    const { saver, store } = saverHarness();
    const firstConfig = config();
    delete firstConfig.configurable?.checkpoint_id;

    const result = await saver.put(
      firstConfig,
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );

    expect(result.configurable?.["checkpoint_id"]).toBe("checkpoint-2");
    expect(store.compactionCalls).toHaveLength(1);
    expect(
      store.compactionCalls[0]?.configurable?.["checkpoint_id"],
    ).toBe("checkpoint-2");
  });

  it("publishes strict compaction failure and explicitly retries the exact coordinate", async () => {
    const { crypto, saver, store } = saverHarness();
    const failure = new Error("strict checkpoint compaction failed");
    store.compactionError = failure;

    const result = await saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );
    expect(result.configurable?.["checkpoint_id"]).toBe("checkpoint-2");
    expect(store.putCalls).toHaveLength(1);
    expect(crypto.operations.map(({ operation }) => operation)).toEqual([
      "write",
      "cleanup",
    ]);
    expect(crypto.successfulOperations).toBe(1);
    expect(crypto.failedOperations).toBe(1);
    const [failed] = saver.takeMaintenanceOutcomes();
    expect(failed?.status).toBe("failed");
    if (failed?.status !== "failed") {
      throw new Error("expected typed maintenance failure");
    }
    expect(failed.error.cause).toBe(failure);
    expect(failed.error.coordinate.retainedCheckpointId).toBe(
      "checkpoint-2",
    );
    expect(saver.pendingMaintenanceCount).toBe(1);

    store.compactionError = undefined;
    const [recovered] = await saver.retryPendingMaintenance();
    expect(recovered).toEqual({
      status: "recovered",
      attempt: "explicit_retry",
      coordinate: failed.error.coordinate,
    });
    expect(saver.pendingMaintenanceCount).toBe(0);
    expect(store.compactionCalls).toHaveLength(2);
    expect(store.compactionCalls[1]).toEqual(store.compactionCalls[0]);
    expect(saver.takeMaintenanceOutcomes()).toEqual([recovered!]);
  });

  it("lets a later successful retained checkpoint supersede failed cleanup without retrying a stale coordinate", async () => {
    const { saver, store } = saverHarness();
    store.compactionError = new Error("first compaction failed");
    await saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );
    expect(saver.pendingMaintenanceCount).toBe(1);

    store.compactionError = undefined;
    const laterCheckpoint: Checkpoint = {
      ...checkpoint(),
      id: "checkpoint-3",
      channel_versions: {
        messages: 3,
        optional_state: 1,
      },
      versions_seen: {
        agent: {
          messages: 3,
          optional_state: 1,
        },
      },
    };
    await saver.put(
      checkpointConfig(),
      laterCheckpoint,
      metadata(),
      { messages: 3, optional_state: 1 },
    );

    expect(saver.pendingMaintenanceCount).toBe(0);
    expect(store.compactionCalls).toHaveLength(2);
    const outcomes = saver.takeMaintenanceOutcomes();
    expect(outcomes.map(({ status }) => status)).toEqual([
      "failed",
      "recovered",
    ]);
    if (outcomes[0]?.status !== "failed") {
      throw new Error("expected initial maintenance failure");
    }
    expect(outcomes[1]).toEqual({
      status: "recovered",
      attempt: "post_put",
      coordinate: {
        threadId: outcomes[0].error.coordinate.threadId,
        checkpointNs: outcomes[0].error.coordinate.checkpointNs,
        retainedCheckpointId: "checkpoint-3",
      },
    });
    expect(await saver.retryPendingMaintenance()).toEqual([]);
    expect(store.compactionCalls).toHaveLength(2);
  });

  it("end waits for an accepted put and its cleanup, closes once, and rejects new work", async () => {
    let endCalls = 0;
    const harness = saverHarness(() => {
      endCalls += 1;
      return Promise.resolve();
    });
    harness.crypto.sealGate = Promise.withResolvers<void>();
    const pendingPut = harness.saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );
    await harness.crypto.sealStarted.promise;

    const firstEnd = harness.saver.end();
    const secondEnd = harness.saver.end();
    await Promise.resolve();
    expect(endCalls).toBe(0);
    expect(harness.saver.deleteThread(
      "room:room-1:bot:agent-1",
    )).rejects.toThrow("saver is closing");

    harness.crypto.sealGate.resolve();
    await pendingPut;
    await Promise.all([firstEnd, secondEnd]);
    expect(harness.crypto.operations.map(({ operation }) => operation)).toEqual([
      "write",
      "cleanup",
    ]);
    expect(endCalls).toBe(1);
  });

  it("rejects unbounded/invalid list limits and malformed cursors before authorization", () => {
    const cases: Array<{
      options: ListOptions;
      message: string;
    }> = [
      { options: { limit: 0 }, message: "positive safe integer" },
      { options: { limit: 101 }, message: "at most 100" },
      { options: { limit: 1.5 }, message: "positive safe integer" },
      {
        options: {
          before: {
            configurable: {
              thread_id: "room:room-1:bot:agent-1",
              checkpoint_ns: "foreground",
            },
          },
        },
        message: "requires checkpoint_id",
      },
      {
        options: {
          before: {
            configurable: {
              thread_id: "room:room-1:bot:agent-1",
              checkpoint_ns: "other",
              checkpoint_id: "checkpoint-1",
            },
          },
        },
        message: "cursor does not match",
      },
    ];

    for (const testCase of cases) {
      const { crypto, saver, store } = saverHarness();
      const consume = async () => {
        for await (const _tuple of saver.list({
          configurable: {
            thread_id: "room:room-1:bot:agent-1",
            checkpoint_ns: "foreground",
          },
        }, testCase.options)) {
          // no-op
        }
      };
      expect(consume()).rejects.toThrow(testCase.message);
      expect(crypto.operations).toHaveLength(0);
      expect(store.listCalls).toHaveLength(0);
    }
  });

  it("maps list cursors and deleteThread into the isolated shadow coordinate", async () => {
    const { store, saver } = saverHarness();
    store.captureCompaction();
    await saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2, optional_state: 1 },
    );

    const listed: CheckpointTuple[] = [];
    for await (const tuple of saver.list(
      {
        configurable: {
          thread_id: "room:room-1:bot:agent-1",
          checkpoint_ns: "foreground",
        },
      },
      { before: config(), limit: 10 },
    )) {
      listed.push(tuple);
    }
    expect(listed).toHaveLength(1);
    expect(listed[0]?.checkpoint).toEqual(checkpoint());
    const listCall = store.listCalls[0]!;
    expect(requiredConfigurable(listCall.config).thread_id).not.toBe(
      "room:room-1:bot:agent-1",
    );
    expect(
      requiredConfigurable(listCall.options!.before!).thread_id,
    ).toBe(requiredConfigurable(listCall.config).thread_id);

    await saver.deleteThread("room:room-1:bot:agent-1");
    expect(store.deleteCalls).toHaveLength(1);
    expect(store.deleteCalls[0]).not.toBe("room:room-1:bot:agent-1");
    expect(store.deleteCalls[0]).toBe(
      requiredConfigurable(listCall.config).thread_id,
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (store.compactionQueries.some(({ params }) => params !== undefined)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const compactionParams = store.compactionQueries
      .flatMap(({ params }) => params === undefined ? [] : [params])
      .filter((params) => params.length >= 2);
    expect(compactionParams.length).toBeGreaterThanOrEqual(3);
    for (const params of compactionParams) {
      expect(params[0]).toBe(requiredConfigurable(listCall.config).thread_id);
      expect(params[1]).toBe(
        requiredConfigurable(listCall.config).checkpoint_ns,
      );
    }
  });

  it("rethrows final delegate put and putWrites failures", async () => {
    const putHarness = saverHarness();
    const putError = new Error("final put failed");
    putHarness.store.putError = putError;
    expect(putHarness.saver.put(
      config(),
      checkpoint(),
      metadata(),
      { messages: 2 },
    )).rejects.toBe(putError);
    expect(putHarness.crypto.successfulOperations).toBe(0);
    expect(putHarness.crypto.failedOperations).toBe(1);

    const writesHarness = saverHarness();
    const writesError = new Error("final writes failed");
    writesHarness.store.putWritesError = writesError;
    expect(writesHarness.saver.putWrites(
      {
        configurable: {
          thread_id: "room:room-1:bot:agent-1",
          checkpoint_ns: "foreground",
          checkpoint_id: "checkpoint-2",
        },
      },
      [["messages", { private: true }]],
      "task-1",
    )).rejects.toBe(writesError);
    expect(writesHarness.crypto.successfulOperations).toBe(0);
    expect(writesHarness.crypto.failedOperations).toBe(1);
  });

  it("rejects malformed pending-write inputs before authorization", () => {
    const { crypto, saver, store } = saverHarness();

    expect(saver.putWrites(
      {
        configurable: {
          thread_id: "room:room-1:bot:agent-1",
          checkpoint_ns: "foreground",
          checkpoint_id: "checkpoint-2",
        },
      },
      [["messages", { private: true }]],
      "",
    )).rejects.toThrow("require taskId");

    expect(crypto.operations).toHaveLength(0);
    expect(store.putWritesCalls).toHaveLength(0);
  });
});

describe("OperationBoundCheckpointPool", () => {
  const cell = {
    $nautiloCheckpointCell: 1 as const,
    ciphertext: Buffer.from("sealed-value").toString("base64"),
  };

  for (
    const [operation, sql] of [
      ["put/putWrites", "INSERT INTO checkpoint_writes VALUES (1)"],
      ["deleteThread", "DELETE FROM checkpoints WHERE thread_id = 'x'"],
      ["compaction", "DELETE FROM checkpoint_blobs WHERE thread_id = 'x'"],
    ] as const
  ) {
    it(`rolls back ${operation} durably when the fresh pre-COMMIT fence fails`, async () => {
      const pool = new DurableTransactionPgPool();
      const fenceEntered = Promise.withResolvers<void>();
      const fence = Promise.withResolvers<void>();
      const controller = new AbortController();
      const boundPool = new OperationBoundCheckpointPool(
        pool as never,
        {
          signal: controller.signal,
          assertActive: () => undefined,
          assertCommitAllowed: () => {
            fenceEntered.resolve();
            return fence.promise;
          },
          remainingMs: () => 60_000,
        },
      );

      const pending = boundPool.query(sql);
      await fenceEntered.promise;
      expect(pool.client.staged).toBeTrue();
      expect(pool.client.durable).toBeFalse();
      fence.reject(new Error("authorization head changed"));

      expect(pending).rejects.toThrow("authorization head changed");
      expect(pool.client.queries).toContain("ROLLBACK");
      expect(pool.client.queries).not.toContain("COMMIT");
      expect(pool.client.staged).toBeFalse();
      expect(pool.client.durable).toBeFalse();
      expect(pool.client.releaseCalls).toBe(1);
    });
  }

  it("commits after a successful fresh authority observation without claiming cross-transaction revocation atomicity", async () => {
    const pool = new DurableTransactionPgPool();
    let observations = 0;
    const controller = new AbortController();
    const boundPool = new OperationBoundCheckpointPool(
      pool as never,
      {
        signal: controller.signal,
        assertActive: () => undefined,
        assertCommitAllowed: () => {
          observations += 1;
          return Promise.resolve();
        },
        remainingMs: () => 60_000,
      },
    );

    await boundPool.query("INSERT INTO checkpoint_writes VALUES (1)");

    expect(observations).toBe(1);
    expect(pool.client.queries).toContain("COMMIT");
    expect(pool.client.queries).not.toContain("ROLLBACK");
    expect(pool.client.durable).toBeTrue();
  });

  for (const operation of ["put", "putWrites", "deleteThread"] as const) {
    for (const expiry of ["abort", "deadline"] as const) {
      it(`${operation} destroys the blocked client without COMMIT when ${expiry} wins`, async () => {
        const pool = new BlockingPgPool();
        const crypto = new CoordinateCheckingCrypto();
        if (expiry === "deadline") {
          crypto.operationRemainingMs = 10;
        }
        const saver = pinnedSaver(pool, operationContext(crypto));
        let pending: Promise<unknown>;
        if (operation === "put") {
          pending = saver.put(
            config(),
            {
              ...checkpoint(),
              channel_values: { messages: cell },
            },
            cell as never,
            { messages: 2 },
          );
        } else if (operation === "putWrites") {
          pending = saver.putWrites(
            checkpointConfig(),
            [["messages", cell]],
            "task-1",
          );
        } else {
          pending = saver.deleteThread("shadow-thread");
        }

        await pool.client.blocked.promise;
        if (expiry === "abort") {
          crypto.operationController.abort();
        }
        const error = await settlePromptly(pending);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "authorized checkpoint operation is no longer active",
        );
        expect(pool.client.destroyed).toBeTrue();
        expect(pool.client.releaseErrors).toContain(true);
        const commands = pool.client.queries.map(({ text }) =>
          text.trim().toUpperCase()
        );
        expect(commands).not.toContain("COMMIT");
        expect(commands.some((command) =>
          command === `SET LOCAL STATEMENT_TIMEOUT = ${
            expiry === "deadline" ? 10 : 60_000
          }`
        )).toBeTrue();

        // A late driver resolution is contained: it cannot resume the pinned
        // saver into COMMIT, and the physical client cannot be checked out.
        pool.client.unblock();
        await Promise.resolve();
        await Promise.resolve();
        expect(pool.client.queries.map(({ text }) =>
          text.trim().toUpperCase()
        )).not.toContain("COMMIT");
        expect(pinnedSaver(
          pool,
          operationContext(new CoordinateCheckingCrypto()),
        ).getTuple(checkpointConfig())).rejects.toThrow(
          "test pool refused a destroyed client",
        );
      });
    }
  }

  for (const expiry of ["abort", "deadline"] as const) {
    it(`rejects a blocked checkout promptly on ${expiry} and destroys the late client`, async () => {
      const pool = new BlockingCheckoutPool();
      const crypto = new CoordinateCheckingCrypto();
      if (expiry === "deadline") {
        crypto.operationRemainingMs = 10;
      }
      const boundPool = new OperationBoundCheckpointPool(
        pool as never,
        operationContext(crypto),
      );

      const pending = boundPool.connect();
      if (expiry === "abort") {
        crypto.operationController.abort();
      }
      const error = await settlePromptly(pending);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "authorized checkpoint operation is no longer active",
      );

      const lateClient = new BlockingPgClient();
      pool.checkout.resolve(lateClient);
      await Promise.resolve();
      await Promise.resolve();
      expect(lateClient.destroyed).toBeTrue();
      expect(lateClient.releaseErrors).toContain(true);
      expect(lateClient.queries).toHaveLength(0);
    });
  }

  it("rejects non-positive or unbounded authority durations before checkout", () => {
    for (const remainingMs of [0, -1, 2_147_483_648]) {
      const pool = new BlockingPgPool();
      const controller = new AbortController();
      const boundPool = new OperationBoundCheckpointPool(
        pool as never,
        {
          signal: controller.signal,
          assertActive: () => undefined,
          assertCommitAllowed: () => Promise.resolve(),
          remainingMs: () => remainingMs,
        },
      );

      expect(boundPool.connect()).rejects.toThrow(
        "remaining time is malformed",
      );
      expect(pool.connectCalls).toBe(0);
    }
  });

  it("runs direct reads through a checked transaction and rejects before decrypt", async () => {
    const pool = new BlockingPgPool();
    const crypto = new CoordinateCheckingCrypto();
    const serializer = new InlineCheckpointCellSerializer();
    const operationStoreFactory: CheckpointOperationStoreFactory = {
      serializer,
      schema: "langchain",
      create: (context) => {
        const boundPool = new OperationBoundCheckpointPool(
          pool as never,
          context,
        );
        return {
          checkpointStore: new PostgresSaver(
            boundPool as never,
            serializer,
            { schema: "langchain" },
          ),
          writeCoordinateReader:
            new PostgresCheckpointWriteCoordinateReader(boundPool as never),
          compact: () => Promise.resolve(),
        };
      },
      end: () => Promise.resolve(),
    };
    const saver = new EncryptedCheckpointSaver({
      operationStoreFactory,
      crypto,
      scope: invocationScope(),
    });

    const pending = saver.getTuple(checkpointConfig());
    await pool.client.blocked.promise;
    crypto.operationController.abort();
    const error = await settlePromptly(pending);
    expect(pool.client.destroyed).toBeTrue();
    pool.client.unblock([{ ciphertext: "must-not-be-decoded" }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "authorized checkpoint operation is no longer active",
    );
    expect(crypto.opens).toHaveLength(0);
    expect(pool.directQueryCalls).toBe(0);
    expect(pool.client.queries.map(({ text }) =>
      text.trim().toUpperCase()
    )).not.toContain("COMMIT");
  });
});

describe("InlineCheckpointCellSerializer", () => {
  it("reads physical write coordinates from only the fixed langchain schema", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const reader = new PostgresCheckpointWriteCoordinateReader({
      query: async (text: string, params?: unknown[]) => {
        calls.push({
          text,
          ...(params === undefined ? {} : { params }),
        });
        return {
          rows: [
            { task_id: "task-1", idx: -1, channel: "__error__" },
            { task_id: "task-1", idx: 2, channel: "messages" },
          ],
        };
      },
    } as never);

    expect(await reader.readPendingWriteCoordinates({
      threadId: "shadow-thread",
      checkpointNs: "shadow-namespace",
      checkpointId: "checkpoint-2",
    })).toEqual([
      { taskId: "task-1", index: -1, channel: "__error__" },
      { taskId: "task-1", index: 2, channel: "messages" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(
      "FROM langchain.checkpoint_writes",
    );
    expect(calls[0]?.text).not.toContain("shadow-thread");
    expect(calls[0]?.params).toEqual([
      "shadow-thread",
      "shadow-namespace",
      "checkpoint-2",
    ]);
  });

  it("is mandatory on the wrapped PostgresSaver", () => {
    expect(() => new EncryptedCheckpointSaver({
      operationStoreFactory: {
        serializer: new PostgresSaver({} as never).serde,
        schema: "langchain",
        create: () => {
          throw new Error("not reached");
        },
        end: () => Promise.resolve(),
      },
      crypto: new CoordinateCheckingCrypto(),
      scope: invocationScope(),
    })).toThrow("requires the strict inline-cell serializer");
  });

  it("rejects a wrapped saver whose schema can diverge from compaction", () => {
    expect(() => new EncryptedCheckpointSaver({
      operationStoreFactory: {
        serializer: new InlineCheckpointCellSerializer(),
        schema: "other",
        create: () => {
          throw new Error("not reached");
        },
        end: () => Promise.resolve(),
      },
      crypto: new CoordinateCheckingCrypto(),
      scope: invocationScope(),
    })).toThrow("requires the fixed langchain schema");
  });

  it("traverses the real pinned PostgresSaver metadata, blob, and write hooks", async () => {
    const serializer = new InlineCheckpointCellSerializer();
    const saver = new InspectableInlinePostgresSaver(
      {} as never,
      serializer,
      { schema: "langchain" },
    );
    const cell = {
      $nautiloCheckpointCell: 1 as const,
      ciphertext: Buffer.from("sealed-channel").toString("base64"),
    };
    const writeCell = {
      $nautiloCheckpointCell: 1 as const,
      ciphertext: Buffer.from("sealed-write").toString("base64"),
    };

    const metadata = await saver.dumpMetadata(cell);
    const blobs = await saver.dumpBlobs({ messages: cell });
    const writes = await saver.dumpWrites([["messages", writeCell]]);

    expect(metadata).toEqual(cell);
    expect(blobs[0]?.[4]).toBe("nautilo.encrypted-checkpoint-cell.v1");
    expect(writes[0]?.[6]).toBe("nautilo.encrypted-checkpoint-cell.v1");
    expect(await saver.loadMetadata(
      metadata as Record<string, unknown>,
    )).toEqual(cell);
    expect(await saver.loadBlobs([[
      new TextEncoder().encode(blobs[0]![2]),
      new TextEncoder().encode(blobs[0]![4]),
      blobs[0]![5]!,
    ]])).toEqual({ messages: cell });
    expect(await saver.loadWrites([[
      new TextEncoder().encode(writes[0]![3]),
      new TextEncoder().encode(writes[0]![5]),
      new TextEncoder().encode(writes[0]![6]),
      writes[0]![7],
    ]])).toEqual([["task-1", "messages", writeCell]]);
  });

  it("round-trips only strict opaque cells and rejects plaintext or malformed input", async () => {
    const serializer = new InlineCheckpointCellSerializer();
    const cell = {
      $nautiloCheckpointCell: 1 as const,
      ciphertext: Buffer.from("sealed").toString("base64"),
    };
    const [type, bytes] = await serializer.dumpsTyped(cell);
    expect(type).toBe("nautilo.encrypted-checkpoint-cell.v1");
    expect(await serializer.loadsTyped(type, bytes)).toEqual(cell);

    expect(serializer.dumpsTyped({ private: "plaintext" }))
      .rejects.toThrow("opaque encrypted checkpoint cell");
    expect(serializer.loadsTyped("json", bytes))
      .rejects.toThrow("unexpected encrypted checkpoint cell type");
    expect(serializer.loadsTyped(
      type,
      new TextEncoder().encode(JSON.stringify({
        ...cell,
        unexpected: true,
      })),
    )).rejects.toThrow("malformed encrypted checkpoint cell");
  });
});
