import { timingSafeEqual } from "node:crypto";
import {
  and,
  eq,
  sessionMessages,
} from "@nautilo/db";
import type { DomainForegroundSecretEntry } from "@nautilo/lattice-crypto";
import {
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "@nautilo/lattice-bridge";
import {
  PostgresConversationProductStore,
  createNativeTaskMessageReadTargetV1,
  createPostgresNativeTaskMessageCryptoCompletion,
  prepareNativeTaskMessage,
  withNativeTaskMessageV1,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
  type CryptoPostgresHandle,
  type NativeTaskMessageAuthority,
  type NativeTaskMessageReadAuthorityV1,
  type PrepareNativeTaskMessageInput,
} from "@nautilo/lattice-bridge/server";

import {
  createProtectedTaskMessageProductGuard,
} from "./protected-task-message-product-authority";
import {
  createProtectedTaskNativeMessageAuthorityResolver,
  type ProtectedTaskNativeMessageAuthorityInput,
} from "./protected-task-native-message-authority";

type AuthoritySeed = Omit<
  ProtectedTaskNativeMessageAuthorityInput,
  "coordinates" | "createdAt"
>;

type Product = Pick<
  PostgresConversationProductStore,
  "appendAllocated" | "markCryptoComplete" | "compareAndSwapCryptoMapping"
>;

type Dependencies = Readonly<{
  createProduct(
    handle: ConversationProductPostgresHandle,
    runner: ConversationProductCanonicalTransactionRunner,
    guard: ReturnType<typeof createProtectedTaskMessageProductGuard>,
  ): Product;
  createAuthorityResolver:
    typeof createProtectedTaskNativeMessageAuthorityResolver;
  prepare: typeof prepareNativeTaskMessage;
  createCompletion: typeof createPostgresNativeTaskMessageCryptoCompletion;
  createReadTarget: typeof createNativeTaskMessageReadTargetV1;
  openStored: typeof withNativeTaskMessageV1;
  readCreatedAt(
    runner: ConversationProductCanonicalTransactionRunner,
    coordinates: Readonly<{
      sessionId: string;
      messageId: number;
      revision: number;
    }>,
  ): Promise<number | null>;
}>;

const productionDependencies: Dependencies = Object.freeze({
  createProduct: (handle, runner, guard) =>
    new PostgresConversationProductStore(handle, runner, guard),
  createAuthorityResolver: createProtectedTaskNativeMessageAuthorityResolver,
  prepare: prepareNativeTaskMessage,
  createCompletion: createPostgresNativeTaskMessageCryptoCompletion,
  createReadTarget: createNativeTaskMessageReadTargetV1,
  openStored: withNativeTaskMessageV1,
  readCreatedAt: (runner, coordinates) => runner.transaction(async tx => {
    const rows = await tx.select({
      createdAt: sessionMessages.createdAt,
    }).from(sessionMessages).where(and(
      eq(sessionMessages.id, coordinates.messageId),
      eq(sessionMessages.sessionId, coordinates.sessionId),
      eq(sessionMessages.editRevision, coordinates.revision),
    )).limit(2).for("share");
    const row = rows[0];
    return rows.length === 1 && row?.createdAt instanceof Date
      ? row.createdAt.getTime()
      : null;
  }, { isolationLevel: "read committed" }),
});

export type ProtectedTaskNativeMessagePublicationInput = Readonly<{
  authority: AuthoritySeed;
  humanTurnId: string;
  productHandle: ConversationProductPostgresHandle;
  cryptoHandle: CryptoPostgresHandle;
  /** Borrowed secret entries from this execution segment's current grant. */
  domains: readonly DomainForegroundSecretEntry[];
  preparation: Pick<
    PrepareNativeTaskMessageInput,
    | "namespace"
    | "runtime"
    | "signerPublication"
    | "agentAuthorizationRevision"
    | "resolveHistoricalSignerPublicationManager"
  >;
  resolveHistoricalAgentSignerAuthority: Parameters<
    typeof createPostgresNativeTaskMessageCryptoCompletion
  >[0]["resolveHistoricalAgentSignerAuthority"];
  /** Reprove the exact live execution grant before product allocation. */
  hasCurrentGrant(): Promise<boolean>;
}>;

export type ProtectedTaskNativeMessagePublicationRequest = Readonly<{
  identity: Readonly<{
    taskId: string;
    taskRunId: string;
    graphThreadId: string;
    roomId: string;
    humanTurnId: string;
    agentId: string;
  }>;
  idempotencyKey: string;
  fingerprint: string;
  payload: MessagePayloadV2;
  signal: AbortSignal;
}>;

function sameAuthority(
  left: NativeTaskMessageAuthority,
  right: NativeTaskMessageAuthority,
): boolean {
  const fields = Object.keys(left) as (keyof NativeTaskMessageAuthority)[];
  return Object.keys(right).length === fields.length
    && fields.every(field => left[field] === right[field]);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function readAuthority(
  expected: NativeTaskMessageAuthority,
): NativeTaskMessageReadAuthorityV1 {
  return Object.freeze({
    mode: expected.mode,
    taskId: expected.taskId,
    taskRunId: expected.taskRunId,
    sourceRoomId: expected.sourceRoomId,
    roomId: expected.roomId,
    sessionId: expected.sessionId,
    messageId: expected.messageId,
    revision: expected.revision,
    graphThreadId: expected.graphThreadId,
    humanTurnId: expected.humanTurnId,
    agentId: expected.agentId,
    role: expected.role,
    createdAt: expected.createdAt,
    objectId: expected.objectId,
    cryptoAccessRevision: 0,
    namespaceId: expected.namespaceId,
    domainId: expected.domainId,
    expectedAccessRevision: expected.namespaceAccessRevision,
    expectedPolicyRevision: expected.policyRevision,
  });
}

function sameReadAuthority(
  left: NativeTaskMessageReadAuthorityV1,
  right: NativeTaskMessageReadAuthorityV1,
): boolean {
  const fields = Object.keys(left) as (keyof NativeTaskMessageReadAuthorityV1)[];
  return Object.keys(right).length === fields.length
    && fields.every(field => left[field] === right[field]);
}

function reject(message: string): never {
  throw new TypeError(message);
}

/**
 * Build a dark publisher for one exact protected Task execution segment.
 * Plain Tasks cannot enter this adapter. In Full mode only structural product
 * fields are allocated; the plaintext payload is never passed to product
 * storage.
 */
export function createProtectedTaskNativeMessagePublication(
  input: ProtectedTaskNativeMessagePublicationInput,
  overrides: Partial<Dependencies> = {},
): (request: ProtectedTaskNativeMessagePublicationRequest) => Promise<void> {
  const dependencies = Object.freeze({ ...productionDependencies, ...overrides });
  const authority = input.authority;
  const signal = authority.productAuthority.signal;
  if (!(signal instanceof AbortSignal)
    || authority.signal !== signal
    || input.humanTurnId.length === 0
    || authority.productAuthority.representation !== "dual"
      && authority.productAuthority.representation !== "protected") {
    throw new TypeError("Protected Task Message publication authority is invalid");
  }
  const policy = Object.freeze({
    expectedRevision: authority.productAuthority.policyRevision,
    representation: authority.productAuthority.representation === "dual"
      ? "ordinary_and_protected" as const
      : "protected_only" as const,
  });
  const guard = createProtectedTaskMessageProductGuard(
    authority.productAuthority,
    authority.now,
  );
  const product = dependencies.createProduct(
    input.productHandle,
    authority.runner,
    guard,
  );

  return async request => {
    signal.throwIfAborted();
    if (request.signal !== signal
      || request.identity.taskId !== authority.occurrence.task.id
      || request.identity.taskRunId !== authority.occurrence.run.id
      || request.identity.graphThreadId !== authority.occurrence.run.graphThreadId
      || request.identity.roomId !== authority.productAuthority.roomId
      || request.identity.humanTurnId !== input.humanTurnId
      || request.identity.agentId !== authority.occurrence.task.agentId
      || request.payload.role === "user"
      || request.idempotencyKey
        !== `task-transcript:${request.identity.taskRunId}:${request.fingerprint}`) {
      reject("Protected Task Message publication coordinates disagree");
    }
    if (!await input.hasCurrentGrant()) {
      reject("Protected Task Message grant is stale before allocation");
    }
    signal.throwIfAborted();
    const messageRequirements = authority.evidence.namespaceRequirements.filter(
      entry => entry.namespaceId === authority.productAuthority.namespaceId,
    );
    const messageRequirement = messageRequirements[0];
    if (messageRequirements.length !== 1
      || messageRequirement === undefined
      || messageRequirement.expectedPolicyRevision
        !== authority.productAuthority.policyRevision
      || !messageRequirement.operations.includes("decrypt")
      || !messageRequirement.operations.includes("encrypt")) {
      reject("Protected Task Message recovery authority is unavailable");
    }

    const encoded = encodeMessagePayloadV2(request.payload);
    let digest: Uint8Array | null = null;
    try {
      const payload = decodeMessagePayloadV2(encoded);
      if (payload.role === "user") {
        reject("Protected Task Message author role is invalid");
      }
      digest = authority.crypto.hash(encoded);
      const full = authority.productAuthority.representation === "protected";
      const allocation = await product.appendAllocated({
        sessionId: authority.productAuthority.sessionId,
        idempotencyKey: request.idempotencyKey,
        content: full ? null : payload.content,
        publicationPolicy: policy,
        keyClass: "ai",
        authorRole: payload.role,
        toolCalls: full || payload.toolCalls === undefined
          ? null
          : JSON.stringify(payload.toolCalls),
        toolName: full ? null : payload.toolName ?? null,
        fingerprint: request.fingerprint,
        humanTurnId: null,
        transcriptOrigin: "subagent",
        parentThreadId: null,
        scopeId: null,
        metadata: null,
        subthreadRoomId: null,
        replyToMessageId: null,
        notificationContext: {
          mentionedHumanUserIds: Object.freeze([]),
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
        structuralProjection: {
          notificationEligibility: "excluded",
          subthreadReplyClassification: "excluded",
        },
        requestDigest: digest,
      });
      if (allocation.status === "conflict"
        || allocation.lifecycle.sessionId !== authority.productAuthority.sessionId
        || allocation.lifecycle.roomId !== authority.productAuthority.roomId
        || allocation.lifecycle.namespaceIdAtAllocation
          !== authority.productAuthority.namespaceId
        || allocation.lifecycle.keyClass !== "ai"
        || allocation.lifecycle.authorRole !== payload.role
        || allocation.lifecycle.objectIdScheme !== "message_v2"
        || allocation.lifecycle.representationMode !== (full
          ? "full_encryption"
          : "shadow_encryption")
        || allocation.lifecycle.publicationPolicyRevision !== (full
          ? authority.productAuthority.policyRevision
          : null)
        || allocation.lifecycle.appendIdempotencyKey
          !== request.idempotencyKey
        || !sameBytes(allocation.lifecycle.allocationRequestDigest, digest)) {
        reject("Protected Task Message allocation is not exact");
      }
      const coordinates = Object.freeze({
        sessionId: allocation.lifecycle.sessionId,
        messageId: allocation.lifecycle.messageId,
        revision: allocation.lifecycle.revision,
        taskId: request.identity.taskId,
        taskRunId: request.identity.taskRunId,
        roomId: request.identity.roomId,
        graphThreadId: request.identity.graphThreadId,
        humanTurnId: request.identity.humanTurnId,
        agentId: request.identity.agentId,
        objectId: allocation.lifecycle.cryptoObjectId,
        role: payload.role,
      });
      const expectedParity = full
        ? "server_authenticated" as const
        : "server_verified" as const;
      const mark = () => product.markCryptoComplete({
        sessionId: coordinates.sessionId,
        messageId: coordinates.messageId,
        revision: coordinates.revision,
        cryptoObjectId: coordinates.objectId,
        parityStatus: expectedParity,
        leaseToken: null,
        publicationPolicy: policy,
      });
      const map = () => product.compareAndSwapCryptoMapping({
        sessionId: coordinates.sessionId,
        messageId: coordinates.messageId,
        revision: coordinates.revision,
        expectedNamespaceId: authority.productAuthority.namespaceId,
        cryptoObjectId: coordinates.objectId,
        leaseToken: null,
        publicationPolicy: policy,
      });
      if (allocation.status === "replayed"
        && allocation.lifecycle.completion === "complete") {
        if ((allocation.lifecycle.disposition !== "active"
            && allocation.lifecycle.disposition !== "mapped")
          || allocation.lifecycle.parityStatus !== expectedParity
          || !await input.hasCurrentGrant()) {
          reject("Protected Task Message replay is not current");
        }
        signal.throwIfAborted();
        const marked = await mark();
        if (marked !== "applied" && marked !== "duplicate") {
          reject("Protected Task Message replay completion is not exact");
        }
        if (allocation.lifecycle.disposition === "mapped") return;
        if (!await input.hasCurrentGrant()) {
          reject("Protected Task Message grant is stale before replay mapping");
        }
        signal.throwIfAborted();
        const mapped = await map();
        if (mapped !== "applied" && mapped !== "duplicate") {
          reject("Protected Task Message replay mapping was not accepted");
        }
        return;
      }
      if (allocation.lifecycle.completion !== "pending"
        || allocation.lifecycle.disposition !== "active"
        || allocation.lifecycle.parityStatus !== "pending") {
        reject("Protected Task Message allocation lifecycle is not writable");
      }
      const createdAt = await dependencies.readCreatedAt(
        authority.runner,
        coordinates,
      );
      if (createdAt === null) {
        reject("Protected Task Message allocation timestamp is unavailable");
      }
      const resolveCurrentAuthority = dependencies.createAuthorityResolver({
        ...authority,
        coordinates,
        createdAt,
      });
      let currentAuthority: NativeTaskMessageAuthority | null = null;
      const resolveAndRemember = async (
        expected: NativeTaskMessageAuthority,
      ): Promise<NativeTaskMessageAuthority | null> => {
        const current = await resolveCurrentAuthority(expected);
        if (current !== null) currentAuthority = current;
        return current;
      };
      const prepared = await dependencies.prepare({
        crypto: authority.crypto,
        evidence: authority.evidence,
        coordinates,
        mode: full ? "encrypted_only" : "shadow_encryption",
        payload,
        createdAt,
        ...input.preparation,
        signal,
        resolveCurrentAuthority: resolveAndRemember,
      });
      if (currentAuthority === null) {
        reject("Protected Task Message preparation authority is unavailable");
      }
      const expected = currentAuthority as NativeTaskMessageAuthority;
      const completion = dependencies.createCompletion({
        handle: input.cryptoHandle,
        crypto: authority.crypto,
        resolveCurrentAuthority: resolveAndRemember,
        resolveHistoricalAgentSignerAuthority:
          input.resolveHistoricalAgentSignerAuthority,
      });
      try {
        await completion.complete(prepared);
      } catch {
        signal.throwIfAborted();
        // A prior attempt may have committed randomized ciphertext before its
        // product completion receipt. Only the verified opener can establish
        // that those bytes decrypt to this exact retry payload.
        const targetAuthority = readAuthority(expected);
        await dependencies.openStored({
          restricted: authority.restricted,
          crypto: authority.crypto,
          serverScope: authority.serverScope,
          evidence: authority.evidence,
          domains: input.domains,
          signal,
          target: dependencies.createReadTarget(targetAuthority),
          resolveCurrentAuthority: async candidate => {
            if (!sameReadAuthority(candidate, targetAuthority)) return null;
            const current = await resolveCurrentAuthority(expected);
            return current !== null && sameAuthority(current, expected)
              ? targetAuthority
              : null;
          },
          resolveHistoricalAgentSignerAuthority:
            input.resolveHistoricalAgentSignerAuthority,
          execute: async (opened, assertCurrentAuthority) => {
            const openedBytes = encodeMessagePayloadV2(opened);
            try {
              if (!sameBytes(openedBytes, encoded)) {
                reject("Protected Task Message recovered content disagrees");
              }
              await assertCurrentAuthority();
            } finally {
              openedBytes.fill(0);
            }
          },
        });
      }

      const assertCurrent = async (): Promise<void> => {
        signal.throwIfAborted();
        const current = await resolveCurrentAuthority(expected);
        if (current === null || !sameAuthority(current, expected)) {
          reject("Protected Task Message authority changed");
        }
        signal.throwIfAborted();
      };
      await assertCurrent();
      const marked = await mark();
      if (marked !== "applied" && marked !== "duplicate") {
        reject("Protected Task Message crypto completion was not accepted");
      }
      await assertCurrent();
      const mapped = await map();
      if (mapped !== "applied" && mapped !== "duplicate") {
        reject("Protected Task Message crypto mapping was not accepted");
      }
    } finally {
      encoded.fill(0);
      digest?.fill(0);
    }
  };
}
