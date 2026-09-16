/**
 * Security audit log writer. D060 Sprint 1 G5.3.d (ship plan v3 §5.8).
 *
 * Append-only JSONL file at `~/.nautilo/security-audit.log` (or
 * whatever path the caller supplies — tests pass a tmpdir). One
 * line per security-relevant event:
 *
 *   - `posture_changed`          — PUT /api/security/posture success
 *   - `capability_check_failed`  — PUT /api/security/posture 403
 *   - `approval_granted`         — D061 approval reply accepted
 *   - `approval_denied`          — D061 approval reply denied/timeout
 *   - `standing_approval_revoked` — D235 standing rule revoked by owner
 *   - `env_var_attempt`          — release-build hard-panic tripped
 *   - `connection_vault_tool`  - D041 Connection tools (store/list/use/delete)
 *
 * v1 only ships the writer for `posture_changed` + builds the shape
 * every other event will adopt. Additional event writers wire in as
 * their source paths land (capability + approval + env-var).
 *
 * Rotation is delegated to the OS (`logrotate` on Linux, `newsyslog`
 * on macOS — ship plan §5.8 decision 5). We do NOT rotate in-process
 * — that would fight the OS rotator. We only ever APPEND + fsync.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";
import { basename, dirname, join } from "node:path";

import type { DeploymentMode, SecurityLevel } from "@nautilo/config";
import type { ApprovalReplyVerb, ApprovalAskNetworkContext } from "@nautilo/types";
import type {
  ConnectionVaultAuditAction,
  ConnectionVaultToolAuditOutcome,
} from "@nautilo/types";
import type {
  WorkstationExecutionClass,
  WorkstationAdmissionReason,
} from "@nautilo/trust";
import { warn } from "@nautilo/logger";

/**
 * Union of audit event shapes. Each variant gets its own `kind`
 * discriminator so downstream consumers (read API in v1.1, SIEM
 * integrations) can switch without string-parsing. All variants
 * share the common envelope fields — actor, timestamp, source IP,
 * user agent — serialized at the top level.
 *
 * Concrete union is declared after all event interfaces (M066).
 */
interface CommonAuditFields {
  /** ISO-8601 timestamp set by the writer (never trusted from input). */
  readonly ts: string;
  /**
   * Caller's actor ID if authenticated. `null` for anonymous probes
   * (no session cookie / invalid token) — those 401 early and we
   * don't audit them (would flood the log with port scanner noise).
   */
  readonly actorId: string | null;
  readonly ip: string;
  readonly userAgent: string | undefined;
}

export interface PostureChangedAuditEvent extends CommonAuditFields {
  readonly kind: "posture_changed";
  readonly prev: {
    readonly deploymentMode: DeploymentMode;
    readonly securityLevel: SecurityLevel;
  };
  readonly next: {
    readonly deploymentMode: DeploymentMode;
    readonly securityLevel: SecurityLevel;
  };
}

export interface CapabilityCheckFailedAuditEvent extends CommonAuditFields {
  readonly kind: "capability_check_failed";
  readonly capability: string;
  readonly attemptedRoute: string;
}

/**
 * Invalid PIN during a posture mutation. Ship plan §5.8 event type.
 * Recorded after auth + Capability succeed but verifyProof fails —
 * the lockout logic in PinChallengeProvider still fires, this row
 * is just the forensic trail. Lockout events (`LockoutError` →
 * 429) get `pinOutcome: "locked_out"` so SIEMs can distinguish
 * them from first-offense failures.
 */
export interface PinCheckFailedAuditEvent extends CommonAuditFields {
  readonly kind: "pin_check_failed";
  readonly attemptedRoute: string;
  readonly pinOutcome: "invalid" | "locked_out";
}

/** D125 / Stack 28 — first successful PIN enrollment. */
export interface PinEnrolledAuditEvent extends CommonAuditFields {
  readonly kind: "pin_enrolled";
  readonly route: "POST /api/auth/pin";
  readonly sessionUserId: string;
}

/** D061 — one-shot approval reply accepted or denied/timeout. */
export interface ApprovalReplyAuditEvent extends CommonAuditFields {
  readonly kind: "approval_granted" | "approval_denied";
  readonly route: "POST /api/auth/approval-reply";
  readonly threadId: string;
  readonly laneKey: string;
  readonly verb: ApprovalReplyVerb;
  readonly network?: ApprovalAskNetworkContext;
}

/** D235 — caller revoked a standing command-approval rule via Settings. */
export interface StandingApprovalRevokedAuditEvent extends CommonAuditFields {
  readonly kind: "standing_approval_revoked";
  readonly route: "DELETE /api/security/standing-approvals/:id";
  readonly actorUserId: string;
  readonly ruleId: string;
  readonly scope: "room" | "server";
  readonly roomId: string | null;
  readonly label: string;
  readonly toolPattern: string;
}

/** M066 — invite lifecycle (JSONL security audit stream). */
export interface InviteMintedAuditEvent extends CommonAuditFields {
  readonly kind: "invite_minted";
  readonly inviteId: string;
  readonly inviteKind: string;
  readonly targetAgentId?: string | null;
  readonly targetRoomId?: string | null;
}

export interface InviteRedeemedAuditEvent extends CommonAuditFields {
  readonly kind: "invite_redeemed";
  readonly tokenHash: string;
  readonly inviteKind: string;
  readonly landingRoomId: string;
  readonly newUserId: string;
}

export interface InviteRevokedAuditEvent extends CommonAuditFields {
  readonly kind: "invite_revoked";
  readonly inviteId: string;
}

export interface InviteRedeemFailedAuditEvent extends CommonAuditFields {
  readonly kind: "invite_redeem_failed";
  readonly tokenHash: string;
  readonly reason: string;
}

export interface InviteRedeemCleanupFailedAuditEvent extends CommonAuditFields {
  readonly kind: "invite_redeem_cleanup_failed";
  readonly logtoSub: string;
  readonly reason: string;
}

/** M105 Phase C — browser-mediated invite redeem half 2 (`complete-profile`) failed. */
export interface InviteCompleteProfileFailedAuditEvent extends CommonAuditFields {
  readonly kind: "invite_complete_profile_failed";
  readonly tokenHash: string;
  readonly reason: string;
}

/** D240 — browser-mediated invite redeem half 1 (`bind-logto-user`) succeeded. */
export interface InviteBindLogtoUserSucceededAuditEvent extends CommonAuditFields {
  readonly kind: "invite_bind_logto_user_succeeded";
  readonly tokenHash: string;
  readonly inviteKind: string;
  readonly targetGroupId?: string | null;
  readonly targetRoomId?: string | null;
  readonly userId: string;
  readonly logtoSub: string;
  readonly handleHash: string;
}

/** D240 — browser-mediated invite redeem half 1 (`bind-logto-user`) failed. */
export interface InviteBindLogtoUserFailedAuditEvent extends CommonAuditFields {
  readonly kind: "invite_bind_logto_user_failed";
  readonly reason: string;
  readonly tokenHash?: string | undefined;
  readonly inviteKind?: string | undefined;
  readonly targetGroupId?: string | null | undefined;
  readonly targetRoomId?: string | null | undefined;
  readonly logtoSub?: string | undefined;
  readonly handleHash?: string | undefined;
}

/** D112 Phase 6 — loopback claim redeem could not mint PAT / token exchange. */
export interface LogtoTokenMintFailedAuditEvent extends CommonAuditFields {
  readonly kind: "logto_token_mint_failed";
  readonly logtoSub: string;
}

/** D041 — agent Connection vault tools; values never appear in this row. */
export interface ConnectionVaultToolAuditEvent extends CommonAuditFields {
  readonly kind: "connection_vault_tool";
  readonly action: ConnectionVaultAuditAction;
  readonly tool: string;
  readonly outcome: ConnectionVaultToolAuditOutcome;
  readonly service?: string;
  readonly field?: string;
  readonly connectionId?: string;
  readonly errorKind?: string;
}

/** M068 — agent / room membership mutations (JSONL security audit). */
export interface AgentRoleAddedAuditEvent extends CommonAuditFields {
  readonly kind: "agent_role_added";
  readonly targetUserId: string;
  readonly targetAgentId: string;
  readonly roleSlug: string;
  readonly replacedFromGroupId: string | null;
  /** Set when an admin bypassed the sole-owner rail on role change (M068). */
  readonly bypassedRail?: boolean;
}

export interface AgentRoleRemovedAuditEvent extends CommonAuditFields {
  readonly kind: "agent_role_removed";
  readonly targetUserId: string;
  readonly targetAgentId: string;
  readonly roleSlug: string;
  readonly bypassedRail: boolean;
}

export interface RoomMemberAddedAuditEvent extends CommonAuditFields {
  readonly kind: "room_member_added";
  readonly targetActorId: string;
  readonly targetActorKind: "user" | "agent";
  readonly targetUserId?: string | undefined;
  readonly targetAgentId?: string | undefined;
  readonly roomId: string;
  readonly roomRole: "admin" | "member";
}

export interface RoomMemberRemovedAuditEvent extends CommonAuditFields {
  readonly kind: "room_member_removed";
  readonly targetActorId: string;
  readonly targetActorKind: "user" | "agent";
  readonly roomId: string;
  readonly bypassedRail: boolean;
}

/** M124 — a user self-joined an open (`kind='open'`) room. */
export interface RoomMemberSelfJoinedAuditEvent extends CommonAuditFields {
  readonly kind: "room_member_self_joined";
  readonly roomId: string;
}

/** M124 — a user self-left a room (self-service membership removal). */
export interface RoomMemberSelfLeftAuditEvent extends CommonAuditFields {
  readonly kind: "room_member_self_left";
  readonly roomId: string;
}

/**
 * Stack 195 / W3.0.2 — typed Group membership mutation events. These
 * kinds were already emitted by `routes/group-members.ts` (PUT/DELETE
 * `/api/groups/:id/members/:userId`) but were not in the typed union;
 * W3.0.1e / W3.0.2f add them. The row is REDACTED: it carries only the
 * opaque `groupId` / `groupType` / `targetUserId` identifiers and the
 * `actorId` envelope — never a bearer, PIN, or any secret. `bypassedRail`
 * mirrors the last-Owner bypass flag from the remover (M068 precedent).
 */
export interface GroupMemberAddedAuditEvent extends CommonAuditFields {
  readonly kind: "group_member_added";
  readonly groupId: string;
  readonly groupType: string;
  readonly targetUserId: string;
}

export interface GroupMemberRemovedAuditEvent extends CommonAuditFields {
  readonly kind: "group_member_removed";
  readonly groupId: string;
  readonly groupType: string;
  readonly targetUserId: string;
  /** Set when the remover bypassed the last-Owner rail (explicit `bypass=true`). */
  readonly bypassedRail?: boolean;
}

/**
 * Stack 195 / W3.2 — redacted RBAC administration mutation events, written
 * by the shared mutation engine after a successful apply. Each row carries
 * ONLY identifiers + capability/role slugs — never a PIN, token, secret, or
 * path. The engine builds `Omit<…, "ts" | "ip" | "userAgent">` payloads and
 * the route attaches the envelope at write time. `group_member_added` /
 * `group_member_removed` are reused for membership operations (already in
 * the union above); the kinds below cover custom Role/Group mutations.
 */
export interface RbacRoleCreatedAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_role_created";
  readonly roleId: string;
  readonly roleSlug: string;
  readonly capabilities: readonly string[];
}

export interface RbacRoleRenamedAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_role_renamed";
  readonly roleId: string;
  readonly roleSlug: string;
  readonly label: string;
}

export interface RbacRoleCapabilitiesSetAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_role_capabilities_set";
  readonly roleId: string;
  readonly roleSlug: string;
  readonly capabilities: readonly string[];
}

export interface RbacRoleDeletedAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_role_deleted";
  readonly roleId: string;
  readonly roleSlug: string;
}

export interface RbacGroupCreatedAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_group_created";
  readonly groupId: string;
  readonly groupType: string;
  readonly ownerUserId: string;
  readonly roleSlugs: readonly string[];
}

export interface RbacGroupRenamedAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_group_renamed";
  readonly groupId: string;
  readonly groupType: string;
  readonly label: string;
}

export interface RbacGroupRolesSetAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_group_roles_set";
  readonly groupId: string;
  readonly groupType: string;
  readonly roleSlugs: readonly string[];
}

export interface RbacGroupOwnerTransferredAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_group_owner_transferred";
  readonly groupId: string;
  readonly groupType: string;
  readonly fromOwnerUserId: string | null;
  readonly toOwnerUserId: string;
}

export interface RbacGroupDeletedAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_group_deleted";
  readonly groupId: string;
  readonly groupType: string;
}

/**
 * Stack 195 / W3.2.14 — atomic Create shared access composite. One redacted
 * row describes the whole Permission-set + Group + Group→Role edge + initial
 * membership creation. Carries ONLY ids/slugs/counts — never a PIN, token,
 * secret, path, or any member's PII. `memberCount` is the de-duplicated
 * initial-member count.
 */
export interface RbacSharedAccessCreatedAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_shared_access_created";
  readonly roleId: string;
  readonly roleSlug: string;
  readonly capabilities: readonly string[];
  readonly groupId: string;
  readonly groupType: string;
  readonly ownerUserId: string;
  readonly memberCount: number;
}

/**
 * Stack 195 / W3.2.14 — atomic Assign existing Permission set composite. One
 * redacted row describes the new Group + Group→existing-Role edge + initial
 * membership creation. Carries ONLY ids/slugs/counts — never a PIN, token,
 * secret, path, or any member's PII. `capabilities` is the existing Role's
 * current bundle (forensic context only; the Role definition is not
 * mutated). `memberCount` is the de-duplicated initial-member count.
 */
export interface RbacSharedAccessAssignedAuditEvent extends CommonAuditFields {
  readonly kind: "rbac_shared_access_assigned";
  readonly roleId: string;
  readonly roleSlug: string;
  readonly capabilities: readonly string[];
  readonly groupId: string;
  readonly groupType: string;
  readonly ownerUserId: string;
  readonly memberCount: number;
}

/** M075 — cross-user resume attempt blocked (JSONL security audit). */
export interface ResumeThreadAuthDeniedAuditEvent extends CommonAuditFields {
  readonly kind: "resume_thread_auth_denied";
  readonly sessionUserId: string;
  readonly threadId: string;
  readonly route: string;
}

/** D112 Phase 8 — loopback Logto password login (handle + password). */
export interface LogtoPasswordLoginSucceededAuditEvent extends CommonAuditFields {
  readonly kind: "logto_password_login_succeeded";
  readonly handleHash: string;
  readonly userId: string;
}

export interface LogtoPasswordLoginFailedAuditEvent extends CommonAuditFields {
  readonly kind: "logto_password_login_failed";
  readonly handleHash: string;
  readonly userId?: string | undefined;
}

/** D219 — a soft-deleted (`disabled_at`) account presented a bearer; the
 * trust preHandler fail-closed with 401. */
export interface UserDisabledSessionBlockedAuditEvent extends CommonAuditFields {
  readonly kind: "user_disabled_session_blocked";
  readonly sessionUserId: string;
  readonly route: string;
}

/** D219 — admin disabled a user account via the admin user-directory. */
export interface UserDisabledAuditEvent extends CommonAuditFields {
  readonly kind: "user_disabled";
  readonly targetUserId: string;
  readonly reason?: string | undefined;
}

/** D219 — admin re-enabled a previously-disabled user account. */
export interface UserEnabledAuditEvent extends CommonAuditFields {
  readonly kind: "user_enabled";
  readonly targetUserId: string;
}

/** D219 — admin issued a one-time Logto password-reset link for a user. */
export interface AdminPasswordResetIssuedAuditEvent extends CommonAuditFields {
  readonly kind: "admin_password_reset_issued";
  readonly targetUserId: string;
}

/**
 * M120 — a recovery-code proof succeeded and a Logto ForgotPassword relay
 * session was opened. No recovery code, Logto code, session token, or email
 * appears in this row — only the SHA-256 of the handle.
 */
export interface RecoverySessionOpenedAuditEvent extends CommonAuditFields {
  readonly kind: "recovery_session_opened";
  readonly handleHash: string;
}

/** M120 — a recovery-code proof failed or Logto was unavailable; no session opened. */
export interface RecoverySessionRejectedAuditEvent extends CommonAuditFields {
  readonly kind: "recovery_session_rejected";
  readonly handleHash: string;
  readonly reason:
    | "reject"
    | "logto_unavailable"
    | "logto_endpoint_missing"
    | "unexpected_error";
}

/**
 * M120 — a relay-code read was denied (unknown session id or wrong session
 * token). No session token or code appears in this row.
 */
export interface RecoveryRelayReadDeniedAuditEvent extends CommonAuditFields {
  readonly kind: "recovery_relay_read_denied";
  readonly reason: "not_found" | "bad_request";
}

/**
 * M120 — Logto delivered a ForgotPassword verification code (through the HTTP
 * Email connector) that matched no pending recovery session. The code is
 * discarded; this redacted warning is the only trace (M120 spec requirement).
 */
export interface RecoveryRelayCodeUnmatchedAuditEvent extends CommonAuditFields {
  readonly kind: "recovery_relay_code_unmatched";
}

/**
 * Stack 66 (D220) — admin hard-deleted a user account (and its owned
 * agents / rooms / sessions) via the admin user directory. Distinct from
 * `user_disabled` (soft-delete): this is irreversible. `logtoRevoked`
 * records whether the external Logto identity was also revoked.
 */
export interface UserDeletedAuditEvent extends CommonAuditFields {
  readonly kind: "user_deleted";
  readonly targetUserId: string;
  readonly logtoRevoked: boolean;
}

/**
 * D281 — admin changed the server-wide model config (default chat model,
 * Conductor / floor-manager model, fallback chain) via the §5.13 Models admin
 * section. `before` / `after` capture the resolved config either side of the
 * write so the audit row is self-contained.
 */
export interface ServerModelConfigChangedAuditEvent extends CommonAuditFields {
  readonly kind: "server_model_config_changed";
  readonly before: {
    readonly defaultChatModel: string;
    readonly conductorModel: string;
    readonly stenographerModel: string;
    readonly reflectionModel: string;
    readonly fallbackChain: readonly string[];
  };
  readonly after: {
    readonly defaultChatModel: string;
    readonly conductorModel: string;
    readonly stenographerModel: string;
    readonly reflectionModel: string;
    readonly fallbackChain: readonly string[];
  };
  readonly changes?: Readonly<Record<string, unknown>>;
}

/** D537 — admin changed non-secret server identity or icon settings. */
export interface ServerProfileChangedAuditEvent extends CommonAuditFields {
  readonly kind: "server_profile_changed";
  readonly changes: Readonly<Record<string, unknown>>;
}

/** D537 — admin changed the server-wide web-research provider mode. */
export interface ServerResearchProviderChangedAuditEvent extends CommonAuditFields {
  readonly kind: "server_research_provider_changed";
  readonly changes: Readonly<Record<string, unknown>>;
}

/** M274 — explicit Human-admin encryption transition policy change. */
export interface EncryptionTransitionPolicyChangedAuditEvent
  extends CommonAuditFields {
  readonly kind: "encryption_transition_policy_changed";
  readonly before: {
    readonly mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
    readonly shadowBehavior: "fallback" | "strict";
    readonly revision: number;
  };
  readonly after: {
    readonly mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
    readonly shadowBehavior: "fallback" | "strict";
    readonly revision: number;
  };
}

/** M274 — mandatory audit admission recorded before the policy CAS. */
export interface EncryptionTransitionPolicyChangeRequestedAuditEvent
  extends CommonAuditFields {
  readonly kind: "encryption_transition_policy_change_requested";
  readonly before: {
    readonly mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
    readonly shadowBehavior: "fallback" | "strict";
    readonly revision: number;
  };
  readonly requested: {
    readonly mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
    readonly shadowBehavior: "fallback" | "strict";
    readonly expectedRevision: number;
  };
}

/**
 * D298 — admin transferred ownership of a shared room from one user to another
 * (the recovery path for the `owns_shared_rooms` delete blocker). `manage_members`
 * gated; the new owner must already be a non-federated human member of the room.
 */
export interface RoomOwnershipTransferredAuditEvent extends CommonAuditFields {
  readonly kind: "room_ownership_transferred";
  readonly roomId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
}

/** D298 — admin archived a room (ownership migrated to caretaker + frozen). */
export interface RoomArchivedAuditEvent extends CommonAuditFields {
  readonly kind: "room_archived";
  readonly roomId: string;
  readonly fromUserId: string;
  readonly byUserId: string;
}

/** D298 — admin unarchived a room (restored read-write; ownership stays with caretaker). */
export interface RoomUnarchivedAuditEvent extends CommonAuditFields {
  readonly kind: "room_unarchived";
  readonly roomId: string;
  readonly byUserId: string;
}

/** D234 — memory mutation at the store-mutator boundary (agent tools + HTTP). */
export interface MemoryEditAuditEvent extends CommonAuditFields {
  /** Stable background mutation identity; delivery is at-least-once across receipt recovery. */
  readonly operationId?: string;
  readonly kind: "memory.edit";
  readonly memoryId: string;
  readonly action: string;
  readonly outcome: "success" | "failure";
  readonly errorKind?: string;
  readonly namespaceId?: string;
  readonly scopeId?: string;
}

/** D234 — memory archive (demote) or hard delete at the store-mutator boundary. */
export interface MemoryDeleteAuditEvent extends CommonAuditFields {
  readonly operationId?: string;
  readonly kind: "memory.delete";
  readonly memoryId: string;
  readonly mode: "archive" | "hard";
  readonly outcome: "success" | "failure";
  readonly errorKind?: string;
  readonly namespaceId?: string;
  readonly scopeId?: string;
}

/**
 * D384 Phase 3 §3.1 — a `manage_server_security`-gated mutation of
 * server-tier MCP config landed via `/api/mcp-servers` (POST/PUT/
 * PATCH-enable/DELETE). `serverName` identifies the affected row;
 * `action` mirrors the verb; `outcome` is "ok" on a successful DB
 * write (the best-effort reconcile that follows never flips this to
 * "error" — a reconcile failure is logged separately and does NOT
 * roll back the write). Denials (403) reuse the existing
 * `capability_check_failed` kind, not this one.
 */
export interface McpServerConfigAuditEvent extends CommonAuditFields {
  readonly kind: "mcp_server_config";
  readonly action: "create" | "update" | "delete" | "enable" | "disable";
  readonly serverName: string;
  readonly outcome: "ok" | "error";
  /** D503 local-install correlation only; no transport/source/session data. */
  readonly effectDigest?: string | undefined;
  /** D503 local relay id; never a Desktop session identity. */
  readonly relayId?: string | undefined;
}

/** OAuth client configuration lifecycle. Never contains client JSON or tokens. */
export interface GoogleOAuthClientConfigAuditEvent extends CommonAuditFields {
  readonly kind: "google_oauth_client_config";
  readonly action: "configure" | "remove";
  readonly outcome: "ok";
  /** Masked identifier returned by the validated store, never the secret. */
  readonly clientId: string | null;
}

/**
 * D418 — Full Workstation session lifecycle + denial. Redacted to
 * identifiers + outcome/denial reason ONLY. NO PIN, command output,
 * roots, environment values, executable paths, tokens, or raw profile
 * data ever appear in this row: the route + provider strip those before
 * emitting, and the runtime `WorkstationAccessAuditEvent` they originate
 * from carries only the binding tuple (`userId / relayId /
 * desktopSessionId / serverBindingId / profileId / profileRevision /
 * grantIds` are NOT included here — only the ids needed to correlate the
 * row, never the grant contents) plus an outcome/denial code. The `kind`
 * union mirrors `@nautilo/runtime`'s `WorkstationAccessAuditEvent`.
 *
 * `grantIds` are deliberately NOT serialized: a Full Desktop Filesystem Grant-id
 * list is binding material, not a redacted identifier, and the
 * established audit pattern (see `ConnectionVaultToolAuditEvent`,
 * `McpServerConfigAuditEvent`) keeps only the opaque id + outcome. The
 * registry/route emit `userId / relayId / desktopSessionId /
 * serverBindingId / capabilityRevision` so an operator can correlate a
 * row with the relay registration + the active session.
 */
export interface WorkstationSessionAuditEvent extends CommonAuditFields {
  readonly kind:
    | "workstation_session_activated"
    | "workstation_session_narrowed"
    | "workstation_session_broadened"
    | "workstation_session_switched"
    | "workstation_session_invalidated"
    | "workstation_session_disabled"
    | "workstation_session_denied";
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly serverBindingId: string;
  readonly capabilityRevision: number;
  /** Present on `workstation_session_denied` — the registry denial code. */
  readonly denialCode?: string;
  /** Present on transitions — the activate/disable outcome. */
  readonly outcome?: string;
  /** Forensic route tag, mirroring the security audit log's `route` field. */
  readonly route?: string;
}

/**
 * D538 — redacted lifecycle evidence for the deliberately separate
 * uncontained-host-command session. This is not a Workstation Profile event:
 * it contains only opaque binding identifiers and a stable reason/outcome.
 * In particular, it must never contain a PIN, command, path, environment,
 * grant contents, or command output.
 */
export interface UncontainedHostCommandsAuditEvent extends CommonAuditFields {
  readonly kind:
    | "uncontained_host_commands_activated"
    | "uncontained_host_commands_disabled"
    | "uncontained_host_commands_invalidated"
    | "uncontained_host_commands_status_invalidated"
    | "uncontained_host_commands_denied"
    | "uncontained_host_commands_dispatch_admitted"
    | "uncontained_host_commands_dispatch_denied";
  readonly userId: string;
  readonly relayId?: string;
  readonly desktopSessionId?: string;
  readonly serverBindingId?: string;
  readonly capabilityRevision?: number;
  readonly reason?: string;
  readonly route?: string;
}

/**
 * D418 Commit 4 — the canonical redacted Workstation execution-admission
 * audit event is defined above as {@link WorkstationAdmissionAuditEvent}
 * and emitted by the server-side override resolver
 * (`createWorkstationApprovalOverrideResolver`) for every dispatch it is
 * consulted on. The row carries execution class + outcome/reason + opaque
 * session/plan binding ids + tool/toolCall id, and never command text,
 * output, roots, environment, token, PIN, or grant contents. `none` is no
 * longer silent: every consultation emits a row (auto or none) so the
 * admission surface is fully auditable.
 */

/**
 * D418 Commit 4 — redacted Workstation execution-ADMISSION audit row, the
 * server-side mirror of `@nautilo/runtime`'s runtime-owned
 * `WorkstationAdmissionAuditEvent`. Emitted by the server-side override
 * resolver (`createWorkstationApprovalOverrideResolver`) for every dispatch
 * it is consulted on, and written through `writeSecurityAuditEvent`.
 *
 * The row is REDACTED: it carries ONLY the execution class, the admission
 * outcome/reason, the concrete tool/tool-call id, and OPAQUE plan/session
 * binding identifiers. It NEVER carries command text, command output,
 * roots, paths, environment values, tokens, PINs, or grant contents —
 * those are authority material owned by the local Electron sandbox/grant
 * enforcement at execution, not by admission. `grantIds` are deliberately
 * NOT serialized (a grant-id list is binding material, not a redacted
 * identifier — see `WorkstationSessionAuditEvent` for the same decision).
 */
export type WorkstationAdmissionAuditOutcome = "auto" | "none";

/**
 * The admission {@link WorkstationAdmissionReason} is used for a `none`
 * outcome (including the server's independent `critical_or_elevation_command`
 * scan refusal); the `auto_admitted` sentinel is used for an `auto` outcome.
 */
export type WorkstationAdmissionAuditReason =
  | WorkstationAdmissionReason
  | "auto_admitted";

export interface WorkstationAdmissionAuditEvent extends CommonAuditFields {
  readonly kind: "workstation_admission";
  readonly userId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly executionClass: WorkstationExecutionClass;
  readonly outcome: WorkstationAdmissionAuditOutcome;
  readonly reason: WorkstationAdmissionAuditReason;
  /** Opaque session binding identifiers (never grant contents). */
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly serverBindingId: string;
  readonly pairingGeneration: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly capabilityRevision: number;
}

/**
 * D480 — grouped device revoke / historical cleanup lifecycle audit. The
 * management target is the server-issued opaque management id (or the fixed
 * `historical` sentinel), never a raw device-group, installation, relay-token,
 * or pairing-generation identifier. Exact revoked generations are authority
 * inputs only and intentionally do not appear in this durable audit row.
 */
export interface RelayPairingLifecycleAuditEvent extends CommonAuditFields {
  readonly kind: "relay_pairing_lifecycle";
  readonly userId: string;
  readonly operation: "group_revoke" | "historical_cleanup";
  readonly managementTarget: string;
  readonly affectedPairingCount: number;
  readonly result: "succeeded" | "not_found_or_foreign" | "stale" | "failed";
  readonly reason: "revoked" | "confirmation_mismatch" | "not_found_or_foreign" | "store_error";
  readonly correlationId: string;
}

export type SecurityAuditEvent =
  | PostureChangedAuditEvent
  | CapabilityCheckFailedAuditEvent
  | PinCheckFailedAuditEvent
  | PinEnrolledAuditEvent
  | ApprovalReplyAuditEvent
  | StandingApprovalRevokedAuditEvent
  | InviteMintedAuditEvent
  | InviteRedeemedAuditEvent
  | InviteRevokedAuditEvent
  | InviteRedeemFailedAuditEvent
  | InviteRedeemCleanupFailedAuditEvent
  | InviteCompleteProfileFailedAuditEvent
  | InviteBindLogtoUserSucceededAuditEvent
  | InviteBindLogtoUserFailedAuditEvent
  | LogtoTokenMintFailedAuditEvent
  | ConnectionVaultToolAuditEvent
  | AgentRoleAddedAuditEvent
  | AgentRoleRemovedAuditEvent
  | RoomMemberAddedAuditEvent
  | RoomMemberRemovedAuditEvent
  | RoomMemberSelfJoinedAuditEvent
  | RoomMemberSelfLeftAuditEvent
  | GroupMemberAddedAuditEvent
  | GroupMemberRemovedAuditEvent
  | RbacRoleCreatedAuditEvent
  | RbacRoleRenamedAuditEvent
  | RbacRoleCapabilitiesSetAuditEvent
  | RbacRoleDeletedAuditEvent
  | RbacGroupCreatedAuditEvent
  | RbacGroupRenamedAuditEvent
  | RbacGroupRolesSetAuditEvent
  | RbacGroupOwnerTransferredAuditEvent
  | RbacGroupDeletedAuditEvent
  | RbacSharedAccessCreatedAuditEvent
  | RbacSharedAccessAssignedAuditEvent
  | ResumeThreadAuthDeniedAuditEvent
  | LogtoPasswordLoginSucceededAuditEvent
  | LogtoPasswordLoginFailedAuditEvent
  | UserDisabledSessionBlockedAuditEvent
  | UserDisabledAuditEvent
  | UserEnabledAuditEvent
  | AdminPasswordResetIssuedAuditEvent
  | RecoverySessionOpenedAuditEvent
  | RecoverySessionRejectedAuditEvent
  | RecoveryRelayReadDeniedAuditEvent
  | RecoveryRelayCodeUnmatchedAuditEvent
  | UserDeletedAuditEvent
  | ServerModelConfigChangedAuditEvent
  | EncryptionTransitionPolicyChangedAuditEvent
  | EncryptionTransitionPolicyChangeRequestedAuditEvent
  | ServerProfileChangedAuditEvent
  | ServerResearchProviderChangedAuditEvent
  | RoomOwnershipTransferredAuditEvent
  | RoomArchivedAuditEvent
  | RoomUnarchivedAuditEvent
  | MemoryEditAuditEvent
  | MemoryDeleteAuditEvent
  | McpServerConfigAuditEvent
  | GoogleOAuthClientConfigAuditEvent
  | WorkstationSessionAuditEvent
  | UncontainedHostCommandsAuditEvent
  | WorkstationAdmissionAuditEvent
  | RelayPairingLifecycleAuditEvent;

export type SecurityAuditEventKind = SecurityAuditEvent["kind"];

export interface ReadSecurityAuditLogOptions {
  readonly since?: string;
  readonly limit?: number;
  readonly actorId?: string;
  readonly kinds?: readonly SecurityAuditEventKind[];
  readonly correlationId?: string;
  readonly cursor?: string;
}

export interface ReadSecurityAuditLogResult {
  readonly events: readonly SecurityAuditEvent[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

function auditSnapshot(
  events: readonly SecurityAuditEvent[],
  opts: ReadSecurityAuditLogOptions,
  limit: number,
): string {
  const query = {
    actorId: opts.actorId ?? null,
    correlationId: opts.correlationId ?? null,
    kinds: opts.kinds === undefined ? null : [...opts.kinds].sort(compareCodeUnits),
    limit,
    since: opts.since ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify({ query, events }), "utf8")
    .digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareAuditEvents(left: SecurityAuditEvent, right: SecurityAuditEvent): number {
  const timestampOrder = Date.parse(right.ts) - Date.parse(left.ts);
  if (timestampOrder !== 0) return timestampOrder;
  return compareCodeUnits(JSON.stringify(left), JSON.stringify(right));
}

function parseAuditCursor(value: string | undefined): { offset: number; snapshot: string } | null {
  if (value === undefined) return { offset: 0, snapshot: "" };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const snapshot = (parsed as { snapshot?: unknown } | null)?.snapshot;
    if (
      parsed === null
      || typeof parsed !== "object"
      || !Number.isInteger((parsed as { offset?: unknown }).offset)
      || ((parsed as { offset: number }).offset < 1)
      || typeof snapshot !== "string"
      || !/^[a-f0-9]{64}$/u.test(snapshot)
    ) return null;
    return parsed as { offset: number; snapshot: string };
  } catch {
    return null;
  }
}

/**
 * Append a single event to the JSONL audit log. Creates the parent
 * directory if missing (first-run case). Opens an append-mode fd,
 * writes the line, fsyncs ON THE SAME FD, then closes — so the
 * audit trail survives a sudden crash.
 *
 * Ship plan §5.8: "audit log is the security compliance artifact;
 * losing rows is worse than the caller seeing a slow write."
 *
 * Idempotent on the parent dir; best-effort swallows mkdir EEXIST.
 */
export function writeSecurityAuditEvent(
  path: string,
  event: SecurityAuditEvent,
): void {
  const parent = dirname(path);
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } catch (err) {
    // Best-effort: if we can't even create the parent dir, the
    // downstream openSync will throw with a clearer error.
    warn(`[security-audit-log] mkdir(${parent}) failed: ${String(err)}`);
  }

  const line = `${JSON.stringify(event)}\n`;
  // Open append-mode fd with 0o600 on creation — holding PII
  // (actor_id, ip, user_agent) per §5.8, so owner-only perms.
  // O_APPEND ensures concurrent writers don't clobber each other
  // (kernel serializes at each write() boundary for files < pipe
  // buffer size, which a single JSONL line always is).
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line, null, "utf-8");
    // Explicit fsync on the SAME fd we wrote through — flushes the
    // write to durable storage. Reading fsync(2): "transfers all
    // modified in-core data of the file referred to by the file
    // descriptor fd to the disk device." Using the append fd (not a
    // separately-opened read fd) is the idiomatic correct pattern.
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch (err) {
      warn(`[security-audit-log] closeSync failed: ${String(err)}`);
    }
  }
}

export function readSecurityAuditLog(
  path: string,
  opts: ReadSecurityAuditLogOptions = {},
): ReadSecurityAuditLogResult {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const sinceMs = opts.since === undefined ? null : Date.parse(opts.since);
  const allowedKinds = opts.kinds === undefined ? null : new Set(opts.kinds);
  const allEvents: SecurityAuditEvent[] = [];

  for (const candidate of auditLogCandidatePaths(path)) {
    for (const line of readJsonlLines(candidate)) {
      if (line.trim().length === 0) continue;
      try {
        const event = JSON.parse(line) as SecurityAuditEvent;
        if (sinceMs !== null && Date.parse(event.ts) < sinceMs) continue;
        if (opts.actorId !== undefined && event.actorId !== opts.actorId) continue;
        if (
          opts.correlationId !== undefined
          && (!("correlationId" in event) || event.correlationId !== opts.correlationId)
        ) continue;
        if (allowedKinds !== null && !allowedKinds.has(event.kind)) continue;
        allEvents.push(event);
      } catch (err) {
        warn(
          `[security-audit-log] skipping malformed JSONL line in ${candidate}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  allEvents.sort(compareAuditEvents);
  const cursor = parseAuditCursor(opts.cursor);
  if (cursor === null) throw new Error("invalid_audit_cursor");
  const snapshot = auditSnapshot(allEvents, opts, limit);
  if (cursor.snapshot.length > 0 && cursor.snapshot !== snapshot) {
    throw new Error("stale_audit_cursor");
  }
  const offset = cursor.offset;
  const hasMore = allEvents.length > offset + limit;
  return {
    events: allEvents.slice(offset, offset + limit),
    hasMore,
    nextCursor: hasMore
      ? Buffer.from(JSON.stringify({ offset: offset + limit, snapshot }), "utf8").toString("base64url")
      : null,
  };
}

function auditLogCandidatePaths(path: string): string[] {
  const parent = dirname(path);
  const base = basename(path);
  if (!existsSync(parent)) return [];

  const candidates = readdirSync(parent)
    .filter((name) => name === base || name.startsWith(`${base}.`))
    .map((name) => join(parent, name))
    .filter((p) => statSync(p).isFile());

  candidates.sort((a, b) => {
    if (a === path) return -1;
    if (b === path) return 1;
    return statSync(b).mtimeMs - statSync(a).mtimeMs;
  });
  return candidates;
}

function readJsonlLines(path: string): string[] {
  try {
    const raw = path.endsWith(".gz")
      ? gunzipSync(readFileSync(path)).toString("utf-8")
      : readFileSync(path, "utf-8");
    return raw.split("\n");
  } catch (err) {
    warn(`[security-audit-log] read ${path} failed: ${String(err)}`);
    return [];
  }
}
