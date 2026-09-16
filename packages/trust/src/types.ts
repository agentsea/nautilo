import type { ToolCall } from "@langchain/core/messages/tool";
import type { CanonicalPrincipal, RbacProjection } from "./m213-read-models";

// ---------------------------------------------------------------------------
// PolicyResolver — the single contract the rest of Nautilo depends on
// ---------------------------------------------------------------------------

export type RequestedRoomAdmission = "human_and_agent" | "human";

/** M213 Phase 3 — principal + RBAC inputs for policy-depth bearer resolution. */
export type ResolveContextFromPrincipalInput = Readonly<{
  principal: CanonicalPrincipal;
  rbacProjection: RbacProjection;
  preferredAgentId: string;
  requestedRoomId?: string;
  /**
   * Agent turns keep the canonical Human + selected-Agent membership gate.
   * Human-facing content surfaces may request Human-only Room admission so
   * Namespace visibility does not depend on which Agent happens to be present.
   */
  requestedRoomAdmission?: RequestedRoomAdmission;
}>;

export interface PolicyResolver {
  /**
   * Server middleware calls this on every incoming message.
   * Resolves transport identity → actor → role → context.
   *
   * M042A: agentId identifies which agent the message is addressed to.
   * Today there is only one agent per deployment; callers pass the
   * seeded default (NAUTILO_DEFAULT_AGENT_ID).
   *
   * M042C: `externalId` is now a federated `@handle@server` string for
   * channels that speak the format. For channels that
   * use channel-native identifiers (Telegram user ids, webhook source
   * ids, etc.) pass that raw identifier; the resolver looks it up via
   * `channel_identities` the same way and resolves to a stranger if no
   * row matches. The UUID-match shortcut from pre-M042C is gone.
   */
  resolveContext(
    channel: string,
    externalId: string,
    agentId: string,
    requestedRoomId?: string,
  ): Promise<RuntimePolicyContext>;

  /**
   * M213 Phase 3 — policy-depth resolution when the caller has already
   * resolved the canonical principal and RBAC projection (e.g.
   * `buildResolveBearer`). Optional so legacy mocks and stub resolvers
   * keep working via `resolveContext`; production `PersonalPolicyResolver`
   * implements this to skip duplicate identity/RBAC DB reads.
   */
  resolveContextFromPrincipal?(
    input: ResolveContextFromPrincipalInput,
  ): Promise<RuntimePolicyContext>;

  /**
   * Runtime calls this before graph invocation.
   * Determines which memory namespaces the actor can read/write.
   *
   * M042A: agentId scopes the envelope to a specific agent. Today,
   * single-agent deployments mean envelope is effectively the same for
   * every agentId, but the parameter threads through for Iteration 3.
   *
   * M042B: optional roomId lets the envelope carry room scope. Pass
   * `""` when there is no room (guest, some test paths). Today the
   * value is carried but not used for filtering; Iteration 3 adds
   * per-room scoping.
   */
  buildEnvelope(
    actorId: string,
    laneKey: string,
    /** Undefined explicitly means Human-only; existing string semantics remain. */
    agentId: string | undefined,
    roomId?: string,
  ): Promise<NamespaceMemoryEnvelope>;

  /**
   * Tool runner calls this before executing any tool.
   * Returns allow, read_only, require_approval, or forbidden.
   * Standing approval matching happens inside this method.
   */
  checkToolAccess(
    actorId: string,
    tool: ToolCall,
    envelope?: MemoryAccessEnvelope | null,
  ): Promise<ToolAccessDecision>;

  /**
   * Called when checkToolAccess returns require_approval.
   * Determines who receives the prove_it challenge.
   *
   * M042A: agentId identifies which agent's owner should receive the
   * challenge. Single-agent behavior today is identical to before;
   * M042D will rewrite the body to use the ownership group model.
   */
  routeApproval(
    actorId: string,
    action: string,
    details: ApprovalRequest,
    agentId: string,
  ): Promise<ApprovalRoute>;
}

// ---------------------------------------------------------------------------
// MemoryAccessEnvelope
// ---------------------------------------------------------------------------

export type ToolAccess = "allow" | "read_only" | "require_prove_it" | "forbidden";

/**
 * Normal room / namespace-backed memory access (M044 + M082). `memoryMode`
 * omitted means namespace mode for back-compat with pre-M084 fixtures.
 */
export type NamespaceMemoryEnvelope = {
  memoryMode?: "namespace";
  ownerId: string;
  actorId: string;
  /**
   * M042A: which agent this envelope is scoped to. Carried but not yet
   * used for namespace filtering — Iteration 3 adds per-agent memory
   * isolation.
   */
  agentId: string;
  /**
   * M042B: which room this envelope is scoped to. Empty string for
   * guest / no-room actors.
   *
   * M044: this is the ANCHOR for namespace access — `readableNamespaces`,
   * `mutableNamespaces`, and `writableNamespaces` are derived from
   * `roomId` via the Room-subset rule (REL-HUM-NSP / REL-NSP-RMS).
   * Empty roomId ⇒ empty namespace lists.
   */
  roomId: string;
  /**
   * M044: per REL-NSP-RMS + REL-HUM-NSP subset rule, this is the set
   * of Namespace ids for every Room `R'` where
   * `H(R') ⊇ H(currentRoom)` — i.e. every Room whose human-member
   * set is a superset of the current Room's. Always includes
   * `Namespace(currentRoom)` for members; empty for non-members.
   */
  readableNamespaces: string[];
  /**
   * M082: namespaces whose attached memories the speaker may mutate
   * (replace / demote / promote / dedup-update overlap check). Today
   * identical to `readableNamespaces` (subset rule: if you can read a
   * memory you can mutate it). Kept distinct for REL-HUM-NSP semantics
   * and future divergence (e.g. read-only NS without mutability).
   */
  mutableNamespaces: string[];
  /**
   * M044 + M082: **attachment target** — `Namespace(currentRoom)` only
   * (length ≤ 1 for members). Drives new-memory saves and
   * `defaultNamespaceId` for connection-vault routes; not the mutation
   * gate (use `mutableNamespaces`).
   */
  writableNamespaces: string[];
  toolPolicy: Record<string, ToolAccess>;
};

/**
 * M084 — subagent scope bag. Memory tools ignore namespace lists; they read
 * and write only through `scopeId` + `memory_scopes`.
 */
export type ScopeMemoryEnvelope = {
  memoryMode: "scope";
  ownerId: string;
  actorId: string;
  agentId: string;
  roomId: string;
  scopeId: string;
  toolPolicy: Record<string, ToolAccess>;
};

export type MemoryAccessEnvelope = NamespaceMemoryEnvelope | ScopeMemoryEnvelope;

export function memoryModeOf(
  envelope: MemoryAccessEnvelope | null | undefined,
): "namespace" | "scope" {
  if (!envelope) return "namespace";
  return envelope.memoryMode === "scope" ? "scope" : "namespace";
}

export function isScopeMemoryEnvelope(
  envelope: MemoryAccessEnvelope | null | undefined,
): envelope is ScopeMemoryEnvelope {
  return envelope != null && envelope.memoryMode === "scope" && typeof envelope.scopeId === "string";
}

export function isNamespaceMemoryEnvelope(
  envelope: MemoryAccessEnvelope | null | undefined,
): envelope is NamespaceMemoryEnvelope {
  return envelope != null && memoryModeOf(envelope) === "namespace";
}

export function envelopeReadableNamespaces(
  envelope: MemoryAccessEnvelope | null | undefined,
): string[] {
  if (!envelope || isScopeMemoryEnvelope(envelope)) return [];
  return envelope.readableNamespaces;
}

export function envelopeMutableNamespaces(
  envelope: MemoryAccessEnvelope | null | undefined,
): string[] {
  if (!envelope || isScopeMemoryEnvelope(envelope)) return [];
  return envelope.mutableNamespaces;
}

export function envelopeWritableNamespaces(
  envelope: MemoryAccessEnvelope | null | undefined,
): string[] {
  if (!envelope || isScopeMemoryEnvelope(envelope)) return [];
  return envelope.writableNamespaces;
}

// ---------------------------------------------------------------------------
// M088A — Artifact namespace access
//
// Artifacts share the same Room-derived access envelope as memory: the
// readable / mutable / writable Namespace sets carry the same semantics
// for both. Artifact tools call `envelopeReadableNamespaces` /
// `envelopeMutableNamespaces` / `envelopeWritableNamespaces` directly
// — there is intentionally one set of helpers, one envelope per Room,
// and no parallel `ArtifactAccessEnvelope` type.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RuntimePolicyContext — what the model receives for behavioral awareness
// ---------------------------------------------------------------------------

export type RuntimePolicyContext = {
  laneKey: string;
  actorId: string;
  /**
   * M042A: which agent is acting on this request. Today always the
   * seeded default; Iteration 3 resolves per-room.
   */
  agentId: string;
  /**
   * M042B: which room this turn runs in. Empty string for guest /
   * no-room traffic. Owner traffic is always a room after M042B.
   */
  roomId: string;
  /**
   * M042B: room type discriminant. "private" | "shared" | "dm" | ""
   * (guest / no room).
   */
  roomType: string;
  /**
   * M042B: opaque LangGraph checkpoint key for this room. For the
   * seeded default room this is "app:default" (preserves pre-M042B
   * checkpoints). New rooms get "room:<id>". Empty string for guest
   * / no-room traffic. Consumers that talk to `PostgresSaver` via
   * `configurable.thread_id` MUST use this value, NOT `laneKey`.
   */
  graphThreadId: string;
  actorLabel: string;
  /**
   * M042C: federated address of the speaking actor — `@handle@server`
   * for known actors (owner, agents), empty string for strangers /
   * guests that haven't paired a federated identity yet. This is the
   * addressing-layer identity, surfaced for logging, approval-payload
   * stamping, and future federation. It is NOT the relay-wire key —
   * relay registry continues to match on `actorId` / `userId` UUIDs
   * (see `state.userId` in the graph, `profile.userId` in the API).
   */
  actorFederatedId: string;
  /**
   * M042C: federated address of the running agent — `@<agentHandle>@<server>`.
   * Empty string only when no agent is bound (edge/test path).
   */
  agentFederatedId: string;
  speakerTrust: "verified" | "unverified";
  laneScope: "private" | "shared";
  /**
   * M128: the requester's highest-rank server-wide Role slug across
   * every Group they belong to. Canonical ladder values:
   * `"owner" | "admin" | "superuser" | "member" | "contributor" |
   * "guest"`. Unauthenticated requests via `buildGuestContext`
   * resolve to `"guest"`. The `"owner"` slug denotes the profile
   * owner (D3) — the Human who claimed the instance — not a
   * per-agent ownership group. Legacy slugs (`"household"`,
   * `"teammate"`, `"stranger"`) may still surface for one release
   * while older clients typecheck.
   */
  actorRole: string;
  /**
   * M042D: per-relationship limits configured by the agent's owner.
   * Always `undefined` in M042D — ISSUE-M037 populates on the
   * standing-approvals path.
   */
  relationshipLimits?: RelationshipLimits | undefined;
  groupContext?: {
    groupType: string;
    groupLabel: string;
  } | undefined;
  memoryAccess: NamespaceMemoryEnvelope;
};

/**
 * M042D: per-relationship override knobs configured by the agent's
 * owner. Always absent in M042D — ISSUE-M037 (standing approvals)
 * populates these via matching-engine logic.
 */
export type RelationshipLimits = {
  /** Per-transaction spend ceiling (USD). Above → route to owner. */
  spendLimit?: number;
  /** Tool name patterns requiring owner approval regardless of role caps. */
  approvalRequired?: string[];
};

// ---------------------------------------------------------------------------
// Tool access decisions
// ---------------------------------------------------------------------------

export type ToolAccessDecision =
  | { type: "allow" }
  | { type: "allow"; autoApprovedBy: string }
  | { type: "read_only" }
  | { type: "require_approval"; route: ApprovalRoute }
  | { type: "forbidden"; reason: string };

export type ApprovalRoute =
  | { type: "auto_approved"; ruleId: string }
  | { type: "prove_it"; approvers: string[] }
  | { type: "forbidden" };

export type ApprovalRequest = {
  toolName: string;
  params: Record<string, unknown>;
  amount?: number | undefined;
  impact: "low" | "high" | "destructive";
};
