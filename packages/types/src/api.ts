import type { AvatarRef } from "./profile";
import type { ProtectedMessageDtoV2 } from "./protected-message";

export * from "./push-notifications";

export const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 10;

export type ActiveMiniAppTargetKind = "artifact" | "fs";
export type ActiveMiniAppMode = "edit" | "preview";

/**
 * M187 — compact active mini-app context forwarded on chat sends.
 * Advisory prompt context only; server sanitizes before agent state.
 */
export interface ActiveMiniAppRequestContext {
  appId: string;
  appName?: string;
  /** Host-owned surface mode; iframe context cannot choose this value. */
  mode?: ActiveMiniAppMode;
  documentPath?: string;
  targetKind?: ActiveMiniAppTargetKind;
  selection?: unknown;
  summary?: unknown;
  updatedAt: number;
}

/**
 * M216 — browser-safe live-document version for trusted mini-app review.
 * Artifact sessions use monotonic workspace revisions; Current Folder sessions
 * pin canonical bytes with a relay-validated SHA-256 digest.
 */
export type LiveDocumentVersion =
  | {
      kind: "artifact_revision";
      revision: number;
    }
  | {
      kind: "local_sha";
      sha256: string;
    };

export type ArtifactDocumentVersion = Extract<
  LiveDocumentVersion,
  { kind: "artifact_revision" }
>;

export type LocalShaDocumentVersion = Extract<LiveDocumentVersion, { kind: "local_sha" }>;

const LOCAL_SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Non-negative safe integer suitable for artifact revision fields. */
export function parseNonNegativeSafeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/** Canonical lowercase 64-character hex SHA-256 digest. */
export function parseLocalSha256(value: unknown): string | null {
  if (typeof value !== "string" || !LOCAL_SHA256_HEX_RE.test(value)) {
    return null;
  }
  return value;
}

export function parseArtifactDocumentVersion(
  value: unknown,
): ArtifactDocumentVersion | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== "artifact_revision") return null;
  const revision = parseNonNegativeSafeInteger(
    (value as { revision?: unknown }).revision,
  );
  if (revision === null) return null;
  return { kind: "artifact_revision", revision };
}

export function parseLocalShaDocumentVersion(
  value: unknown,
): LocalShaDocumentVersion | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== "local_sha") return null;
  const sha256 = parseLocalSha256((value as { sha256?: unknown }).sha256);
  if (sha256 === null) return null;
  return { kind: "local_sha", sha256 };
}

export function parseLiveDocumentVersion(value: unknown): LiveDocumentVersion | null {
  return parseArtifactDocumentVersion(value) ?? parseLocalShaDocumentVersion(value);
}

export function liveDocumentVersionEquals(
  a: LiveDocumentVersion,
  b: LiveDocumentVersion,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "artifact_revision") {
    return b.kind === "artifact_revision" && a.revision === b.revision;
  }
  return b.kind === "local_sha" && a.sha256 === b.sha256;
}

/**
 * A bounded logical position in a paginated document-table read. It is
 * deliberately a coordinate, never a source offset or document payload.
 */
export type LiveDocumentTableReadCursor = Readonly<{
  rowIndex: number;
  colIndex: number;
  blockIndex: number;
  sliceIndex: number;
}>;

/**
 * Server-classified, non-authorizing evidence that an exact live document
 * version was read. These facts contain only structural indexes and cursors;
 * they must never carry a session bearer, path, or document text.
 */
export type LiveDocumentReadCoverageFact =
  | Readonly<{
      kind: "block_range";
      documentVersion: LiveDocumentVersion;
      blockCount: number;
      blockIndexes: readonly number[];
    }>
  | Readonly<{
      kind: "table_page";
      documentVersion: LiveDocumentVersion;
      blockCount: number;
      tableBlockIndex: number;
      cursor: LiveDocumentTableReadCursor;
      nextCursor: LiveDocumentTableReadCursor | null;
    }>;

/** Opaque host-issued authority for a currently hydrated live mini-app document. */
export interface LiveMiniAppSessionCapability {
  sessionToken: string;
  /** Non-authorizing opaque handle used only to route live results to the iframe. */
  sessionId: string;
  documentVersion: LiveDocumentVersion;
}

/**
 * Host-owned, server-validated live-review context. Unlike `activeMiniApp`,
 * this is not advisory iframe data and is only constructed after registry
 * validation at chat ingress.
 */
export interface TrustedLiveMiniAppSessionContext extends LiveMiniAppSessionCapability {
  appId: string;
  instructions: string;
}

export type IssueLiveMiniAppSessionRequest = {
  /** Host-created cleanup identity, scoped by authenticated user and app. */
  clientSessionId?: string;
  /** Host-only one-shot preparation receipt; never sent to the iframe/model. */
  issuanceToken?: string;
} & (
  | {
      targetKind: "artifact";
      artifactId: string;
      documentVersion: ArtifactDocumentVersion;
    }
  | {
      targetKind: "currentFile";
      /** Host-only hint from Electron preload; never forwarded to iframe/model. */
      relayIdHint: string;
      currentFolder: string;
      relativePath: string;
      documentVersion: LocalShaDocumentVersion;
    });

export interface IssueLiveMiniAppSessionResponse extends LiveMiniAppSessionCapability {
  expiresAt: number;
}

export type RefreshLiveMiniAppSessionRequest = IssueLiveMiniAppSessionRequest & {
  sessionToken: string;
};

export type RevokeLiveMiniAppSessionRequest =
  | { sessionToken: string }
  | { clientSessionId: string };

export interface ListPendingLiveProposalReviewsRequest {
  sessionToken: string;
}

export interface PendingLiveProposalReview {
  proposalId: string;
  appId: string;
  sessionId: string;
  documentVersion: LiveDocumentVersion;
  operations: unknown[];
}

export interface ListPendingLiveProposalReviewsResponse {
  proposals: PendingLiveProposalReview[];
}

export interface ApplyAcceptedLiveProposalRequest {
  requestId: string;
  sessionToken: string;
  proposalId: string;
  documentVersion: LiveDocumentVersion;
  acceptedContent: string;
  acceptedOperationIndexes: number[];
}

export interface ApplyAcceptedLiveProposalResponse {
  /** Canonical post-write version from the target's existing write seam. */
  documentVersion: LiveDocumentVersion;
  /** SHA-256 of the exact canonical postimage used as Writer's next base. */
  contentSha256: string;
  /** Current Folder only; opaque server/relay revision receipt. */
  localRevisionRef?: string;
}

export interface ResolveLiveProposalReviewRequest {
  sessionToken: string;
  proposalId: string;
  /** Version on which the proposal was created. */
  documentVersion: LiveDocumentVersion;
  outcome: "accepted" | "rejected";
  /** Required only after accepted persistence. */
  resultDocumentVersion?: LiveDocumentVersion;
}

export interface ResolveLiveProposalReviewResponse {
  ok: true;
  taskStatus: "not_task" | "running" | "pending" | "completed" | "cancelled";
}

/** A review became impossible to present or accept; this never writes bytes. */
export type InvalidateLiveProposalReviewReason =
  | "human_changed"
  | "stale_version"
  | "remote_changed"
  | "session_closed"
  | "no_effective_change";

export interface InvalidateLiveProposalReviewRequest {
  sessionToken: string;
  proposalId: string;
  /** Original proposal version; may intentionally differ from the live version. */
  documentVersion: LiveDocumentVersion;
  reason: InvalidateLiveProposalReviewReason;
}

export interface InvalidateLiveProposalReviewResponse {
  ok: true;
  taskStatus: "not_task" | "running" | "failed";
}

export type ApplyAcceptedLiveProposalErrorCode =
  | "session_closed"
  | "stale_version"
  | "relay_unavailable"
  | "local_target_forbidden"
  | "proposal_closed"
  | "acceptance_conflict"
  | "invalid_request"
  | "payload_too_large";

/**
 * D356 — metadata-only artifact reference forwarded on chat sends.
 *
 * A "focus on this artifact" chip. The artifact already lives server-side
 * (workspace-artifacts), so NO bytes are uploaded — this carries only the
 * external `artifactId` plus display metadata. Mirrors the `activeMiniApp` /
 * `currentFolder` in-focus-context pattern (NOT the `attachments[]` byte
 * pipeline). The server resolves+validates each `artifactId` against the
 * caller's readable namespaces and injects a "## Referenced artifacts"
 * system-prompt block; bytes are reached (if at all) via the agent's
 * workspace file tools by `artifactId`/`path`.
 *
 * `artifactId` is the EXTERNAL, agent-facing id (may contain `/`), NOT the
 * internal artifact row uuid used in REST URLs / drag payloads.
 */
export interface ChatArtifactRef {
  artifactId: string;
  path: string;
  mimeType: string;
  size: number;
}

/**
 * D423 — authoritative capability set for a resolved focused resource.
 * Server/relay-derived only; NEVER client-authored. A focus ref never implies
 * ingestion — a capability describes what an approved tool operation against
 * the resource may do, not what has already happened.
 */
export type ResourceCapability =
  | "read"
  | "edit"
  | "convert"
  | "transcribe"
  | "extract-audio"
  | "share";

/**
 * D423 — the kind of origin a focused resource lives at. Drives which
 * resolver owns authority over metadata + capabilities.
 */
export type FocusedResourceLocation = "server" | "relay";

/**
 * D423 — how long a focused resource remains in scope. Focus refs are
 * execution context, not durable message attachments.
 *   - "turn"      → this agent turn only (e.g. a local-file focus ref)
 *   - "message"   → owned by the D271 message attachment (retained/consumed)
 *   - "workspace" → persistent server-side artifact
 */
export type FocusedResourceLifetime = "turn" | "message" | "workspace";

/**
 * D423 Phase 4 — the model-facing `file` tool target a resolved resource maps
 * to. The model sees a unified `file` zone/path; relay selection, WebSocket /
 * API routing, and byte-bridge mechanics stay private to the resolver / tool
 * dispatch layer.
 */
export interface FocusedResourceToolTarget {
  tool: "file";
  zone: "workspace" | "current" | "absolute";
  path: string;
}

/**
 * D423 Phase 4 — internal authoritative manifest entry produced by the
 * kind-keyed resolver registry. The client identifies a resource
 * (`ChatFocusedResourceRef`); the server derives every field below. `locator`
 * is PRIVATE, kind-specific, server-only run metadata (absolute paths, relay
 * IDs, internal row ids) — it MUST NOT enter room-visible messages, receipts,
 * public audit summaries, or the model prompt prose.
 */
export interface ResolvedFocusedResource {
  kind: "workspace-artifact" | "local-file" | "message-attachment";
  displayName: string;
  mimeType?: string;
  size?: number;
  location: FocusedResourceLocation;
  lifetime: FocusedResourceLifetime;
  capabilities: ResourceCapability[];
  toolTarget?: FocusedResourceToolTarget;
  /** Private, kind-specific, never serialized into public prompt prose. */
  locator: unknown;
}

/**
 * D423 Phase 4 — generic discriminated focus-ref union carried on chat sends.
 *
 * The client identifies a resource by origin; it NEVER asserts what the
 * resource is allowed to do. Capabilities, metadata, and the model-facing
 * `file` tool target are server/relay-derived by the resolver registry
 * (`packages/server/src/messaging/focused-resources.ts`). A focus ref never
 * implies byte ingestion, persistence, sharing, conversion, or transcription.
 *
 *   - `workspace-artifact` → metadata-only focus on a server-side artifact;
 *     supersedes nothing — legacy `artifactRefs` continue to be accepted and
 *     normalized through the same adapter.
 *   - `local-file` → metadata-only, device-bound focus on a file that already
 *     lives on the sender's paired Electron relay. `path` / `rootPath` are
 *     private run metadata; `name` is the bounded basename for public display;
 *     `relayId` is the EXACT originating relay (renderer never invents one).
 *     No bytes cross the network merely because the file was dragged.
 *
 * Capped at 10 refs per send; each resolver defines its stable dedupe key.
 */
export type ChatFocusedResourceRef =
  | { kind: "workspace-artifact"; artifactId: string }
  | {
      kind: "local-file";
      /** Private run metadata; never authorization. */
      path: string;
      /** Advisory only; tool execution derives authority from relay allowedRoots. */
      rootPath: string;
      /** Bounded basename for public display. */
      name: string;
      /** Exact originating Electron relay; renderer-supplied replacements are rejected. */
      relayId: string;
    };

/** Canonical response from `POST /api/rooms/:roomId/messages`. */
export type RoomMessageLiveShadowResult =
  | {
      responseVersion: 1;
      status: "human_verified";
      operationId: string;
      protectedMessage: ProtectedMessageDtoV2;
    }
  | {
      responseVersion: 1;
      status: "ordinary_fallback";
      operationId: string;
      reason:
        | "request_invalid"
        | "authority_stale"
        | "grant_invalid"
        | "protected_open_failed"
        | "human_parity_failed"
        | "human_persistence_failed"
        | "deadline_expired"
        | "restart_lost"
        | "agent_capacity_unavailable"
        | "integrity_conflict";
    };

export interface RoomMessageSendResponse {
  messageId: number | null;
  jobId: string | null;
  accepted: true;
  attachments: ChatAttachmentStatus[];
  coalesced: boolean;
  /** Present only when this request submitted an eligible live Shadow turn. */
  liveShadow?: RoomMessageLiveShadowResult;
}

/**
 * Safe public projection for a machine-owned follow-up from an interactive
 * workcard. It never changes the durable speaker of the underlying Human
 * turn; clients use it only to avoid presenting card machinery as typed prose.
 */
export interface AdvancedVideoWorkcardContinuation {
  kind: "advanced_video";
  referenceCount: number;
}

/**
 * @nautilo/types - API type definitions
 *
 * Contract between frontend apps and the server.
 */

export interface SendMessageRequest {
  message: string;
  /**
   * D513 Phase 3.1 — optional server-minted socket session. It is ephemeral,
   * ignored by old servers, and never a durable message/transcript field.
   */
  clientActionSessionId?: string | undefined;
  /** M233 — picker-authored stable Human recipients; never inferred from message text. */
  mentionedHumanUserIds?: string[] | undefined;
  laneKey?: string | undefined;
  /**
   * M065 — optional explicit room for owner chat. Omitted preserves
   * pre-M065 resolver behavior (`findDefaultRoomForActor` tie-break).
   */
  roomId?: string | undefined;
  voiceMode?: boolean | undefined;
  /**
   * Ephemeral approval posture selected by this authenticated client for this
   * turn. The server may use it only where the normal session Auto-Approve
   * policy already permits a Human's silent `once` reply.
   */
  autoApprove?: boolean | undefined;
  /**
   * D271 — uploaded chat attachments.
   *
   * The client uploads bytes first (`POST /api/message-attachments`) and sends
   * only the resulting `attachmentId`s here. The server resolves each id to a
   * pending upload (capability-gated by uploader + namespace), runs the central
   * attachment security gate on the stored bytes, and materializes content into
   * the turn. No filesystem paths cross the boundary (supersedes the D066
   * path-ref model; see ISSUE-D271).
   */
  attachments?: ChatUploadedAttachmentRef[] | undefined;
  /**
   * D079 Phase 2 — two-path API.
   *
   * Absolute path of the folder the user has opened for THIS task
   * (Surface B per D079; e.g. a codebase, a Figma export, a legal
   * PDF tree). `null` / omitted when no folder is open — valid state
   * post-D079 Phase 1. Renderer sources this from
   * `BrowserColumnContext.currentFolderPath`. Server validates absolute-
   * path shape + strips control chars before injecting into prompt
   * state.
   *
   * Distinct from `workspacePath` (Surface A — the Agent's persistent
   * drawer); both can coexist on a single turn so the agent knows
   * about both.
   *
   * Not used by tools until D079 Phase 4 (unified `file` tool's zone
   * resolution). Phase 2 only threads the paths into the system prompt
   * so the Agent has context to reason about them and can answer
   * "what folder am I in?" from prompt knowledge without a tool call.
   */
  currentFolder?: string | null | undefined;
  /**
   * D448 Phase 5 — authenticated Desktop relay identity captured with the
   * Current Folder by Electron. It is opaque client input until the server
   * validates it against the owner-paired live relay registry; it never
   * enters model-visible prompt prose.
   */
  currentFolderRelayId?: string | null | undefined;
  /**
   * D079 Phase 2 — two-path API.
   *
   * Absolute path of the Agent's persistent workspace / drawer
   * (Surface A per D079; defaults to `~/Documents/Nautilo/` after
   * D079 Phase 3 wires the setup). `undefined` / omitted during the
   * Phase 2-only overlap window; Phase 3 makes it always-set for
   * owner sessions. Server tolerates absence gracefully: the
   * "YOUR WORKSPACE" prompt block is omitted when missing.
   */
  workspacePath?: string | null | undefined;
  /**
   * M187 — compact active mini-app context from the Workbench app surface.
   * Omitted when no mini-app is open or context is stale on the client.
   */
  activeMiniApp?: ActiveMiniAppRequestContext | null | undefined;
  /**
   * Opaque capability supplied by the Workbench host alongside (never inside)
   * advisory mini-app context. The server validates it before a job is made.
   */
  liveMiniAppSession?: LiveMiniAppSessionCapability | null | undefined;
  /**
   * D356 — metadata-only "focus on these artifacts" references. The client
   * sends only external `artifactId` + display metadata (no bytes); the
   * server validates each against the caller's readable namespaces and
   * threads them into the turn as in-focus prompt context. Omitted/empty when
   * no artifact chips are queued.
   */
  artifactRefs?: ChatArtifactRef[] | null | undefined;
  /**
   * D423 Phase 4 — generic discriminated "focus on these resources" refs.
   *
   * The client identifies resources by origin (workspace artifact or local
   * file); the server resolves each via the kind-keyed resolver registry into
   * an authoritative `ResolvedFocusedResource[]` manifest. Metadata-only and
   * turn-scoped: NO bytes are uploaded or inlined into model context merely
   * because a ref was sent. Legacy `artifactRefs` remain accepted and are
   * normalized through the same adapter (deduped by `artifactId`). Omitted /
   * empty when no focus refs are queued. Capped at 10 refs per send.
   */
  focusedResources?: ChatFocusedResourceRef[] | null | undefined;
  /** Closed, server-validated neutral presentation for a card-owned continuation. */
  cardContinuation?: "advanced_video" | undefined;
  /**
   * D124 — quote-reply: persisted on `session_messages.reply_to_message_id`
   * when the original message is in the same room (server-validated).
   */
  replyToMessageId?: number | null | undefined;
  /**
   * M087 — IANA timezone string (e.g. "Europe/Athens", "America/New_York")
   * auto-detected by the client via
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`. Server validates
   * against `Intl.supportedValuesOf("timeZone")`; an invalid value is
   * dropped + logged, NOT 400'd. When omitted or invalid the server falls
   * back to `users.timezone ?? "UTC"`. When the validated value differs from
   * the stored `users.timezone`, the server persists it best-effort so
   * background firings (Task Primitive cron) reflect the user's most-recent
   * reality.
   */
  userTimezone?: string | undefined;
  /**
   * D371 R2 — optional per-turn model override. When a non-empty string
   * that resolves via the server's `getModelById(...)`, the executor uses
   * it for THIS turn only (per-thread override, decision A); otherwise the
   * field is dropped and the agent profile default / system default runs.
   * Inert until R3 wires a UI to set it.
   */
  model?: string | undefined;
}

/** M233 — Human-owned notification classification policy. */
export type NotificationLevel = "none" | "direct" | "all";

export interface NotificationPreferencesDto {
  defaultLevel: NotificationLevel;
  roomOverrides: Array<{
    roomId: string;
    level: NotificationLevel;
  }>;
}

export interface RoomNotificationPreferenceDto {
  roomId: string;
  effectiveLevel: NotificationLevel;
  inherited: boolean;
  overrideLevel: NotificationLevel | null;
}

export interface UpdateNotificationDefaultRequest {
  defaultLevel: NotificationLevel;
}

export interface UpdateRoomNotificationPreferenceRequest {
  level: "inherit" | NotificationLevel;
}

/** M236 — one complete, server-authored notification-state snapshot. */
export interface NotificationStateResponse {
  generatedAt: string;
  preferences: NotificationPreferencesDto;
  totals: {
    unreadCount: number;
    importantUnreadCount: number;
  };
  rooms: NotificationRoomStateDto[];
  subthreads: NotificationSubthreadStateDto[];
}

export interface NotificationRoomStateDto {
  roomId: string;
  ownUnreadCount: number;
  ownImportantUnreadCount: number;
  subthreadUnreadCount: number;
  subthreadImportantUnreadCount: number;
  unreadCount: number;
  importantUnreadCount: number;
}

export interface NotificationSubthreadStateDto {
  roomId: string;
  parentRoomId: string;
  anchorMessageId: number;
  replyCount: number;
  unreadCount: number;
  importantUnreadCount: number;
}

export interface NotificationStateErrorDto {
  error: string;
  code: "notification_state_too_large";
}

/**
 * M065 — room list/detail API shapes shared by clients.
 *
 * M124 adds `'open'` — a discoverable, self-joinable public room. Existing
 * clients render an `open`-kind room in the rooms list like any other room
 * they're a member of; the Browse-tab UX lives in D189.
 */
export type RoomKind =
  | "private"
  | "group"
  | "multi_agent"
  | "subthread"
  | "open"
  | "task"
  // M173 — non-conversational, humans-only memory-access container. Excluded
  // from every room-enumeration surface, so it should never actually reach a
  // client DTO; included here so the kind union matches the DB column.
  | "access";

/**
 * D246 Wave 2 — compact roster member projection folded into the room-list
 * response. Contains ONLY the grouping/display fields the Relationship
 * Explorer needs to classify rows without a per-room `GET /api/rooms/:id`
 * detail call: actor id, kind, display name, and the optional identity
 * pointers (`userId` / `agentId` / `handle` / `federatedId`) the explorer's
 * owned-agent, people-entity, and federated-handle classifiers read.
 *
 * Authoritative member-management detail — `roomRole`, `agentResponseMode`,
 * owner cues — is deliberately NOT here. It loads progressively via
 * the active-room detail fetch (`GET /api/rooms/:id`); role/mode controls
 * stay skeletal until that arrives. `roomRole` is intentionally omitted
 * because the room chrome (`RoomAuthorScope` / `Conversation`) does not
 * consume it before detail hydrates.
 */
export interface RoomSummaryRosterMemberDto {
  actorId: string;
  kind: "user" | "agent";
  displayName: string;
  /** Canonical mention handle (agents: `agents.handle`; users: `users.handle`). */
  handle?: string | null;
  /**
   * Canonical `@handle@server` identity. Preserves the home-server component
   * used by explorer display and server-name search without adding detail-only
   * member fields.
   */
  federatedId?: string;
  /** Present iff `kind === "user"` — `users.id` backing the actor. */
  userId?: string;
  /** Present iff `kind === "agent"` — `agents.id`. */
  agentId?: string;
  /** Agent avatar identity used by compact relationship surfaces. */
  agentAvatar?: AvatarRef | null;
}

export interface RoomSummaryDto {
  id: string;
  label: string;
  type: string;
  graphThreadId: string;
  createdAt: string;
  memberCount: number;
  /** Total persisted messages across sessions attached to this Room. */
  messageCount?: number;
  /** Latest persisted message timestamp, ISO-8601 UTC; null when empty. */
  lastMessageAt?: string | null;
  /** D111 — dispatch kind (distinct from legacy `type`). */
  kind: RoomKind;
  parentRoomId?: string | null;
  threadRootMessageId?: number | null;
  /**
   * M122 — count of unread messages in this room for the calling user.
   * 0 for callers that are agent-actors (no unread semantics).
   * Server always populates; optional in the type only for back-compat marshaling.
   */
  unreadCount?: number;
  /**
   * D246 Wave 2 — compact roster projection for explorer grouping. Folded
   * from one batch query keyed by `roomId` so the client never issues a
   * `GET /api/rooms/:id` per room solely to classify explorer rows.
   * Populated by `GET /api/rooms`; omitted by surfaces that don't need it
   * (manageable / discoverable lists). Absent or empty → the explorer
   * falls back to its existing `kind`/`memberCount` heuristics.
   */
  roster?: RoomSummaryRosterMemberDto[];
}

export interface ListRoomsResponse {
  rooms: RoomSummaryDto[];
}

/** M122 — body for `POST /api/rooms/:roomId/read`. */
export interface MarkRoomReadRequest {
  /** When omitted, marks every currently-visible message in the room as read. */
  upToMessageId?: number;
}

/** M122 — response for `POST /api/rooms/:roomId/read`. `marked` = rows actually flipped. */
export interface MarkRoomReadResponse {
  ok: true;
  marked: number;
}

/**
 * D128 — per-(Room, Agent) reply policy. NULL on `kind === "user"` rows;
 * meaningful only on `kind === "agent"` rows. Drives the trust-layer
 * `shouldFireLLMTurn` gate. See `agent-response-modes.md` for the full
 * decision tree.
 */
export type AgentResponseMode = "active" | "mention_only" | "observe";
export type RoomConductorMode = "advanced" | "standard";

export interface RoomMemberDto {
  actorId: string;
  kind: "user" | "agent";
  displayName: string;
  /** Canonical mention handle; for agents this must match `agents.handle`. */
  handle?: string | null | undefined;
  /** Present when `kind === "user"` — `users.id` for create-room member lists. */
  userId?: string | undefined;
  agentId?: string | undefined;
  roomRole: "admin" | "member";
  /**
   * D128 — per-(Room, Agent) reply policy. Present iff `kind === "agent"`.
   * NULL is treated as `'active'` by the trust gate (legacy default for
   * pre-D128 rows backfilled by migration 0054).
   */
  agentResponseMode?: AgentResponseMode | null | undefined;
  /**
   * D300 — human owner of this agent member. Present iff `kind === "agent"`.
   * Used by the UI to render owner cues (`Nova · the planned agent`, `Genie · @alex`).
   */
  agentOwnerUserId?: string | undefined;
  /** D300 — owner handle when cheaply available from roster joins. */
  agentOwnerHandle?: string | null | undefined;
  /** D300 — owner display name when cheaply available from roster joins. */
  agentOwnerDisplayName?: string | null | undefined;
  /** D300 — profile avatar for this agent member. Present iff `kind === "agent"` and configured. */
  agentAvatar?: AvatarRef | null | undefined;
}

/** M297 — caller-safe projection of one Server-local Human relationship. */
export interface HumanBlockStatusResponse {
  userId: string;
  /** The caller may inspect and undo only their own directional relation. */
  blockedByViewer: boolean;
  /** True in either direction; deliberately does not identify a peer-owned block. */
  directInteractionBlocked: boolean;
}

export interface HumanBlockListResponse {
  blockedUserIds: string[];
}

/** D128 / D194 C2 — body shape for `PATCH /api/rooms/:roomId/members/:actorId`. */
export interface UpdateRoomMemberRequest {
  /** D128 — agent response mode flip (agent members only). */
  agentResponseMode?: AgentResponseMode;
  /** D194 C2 — human room-role flip (user members only). */
  roomRole?: "admin" | "member";
}

/** D128 / D194 C2 — response shape for the same PATCH route. */
export interface UpdateRoomMemberResponse {
  actorId: string;
  agentResponseMode?: AgentResponseMode;
  roomRole?: "admin" | "member";
}

export interface RoomDetailResponse {
  id: string;
  /** Member-visible coordinate; cryptographic operations independently revalidate access. */
  namespaceId?: string | null;
  label: string;
  type: string;
  graphThreadId: string;
  createdAt: string;
  kind: RoomKind;
  parentRoomId?: string | null;
  threadRootMessageId?: number | null;
  /** D302 — smart routing policy for group-room conductor inference. */
  conductorMode: RoomConductorMode;
  members: RoomMemberDto[];
}

export interface CreateRoomMemberInput {
  kind: "user" | "agent";
  id: string;
}

export interface CreateRoomRequest {
  label: string;
  /**
   * Resolve or atomically create the caller's exact two-Human DM. The server
   * verifies reachability and resolves the target's Human Actor; callers must
   * not combine this with `members` or `personalAgentId`.
   */
  directHumanUserId?: string;
  /**
   * Start a fresh private conversation with one of the caller's own Genies.
   * The server verifies ownership; callers must not combine this with an
   * explicit `members` roster or `directHumanUserId`.
   */
  personalAgentId?: string;
  /**
   * Human-facing catalogue placement. `chat` is participant-driven (1:1 or
   * group chat); `room` is a named durable space. This is deliberately
   * independent from dispatch `kind`, because a private named Room and a 1:1
   * chat can both have `kind='private'`.
   */
  catalogueKind?: "chat" | "room";
  /**
   * D111 / D473 — explicit initial roster. Omit to use the legacy
   * creator + default-agent private-room path, or the creator-only open-room
   * path. When supplied for an open room it must include the creator exactly
   * once and is persisted as the initial roster.
   */
  members?: CreateRoomMemberInput[];
  /**
   * M124 — room kind to create. Omit (or `'private'` / `'group'`) for the
   * existing private/group path; `'open'` mints a public, discoverable room
   * and is gated on the `manage_rooms` capability. An omitted `members[]`
   * creates a creator-only open room; a supplied roster is validated and
   * persisted atomically with the room.
   */
  kind?: "private" | "group" | "open";
}

/** D111 — Subthread list/detail. */
export interface SubthreadSummary {
  id: string;
  parentRoomId: string;
  anchorMessageId: number;
  label: string;
  replyCount: number;
  lastReplyAt: string | null;
  createdAt: string;
}

export interface CreateSubthreadRequest {
  label?: string;
}

export interface CreateSubthreadResponse {
  subthreadRoomId: string;
}

/** D426 — one membership-gated payload sufficient to hydrate a thread drawer. */
export interface ThreadDetailResponse {
  parentRoomId: string;
  subthreadRoomId: string;
  /** Canonical persisted parent message that anchors this child Room. */
  anchor: RoomMessageDto;
  /** Absolute snapshot; clients replace state only at a newer revision. */
  summary: {
    replyCount: number;
    lastReplyAt: string | null;
    summaryRevision: number;
  };
}

/** D106 — rename private room (`PATCH /api/rooms/:id`). */
export interface RenameRoomRequest {
  label: string;
}

/** D194 — flip room visibility (`POST /api/rooms/:id/visibility`). */
export interface SetRoomVisibilityRequest {
  public: boolean;
}

/** D302 P5b — flip group-room conductor inference policy. */
export interface SetRoomConductorModeRequest {
  conductorMode: RoomConductorMode;
}

export interface SetRoomConductorModeResponse {
  conductorMode: RoomConductorMode;
}

/**
 * D271 — wire ref for an already-uploaded attachment. The client uploads bytes
 * via `POST /api/message-attachments` and references the result by id at send.
 */
export interface ChatUploadedAttachmentRef {
  attachmentId: string;
}

export interface ChatAttachmentStatus {
  id: string;
  filename: string;
  decision: "accept" | "stub" | "reject" | "blocked";
  kind?: string | undefined;
  reason?: string | undefined;
  code?: string | undefined;
  threats?: string[] | undefined;
}

/**
 * D066 — image payload passed through chat job input for multimodal models.
 * Serialized as JSON inside `Job.input.multimodalImages`; bytes stay server-side until here.
 */
export interface ChatMultimodalImagePart {
  type: "image";
  attachmentId: string;
  filename: string;
  mimeType: string;
  base64: string;
}

export interface SendMessageResponse {
  /** Null when the message was coalesced into a buffer (M074); real id arrives via `job.dispatched`. */
  jobId: string | null;
  laneKey: string;
  accepted: boolean;
  /** Present and true when this HTTP response corresponds to a buffered send (M074). */
  coalesced?: boolean | undefined;
  attachments?: ChatAttachmentStatus[] | undefined;
}

export interface CreateBackgroundJobRequest {
  task: string;
}

export interface CreateBackgroundJobResponse {
  jobId: string;
  accepted: boolean;
}

export type JobType = "foreground" | "background";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface JobStatusResponse {
  id: string;
  type: JobType;
  status: JobStatus;
  message: string | null;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** D124 — aggregated read/delivery for GET /api/messages/:id/read-state. */
export interface MessageReadStateDto {
  shape: "1:1" | "group";
  selfDelivered: boolean;
  selfRead: boolean;
  recipientCount: number;
  deliveredCount: number;
  readCount: number;
}

/**
 * D391 — durable message attachment reference carried on a history message.
 * Type-agnostic: the same shape serves images and audio (and future kinds).
 * The client resolves bytes via the authed `GET /api/message-attachments/:id`
 * route (`getMessageAttachmentUrl`). Joined to the deduped human message by
 * `turn_id` (= M134 fingerprint), so an attachment renders once per turn
 * regardless of how many per-bot copies of the message exist.
 */
export interface MessageAttachmentRef {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * D424 — ArtifactOpenCard receive contract.
 *
 * A server-authored, pointer-only reference to a workspace artifact attached
 * to an authorized persisted message. The ordinary authoring path is a
 * user-sent workspace-artifact focus ref (legacy `artifactRefs` +
 * `focusedResources` kind `workspace-artifact`). The only assistant authoring
 * path is the server-stamped `ask_peer` Artifact handoff, after dispatch has
 * attached the Artifact to that exact peer DM's canonical namespace.
 * Assistant cards are NEVER inferred from prose or tool text; local-file and
 * message-attachment focus refs never become cards.
 *
 * The durable relation (`session_message_artifacts`) is keyed by INTERNAL
 * `artifacts.id` and stores only the relation + send-time ordering — it does
 * NOT snapshot the external id, logical path, storage URI, namespace id,
 * capability, or any private locator. This shape is hydrated at read/event
 * time from that relation against the artifact's CURRENT row, so it carries
 * only safe current metadata plus the server-validated `roomId` of the
 * canonical room the artifact is still attached to.
 *
 * Authorization at hydrate: the viewer must be a member of `roomId` (enforced
 * by the history route / send seam) AND the artifact must still be attached to
 * that room's canonical namespace and not soft-deleted. Detached, deleted, or
 * private refs are omitted — they never reach this shape.
 */
export interface MessageArtifactOpenRef {
  /** Internal `artifacts.id` (uuid) — the `:id` for `GET /api/workspace/artifacts/:id`. */
  artifactInternalId: string;
  /** Server-validated canonical room id the artifact is attached to at hydrate. */
  roomId: string;
  /** Safe basename derived from the artifact's logical path (no directory, no storage URI). */
  basename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Content-free durable outcome for one protected Agent execution associated
 * with a Human history row. The stable execution id distinguishes multi-Agent
 * outcomes for the same input without making any claim about other mapped
 * output that may also exist.
 */
export interface RoomHistoryTerminalExecutionSummary {
  messageId: number;
  executionId: string;
  classification: "cancelled" | "process_lost";
}

/** D124 / D300 — row shape for `GET /api/rooms/:id/messages`. */
export interface RoomMessageDto {
  id: string;
  /** M230 — opaque client identity for one logical persisted message/turn. */
  logicalMessageKey?: string;
  role: string;
  content: string;
  toolCalls?: string | null;
  toolName?: string | null;
  displayContent?: string;
  createdAt: string;
  /** M230 — null until the first successful edit. */
  editedAt?: string | null;
  /** M230 — monotonic optimistic-concurrency token. */
  editRevision?: number;
  replyToMessageId?: number | null;
  /** D426 — authoritative child-reply count for a parent-room anchor. */
  replyCount?: number;
  /** D426 — latest counted child reply timestamp, or null after the last reply is removed. */
  lastReplyAt?: string | null;
  /** D426 — monotonic revision used to reject stale live summary updates. */
  summaryRevision?: number;
  /** D124 — `sessions.owner_id` for human-authored rows. */
  sourceUserId?: string;
  /** D300 — authoring agent for assistant/tool rows (`sessions.agent_id`). */
  authorAgentId?: string;
  /** D391 — retained attachments linked to this human turn (images + audio). */
  attachments?: MessageAttachmentRef[];
  /**
   * D424/D570 — server-authored ArtifactOpenCard refs. Ordinarily authored by
   * a user focus send; also allowed on the exact assistant question emitted by
   * a server-stamped ask_peer Artifact handoff. Never inferred from prose.
   */
  artifacts?: MessageArtifactOpenRef[];
  /** Server-validated presentation marker for an Advanced video workcard continuation. */
  workcardContinuation?: AdvancedVideoWorkcardContinuation;
}

/** M230 — optimistic, author-only Human message text edit. */
export interface EditRoomMessageRequest {
  content: string;
  expectedRevision: number;
}

export interface EditedRoomMessageDto {
  id: string;
  logicalMessageKey: string;
  content: string;
  editedAt: string;
  editRevision: number;
}

/** Current canonical value returned when an optimistic edit conflicts. */
export interface EditableRoomMessageConflictDto
  extends Omit<EditedRoomMessageDto, "editedAt"> {
  editedAt: string | null;
}

export interface EditRoomMessageResponse {
  message: EditedRoomMessageDto;
}

/** D430 — indexed search modes supported by the Room transcript reader. */
export type RoomMessageSearchMode = "whole" | "prefix";

/** D430 — stable newest-first cursor and frozen search snapshot boundary. */
export interface RoomMessageSearchCursor {
  createdAt: string;
  messageId: string;
}

/** D430 — one bounded, human-visible Room transcript search result. */
export interface RoomMessageSearchHit {
  messageId: string;
  createdAt: string;
  role: string;
  snippet: string;
  toolName?: string;
  sourceUserId?: string;
  authorAgentId?: string;
  authorActorId?: string;
  authorDisplayName?: string;
  authorHandle?: string;
}

/** D430 — one cursor-paged search response; no exact total is implied. */
export interface RoomMessageSearchPage {
  hits: RoomMessageSearchHit[];
  asOf: RoomMessageSearchCursor | null;
  nextOlderCursor: RoomMessageSearchCursor | null;
  hasMoreOlder: boolean;
}

interface RoomMessageSearchBaseOptions {
  roomId: string;
  query: string;
  mode: RoomMessageSearchMode;
  /** Defaults to true at the HTTP boundary for older clients. */
  ignoreCase?: boolean;
  limit?: number;
}

/**
 * D430 — request options for one Room transcript search page. Continuation
 * cursors always travel with their frozen `asOf` boundary; a one-sided pair
 * is invalid at the HTTP boundary.
 */
export type RoomMessageSearchOptions =
  | (RoomMessageSearchBaseOptions & {
      cursor?: never;
      asOf?: never;
    })
  | (RoomMessageSearchBaseOptions & {
      cursor: RoomMessageSearchCursor;
      asOf: RoomMessageSearchCursor;
    });

/** D470 — one authorized top-level conversation match in Chats-wide search. */
export interface ChatSearchConversationHit {
  room: RoomSummaryDto;
  matchedBy: "label" | "participant";
}

/** D470 — a D430-visible message match with its owning Room breadcrumb. */
export interface ChatSearchMessageHit extends RoomMessageSearchHit {
  roomId: string;
  roomLabel: string;
  roomKind: RoomKind;
  /** Present when the matching message belongs to a Subthread. */
  parentRoomId?: string;
  /** Present with `parentRoomId` for the visible Subthread breadcrumb. */
  parentRoomLabel?: string;
}

/** D470 — one bounded Chats-wide search response. */
export interface ChatSearchPage {
  /** At most 20 top-level conversation matches; no conversation cursor exists. */
  conversations: ChatSearchConversationHit[];
  conversationsTruncated: boolean;
  /** D430-compatible newest-first message page (default 20, maximum 50). */
  messages: ChatSearchMessageHit[];
  messageAsOf: RoomMessageSearchCursor | null;
  nextOlderMessageCursor: RoomMessageSearchCursor | null;
  hasMoreOlderMessages: boolean;
}

interface ChatSearchBaseOptions {
  query: string;
  mode: RoomMessageSearchMode;
  /** Defaults to active rooms. Archived-room recovery uses the archived-only scope. */
  archiveScope?: "active" | "archived" | "all";
  /** Defaults to true at the HTTP boundary for older clients. */
  ignoreCase?: boolean;
  limit?: number;
}

/**
 * D470 — request options for one Chats-wide search page. Continuations retain
 * D430's paired frozen message cursor and `asOf` boundary.
 */
export type ChatSearchOptions =
  | (ChatSearchBaseOptions & {
      cursor?: never;
      asOf?: never;
    })
  | (ChatSearchBaseOptions & {
      cursor: RoomMessageSearchCursor;
      asOf: RoomMessageSearchCursor;
    });

/** D470 — validation codes exposed by `GET /api/rooms/search`. */
export type ChatSearchValidationErrorCode =
  | "invalid_search_mode"
  | "invalid_search_archive_scope"
  | "invalid_search_query"
  | "invalid_search_case"
  | "invalid_search_limit"
  | "invalid_search_cursor"
  | "invalid_search_as_of";

export interface ChatSearchValidationError {
  code: ChatSearchValidationErrorCode;
  error: string;
}

/** D430 — bounded chronological page around one exact Room message. */
export interface RoomMessagesAroundPage {
  messages: RoomMessageDto[];
  target: RoomMessageSearchCursor;
  includedToolCallCompanion: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
}

/** D430 — request options for bounded around-message hydration. */
export interface RoomMessagesAroundOptions {
  roomId: string;
  messageId: string;
  limit?: number;
}

/** D430 — validation codes exposed by Room search and around-message HTTP routes. */
export type RoomMessageSearchValidationErrorCode =
  | "invalid_search_mode"
  | "invalid_search_query"
  | "invalid_search_limit"
  | "invalid_search_cursor"
  | "invalid_search_as_of"
  | "invalid_message_id"
  | "invalid_around_limit";

export interface RoomMessageSearchValidationError {
  code: RoomMessageSearchValidationErrorCode;
  error: string;
}

/** D124 — extended SessionMessageDto (transcript / latest-messages payloads). */
export interface SessionMessageDto {
  id: number;
  logicalMessageKey?: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  editedAt?: string | null;
  editRevision?: number;
  deliveredAt?: string | null;
  readAt?: string | null;
  replyToMessageId?: number | null;
  /** Hydrated by the latest-messages route on demand. */
  readState?: MessageReadStateDto;
  /**
   * D424/D570 — server-authored ArtifactOpenCard refs. May be present on a
   * user focus send or on the trusted ask_peer Artifact question. Pointer-only;
   * never inferred from prose/tool output.
   */
  artifacts?: MessageArtifactOpenRef[];
}

/** D124 — augment user-facing profile shape with last_seen_at. */
export interface UserPresenceDto {
  userId: string;
  lastSeenAt: string | null;
}

/**
 * D420 — active (non-`normal`) durable maintenance states. Wave 2 task 2.2.1
 * gates only executable-work ingress; the rejection surfaces the active state
 * so API callers can distinguish a retryable drain from a hard failure.
 */
export type MaintenanceActiveState = "draining" | "applying";

/**
 * D420 — machine-readable code carried by every maintenance rejection
 * (`MaintenanceDrainError.code`, HTTP response `code`/`error`).
 */
export const MAINTENANCE_REJECTION_CODE = "maintenance_draining" as const;

/**
 * D420 (Wave 2 task 2.2.1) — typed retryable rejection returned to HTTP/API
 * callers when new executable work is refused because the durable maintenance
 * state is active. `retryable: true` is the contract a caller polls on: the
 * work was not persisted/accepted, so re-sending once the server clears
 * maintenance is safe and idempotent at the ingress layer.
 */
export interface MaintenanceRejectionResponse {
  error: typeof MAINTENANCE_REJECTION_CODE;
  code: typeof MAINTENANCE_REJECTION_CODE;
  message: string;
  retryable: true;
  maintenanceState: MaintenanceActiveState;
}

/**
 * D420 (Wave 2 task 2.2.2) — full durable maintenance state including the
 * idle `normal` state. The operator maintenance API surfaces all three; the
 * 2.2.1 rejection surface only carries the active subset
 * ({@link MaintenanceActiveState}).
 */
export type MaintenanceState = "normal" | "draining" | "applying";

/**
 * D420 (Wave 2 task 2.2.2) — aggregate executable-work counts returned by
 * the operator maintenance status read. Counts ONLY — never prompt, room,
 * lane key, job id, or user payload. `acceptedWork` is the durable
 * payload-free acceptance-ledger count of units not yet dispatched or
 * terminalized (Wave 2 task 2.1.2).
 *
 * Counting contract: all fields must be zero before `nautilo upgrade` may
 * advance. `runningForegroundJobs` excludes Task-run Jobs because
 * `runningTaskRuns` owns every durable running Task (including one already
 * backed by a Job), preventing double-counting. `claimedTasks` covers the
 * observer's fire-locked, pending dispatch window. Parked `awaiting` and
 * `paused` Tasks are intentionally excluded: they are not executable work.
 */
export interface MaintenanceWorkCounts {
  /** Running non-Task foreground Jobs. */
  runningForegroundJobs: number;
  /** Running background Jobs. */
  runningBackgroundJobs: number;
  queuedTurns: number;
  bufferedLanes: number;
  acceptedWork: number;
  /** Durable task_runs currently executing, whether or not Job-linked. */
  runningTaskRuns: number;
  /** Pending Tasks held by TaskObserver's fire lock before dispatch. */
  claimedTasks: number;
}

/**
 * D420 (Wave 2 task 2.2.2) — payload-free operator maintenance snapshot.
 * The enter/status/renew/applying/cancel/complete endpoints all return
 * this shape: maintenance state, operation ownership, lease + hard expiry
 * (ISO strings, null when idle), and aggregate work counts. Nothing else.
 */
export interface MaintenanceOperatorStatus {
  state: MaintenanceState;
  operationId: string | null;
  leaseExpiresAt: string | null;
  hardExpiresAt: string | null;
  work: MaintenanceWorkCounts;
}

/** D420 (task 2.2.2) — request body for the enter operation. */
export interface MaintenanceEnterRequest {
  operationId?: string;
  leaseMs?: number;
  hardMs?: number;
}

/**
 * D420 (task 2.2.2) — request body for the owning-operation verbs
 * (renew/applying/cancel/complete). The owning operation id is the
 * lease authority returned by enter; cross-owner transitions fail closed.
 */
export interface MaintenanceOperationRequest {
  operationId: string;
}

/**
 * D420 (task 2.2.2) — machine-readable codes for operator maintenance
 * transition failures, mirrored from the durable store's
 * `MaintenanceTransitionError`. A 409 carries the matching code so the
 * CLI/driver can distinguish a busy lease, a cross-owner refusal, an
 * invalid transition, or an expired lease.
 */
export type MaintenanceTransitionErrorCode =
  | "in_progress"
  | "not_owner"
  | "invalid_transition"
  | "lease_expired"
  | "hard_expired"
  | "not_found";

/**
 * D420 (task 2.2.2) — 409 body for a maintenance transition failure
 * (cross-owner, invalid transition, expired lease, already in progress).
 */
export interface MaintenanceTransitionErrorResponse {
  error: "maintenance_transition";
  code: MaintenanceTransitionErrorCode;
  message: string;
}
