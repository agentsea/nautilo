/**
 * Connection vault public contract (ISSUE-D041).
 *
 * Naming: Connections are Agent-facing external-system secrets/handles — not Human
 * PIN/passkey Credentials (`entity-model/GLOSSARY`).
 */

/** Identifies which external system and field/key this Connection denotes. */
export interface ConnectionRef {
  service: string;
  field: string;
}

/** Connections are user/Namespace-scoped external-service handles. */
export type SecretCategory = "user";

/**
 * Resolved scope used for vault reads/lists/deletes — always namespace/agent aware.
 * Backend APIs MUST take ConnectionScope — no ref resolution without scope context.
 */
export interface ConnectionScope {
  readonly readableNamespaceIds: readonly string[];
  readonly agentId: string;
  /**
   * When storing a non-system Connection without an explicit namespace, the
   * runtime supplies the Room/Namespace (“current Namespace”).
   */
  readonly defaultNamespaceId?: string | null | undefined;
  /**
   * Opt-in compatibility for migrated rows with intentionally null identifiers.
   */
  readonly allowMigrationNullNamespaces?: boolean | undefined;
}

/**
 * Plaintext index metadata persisted alongside ciphertext (values never appear here).
 */
export interface ConnectionMetadata {
  readonly service: string;
  readonly field: string;
  readonly category: SecretCategory;
  readonly namespace_id: string | null;
  readonly agent_id: string | null;
  readonly authored_by_user_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
}

/** List result — metadata (+ id) only, never decrypted values. */
export interface ConnectionRecord {
  readonly id: string;
  readonly ref: ConnectionRef;
  readonly metadata: ConnectionMetadata;
}

export interface ConnectionRefWithId extends ConnectionRef {
  /**
   * Optional stable row id from `list(scope)`. Supplying it removes ambiguity
   * when multiple readable Namespaces carry the same `{ service, field }`.
   */
  readonly id?: string | undefined;
}

export type VaultState =
  | "plaintext_open"
  | "encrypted_locked"
  | "encrypted_unlocked";

export interface StoreConnectionOptions {
  readonly category?: SecretCategory | undefined;
  readonly namespaceId?: string | null | undefined;
  readonly agentId?: string | null | undefined;
  readonly authoredByUserId?: string | null | undefined;
  readonly expiresAt?: string | null | undefined;
  /** Epoch ms overrides for tests */
  readonly nowMs?: number | undefined;
}

export interface UnlockVaultOptions {
  /** Fallback when OS keychain is unavailable — unwraps persisted master envelope. */
  readonly pinUtf8?: string | undefined;
}

export interface VaultBackend {
  readonly state: VaultState;
  readonly vaultFilePath: string;

  unlock(options?: UnlockVaultOptions  ): Promise<void>;
  /** TODO(M072 follow-up): inactivity-based re-lock after idle timeout (ISSUE-M072 §Out of scope). */
  lock(): void;

  /**
   * Switches the store to encrypted-at-rest mode: generates a master key, writes
   * the sentinel, and re-writes all values with AES-256-GCM.
   */
  enableEncryption(options?: UnlockVaultOptions  ): Promise<void>;

  get(
    ref: ConnectionRefWithId,
    scope: ConnectionScope,
  ): Promise<Uint8Array | null>;

  set(
    ref: ConnectionRef,
    value: Uint8Array,
    scope: ConnectionScope,
    options?: StoreConnectionOptions  ,
  ): Promise<void>;

  list(scope: ConnectionScope): Promise<ConnectionRecord[]>;

  delete(
    ref: ConnectionRefWithId,
    scope: ConnectionScope,
  ): Promise<boolean>;

  rotateKey(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent Connection tool JSON shapes (D041) - metadata only, never values
// ---------------------------------------------------------------------------

export interface ConnectionToolStoreResult {
  readonly status: "stored";
  readonly service: string;
  readonly field: string;
}

export interface ConnectionToolListEntry {
  readonly id: string;
  readonly service: string;
  readonly field: string;
  readonly category: SecretCategory;
  readonly namespace_id: string | null;
  readonly agent_id: string | null;
  readonly updated_at: string;
  readonly expires_at: string | null;
}

export interface ConnectionToolListResult {
  readonly status: "ok";
  readonly connections: readonly ConnectionToolListEntry[];
}

export type ConnectionToolUseStatus = "available" | "missing";

export interface ConnectionToolUseResult {
  readonly status: ConnectionToolUseStatus;
  readonly service: string;
  readonly field: string;
}

export type ConnectionToolDeleteStatus = "deleted" | "missing";

export interface ConnectionToolDeleteResult {
  readonly status: ConnectionToolDeleteStatus;
  readonly service: string;
  readonly field: string;
}

export type ConnectionAuthShape =
  | "api_key"
  | "bearer_token"
  | "basic_auth"
  | "cookie"
  | "oauth_token"
  | "custom";

export interface ToolConnectionRequirement {
  readonly service: string;
  readonly field: string;
  readonly category: SecretCategory;
  readonly required: boolean;
  readonly authShape: ConnectionAuthShape;
  /** Safe label for catalog/UI display. Never includes local value names. */
  readonly displayLabel: string;
}

export interface ConnectionManagementEntry extends ConnectionToolListEntry {
  readonly scope_label: string;
  readonly configured: boolean;
  readonly valid: boolean | null;
}

export interface ConnectionListResponse {
  readonly status: "ok";
  readonly connections: readonly ConnectionManagementEntry[];
}

export interface StoreConnectionRequest {
  readonly service: string;
  readonly field: string;
  readonly value: string;
  readonly category?: "user" | undefined;
  readonly expiresAt?: string | null | undefined;
}

export interface StoreConnectionResponse {
  readonly status: "stored";
  readonly connection: ConnectionManagementEntry;
}

export interface DeleteConnectionResponse {
  readonly status: ConnectionToolDeleteStatus;
  readonly service: string;
  readonly field: string;
}

export type ConnectionAuditFindingKind =
  | "plaintext_config"
  | "unresolved_ref"
  | "legacy_alias"
  | "null_scope"
  | "missing_required_connection";

export interface ConnectionAuditFinding {
  readonly kind: ConnectionAuditFindingKind;
  readonly severity: "info" | "warning" | "error";
  readonly service?: string | undefined;
  readonly field?: string | undefined;
  readonly envVar?: string | undefined;
  readonly tool?: string | undefined;
  readonly message: string;
}

export interface ConnectionAuditResponse {
  readonly status: "ok";
  readonly findings: readonly ConnectionAuditFinding[];
}

export interface ConnectionProxyRequest {
  readonly field: string;
  readonly url: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
  readonly category?: "user" | undefined;
  readonly authShape?: ConnectionAuthShape | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: string | undefined;
}

export interface ConnectionProxyResponse {
  readonly status: "ok";
  readonly upstreamStatus: number;
  readonly body: string;
  readonly headers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// security-audit.log fragment (D041) - server merges with CommonAuditFields
// ---------------------------------------------------------------------------

export type ConnectionVaultAuditAction = "store" | "list" | "use" | "delete";

export type ConnectionVaultToolAuditOutcome = "ok" | "missing" | "error";

export interface ConnectionVaultToolAuditPayload {
  readonly action: ConnectionVaultAuditAction;
  readonly tool: string;
  readonly outcome: ConnectionVaultToolAuditOutcome;
  readonly service?: string | undefined;
  readonly field?: string | undefined;
  readonly connectionId?: string | undefined;
  /** Error `.name` or short code - never user-supplied secret text */
  readonly errorKind?: string | undefined;
}
