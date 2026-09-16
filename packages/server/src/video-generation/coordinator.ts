/**
 * D378's narrow Video -> D525 seam.  This is not a generic app-tool
 * invocation surface: the route must first attest the first-party Video host,
 * then this coordinator binds that same Human/Room/namespace/project to one
 * closed D525 video_app origin.
 */
import { randomUUID } from "node:crypto";
import {
  mediaGenerationApprovalFromPrepared,
  prepareMediaGenerationApproval,
  submitMediaGenerationApproval,
  type MediaGenerationApprovalActorContext,
  type MediaGenerationSafeResult,
} from "@nautilo/agent";
import type { MediaGenerationApproval, MediaGenerationPreparedApproval } from "@nautilo/types";
import type { NormalizedMediaGenerationRequest } from "@nautilo/agent";

export interface VideoGenerationProjectScope extends MediaGenerationApprovalActorContext {
  readonly namespaceId: string;
  readonly projectArtifactInternalId: string;
  readonly projectArtifactId: string;
}

export interface VideoGenerationLinkRecord {
  readonly takeId: string;
  readonly receiptId: string;
  readonly ownerId: string;
  readonly actorUserId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly projectArtifactInternalId: string;
  readonly requestId: string;
  readonly shotId: string;
  readonly shotLabel: string;
  readonly briefDigest: string;
  readonly documentRevision: number;
  readonly admittedAt?: Date | null;
}

export interface VideoGenerationLinkStore {
  findByRequest(scope: VideoGenerationProjectScope, requestId: string): Promise<VideoGenerationLinkRecord | null>;
  create(input: VideoGenerationLinkRecord): Promise<VideoGenerationLinkRecord>;
  markAdmitted(scope: VideoGenerationProjectScope, takeId: string): Promise<boolean>;
}

export interface VideoGenerationPrepareRequest {
  readonly scope: VideoGenerationProjectScope;
  readonly requestId: string;
  readonly shotId: string;
  readonly shotLabel: string;
  readonly briefDigest: string;
  readonly documentRevision: number;
  /** Untrusted request is normalized by D525 before quote I/O. */
  readonly intent: unknown;
}

/** Client-safe exact-review result. `reviewHandle` is not an artifact/receipt/provider id. */
export interface VideoGenerationReview {
  readonly takeId: string;
  readonly reviewHandle: string;
  readonly approval: MediaGenerationApproval;
}

type PendingReview = Readonly<{
  scope: VideoGenerationProjectScope;
  prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>;
  takeId: string;
  expiresAtMs: number;
}>;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PLAN_FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const SHOT_ID = /^(?:quick-brief|[A-Za-z][A-Za-z0-9_-]{0,63})$/u;
function validShotLabel(value: string): boolean {
  return value.length > 0 && !/[\r\n\0]/u.test(value);
}

function validRequest(input: VideoGenerationPrepareRequest): boolean {
  return REQUEST_ID.test(input.requestId) && PLAN_FINGERPRINT.test(input.briefDigest) &&
    Number.isSafeInteger(input.documentRevision) && input.documentRevision >= 0 &&
    SHOT_ID.test(input.shotId) && validShotLabel(input.shotLabel);
}

type VideoGenerationPrepareFailure = {
  readonly ok: false;
  readonly code: "request_invalid" | "quote_unavailable";
  readonly recovery: string;
};

function mapPreparationFailure(
  result: Exclude<Awaited<ReturnType<typeof prepareMediaGenerationApproval>>, { readonly ok: true }>,
): VideoGenerationPrepareFailure {
  switch (result.code) {
    case "request_invalid":
    case "quote_rejected":
      return { ok: false, code: "request_invalid", recovery: result.recovery };
    case "target_unavailable":
    case "quote_unavailable":
    case "quote_binding_failed":
    case "quote_reservation_failed":
      return { ok: false, code: "quote_unavailable", recovery: result.recovery };
  }
}

/**
 * Pending reviews intentionally live only for the D525 approval TTL. A server
 * restart cannot turn an old quote into a spend; it requires a fresh review.
 * The durable link survives and remains the project/take lineage once a
 * receipt has been reserved.
 */
export function createVideoGenerationCoordinator(deps: {
  readonly links: VideoGenerationLinkStore;
  readonly randomId?: () => string;
  readonly now?: () => Date;
}): {
  prepare(input: VideoGenerationPrepareRequest): Promise<
    | { readonly ok: true; readonly review: VideoGenerationReview }
    | { readonly ok: false; readonly code: "request_invalid" | "quote_unavailable" | "already_prepared"; readonly recovery: string }
  >;
  submit(input: { readonly scope: VideoGenerationProjectScope; readonly takeId: string; readonly reviewHandle: string }): Promise<MediaGenerationSafeResult>;
} {
  const pending = new Map<string, PendingReview>();
  const randomId = deps.randomId ?? randomUUID;
  const now = deps.now ?? (() => new Date());

  function prunePending(): void {
    const current = now().getTime();
    for (const [handle, review] of pending) {
      if (review.expiresAtMs <= current) pending.delete(handle);
    }
  }

  return {
    async prepare(input) {
      if (!validRequest(input)) {
        return { ok: false, code: "request_invalid", recovery: "Review the shot details and request a fresh generation." };
      }
      prunePending();
      const existing = await deps.links.findByRequest(input.scope, input.requestId);
      if (existing) {
        // The original quote may already be expired and its prompt must never
        // be reconstructed from a durable link. A new client request id starts
        // a new reviewed quote; neither branch spends anything.
        return { ok: false, code: "already_prepared", recovery: "This shot already has a generation request. Open its take or make a fresh reviewed request." };
      }
      const result = await prepareMediaGenerationApproval({
        actor: { userId: input.scope.userId, roomId: input.scope.roomId, agentId: input.scope.agentId },
        intent: input.intent,
        approvalId: `video:${input.requestId}`,
        origin: { kind: "video_app", projectArtifactId: input.scope.projectArtifactId, requestId: input.requestId },
      });
      if (!result.ok) return mapPreparationFailure(result);
      const prepared = result.prepared;
      const takeId = `take_${randomId().replace(/-/gu, "")}`;
      let link: VideoGenerationLinkRecord;
      try {
        link = await deps.links.create({
          takeId,
          receiptId: prepared.binding.receiptId,
          ownerId: input.scope.userId,
          actorUserId: input.scope.userId,
          roomId: input.scope.roomId,
          namespaceId: input.scope.namespaceId,
          projectArtifactInternalId: input.scope.projectArtifactInternalId,
          requestId: input.requestId,
          shotId: input.shotId,
          shotLabel: input.shotLabel,
          briefDigest: input.briefDigest,
          documentRevision: input.documentRevision,
        });
      } catch {
        return { ok: false, code: "quote_unavailable", recovery: "The reviewed generation could not be linked safely. No generation was started." };
      }
      const expiresAtMs = new Date(prepared.binding.expiresAt).getTime();
      if (!Number.isFinite(expiresAtMs)) {
        return { ok: false, code: "quote_unavailable", recovery: "The reviewed generation expired before it could be shown. Request a fresh quote." };
      }
      const reviewHandle = randomId();
      pending.set(reviewHandle, { scope: input.scope, prepared, takeId: link.takeId, expiresAtMs });
      return { ok: true, review: { takeId: link.takeId, reviewHandle, approval: mediaGenerationApprovalFromPrepared(prepared) } };
    },

    async submit(input) {
      prunePending();
      const pendingReview = pending.get(input.reviewHandle);
      if (!pendingReview || pendingReview.takeId !== input.takeId || pendingReview.scope.userId !== input.scope.userId ||
          pendingReview.scope.roomId !== input.scope.roomId ||
          pendingReview.scope.namespaceId !== input.scope.namespaceId ||
          pendingReview.scope.projectArtifactInternalId !== input.scope.projectArtifactInternalId) {
        return {
          kind: "generated_media", version: 1, queueStarted: false, mediaKind: "video", state: "failed",
          model: "unavailable", promptSummary: "", settings: {},
          failure: { code: "VIDEO_REVIEW_STALE", message: "This review is no longer available. Request a fresh quote before generating." },
          recoveryActions: [],
        };
      }
      const prepared = pendingReview.prepared;
      const result = await submitMediaGenerationApproval(
        { userId: input.scope.userId, roomId: input.scope.roomId, agentId: input.scope.agentId },
        {
          prepared,
          approvalId: prepared.binding.approvalId,
          receiptId: prepared.binding.receiptId,
          digest: prepared.binding.approvalDigest,
          quoteDigest: prepared.binding.quoteDigest,
          revision: prepared.binding.revision,
        },
      );
      if (result.queueStarted !== true) return result;
      try {
        if (await deps.links.markAdmitted(input.scope, pendingReview.takeId)) return result;
      } catch {
        // D525 has accepted work but the project take was not durably made
        // visible. Fence a fresh spend; replaying this same receipt can repair
        // the link idempotently.
      }
      return {
        ...result,
        queueStarted: null,
        state: "unknown",
        failure: { code: "VIDEO_TAKE_RECONCILIATION_REQUIRED", message: "The generation was accepted, but its project take needs reconciliation before another generation." },
      };
    },
  };
}
