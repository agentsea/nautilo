import type {
  ConversationAppendInput,
  ConversationDeleteEffects,
  ConversationMessageKeyClass,
  ConversationNotificationEligibility,
  ConversationProtectedAgentContentOpener,
  ConversationProtectedAgentObjectOutcome,
  ConversationProtectedProductReadAuthorization,
  ConversationProtectedProductReadPort,
  ConversationProtectedProductReadRecord,
  ConversationSubthreadReplyClassification,
  MessagePayloadV2,
  PreparedConversationCryptoRevision,
  ProtectedAgentRuntimeForegroundEntrypointId,
} from "@nautilo/lattice-bridge";
import type {
  ProtectedMessageDtoV2,
  ProtectedMessageUnavailableReasonV2,
  SessionMessageDto,
} from "@nautilo/types";

import type {
  ForegroundAuthorizationView,
} from "../protected-execution/foreground-authorization-session";

declare const preparedProtectedAgentMessageWriteBrand: unique symbol;

/**
 * Opaque output of an authorized protected Agent-message preparer. Runtime
 * cannot manufacture this from an opened aiRoot: the preparer must also hold
 * the independently authorized object-manifest signing capability.
 */
export type PreparedProtectedAgentMessageWrite = Readonly<{
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly [preparedProtectedAgentMessageWriteBrand]: true;
}>;

export type ActiveConversationMutationResult =
  | Readonly<{
    readonly status: "committed";
    readonly message?: ProtectedMessageDtoV2;
  }>
  | Readonly<{ readonly status: "pending_shadow" }>
  | Readonly<{ readonly status: "conflict" }>
  | Readonly<{ readonly status: "missing" }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "authorization_unavailable"
      | "content_unavailable"
      | "content_invalid";
  }>;

export type ActiveConversationHardDeleteResult =
  | Readonly<{
    readonly status: "committed";
    readonly disposition: "deleted" | "replayed";
    readonly effects: ConversationDeleteEffects;
  }>
  | Readonly<{ readonly status: "conflict" | "missing" }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "authorization_unavailable"
      | "content_unavailable"
      | "content_invalid";
  }>;

/**
 * Explicit dependency for protected Agent writes. Its implementation owns
 * both preparation and manifest-signing authority. Neither the repository nor
 * the runtime may substitute server identity or a raw opened root.
 */
export interface ProtectedAgentMessageWritePreparer {
  readonly prepare: (input: Readonly<{
    readonly sessionId: string;
    readonly idempotencyKey: string;
    readonly payload: MessagePayloadV2;
    readonly entrypointId?: ProtectedAgentRuntimeForegroundEntrypointId;
    readonly agentId?: string;
    readonly appendContext?: Readonly<{
      readonly transcriptOrigin: "main" | "subagent";
      readonly parentThreadId: string | null;
      readonly scopeId: string | null;
      readonly subthreadRoomId: string | null;
      readonly notificationContext: Readonly<{
        readonly mentionedHumanUserIds: readonly string[];
        readonly causalHumanUserId: string | null;
        readonly causalHumanTurnId: string | null;
      }>;
    }>;
    readonly productReadAuthorization?:
      ProtectedConversationProductReadAuthorization;
    readonly authorization: ForegroundAuthorizationView;
    readonly signal?: AbortSignal;
  }>) => Promise<
    | Readonly<{
      readonly status: "prepared";
      readonly write: PreparedProtectedAgentMessageWrite;
    }>
    | Readonly<{
      readonly status: "unavailable";
      readonly reason:
        | "authorization_unavailable"
        | "signing_capability_unavailable"
        | "content_unavailable"
        | "content_invalid";
    }>
  >;
}

/**
 * Completes an opaque Agent write prepared under independently held signing
 * authority. The Active repository never receives a Runtime key, signer seed,
 * object DEK, or opened Domain/Namespace root.
 */
export interface ProtectedAgentMessageWriteCommitter {
  readonly appendPrepared: (
    write: PreparedProtectedAgentMessageWrite,
  ) => Promise<ActiveConversationMutationResult>;
}

export type HumanConversationRevisionAllocation =
  | Readonly<{
    readonly status: "allocated" | "replayed";
    readonly sessionId: string;
    readonly messageId: number;
    readonly revision: number;
    readonly namespaceId: string;
    readonly cryptoObjectId: string;
  }>
  | Readonly<{ readonly status: "conflict" | "missing" | "stale" }>;

export type AllocatedHumanConversationRevision = Extract<
  HumanConversationRevisionAllocation,
  Readonly<{ readonly status: "allocated" | "replayed" }>
>;

export type HumanConversationEditAllocation =
  | Readonly<{
    readonly status: "allocated" | "replayed";
    /**
     * Every physical Human-turn sibling allocated by the logical edit. The
     * caller must complete each coordinate independently.
     */
    readonly allocations: readonly AllocatedHumanConversationRevision[];
  }>
  | Readonly<{ readonly status: "conflict" | "missing" | "stale" }>;

export type HumanConversationRevisionCompletion =
  | Readonly<{
    readonly status: "mapped" | "replayed";
    readonly messageId: number;
    readonly revision: number;
    readonly cryptoObjectId: string;
  }>
  | Readonly<{
    readonly status: "orphaned";
    readonly reason: "stale_mapping" | "superseded" | "hard_delete";
    readonly messageId: number;
    readonly revision: number;
    readonly cryptoObjectId: string;
  }>;

export type HumanConversationRead =
  | Readonly<{
    readonly kind: "page";
    readonly authorization: ProtectedConversationProductReadAuthorization;
    readonly sessionId: string;
    readonly beforeMessageId?: number;
    readonly limit: number;
  }>
  | Readonly<{
    readonly kind: "around";
    readonly authorization: ProtectedConversationProductReadAuthorization;
    readonly sessionId: string;
    readonly messageId: number;
    readonly radius: number;
  }>
  | Readonly<{
    readonly kind: "search";
    readonly namespaceId: string;
    readonly query: string;
    readonly limit: number;
  }>;

export type HumanConversationReadResult =
  | Readonly<{
    readonly status: "available";
    readonly messages: readonly HumanConversationMessageDto[];
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "content_unavailable"
      | "content_invalid"
      | "search_unavailable";
  }>;

export type HumanConversationMessageDto =
  | Readonly<{
    readonly mode: "legacy";
    readonly dto: SessionMessageDto;
  }>
  | Readonly<{
    readonly mode: "protected";
    readonly dto: ProtectedMessageDtoV2;
  }>;

export const ACTIVE_CONVERSATION_MAX_READ_BATCH = 256 as const;

/**
 * Public product coordinates plus the protected wire DTO. Implementations may
 * not add raw `content`, `tool_calls`, free metadata, ciphertext table rows,
 * or key material to this record.
 */
export type ProtectedConversationProductReadRecord =
  ConversationProtectedProductReadRecord<ProtectedMessageDtoV2>;

export type ProtectedConversationProductReadAuthorization =
  ConversationProtectedProductReadAuthorization;

/**
 * Product-side protected read seam. This port owns bounded pagination and
 * authorization-aware public-coordinate projection, but never opens content.
 */
export type ProtectedConversationProductReadPort =
  ConversationProtectedProductReadPort<ProtectedMessageDtoV2>;

export type ProtectedConversationAgentObjectOutcome =
  ConversationProtectedAgentObjectOutcome<
    ProtectedMessageUnavailableReasonV2
  >;

export type ProtectedConversationAgentObjectStatus =
  | Readonly<{
    readonly messageId: number;
    readonly revision: number;
    readonly status: "opened";
  }>
  | Readonly<{
    readonly messageId: number;
    readonly revision: number;
    readonly status: "pending";
    readonly reason: "shadow_pending" | "backfill_pending";
  }>
  | Readonly<{
    readonly messageId: number;
    readonly revision: number;
    readonly status: "unavailable";
    readonly reason: ProtectedMessageUnavailableReasonV2;
  }>;

/**
 * Bridge-owned message opener. Its implementation must bind
 * `authorizationSession` to the exact live foreground session, acquire one
 * bounded decrypt lease for this batch, repeat current authority checks, and
 * invoke `execute` before wiping opened payload/key material.
 *
 * Runtime deliberately treats the authorization handle and protected DTOs as
 * opaque inputs. No raw root, keyring, DEK, or crypto storage record crosses
 * this port.
 */
export type ProtectedConversationAgentContentOpener =
  ConversationProtectedAgentContentOpener<
    ProtectedMessageDtoV2,
    ProtectedMessageUnavailableReasonV2
  >;

export type AgentTranscriptOpenResult<Value> =
  | Readonly<{ readonly status: "executed"; readonly value: Value }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason:
      | "authorization_unavailable"
      | "content_unavailable"
      | "content_invalid";
    /** Content-free per-object evidence when the batch itself was opened. */
    readonly outcomes?: readonly ProtectedConversationAgentObjectStatus[];
  }>;

/**
 * Decrypted confidential payload plus the reviewed, content-free product
 * coordinates required to rebuild a truthful labelled Room transcript.
 *
 * The repository returns these in strict `(createdAt, messageId)`
 * oldest-first order. Author identity is routing metadata; it must not be
 * guessed from the payload role because Rooms may contain multiple Humans and
 * Agents.
 */
export type ActiveConversationTranscriptMessage = Readonly<{
  readonly messageId: number;
  readonly revision: number;
  readonly createdAt: Date;
  readonly author: Readonly<{
    readonly actorId: string;
    readonly handle: string;
    readonly displayName: string;
  }>;
  readonly payload: MessagePayloadV2;
  readonly reactions?: readonly Readonly<{
    readonly emoji: string;
    readonly count: number;
  }>[];
}>;

export type AgentTranscriptOpenInput<Value> = Readonly<{
  readonly sessionId: string;
  readonly namespaceId: string;
  readonly upToMessageId?: number;
  readonly limit: number;
  readonly productReadAuthorization:
    ProtectedConversationProductReadAuthorization;
  readonly authorization: ForegroundAuthorizationView;
  readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
  readonly signal?: AbortSignal;
  readonly execute: (
    messages: readonly ActiveConversationTranscriptMessage[],
  ) => Value | PromiseLike<Value>;
}>;

export type HumanConversationAppendInput = Readonly<{
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly keyClass: ConversationMessageKeyClass;
  readonly legacyPayload: MessagePayloadV2;
  readonly fingerprint: string | null;
  readonly humanTurnId: string | null;
  readonly transcriptOrigin: ConversationAppendInput["transcriptOrigin"];
  readonly parentThreadId: string | null;
  readonly scopeId: string | null;
  readonly subthreadRoomId: string | null;
  readonly replyToMessageId: number | null;
  readonly notificationContext: ConversationAppendInput["notificationContext"];
  readonly structuralProjection: Readonly<{
    readonly notificationEligibility: ConversationNotificationEligibility;
    readonly subthreadReplyClassification:
      ConversationSubthreadReplyClassification;
  }>;
}>;

export type HumanConversationEditInput = Readonly<{
  readonly messageId: number;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly legacyPayload: MessagePayloadV2;
  readonly subthreadReplyClassification:
    ConversationSubthreadReplyClassification;
}>;

/**
 * The single runtime-owned conversation spine. Human writes are deliberately
 * coordinate-first: plaintext allocation produces the physical
 * message/revision coordinate before a client-prepared protected revision can
 * be completed. Agent plaintext is only lent to an invocation callback.
 *
 * The bridge's shadow `ConversationRepository` remains an internal lifecycle
 * primitive behind a protected implementation of this product contract.
 */
export interface ActiveConversationRepository {
  readonly allocateHumanAppend: (
    input: HumanConversationAppendInput,
  ) => Promise<HumanConversationRevisionAllocation>;
  readonly allocateHumanEdit: (
    input: HumanConversationEditInput,
  ) => Promise<HumanConversationEditAllocation>;
  readonly completeHumanRevision: (input: Readonly<{
    readonly messageId: number;
    readonly expectedRevision: number;
    readonly preparedClientRevision: PreparedConversationCryptoRevision;
  }>) => Promise<HumanConversationRevisionCompletion>;
  readonly appendPreparedAgent: (
    write: PreparedProtectedAgentMessageWrite,
  ) => Promise<ActiveConversationMutationResult>;
  readonly hardDelete: (input: Readonly<{
    readonly messageId: number;
    readonly operationId: string;
    readonly expectedRevision: number;
  }>) => Promise<ActiveConversationHardDeleteResult>;
  readonly readHumanMessages: (
    query: HumanConversationRead,
  ) => Promise<HumanConversationReadResult>;
  readonly withAgentTranscript: <Value>(
    input: AgentTranscriptOpenInput<Value>,
  ) => Promise<AgentTranscriptOpenResult<Value>>;
}
