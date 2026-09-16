import { createHash } from "node:crypto";
import {
  describeProtectedMemoryUnavailable,
  type ProtectedMemoryUnavailableReason,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryResult,
  type ProtectedAgentMemoryAccessAction,
  type ProtectedAgentMemoryAccessPort,
  type ProtectedAgentMemoryProjectionApprovalPreview,
  type ProtectedAgentMemoryProjectionPort,
  type ProtectedAgentMemoryProjectionPreparation,
  type ProtectedAgentMemoryProjectionReference,
} from "@nautilo/lattice-bridge";

const MAX_PROCESS_LOCAL_PROJECTION_TTL_MS = 10 * 60 * 1_000;

/** Keep typed protected unavailability out of successful ToolMessage results. */
export class ProtectedMemoryToolUnavailableError extends Error {
  constructor(readonly reason: ProtectedMemoryUnavailableReason) {
    super(`Memory operation unavailable: ${describeProtectedMemoryUnavailable(reason)}.`);
    this.name = "ProtectedMemoryToolUnavailableError";
  }
}

export type {
  ProtectedAgentMemoryAccessAction,
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionApprovalPreview,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryProjectionPreparation,
  ProtectedAgentMemoryProjectionReference,
};

/**
 * Checkpoint-safe projection coordinate. Confidential proposed content,
 * source Memory ids, destination ids, and authority material are deliberately
 * absent. A process-local port may recognize this coordinate while its live
 * foreground authorization remains available; it must reject reconstruction
 * after process loss.
 */

type ProtectedAgentMemoryProjectionPrepareInput = Parameters<
  ProtectedAgentMemoryProjectionPort["prepare"]
>[0];
type ProtectedAgentMemoryProjectionPublishValue = Extract<
  Awaited<ReturnType<ProtectedAgentMemoryProjectionPort["publish"]>>,
  { status: "success" }
>["value"];
type ProtectedProjectionDisambiguation = Extract<
  ProtectedAgentMemoryProjectionPreparation,
  { kind: "needs_disambiguation" }
>;

type ResumableProtectedProjectionPreparation<State> =
  | Readonly<{
      kind: "prepared";
      preview: ProtectedAgentMemoryProjectionApprovalPreview;
      state: State;
    }>
  | ProtectedProjectionDisambiguation;

export interface ResumableProtectedAgentMemoryProjectionPortInput<State> {
  readonly now: () => number;
  readonly createReferenceId: () => string;
  readonly ttlMs: number;
  /** Exact foreground principals bound to this invocation-local port. */
  readonly requesterUserId: string;
  readonly requesterActorId: string;
  readonly agentId: string;
  readonly prepare: (
    request: ProtectedAgentMemoryProjectionPrepareInput,
  ) => Promise<ProtectedMemoryResult<
    ResumableProtectedProjectionPreparation<State>
  >>;
  readonly seal: (input: Readonly<{
    reference: ProtectedAgentMemoryProjectionReference;
    prepared: ProtectedAgentMemoryProjectionPrepareInput;
    state: State;
  }>) => Promise<string>;
  readonly open: (
    reference: ProtectedAgentMemoryProjectionReference,
  ) => Promise<Readonly<{
    prepared: ProtectedAgentMemoryProjectionPrepareInput;
    state: State;
  }> | null>;
  readonly validate: (input: Readonly<{
    authority: ProtectedMemoryAuthority;
    prepared: ProtectedAgentMemoryProjectionPrepareInput;
    state: State;
  }>) => Promise<ProtectedMemoryResult<
    ProtectedAgentMemoryProjectionApprovalPreview
  >>;
  readonly publish: (input: Readonly<{
    authority: ProtectedMemoryAuthority;
    reference: ProtectedAgentMemoryProjectionReference;
    prepared: ProtectedAgentMemoryProjectionPrepareInput;
    state: State;
  }>) => Promise<ProtectedMemoryResult<
    ProtectedAgentMemoryProjectionPublishValue
  >>;
}

function isProtectedProjectionDisambiguation(
  value: ProtectedAgentMemoryProjectionApprovalPreview |
    ProtectedProjectionDisambiguation,
): value is ProtectedProjectionDisambiguation {
  return "kind" in value && value.kind === "needs_disambiguation";
}

/**
 * Process-local custody for a protected projection proposal. The only durable
 * value is the content-free reference. All confidential preparation input is
 * retained exclusively as a WeakMap value keyed by that exact reference
 * object. A checkpoint clone or process restart is intentionally unusable and
 * must run a fresh authorized preflight.
 */
export function createProcessLocalProtectedAgentMemoryProjectionPort(
  input: Readonly<{
    now(): number;
    createReferenceId(): string;
    ttlMs: number;
    prepare(
      request: ProtectedAgentMemoryProjectionPrepareInput,
    ): Promise<ProtectedMemoryResult<
      ProtectedAgentMemoryProjectionApprovalPreview |
      ProtectedProjectionDisambiguation
    >>;
    publish(request: Readonly<{
      authority: ProtectedMemoryAuthority;
      prepared: ProtectedAgentMemoryProjectionPrepareInput;
    }>): Promise<ProtectedMemoryResult<ProtectedAgentMemoryProjectionPublishValue>>;
  }>,
): ProtectedAgentMemoryProjectionPort {
  if (
    !Number.isSafeInteger(input.ttlMs)
    || input.ttlMs < 1
    || input.ttlMs > MAX_PROCESS_LOCAL_PROJECTION_TTL_MS
  ) {
    throw new TypeError("Protected projection TTL must be within 1..600000ms");
  }
  const tokensByReferenceId = new Map<string, object>();
  const preparedByToken = new WeakMap<object, Readonly<{
    reference: ProtectedAgentMemoryProjectionReference;
    prepared: ProtectedAgentMemoryProjectionPrepareInput;
  }>>();
  const discardExpired = () => {
    const now = input.now();
    for (const [referenceId, token] of tokensByReferenceId) {
      const retained = preparedByToken.get(token);
      if (retained === undefined || retained.reference.expiresAt <= now) {
        tokensByReferenceId.delete(referenceId);
      }
    }
  };
  return Object.freeze({
    async prepare(request: ProtectedAgentMemoryProjectionPrepareInput) {
      discardExpired();
      if (tokensByReferenceId.size >= 256) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "target_encryption_not_ready" as const,
        });
      }
      const prepared = await input.prepare(request);
      if (prepared.status === "unavailable") return prepared;
      if (isProtectedProjectionDisambiguation(prepared.value)) return Object.freeze({
        status: "success" as const, value: prepared.value,
      });
      const createdAt = input.now();
      const referenceId = input.createReferenceId();
      if (
        referenceId.length < 1
        || referenceId.length > 256
        || referenceId.trim() !== referenceId
        || tokensByReferenceId.has(referenceId)
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "integrity_failure" as const,
        });
      }
      const reference = Object.freeze({
        referenceVersion: 1 as const,
        referenceId,
        toolCallId: request.toolCallId,
        requesterUserId: request.authority.subjectUserId,
        requesterActorId: request.requesterActorId,
        agentId: request.authority.agentId,
        createdAt,
        expiresAt: createdAt + input.ttlMs,
      });
      const token = Object.freeze({});
      tokensByReferenceId.set(referenceId, token);
      preparedByToken.set(token, Object.freeze({
        reference,
        prepared: request,
      }));
      const expiry = setTimeout(() => {
        if (tokensByReferenceId.get(referenceId) === token) {
          tokensByReferenceId.delete(referenceId);
        }
      }, input.ttlMs);
      expiry.unref?.();
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          kind: "prepared" as const,
          reference,
          preview: prepared.value,
        }),
      });
    },
    async publish(request: Parameters<ProtectedAgentMemoryProjectionPort["publish"]>[0]) {
      discardExpired();
      const token = tokensByReferenceId.get(request.reference.referenceId);
      const retained = token === undefined
        ? undefined
        : preparedByToken.get(token);
      if (
        retained === undefined
        || input.now() >= request.reference.expiresAt
        || request.reference.referenceVersion
          !== retained.reference.referenceVersion
        || request.reference.toolCallId !== retained.reference.toolCallId
        || request.reference.requesterUserId
          !== retained.reference.requesterUserId
        || request.reference.requesterActorId
          !== retained.reference.requesterActorId
        || request.reference.agentId !== retained.reference.agentId
        || request.reference.createdAt !== retained.reference.createdAt
        || request.reference.expiresAt !== retained.reference.expiresAt
        || request.authority.subjectUserId
          !== request.reference.requesterUserId
        || request.authority.agentId !== request.reference.agentId
        || retained.prepared.authority.subjectUserId
          !== request.authority.subjectUserId
        || retained.prepared.authority.agentId !== request.authority.agentId
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_required" as const,
        });
      }
      return input.publish({
        authority: request.authority,
        prepared: retained.prepared,
      });
    },
  });
}

function resumableProjectionReferenceIsBound(
  input: Pick<
    ResumableProtectedAgentMemoryProjectionPortInput<unknown>,
    "requesterUserId" | "requesterActorId" | "agentId"
  >,
  authority: ProtectedMemoryAuthority,
  reference: ProtectedAgentMemoryProjectionReference,
  now: number,
): boolean {
  return reference.referenceVersion === 1
    && typeof reference.referenceId === "string"
    && reference.referenceId.length > 0
    && reference.referenceId.length <= 256
    && reference.referenceId.trim() === reference.referenceId
    && typeof reference.toolCallId === "string"
    && reference.toolCallId.length > 0
    && reference.requesterUserId === input.requesterUserId
    && reference.requesterActorId === input.requesterActorId
    && reference.agentId === input.agentId
    && authority.subjectUserId === input.requesterUserId
    && authority.agentId === input.agentId
    && Number.isSafeInteger(reference.createdAt)
    && Number.isSafeInteger(reference.expiresAt)
    && reference.createdAt <= now
    && now < reference.expiresAt
    && typeof reference.sealedPreparation === "string"
    && reference.sealedPreparation.length > 0;
}

function resumableProjectionPreparationIsBound(
  input: Pick<
    ResumableProtectedAgentMemoryProjectionPortInput<unknown>,
    "requesterUserId" | "requesterActorId" | "agentId"
  >,
  reference: ProtectedAgentMemoryProjectionReference,
  prepared: ProtectedAgentMemoryProjectionPrepareInput,
  authority: ProtectedMemoryAuthority,
): boolean {
  return prepared.toolCallId === reference.toolCallId
    && prepared.authority.subjectUserId === input.requesterUserId
    && prepared.requesterActorId === input.requesterActorId
    && prepared.authority.agentId === input.agentId
    && sameProtectedMemoryAuthority(prepared.authority, authority);
}

function sameCanonicalIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return left.length === right.length
    && sortedLeft.every((value, index) =>
      value === sortedRight[index]
    );
}

function sameProtectedMemoryAuthority(
  left: ProtectedMemoryAuthority,
  right: ProtectedMemoryAuthority,
): boolean {
  if (
    left.mode !== right.mode
    || left.subjectUserId !== right.subjectUserId
    || left.agentId !== right.agentId
  ) return false;
  if (left.mode === "scope" && right.mode === "scope") {
    return left.scopeId === right.scopeId
      && left.originWritableNamespaceId === right.originWritableNamespaceId;
  }
  if (left.mode !== "namespace" || right.mode !== "namespace") return false;
  return left.writableNamespaceId === right.writableNamespaceId
    && sameCanonicalIds(
      left.readableNamespaceIds,
      right.readableNamespaceIds,
    )
    && sameCanonicalIds(
      left.mutableNamespaceIds,
      right.mutableNamespaceIds,
    );
}

/**
 * Restart-safe custody for a protected projection proposal.
 *
 * The factory owns no live preparation map. It checkpoints only the opaque
 * authenticated capsule returned by `seal`; every restore or publish opens
 * that capsule under the caller's fresh invocation authority, verifies its
 * exact principal/tool binding, and revalidates the recovered state before it
 * can be shown or committed.
 */
export function createResumableProtectedAgentMemoryProjectionPort<State>(
  input: ResumableProtectedAgentMemoryProjectionPortInput<State>,
): ProtectedAgentMemoryProjectionPort {
  if (
    !Number.isSafeInteger(input.ttlMs)
    || input.ttlMs < 1
    || input.ttlMs > MAX_PROCESS_LOCAL_PROJECTION_TTL_MS
  ) {
    throw new TypeError("Protected projection TTL must be within 1..600000ms");
  }
  if (
    input.requesterUserId.length === 0
    || input.requesterActorId.length === 0
    || input.agentId.length === 0
  ) {
    throw new TypeError("Protected projection principals are required");
  }

  const recover = async (
    authority: ProtectedMemoryAuthority,
    reference: ProtectedAgentMemoryProjectionReference,
  ): Promise<Readonly<{
    prepared: ProtectedAgentMemoryProjectionPrepareInput;
    state: State;
  }> | null> => {
    if (!resumableProjectionReferenceIsBound(
      input,
      authority,
      reference,
      input.now(),
    )) return null;
    let opened: Readonly<{
      prepared: ProtectedAgentMemoryProjectionPrepareInput;
      state: State;
    }> | null;
    try {
      opened = await input.open(reference);
    } catch {
      return null;
    }
    return opened !== null && resumableProjectionPreparationIsBound(
      input,
      reference,
      opened.prepared,
      authority,
    ) && resumableProjectionReferenceIsBound(
      input,
      authority,
      reference,
      input.now(),
    ) ? opened : null;
  };

  return Object.freeze({
    async prepare(request: ProtectedAgentMemoryProjectionPrepareInput) {
      if (
        request.authority.subjectUserId !== input.requesterUserId
        || request.requesterActorId !== input.requesterActorId
        || request.authority.agentId !== input.agentId
      ) return Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      });
      const prepared = await input.prepare(request);
      if (prepared.status === "unavailable") return prepared;
      if (prepared.value.kind === "needs_disambiguation") return Object.freeze({
        status: "success" as const,
        value: prepared.value,
      });
      const createdAt = input.now();
      const referenceId = input.createReferenceId();
      if (
        referenceId.length < 1
        || referenceId.length > 256
        || referenceId.trim() !== referenceId
      ) return Object.freeze({
        status: "unavailable" as const,
        reason: "integrity_failure" as const,
      });
      const unsealedReference: ProtectedAgentMemoryProjectionReference =
        Object.freeze({
          referenceVersion: 1 as const,
          referenceId,
          toolCallId: request.toolCallId,
          requesterUserId: input.requesterUserId,
          requesterActorId: input.requesterActorId,
          agentId: input.agentId,
          createdAt,
          expiresAt: createdAt + input.ttlMs,
        });
      let sealedPreparation: string;
      try {
        sealedPreparation = await input.seal({
          reference: unsealedReference,
          prepared: request,
          state: prepared.value.state,
        });
      } catch {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "target_encryption_not_ready" as const,
        });
      }
      if (
        sealedPreparation.length === 0
        || input.now() >= unsealedReference.expiresAt
      ) return Object.freeze({
        status: "unavailable" as const,
        reason: sealedPreparation.length === 0
          ? "integrity_failure" as const
          : "authorization_required" as const,
      });
      return Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          kind: "prepared" as const,
          reference: Object.freeze({
            ...unsealedReference,
            sealedPreparation,
          }),
          preview: prepared.value.preview,
        }),
      });
    },

    async restore(request: Parameters<NonNullable<
      ProtectedAgentMemoryProjectionPort["restore"]
    >>[0]) {
      const recovered = await recover(request.authority, request.reference);
      if (recovered === null) return Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      });
      const validated = await input.validate({
        authority: request.authority,
        prepared: recovered.prepared,
        state: recovered.state,
      });
      if (
        validated.status === "success"
        && !resumableProjectionReferenceIsBound(
          input,
          request.authority,
          request.reference,
          input.now(),
        )
      ) return Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      });
      return validated;
    },

    async publish(request: Parameters<ProtectedAgentMemoryProjectionPort["publish"]>[0]) {
      const recovered = await recover(request.authority, request.reference);
      if (recovered === null) return Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      });
      const validated = await input.validate({
        authority: request.authority,
        prepared: recovered.prepared,
        state: recovered.state,
      });
      if (validated.status === "unavailable") return validated;
      if (!resumableProjectionReferenceIsBound(
        input,
        request.authority,
        request.reference,
        input.now(),
      )) return Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_required" as const,
      });
      return input.publish({
        authority: request.authority,
        reference: request.reference,
        prepared: recovered.prepared,
        state: recovered.state,
      });
    },
  });
}

export interface ProtectedAgentMemoryScopeLifecyclePort {
  create(input: Readonly<{
    operationId: string;
    authority: ProtectedMemoryAuthority;
    name: string;
    purpose?: string;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    scopeId: string;
    name: string;
  }>>>;

  attachSeed(input: Readonly<{
    operationId: string;
    authority: ProtectedMemoryAuthority;
    memoryId: string;
    scopeId: string;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    status: "attached" | "already_attached";
    scopeName: string;
  }>>>;

  close(input: Readonly<{
    operationId: string;
    authority: ProtectedMemoryAuthority;
    scopeId: string;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    status: "closing" | "closed" | "replayed";
    scopeId: string;
    transitionCount: number;
  }>>>;
}

export type ProtectedMemoryToolPorts = Readonly<{
  protectedMemoryAccessPort?: ProtectedAgentMemoryAccessPort;
  protectedMemoryProjectionPort?: ProtectedAgentMemoryProjectionPort;
  protectedMemoryScopeLifecyclePort?: ProtectedAgentMemoryScopeLifecyclePort;
}>;

export function protectedMemoryToolOperationId(input: Readonly<{
  requestId: string;
  action: string;
  subjectId?: string;
}>): string {
  return `memory:v1:${createHash("sha256").update(
    `nautilo/protected-memory-operation/v1\n${input.requestId}\n${input.action}\n${input.subjectId ?? "new"}`,
    "utf8",
  ).digest("hex")}`;
}

export function protectedMemoryToolRequestId(
  runId: string | undefined,
  configured: unknown,
): string | null {
  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : runId?.trim() || null;
}
