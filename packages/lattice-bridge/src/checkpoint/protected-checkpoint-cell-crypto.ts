import {
  type HistoricalCommitterResolver,
  type LatticeCrypto,
  type LatticeStorage,
  portableIdIsValid,
} from "@nautilo/lattice-crypto";

import {
  executeProtectedGrantSessionCapabilityOperation,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthorityPort,
  type ProtectedGrantOperation,
  type ProtectedGrantUnavailableReason,
  type ProtectedInvocationCapability,
} from "../invocation/protected-grant-invocation.ts";
import {
  PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS,
  type ProtectedAgentRuntimeForegroundEntrypointId,
} from "../invocation/protected-agent-runtime.ts";
import {
  withProtectedCurrentNamespaceKeyring,
  type ProtectedNamespaceKeyringMaterial,
} from "../invocation/protected-namespace-keyring.ts";

const CHECKPOINT_CELL_KEY_DOMAIN =
  "nautilo/lattice-crypto/checkpoint-cell-key/v1";
const CHECKPOINT_CELL_AAD_DOMAIN =
  "nautilo/lattice-crypto/checkpoint-cell-aad/v1";
const CHECKPOINT_CELL_MAGIC = Object.freeze([0x4e, 0x43, 0x43, 0x31]);
const CHECKPOINT_CELL_HEADER_BYTES = 12;
const CHECKPOINT_CELL_KEY_BYTES = 32;
const MAX_CHECKPOINT_CELL_BYTES = 64 * 1024 * 1024;
const MAX_COORDINATE_TEXT_BYTES = 4_096;
const textEncoder = new TextEncoder();
const protectedCheckpointEntrypoints = new Set<string>(
  PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS,
);
const reservedCheckpointChannels = new Set<string>([
  // LangGraph's initial checkpoint versions its reserved input channel.
  "__start__",
  // LangGraph records successful tasks that produced no state updates.
  "__no_writes__",
  "__error__",
  "__scheduled__",
  "__interrupt__",
  "__resume__",
]);

export type ProtectedCheckpointCellCoordinate =
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

export type ProtectedCheckpointInvocationScope = Readonly<{
  logicalThreadId: string;
  namespaceId: string;
  keyClass: "ai";
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  authorizationSession: unknown;
}>;

export type ProtectedCheckpointAuthorizationOperation =
  | "read"
  | "write"
  | "delete"
  | "cleanup";

export type ProtectedCheckpointAuthorizedOperationContext = Readonly<{
  signal: AbortSignal;
  assertActive(): void;
  /**
   * Observe current product authority immediately before checkpoint COMMIT.
   * This is a freshness fence, not a cross-transaction atomic revocation lock.
   */
  assertCommitAllowed(): Promise<void>;
  remainingMs(): number;
}>;

export type ProtectedCheckpointNamespaceMaterial = Pick<
  ProtectedNamespaceKeyringMaterial,
  | "namespaceId"
  | "domainId"
  | "accessRevision"
  | "agentAuthorizationRevision"
  | "currentGeneration"
  | "generations"
>;

export type ProtectedCheckpointNamespaceOperationContext =
  ProtectedCheckpointAuthorizedOperationContext
  & Readonly<{ material: ProtectedCheckpointNamespaceMaterial }>;

export type ProtectedCheckpointNamespaceContentResult<Value> =
  | Readonly<{ status: "executed"; value: Value }>
  | Readonly<{
      status: "unavailable";
      reason:
        | ProtectedGrantUnavailableReason
        | "namespace_unavailable"
        | "namespace_invalid";
    }>;

/**
 * Bridge-owned root/keyring opener. Runtime can route a live capability
 * through this port, but Namespace key bytes exist only during `execute`.
 */
export interface ProtectedCheckpointNamespaceSessionContentExecutor {
  execute<Value>(input: Readonly<{
    capability: ProtectedInvocationCapability;
    entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    operation: ProtectedGrantOperation;
    namespaceId: string;
    domainId: string;
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
    signal?: AbortSignal;
    execute(
      material: ProtectedCheckpointNamespaceMaterial,
      /**
       * Re-observe current Namespace/grant authority. A successful observation
       * is not atomically ordered with a later revocation transaction.
       */
      assertCurrentAuthority: () => Promise<void>,
    ): Value | PromiseLike<Value>;
  }>): Promise<ProtectedCheckpointNamespaceContentResult<Value>>;
}

export interface ProtectedCheckpointCellAuthorityPort {
  execute<Value>(input: Readonly<{
    authorizationSession: unknown;
    entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    operation: ProtectedGrantOperation;
    namespaceId: string;
    domainId: string;
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
    execute(
      context: ProtectedCheckpointNamespaceOperationContext,
    ): Promise<Value>;
  }>): Promise<Value>;
}

export interface ProtectedCheckpointCellCrypto {
  executeAuthorizedOperation<Value>(input: Readonly<{
    operation: ProtectedCheckpointAuthorizationOperation;
    scope: ProtectedCheckpointInvocationScope;
    execute(
      context: ProtectedCheckpointAuthorizedOperationContext,
    ): Promise<Value>;
  }>): Promise<Value>;
  seal(input: Readonly<{
    scope: ProtectedCheckpointInvocationScope;
    coordinate: ProtectedCheckpointCellCoordinate;
    plaintext: Uint8Array;
    signal: AbortSignal;
  }>): Promise<Uint8Array>;
  open(input: Readonly<{
    scope: ProtectedCheckpointInvocationScope;
    coordinate: ProtectedCheckpointCellCoordinate;
    ciphertext: Uint8Array;
    signal: AbortSignal;
  }>): Promise<Uint8Array>;
}

export type ProtectedCheckpointCryptoErrorCode =
  | "authentication_failed"
  | "authorization_unavailable"
  | "cell_malformed"
  | "content_invalid"
  | "content_unavailable"
  | "coordinate_invalid"
  | "operation_mismatch"
  | "scope_invalid";

export class ProtectedCheckpointCryptoError extends Error {
  readonly code: ProtectedCheckpointCryptoErrorCode;

  constructor(
    code: ProtectedCheckpointCryptoErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProtectedCheckpointCryptoError";
    this.code = code;
  }
}

type ActiveCellOperation = Readonly<{
  operation: ProtectedCheckpointAuthorizationOperation;
  scope: ProtectedCheckpointInvocationScope;
  material: ProtectedCheckpointNamespaceMaterial;
  context: ProtectedCheckpointAuthorizedOperationContext;
}>;

type ProtectedCheckpointSealInput = Readonly<{
  scope: ProtectedCheckpointInvocationScope;
  coordinate: ProtectedCheckpointCellCoordinate;
  plaintext: Uint8Array;
  signal: AbortSignal;
}>;

type ProtectedCheckpointOpenInput = Readonly<{
  scope: ProtectedCheckpointInvocationScope;
  coordinate: ProtectedCheckpointCellCoordinate;
  ciphertext: Uint8Array;
  signal: AbortSignal;
}>;

function portableText(value: unknown): value is string {
  return typeof value === "string"
    && portableIdIsValid(value)
    && textEncoder.encode(value).length <= MAX_COORDINATE_TEXT_BYTES;
}

function physicalCheckpointCoordinateText(value: unknown): value is string {
  // These are storage coordinates, not portable authority IDs. The saver adds
  // a prefix and base64url encoding, so UUID-shaped Room/Agent thread IDs
  // legitimately exceed the portable ID limit while retaining its grammar.
  return typeof value === "string"
    && textEncoder.encode(value).length <= MAX_COORDINATE_TEXT_BYTES
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value);
}

function checkpointChannelText(value: unknown): value is string {
  return (
    typeof value === "string"
    && textEncoder.encode(value).length <= MAX_COORDINATE_TEXT_BYTES
    && (
      reservedCheckpointChannels.has(value)
      || portableIdIsValid(value)
    )
  );
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertScope(
  scope: ProtectedCheckpointInvocationScope,
): ProtectedCheckpointInvocationScope {
  if (
    typeof scope !== "object"
    || scope === null
    || !portableText(scope.logicalThreadId)
    || !portableText(scope.namespaceId)
    || scope.keyClass !== "ai"
    || !validCounter(scope.expectedAccessRevision)
    || !validCounter(scope.expectedPolicyRevision)
    || scope.authorizationSession === null
    || scope.authorizationSession === undefined
  ) {
    throw new ProtectedCheckpointCryptoError(
      "scope_invalid",
      "protected checkpoint scope is invalid",
    );
  }
  return scope;
}

function assertCoordinate(
  coordinate: ProtectedCheckpointCellCoordinate,
): void {
  if (
    typeof coordinate !== "object"
    || coordinate === null
    || !physicalCheckpointCoordinateText(coordinate.threadId)
    || !physicalCheckpointCoordinateText(coordinate.checkpointNs)
  ) {
    throw new ProtectedCheckpointCryptoError(
      "coordinate_invalid",
      "protected checkpoint coordinate is invalid",
    );
  }
  if (
    coordinate.kind === "metadata"
    && portableText(coordinate.checkpointId)
    && (
      coordinate.parentCheckpointId === null
      || portableText(coordinate.parentCheckpointId)
    )
  ) {
    return;
  }
  if (
    coordinate.kind === "channel"
    && checkpointChannelText(coordinate.channel)
    && portableText(coordinate.version)
  ) {
    return;
  }
  if (
    coordinate.kind === "write"
    && portableText(coordinate.checkpointId)
    && portableText(coordinate.taskId)
    && Number.isSafeInteger(coordinate.index)
    && checkpointChannelText(coordinate.channel)
  ) {
    return;
  }
  throw new ProtectedCheckpointCryptoError(
    "coordinate_invalid",
    "protected checkpoint coordinate is invalid",
  );
}

function scopeMatches(
  left: ProtectedCheckpointInvocationScope,
  right: ProtectedCheckpointInvocationScope,
): boolean {
  return (
    left.logicalThreadId === right.logicalThreadId
    && left.namespaceId === right.namespaceId
    && left.keyClass === right.keyClass
    && left.expectedAccessRevision === right.expectedAccessRevision
    && left.expectedPolicyRevision === right.expectedPolicyRevision
    && left.authorizationSession === right.authorizationSession
  );
}

function canonicalCoordinate(
  coordinate: ProtectedCheckpointCellCoordinate,
): readonly unknown[] {
  switch (coordinate.kind) {
    case "metadata":
      return [
        coordinate.kind,
        coordinate.threadId,
        coordinate.checkpointNs,
        coordinate.checkpointId,
        coordinate.parentCheckpointId,
      ];
    case "channel":
      return [
        coordinate.kind,
        coordinate.threadId,
        coordinate.checkpointNs,
        coordinate.channel,
        coordinate.version,
      ];
    case "write":
      return [
        coordinate.kind,
        coordinate.threadId,
        coordinate.checkpointNs,
        coordinate.checkpointId,
        coordinate.taskId,
        coordinate.index,
        coordinate.channel,
      ];
  }
}

function cellAad(
  scope: ProtectedCheckpointInvocationScope,
  domainId: string,
  generation: number,
  coordinate: ProtectedCheckpointCellCoordinate,
): Uint8Array {
  return textEncoder.encode(JSON.stringify([
    CHECKPOINT_CELL_AAD_DOMAIN,
    scope.namespaceId,
    domainId,
    scope.expectedAccessRevision,
    scope.expectedPolicyRevision,
    generation,
    ...canonicalCoordinate(coordinate),
  ]));
}

function deriveCellKey(
  crypto: LatticeCrypto,
  namespaceKey: Uint8Array,
): Uint8Array {
  if (namespaceKey.length !== CHECKPOINT_CELL_KEY_BYTES) {
    throw new ProtectedCheckpointCryptoError(
      "scope_invalid",
      "protected checkpoint Namespace key is invalid",
    );
  }
  return crypto.deriveKey(
    namespaceKey,
    CHECKPOINT_CELL_KEY_DOMAIN,
    CHECKPOINT_CELL_KEY_BYTES,
  );
}

function encodeCell(generation: number, body: Uint8Array): Uint8Array {
  if (
    !validCounter(generation)
    || body.length === 0
    || body.length > MAX_CHECKPOINT_CELL_BYTES
  ) {
    throw new ProtectedCheckpointCryptoError(
      "cell_malformed",
      "protected checkpoint cell is malformed",
    );
  }
  const cell = new Uint8Array(CHECKPOINT_CELL_HEADER_BYTES + body.length);
  cell.set(CHECKPOINT_CELL_MAGIC, 0);
  new DataView(cell.buffer).setBigUint64(4, BigInt(generation));
  cell.set(body, CHECKPOINT_CELL_HEADER_BYTES);
  return cell;
}

function decodeCell(
  ciphertext: Uint8Array,
): Readonly<{ generation: number; body: Uint8Array }> {
  if (
    !(ciphertext instanceof Uint8Array)
    || ciphertext.length <= CHECKPOINT_CELL_HEADER_BYTES
    || ciphertext.length
      > CHECKPOINT_CELL_HEADER_BYTES + MAX_CHECKPOINT_CELL_BYTES
    || !CHECKPOINT_CELL_MAGIC.every((byte, index) =>
      ciphertext[index] === byte
    )
  ) {
    throw new ProtectedCheckpointCryptoError(
      "cell_malformed",
      "protected checkpoint cell is malformed",
    );
  }
  const value = new DataView(
    ciphertext.buffer,
    ciphertext.byteOffset,
    CHECKPOINT_CELL_HEADER_BYTES,
  ).getBigUint64(4);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtectedCheckpointCryptoError(
      "cell_malformed",
      "protected checkpoint cell generation is invalid",
    );
  }
  return Object.freeze({
    generation: Number(value),
    body: ciphertext.slice(CHECKPOINT_CELL_HEADER_BYTES),
  });
}

function mapOperation(
  operation: ProtectedCheckpointAuthorizationOperation,
): ProtectedGrantOperation {
  return operation === "read" ? "decrypt" : "encrypt";
}

function assertActiveContext(
  context: ProtectedCheckpointAuthorizedOperationContext,
): void {
  context.assertActive();
  const remaining = context.remainingMs();
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new ProtectedCheckpointCryptoError(
      "authorization_unavailable",
      "protected checkpoint operation authority expired",
    );
  }
  if (context.signal.aborted) {
    throw new ProtectedCheckpointCryptoError(
      "authorization_unavailable",
      "protected checkpoint operation was cancelled",
    );
  }
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function fromSynchronous<Value>(execute: () => Value): Promise<Value> {
  try {
    return Promise.resolve(execute());
  } catch (error) {
    return Promise.reject(
      error instanceof Error
        ? error
        : new Error("protected checkpoint operation failed"),
    );
  }
}

/**
 * Concrete CheckpointCellCrypto implementation. The active operation table is
 * instance-local and keyed by the authority-owned AbortSignal; it is neither
 * process-global nor AsyncLocalStorage, and entries are deleted on every exit.
 */
export function createProtectedCheckpointCellCrypto(input: Readonly<{
  crypto: LatticeCrypto;
  authority: ProtectedCheckpointCellAuthorityPort;
  domainId: string;
  entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
}>): ProtectedCheckpointCellCrypto {
  if (!portableText(input.domainId)) {
    throw new ProtectedCheckpointCryptoError(
      "scope_invalid",
      "protected checkpoint Domain id is invalid",
    );
  }
  const active = new WeakMap<AbortSignal, ActiveCellOperation>();

  function requireActive(
    scope: ProtectedCheckpointInvocationScope,
    signal: AbortSignal,
    expected: "read" | "write",
  ): ActiveCellOperation {
    const operation = active.get(signal);
    if (operation === undefined) {
      throw new ProtectedCheckpointCryptoError(
        "authorization_unavailable",
        "protected checkpoint operation has no live authority",
      );
    }
    if (!scopeMatches(operation.scope, scope)) {
      throw new ProtectedCheckpointCryptoError(
        "scope_invalid",
        "protected checkpoint operation scope changed",
      );
    }
    if (operation.operation !== expected) {
      throw new ProtectedCheckpointCryptoError(
        "operation_mismatch",
        "protected checkpoint cell operation direction is invalid",
      );
    }
    assertActiveContext(operation.context);
    return operation;
  }

  return Object.freeze({
    executeAuthorizedOperation: async <Value>(request: Readonly<{
      operation: ProtectedCheckpointAuthorizationOperation;
      scope: ProtectedCheckpointInvocationScope;
      execute(
        context: ProtectedCheckpointAuthorizedOperationContext,
      ): Promise<Value>;
    }>): Promise<Value> => {
      const scope = assertScope(request.scope);
      if (
        request.operation !== "read"
        && request.operation !== "write"
        && request.operation !== "delete"
        && request.operation !== "cleanup"
      ) {
        throw new ProtectedCheckpointCryptoError(
          "operation_mismatch",
          "protected checkpoint operation is invalid",
        );
      }
      return input.authority.execute({
        authorizationSession: scope.authorizationSession,
        entrypointId: input.entrypointId,
        operation: mapOperation(request.operation),
        namespaceId: scope.namespaceId,
        domainId: input.domainId,
        expectedAccessRevision: scope.expectedAccessRevision,
        expectedPolicyRevision: scope.expectedPolicyRevision,
        execute: async (context) => {
          assertActiveContext(context);
          if (
            context.material.namespaceId !== scope.namespaceId
            || context.material.domainId !== input.domainId
            || context.material.accessRevision
              !== scope.expectedAccessRevision
            || context.material.agentAuthorizationRevision
              !== scope.expectedPolicyRevision
            || !validCounter(context.material.currentGeneration)
            || context.material.generations.length === 0
          ) {
            throw new ProtectedCheckpointCryptoError(
              "scope_invalid",
              "protected checkpoint Namespace material does not match scope",
            );
          }
          if (active.has(context.signal)) {
            throw new ProtectedCheckpointCryptoError(
              "authorization_unavailable",
              "protected checkpoint operation signal is already in use",
            );
          }
          const publicContext: ProtectedCheckpointAuthorizedOperationContext =
            Object.freeze({
              signal: context.signal,
              assertActive: () => {
                assertActiveContext(context);
              },
              assertCommitAllowed: async () => {
                assertActiveContext(context);
                await context.assertCommitAllowed();
                assertActiveContext(context);
              },
              remainingMs: () => context.remainingMs(),
            });
          active.set(context.signal, Object.freeze({
            operation: request.operation,
            scope,
            material: context.material,
            context: publicContext,
          }));
          try {
            const value = await request.execute(publicContext);
            assertActiveContext(publicContext);
            return value;
          } finally {
            active.delete(context.signal);
          }
        },
      });
    },

    seal: (
      request: ProtectedCheckpointSealInput,
    ): Promise<Uint8Array> => fromSynchronous(() => {
      assertScope(request.scope);
      assertCoordinate(request.coordinate);
      if (
        !(request.plaintext instanceof Uint8Array)
        || request.plaintext.length > MAX_CHECKPOINT_CELL_BYTES
      ) {
        throw new ProtectedCheckpointCryptoError(
          "cell_malformed",
          "protected checkpoint plaintext is malformed",
        );
      }
      const operation = requireActive(
        request.scope,
        request.signal,
        "write",
      );
      const generation = operation.material.currentGeneration;
      const generationEntry = operation.material.generations.find(
        (entry) => entry.generation === generation,
      );
      if (generationEntry === undefined) {
        throw new ProtectedCheckpointCryptoError(
          "scope_invalid",
          "protected checkpoint current Namespace generation is unavailable",
        );
      }
      let key: Uint8Array | null = null;
      let aad: Uint8Array | null = null;
      let body: Uint8Array | null = null;
      try {
        key = deriveCellKey(input.crypto, generationEntry.key);
        aad = cellAad(
          request.scope,
          operation.material.domainId,
          generation,
          request.coordinate,
        );
        body = input.crypto.aeadSeal(key, request.plaintext, aad);
        assertActiveContext(operation.context);
        return encodeCell(generation, body);
      } finally {
        key?.fill(0);
        aad?.fill(0);
        body?.fill(0);
      }
    }),

    open: (
      request: ProtectedCheckpointOpenInput,
    ): Promise<Uint8Array> => fromSynchronous(() => {
      assertScope(request.scope);
      assertCoordinate(request.coordinate);
      const operation = requireActive(
        request.scope,
        request.signal,
        "read",
      );
      const cell = decodeCell(request.ciphertext);
      const generationEntry = operation.material.generations.find(
        (entry) => entry.generation === cell.generation,
      );
      if (generationEntry === undefined) {
        cell.body.fill(0);
        throw new ProtectedCheckpointCryptoError(
          "authentication_failed",
          "protected checkpoint Namespace generation is unavailable",
        );
      }
      let key: Uint8Array | null = null;
      let aad: Uint8Array | null = null;
      try {
        key = deriveCellKey(input.crypto, generationEntry.key);
        aad = cellAad(
          request.scope,
          operation.material.domainId,
          cell.generation,
          request.coordinate,
        );
        const plaintext = input.crypto.aeadOpen(key, cell.body, aad);
        if (plaintext === null) {
          throw new ProtectedCheckpointCryptoError(
            "authentication_failed",
            "protected checkpoint cell authentication failed",
          );
        }
        try {
          assertActiveContext(operation.context);
          return plaintext;
        } catch (error) {
          plaintext.fill(0);
          throw error;
        }
      } finally {
        key?.fill(0);
        aad?.fill(0);
        cell.body.fill(0);
      }
    }),
  });
}

function unavailable<Value>(
  reason:
    | ProtectedGrantUnavailableReason
    | "namespace_unavailable"
    | "namespace_invalid",
): ProtectedCheckpointNamespaceContentResult<Value> {
  return Object.freeze({ status: "unavailable", reason });
}

/**
 * Opens the authenticated current AI Namespace keyring under one reusable
 * Grant operation. The Domain root and every Namespace generation key are
 * wiped by their respective owners before this function returns.
 */
export function createProtectedCheckpointNamespaceSessionContentExecutor(
  input: Readonly<{
    crypto: LatticeCrypto;
    storage: Pick<
      LatticeStorage,
      | "getGrant"
      | "consumeGrant"
      | "getNamespaceHead"
      | "getBinding"
    >;
    authority: ProtectedGrantAuthorityPort;
    resolveHistoricalCommitter: HistoricalCommitterResolver;
  }>,
): ProtectedCheckpointNamespaceSessionContentExecutor {
  return Object.freeze({
    execute: async <Value>(request: Readonly<{
      capability: ProtectedInvocationCapability;
      entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
      operation: ProtectedGrantOperation;
      namespaceId: string;
      domainId: string;
      expectedAccessRevision: number;
      expectedPolicyRevision: number;
      signal?: AbortSignal;
      execute(
        material: ProtectedCheckpointNamespaceMaterial,
        assertCurrentAuthority: () => Promise<void>,
      ): Value | PromiseLike<Value>;
    }>): Promise<ProtectedCheckpointNamespaceContentResult<Value>> => {
      if (
        signalIsAborted(request.signal)
        || !protectedCheckpointEntrypoints.has(request.entrypointId)
        || !portableText(request.namespaceId)
        || !portableText(request.domainId)
        || !validCounter(request.expectedAccessRevision)
        || !validCounter(request.expectedPolicyRevision)
      ) {
        return unavailable("authorization_unavailable");
      }
      const capability = inspectProtectedInvocationCapability(
        request.capability,
      );
      if (capability === null) {
        return unavailable("authorization_unavailable");
      }
      const granted =
        await executeProtectedGrantSessionCapabilityOperation({
          capability: request.capability,
          crypto: input.crypto,
          storage: input.storage,
          operation: request.operation,
          namespaceId: request.namespaceId,
          domainId: request.domainId,
          authority: input.authority,
          execute: (opened) =>
            withProtectedCurrentNamespaceKeyring({
              crypto: input.crypto,
              storage: input.storage,
              authority: input.authority,
              resolveHistoricalCommitter:
                input.resolveHistoricalCommitter,
              capability,
              opened,
              operation: request.operation,
              namespaceId: request.namespaceId,
              domainId: request.domainId,
              expectedAccessRevision: request.expectedAccessRevision,
              expectedPolicyRevision: request.expectedPolicyRevision,
              ...(request.signal === undefined
                ? {}
                : { signal: request.signal }),
              execute: request.execute,
            }),
        });
      if (granted.status === "unavailable") return granted;
      return granted.value;
    },
  });
}
