/** A Room scope never implies membership or access to its private content. */
export type ModerationScope = { readonly roomId: string | null };
export type ModerationAction = "ban" | "kick" | "timeout" | "mute" | "lift";

export interface ModerationCommand {
  readonly operationId: string;
  readonly targetUserId: string;
  readonly roomId: string | null;
  readonly action: ModerationAction;
  readonly reason: string;
  readonly deleteCommunityMessages?: boolean;
  readonly privateNote: string | null;
  readonly expiresAt: string | null;
  /** Exact target/authority state returned by the person inspection. */
  readonly targetRevision: string;
  readonly restrictionId: string | null;
  readonly restrictionRevision: number | null;
}

export interface ModerationReceipt {
  readonly operationId: string;
  readonly action: ModerationAction;
  readonly roomId: string | null;
  readonly restrictionId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly committed: true;
  readonly replayed: boolean;
  readonly auditRecorded: boolean;
  readonly converged: boolean;
  readonly messageCleanup?: "not_requested" | "pending" | "complete";
}

export type ModerationFailureCode =
  | "invalid_request" | "forbidden_scope" | "protected_target" | "target_unavailable"
  | "stale_revision" | "idempotency_conflict" | "admission_withdrawn" | "active_ban"
  | "restriction_inactive" | "unsupported_identity" | "enrollment_paused" | "moderation_disabled"
  | "join_message_required" | "enrollment_review_required" | "enrollment_rejected";

export interface ServerModerationPolicy {
  readonly enabled: boolean;
  readonly joinsPaused: boolean;
  readonly approvalRequired: boolean;
  readonly revision: number;
}

export interface EnrollmentReviewStatus {
  readonly required: boolean;
  readonly paused: boolean;
  readonly state: "not_requested" | "pending" | "approved" | "rejected" | "completed";
  readonly message: string | null;
  readonly revision: number;
}

export interface EnrollmentReviewItem {
  readonly inviteId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly handle: string | null;
  readonly message: string;
  readonly state: "pending" | "approved" | "rejected";
  readonly revision: number;
}

export interface ModerationPerson {
  readonly userId: string;
  readonly displayName: string;
  readonly roomId: string | null;
  readonly targetRevision: string;
  readonly allowedActions: readonly ModerationAction[];
  readonly protectedTarget: boolean;
}

export interface ModerationRestriction {
  readonly id: string;
  readonly targetUserId: string | null;
  readonly displayName: string | null;
  readonly roomId: string | null;
  readonly kind: "access" | "participation";
  readonly reason: string | null;
  readonly startsAt: string;
  readonly expiresAt: string | null;
  readonly revision: number;
}
