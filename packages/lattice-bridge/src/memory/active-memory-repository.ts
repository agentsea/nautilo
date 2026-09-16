export type ProtectedMemoryUnavailableReason =
  | "missing_mapping"
  | "legacy_plaintext"
  | "encryption_pending"
  | "stale_revision"
  | "incomplete_access_set"
  | "integrity_failure"
  | "authorization_required"
  | "text_search_unsupported"
  | "deleted"
  | "target_encryption_not_ready"
  | "embedding_unavailable";

export type ProtectedMemoryResult<Value> =
  | Readonly<{
      readonly status: "success";
      readonly value: Value;
      /** Product publication is durable; its derived effect awaits acknowledgement. */
      readonly followUpPending?: true;
      /** Explicit Shadow fallback observation; never protected verification. */
      readonly fallbackReason?: ProtectedMemoryUnavailableReason;
    }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedMemoryUnavailableReason;
  }>;

export type ProtectedAgentMemoryAccessAction = Readonly<{
  kind: "grant_user";
  userHandle: string;
}>;

export type ProtectedAgentMemoryAccessApprovalReference = Readonly<{
  referenceVersion: 1;
  referenceId: string;
  toolCallId: string;
  requesterUserId: string;
  agentId: string;
}>;

export type ProtectedAgentMemoryAccessApprovalPreview = Readonly<{
  type: string;
  content: string;
}>;

export interface ProtectedAgentMemoryAccessPort {
  prepareApproval?(input: Readonly<{
    operationId: string;
    toolCallId: string;
    authority: ProtectedMemoryAuthority;
    memoryId: string;
    action: ProtectedAgentMemoryAccessAction;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    reference: ProtectedAgentMemoryAccessApprovalReference;
    preview: ProtectedAgentMemoryAccessApprovalPreview;
  }>>>;
  change(input: Readonly<{
    operationId: string;
    authority: ProtectedMemoryAuthority;
    memoryId: string;
    action: ProtectedAgentMemoryAccessAction;
    approvalReference?: ProtectedAgentMemoryAccessApprovalReference;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    status: "unchanged" | "updated" | "replayed";
    memoryId: string;
  }>>>;
}

export type ProtectedAgentMemoryProjectionReference = Readonly<{
  referenceVersion: 1;
  referenceId: string;
  toolCallId: string;
  requesterUserId: string;
  requesterActorId: string;
  agentId: string;
  createdAt: number;
  expiresAt: number;
  /** Authenticated ciphertext only. Never a key, plaintext plan, or authority. */
  sealedPreparation?: string;
}>;

export type ProtectedAgentMemoryProjectionApprovalPreview = Readonly<{
  proposedContent: string;
  roomLabel: string;
  roomKind: "private" | "group" | "multi_agent" | "subthread" | "open" | "task" | "access";
  memberCount: number;
}>;

export type ProtectedAgentMemoryProjectionPreparation =
  | Readonly<{ kind: "prepared"; reference: ProtectedAgentMemoryProjectionReference; preview: ProtectedAgentMemoryProjectionApprovalPreview }>
  | Readonly<{ kind: "needs_disambiguation"; candidates: readonly Readonly<{ choiceToken: string; label: string; roomKind: "private" | "group" | "multi_agent" | "subthread" | "open" | "task" | "access"; memberCount: number }>[] }>;

export interface ProtectedAgentMemoryProjectionPort {
  /** Reopen the exact prepared preview under fresh invocation authorization. */
  restore?(input: Readonly<{ authority: ProtectedMemoryAuthority; reference: ProtectedAgentMemoryProjectionReference }>): Promise<ProtectedMemoryResult<ProtectedAgentMemoryProjectionApprovalPreview>>;
  prepare(input: Readonly<{ operationId: string; toolCallId: string; authority: ProtectedMemoryAuthority; requesterActorId: string; sourceMemoryIds: readonly string[]; proposedContent: string; targetRoomName: string; roomChoiceToken?: string }>): Promise<ProtectedMemoryResult<ProtectedAgentMemoryProjectionPreparation>>;
  publish(input: Readonly<{ authority: ProtectedMemoryAuthority; reference: ProtectedAgentMemoryProjectionReference }>): Promise<ProtectedMemoryResult<Readonly<{ status: "created" | "replayed"; memoryId: string; roomLabel: string }>>>;
}

export type ProtectedMemoryAuthority =
  | Readonly<{
    readonly mode: "namespace";
    readonly subjectUserId: string;
    readonly agentId: string;
    readonly readableNamespaceIds: readonly string[];
    readonly mutableNamespaceIds: readonly string[];
    readonly writableNamespaceId: string | null;
  }>
  | Readonly<{
    readonly mode: "scope";
    readonly subjectUserId: string;
    readonly agentId: string;
    readonly scopeId: string;
    readonly originWritableNamespaceId: string;
  }>;

export type ProtectedMemoryOpenedItem = Readonly<{
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly importance: number;
  readonly tier: number;
  readonly score: number;
  readonly createdAt: Date;
}>;

/**
 * Invocation-bound Agent view of protected Memory. A Runtime composition must
 * bind this object to one live foreground authorization session; callers
 * supply product authority coordinates, never roots, Grants, or session
 * capabilities. Implementations revalidate the bound session for every
 * method and release opened payload bytes before returning.
 */
export interface ProtectedAgentMemoryRepository {
  search(input: Readonly<{
    readonly authority: ProtectedMemoryAuthority;
    readonly query: string;
    readonly limit: number;
    readonly includeArchive: boolean;
    readonly mode: "vector";
    readonly signal?: AbortSignal;
  }>): Promise<ProtectedMemoryResult<readonly ProtectedMemoryOpenedItem[]>>;

  save(input: Readonly<{
    readonly operationId: string;
    readonly authority: ProtectedMemoryAuthority;
    readonly type: string;
    readonly content: string;
    readonly importance?: number;
  }>): Promise<ProtectedMemoryResult<Readonly<{
    readonly id: string;
    readonly action: "created" | "updated";
    readonly similarity?: number;
  }>>>;

  replace(input: Readonly<{
    readonly operationId: string;
    readonly authority: ProtectedMemoryAuthority;
    readonly memoryId: string;
    readonly content: string;
  }>): Promise<ProtectedMemoryResult<void>>;

  setTier(input: Readonly<{
    readonly operationId: string;
    readonly authority: ProtectedMemoryAuthority;
    readonly memoryId: string;
    readonly action: "promote" | "demote";
  }>): Promise<ProtectedMemoryResult<void>>;
}

/** Read-only foreground subset; it cannot authorize Memory mutation tools. */
export type ProtectedAgentMemorySearchPort = Pick<
  ProtectedAgentMemoryRepository,
  "search"
>;

export function describeProtectedMemoryUnavailable(
  reason: ProtectedMemoryUnavailableReason,
): string {
  switch (reason) {
    case "missing_mapping":
      return "encrypted Memory mapping is missing";
    case "legacy_plaintext":
      return "Memory has not been encrypted yet";
    case "encryption_pending":
      return "Memory encryption is still pending";
    case "stale_revision":
      return "Memory changed while this operation was running";
    case "incomplete_access_set":
      return "Memory access is not fully published";
    case "integrity_failure":
      return "Memory integrity verification failed";
    case "authorization_required":
      return "current Memory authorization is unavailable";
    case "text_search_unsupported":
      return "plaintext Memory text search is unavailable";
    case "deleted":
      return "Memory was deleted";
    case "target_encryption_not_ready":
      return "target Namespace encryption is not ready";
    case "embedding_unavailable":
      return "compatible Memory embeddings are unavailable";
  }
}
