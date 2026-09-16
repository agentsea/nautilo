import type { ConnectionAuditFinding } from "@nautilo/types";

export type ConfigOperationType = "set" | "remove";

export type AuditOperationType = ConfigOperationType | "convert";

export interface ConfigOperation {
  type: ConfigOperationType;
  key: string;
  value?: string | undefined;
}

export type HealthCheckMode = "keys" | "server" | "none";

export type KeyStatus =
  | "missing"
  | "invalid_format"
  | "present"
  | "verified"
  | "invalid_key"
  | "unreachable";

export type KeyCategory = "llm" | "llm+embeddings" | "voice" | "search" | "conversion" | "browser";

export interface DoctorHintRule {
  condition: (value: string) => boolean;
  message: string;
}

export interface KeyDefinition {
  id: string;
  name: string;
  envVar: string;
  category: KeyCategory;
  purpose: string;
  required: boolean;
  signupUrl: string;
  formatHint: string;
  formatCheck: (value: string) => boolean;
  doctorHints: DoctorHintRule[];
  /** Some providers publish no non-mutating authentication probe. */
  healthCheck?: "provider" | "format_only";
}

export interface KeyReport {
  id: string;
  name: string;
  envVar: string;
  category: KeyCategory;
  purpose: string;
  required: boolean;
  signupUrl: string;
  formatHint: string;
  status: KeyStatus;
  masked: string | null;
  hint: string | null;
}

export type TransactionActor = "setup-spa" | "agent" | "cli" | "test";

/** Actors that may appear in `config-audit.jsonl` (broader than `transaction()` actors). */
export type AuditActor = TransactionActor | "boot-migration";

export interface TransactionInput {
  operations: ConfigOperation[];
  healthCheck: HealthCheckMode;
  overwrite?: boolean | undefined;
  reason: string;
  actor: TransactionActor;
}

export interface TransactionDetail {
  key: string;
  action: "applied" | "skipped" | "failed";
  reason?: string | undefined;
}

/** Discriminant for non-throwing `transaction()` rejections (distinct from `ConfigGuardError.code`). */
export type ConfigGuardErrorKind =
  | "read_only_in_cloud"
  | "provider_keys_only_in_cloud"
  | "managed_provider_key";

export interface TransactionResult {
  success: boolean;
  snapshot: string | null;
  applied: number;
  skipped: number;
  rolledBack: boolean;
  error: string | null;
  details: TransactionDetail[];
  rejectedReason?: ConfigGuardErrorKind | undefined;
}

export interface SnapshotMeta {
  id: string;
  timestamp: string;
  actor: TransactionActor;
  reason: string;
  operations: Array<{ type: ConfigOperationType; key: string }>;
  result: "applied" | "rolled_back" | "pending";
  error?: string | undefined;
}

export interface CheckInput {
  validate?: boolean | undefined;
}

export interface CheckSummary {
  total: number;
  configured: number;
  verified: number;
  missing: number;
  invalid: number;
  hasLlm: boolean;
  hasEmbeddings: boolean;
  hasVoice: boolean;
  hasSearch: boolean;
  hasConversion: boolean;
}

export interface CheckResult {
  keys: KeyReport[];
  summary: CheckSummary;
}

/**
 * M051 (Logto cluster): single MODE_REGISTRY entry as it surfaces to UI / CLI
 * consumers. `value` is already redacted when appropriate — never the raw
 * env. Callers should not need to know the underlying `redact` flag, but
 * `redacted: true` is exposed for UI affordances like a "show secret" gate.
 */
export interface ModeReportEntry {
  id: string;
  envVar: string;
  description: string;
  /** When true, entry is a deprecated alias (M071 hostname split). */
  deprecated?: boolean;
  status: "set" | "missing";
  /** Already-masked when the entry's `redact: true`. `null` iff `status === "missing"`. */
  value: string | null;
  redacted: boolean;
}

export interface ModeReport {
  entries: ModeReportEntry[];
}

export interface AuditEntry {
  ts: string;
  actor: AuditActor;
  reason: string;
  ops: Array<{ type: AuditOperationType; key: string }>;
  result: "applied" | "rolled_back" | "rejected";
  error?: string | undefined;
  snapshot?: string | undefined;
}

export interface ConnectionAuditPlan {
  findings: ConnectionAuditFinding[];
}

export class ConfigGuardError extends Error {
  constructor(
    public readonly code: "VALIDATION" | "RATE_LIMIT" | "IO" | "HEALTH",
    message: string,
  ) {
    super(message);
    this.name = "ConfigGuardError";
  }
}
