/**
 * Nautilo agent runtime configuration.
 *
 * Two layers:
 * 1. A user-facing sectioned config file (`nautilo.config.ts`)
 * 2. A flat internal runtime config used by the codebase
 *
 * Resolution order:
 * 1. Runtime overrides (from the config file or passed programmatically)
 * 2. Environment variables (NAUTILO_*)
 * 3. Zod defaults
 */

import { domainToASCII } from "node:url";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { setLogLevel, type LogLevel } from "@nautilo/logger";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const SearchProviderSchema = z.enum(["auto", "tavily", "duckduckgo_html"]);
const SearchDepthSchema = z.enum(["basic", "advanced"]);
const SearchQualityModeSchema = z.enum(["balanced", "strict"]);

const MODEL_DEFAULTS = {
  default: "",
  sessionSearch: "",
  // — explicit Room Conductor override. Empty delegates
  // to the shared role-candidate policy; Admin can still override it live.
  conductor: "",
  flush: "",
  reviewer: "",
  webSearch: "",
  // Existing pgvector storage is 1536-dimensional. Empty selects the
  // provider-specific automatic model; bare legacy selections remain explicit.
  embeddingModel: "",
  embeddingDimensions: 1536,
} as const;

const HISTORY_DEFAULTS = {
  validationEnabled: true,
  pruningEnabled: false,
  tokenBudgetFraction: 0.6,
  windowKeepRecent: 20,
} as const;

const MEMORY_DEFAULTS = {
  briefCharLimit: 8000,
  searchLimit: 10,
  sessionSearchLimit: 5,
  dedupSimilarityThreshold: 0.9,
  exitFlushEnabled: true,
  flushMinTurns: 3,
  nudgeThreshold: 10,
  reviewerEnabled: true,
  reviewerMaxIterations: 8,
} as const;

const RESEARCH_DEFAULTS = {
  // Operator-overridable audit policy for initial provider silence; not an
  // upstream hard limit or an absolute deadline for a progressing response.
  auditFirstProgressTimeoutMs: 600_000,
  searchProvider: "auto",
  searchMaxResults: 5,
  searchDepth: "basic",
  searchReadPageCount: 2,
  readWebpageTimeoutMs: 30_000,
  readWebpageMaxContentLength: 50_000,
  searchExcludeDomains: [
    "reddit.com",
    "facebook.com",
    "quora.com",
    "pinterest.com",
    "tiktok.com",
  ],
  searchTrustedDomains: ["wikipedia.org", "britannica.com"],
  searchQualityMode: "balanced",
} as const;

const SESSION_DEFAULTS = {
  autoResume: true,
  stateFile: "session.json",
} as const;

const HOME_DEFAULTS = {
  rootDir: "home",
  workspaceDir: "home/workspace",
  researchDir: "home/research",
  notesDir: "home/notes",
  exportsDir: "home/exports",
  logsDir: "home/logs",
  transcriptsDir: "home/transcripts",
} as const;

/**
 * Zone root directories and data sub-paths ( artifact-centric pivot).
 * `scratch/` is a SIBLING of `home/`, not a child — enables cleaning
 * ephemeral content without risking permanent work product. `data/*`
 * and `vault/` are app-internal; relay adapters do not receive
 * providers for these zones (v8 §9.1).
 *
 * No `inboxDir`: the legacy inbox is not a managed storage zone. Existing
 * contents are preserved by the storage-layout migration.
 */
const STORAGE_DEFAULTS = {
  scratchDir: "scratch",
  dataDir: "data",
  dbDataDir: "data/db",
  embeddingsDir: "data/embeddings",
  voiceCacheDir: "data/voice-previews",
  audioCacheDir: "data/audio",
  vaultDir: "vault",
} as const;

const SOUL_DEFAULTS = {
  charLimit: 4000,
  generatorModel: null,
  motherEasterEgg: false,
} as const;

const VOICE_DEFAULTS = {
  enabled: false,
  provider: "auto",
  voiceName: null,
  speakToolSummaries: false,
} as const;

const LOGGING_DEFAULTS = {
  toolCalls: true,
  level: "info",
  historyOperations: false,
} as const;

/**
 * backup subsystem retention knobs. Owners / ops can
 * override via environment (NAUTILO_BACKUP_*) or the runtime config
 * object. The router's size thresholds (5 MB pre-size, 1 MB diff
 * inflation) are intentionally NOT exposed as runtime knobs — they
 * encode measured behaviour of the Myers diff algorithm on real
 * agent-driven edits and operators shouldn't need to tune them.
 */
const BACKUP_DEFAULTS = {
  perFileCap: 50,
  totalSizeCapMb: 500,
  gcIntervalMs: 60 * 60 * 1000, // 1 hour
} as const;

const runtimeModelSchema = {
  nautilo_model: z.string().default(MODEL_DEFAULTS.default),
  nautilo_embedding_model: z.string().default(MODEL_DEFAULTS.embeddingModel),
  nautilo_embedding_dims: z.number().int().positive().default(MODEL_DEFAULTS.embeddingDimensions),
  nautilo_session_search_model: z.string().default(MODEL_DEFAULTS.sessionSearch),
  /** Room Conductor Floor Manager model. Empty ⇒ default model. */
  nautilo_conductor_model: z.string().default(MODEL_DEFAULTS.conductor),
  nautilo_flush_model: z.string().default(MODEL_DEFAULTS.flush),
  nautilo_reviewer_model: z.string().default(MODEL_DEFAULTS.reviewer),
  nautilo_web_search_model: z.string().default(MODEL_DEFAULTS.webSearch),
  /** Optional browser-action decision model; empty preserves ordinary browser routing. */
  nautilo_browser_decision_model: z.string().default(""),
  /** Recoverable/no-progress events between Genie interventions; not a provider retry, time, or step limit. */
  nautilo_browser_decision_intervention_limit: z.number().int().positive().default(2),
  /** vision-capable chat model id for summarizing images when the user's model is text-only */
  nautilo_vision_fallback_model: z.string().default(""),
  /**
   * Comma/newline-separated ordered list; first entry with image input + runnable provider keys wins.
   * When empty, `nautilo_vision_fallback_model` is used as a single candidate.
   */
  nautilo_vision_fallback_candidates: z.string().default(""),
  /**
   * When the chat model is text-only and the user attaches images: `unsupported` (default) skips auxiliary vision calls;
   * `vision_summary` enables the candidate-list summarization path (lossy, opt-in).
   */
  nautilo_text_only_image_policy: z.enum(["unsupported", "vision_summary"]).default("unsupported"),
} satisfies z.ZodRawShape;

const runtimeHistorySchema = {
  nautilo_history_validation_enabled: z.boolean().default(HISTORY_DEFAULTS.validationEnabled),
  nautilo_history_pruning_enabled: z.boolean().default(HISTORY_DEFAULTS.pruningEnabled),
  nautilo_token_budget_fraction: z.number().min(0.1).max(0.9).default(HISTORY_DEFAULTS.tokenBudgetFraction),
  nautilo_window_keep_recent: z.number().int().positive().max(100).default(HISTORY_DEFAULTS.windowKeepRecent),
} satisfies z.ZodRawShape;

const runtimeMemorySchema = {
  nautilo_memory_brief_char_limit: z.number().int().positive().default(MEMORY_DEFAULTS.briefCharLimit),
  nautilo_memory_search_limit: z.number().int().positive().default(MEMORY_DEFAULTS.searchLimit),
  nautilo_session_search_limit: z.number().int().positive().default(MEMORY_DEFAULTS.sessionSearchLimit),
  nautilo_memory_dedup_similarity_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(MEMORY_DEFAULTS.dedupSimilarityThreshold),
  nautilo_exit_flush_enabled: z.boolean().default(MEMORY_DEFAULTS.exitFlushEnabled),
  nautilo_flush_min_turns: z.number().int().nonnegative().default(MEMORY_DEFAULTS.flushMinTurns),
  nautilo_nudge_threshold: z.number().int().positive().default(MEMORY_DEFAULTS.nudgeThreshold),
  nautilo_reviewer_enabled: z.boolean().default(MEMORY_DEFAULTS.reviewerEnabled),
  nautilo_reviewer_max_iterations: z.number().int().positive().default(MEMORY_DEFAULTS.reviewerMaxIterations),
} satisfies z.ZodRawShape;

const runtimeResearchSchema = {
  nautilo_research_first_progress_timeout_ms: z.number().int().positive().safe().default(RESEARCH_DEFAULTS.auditFirstProgressTimeoutMs),
  nautilo_search_provider: SearchProviderSchema.default(RESEARCH_DEFAULTS.searchProvider),
  nautilo_search_max_results: z.number().int().positive().default(RESEARCH_DEFAULTS.searchMaxResults),
  nautilo_search_depth: SearchDepthSchema.default(RESEARCH_DEFAULTS.searchDepth),
  nautilo_search_read_page_count: z.number().int().positive().default(RESEARCH_DEFAULTS.searchReadPageCount),
  nautilo_read_webpage_timeout_ms: z.number().int().positive().default(RESEARCH_DEFAULTS.readWebpageTimeoutMs),
  nautilo_read_webpage_max_content_length: z
    .number()
    .int()
    .positive()
    .default(RESEARCH_DEFAULTS.readWebpageMaxContentLength),
  nautilo_search_exclude_domains: z.array(z.string()).default([...RESEARCH_DEFAULTS.searchExcludeDomains]),
  nautilo_search_trusted_domains: z.array(z.string()).default([...RESEARCH_DEFAULTS.searchTrustedDomains]),
  nautilo_search_quality_mode: SearchQualityModeSchema.default(RESEARCH_DEFAULTS.searchQualityMode),
} satisfies z.ZodRawShape;

const runtimeSessionSchema = {
  nautilo_session_auto_resume: z.boolean().default(SESSION_DEFAULTS.autoResume),
  nautilo_session_state_file: z.string().default(SESSION_DEFAULTS.stateFile),
} satisfies z.ZodRawShape;

const runtimeHomeSchema = {
  nautilo_home_root_dir: z.string().default(HOME_DEFAULTS.rootDir),
  nautilo_home_workspace_dir: z.string().default(HOME_DEFAULTS.workspaceDir),
  nautilo_home_research_dir: z.string().default(HOME_DEFAULTS.researchDir),
  nautilo_home_notes_dir: z.string().default(HOME_DEFAULTS.notesDir),
  nautilo_home_exports_dir: z.string().default(HOME_DEFAULTS.exportsDir),
  nautilo_home_logs_dir: z.string().default(HOME_DEFAULTS.logsDir),
  nautilo_home_transcripts_dir: z.string().default(HOME_DEFAULTS.transcriptsDir),
} satisfies z.ZodRawShape;

const runtimeStorageSchema = {
  nautilo_scratch_dir: z.string().default(STORAGE_DEFAULTS.scratchDir),
  nautilo_data_dir: z.string().default(STORAGE_DEFAULTS.dataDir),
  nautilo_db_data_dir: z.string().default(STORAGE_DEFAULTS.dbDataDir),
  nautilo_embeddings_dir: z.string().default(STORAGE_DEFAULTS.embeddingsDir),
  nautilo_voice_cache_dir: z.string().default(STORAGE_DEFAULTS.voiceCacheDir),
  nautilo_audio_cache_dir: z.string().default(STORAGE_DEFAULTS.audioCacheDir),
  nautilo_vault_dir: z.string().default(STORAGE_DEFAULTS.vaultDir),
} satisfies z.ZodRawShape;

const runtimeSoulSchema = {
  nautilo_soul_char_limit: z.number().int().positive().default(SOUL_DEFAULTS.charLimit),
  nautilo_soul_generator_model: z.string().nullable().default(SOUL_DEFAULTS.generatorModel),
  nautilo_soul_mother_easter_egg: z.boolean().default(SOUL_DEFAULTS.motherEasterEgg),
} satisfies z.ZodRawShape;

const runtimeVoiceSchema = {
  nautilo_voice_enabled: z.boolean().default(VOICE_DEFAULTS.enabled),
  nautilo_voice_provider: z.enum(["auto", "elevenlabs", "say"]).default(VOICE_DEFAULTS.provider),
  nautilo_voice_name: z.string().nullable().default(VOICE_DEFAULTS.voiceName),
  nautilo_voice_speak_tool_summaries: z.boolean().default(VOICE_DEFAULTS.speakToolSummaries),
} satisfies z.ZodRawShape;

const runtimeLoggingSchema = {
  nautilo_log_tool_calls: z.boolean().default(LOGGING_DEFAULTS.toolCalls),
  nautilo_log_level: LogLevelSchema.default(LOGGING_DEFAULTS.level),
  nautilo_log_history_operations: z.boolean().default(LOGGING_DEFAULTS.historyOperations),
} satisfies z.ZodRawShape;

export const SecurityLevelSchema = z.enum(["yolo", "permissive", "standard", "cautious", "paranoid"]);

/**
 * Server deployment mode. Sprint 1 G5.3 (security ship plan v3
 * §5.3). Server-enforced posture that selects the deployment profile
 * the sandbox is constructed from (see `@nautilo/sandbox/profiles`).
 *
 * `server` — workspace-only, paranoid default. Cloud/CI/OSS.
 * `desktop-permissive` — broad RO home + narrow RW project, cautious.
 * `desktop-locked` — workspace-only on desktop, paranoid.
 */
export const DeploymentModeSchema = z.enum([
  "server",
  "desktop-permissive",
  "desktop-locked",
]);

const NetworkPortsSchema = z.array(z.number().int().min(1).max(65535)).min(1).optional();

const DomainHostSchema = z.string().min(1).refine(isValidDomainName, {
  message: "host must be a valid domain name without scheme, path, query, or port",
});

const WildcardSuffixSchema = z.string().min(1).refine((value) => {
  const suffix = value.replace(/^\*\./, "");
  return value !== "*" && isValidDomainName(suffix);
}, {
  message: "suffix must be a valid wildcard suffix like github.com",
});

const CidrSchema = z.string().min(1).refine(isValidStrictCidr, {
  message: "cidr must be a valid IPv4/IPv6 CIDR",
});

export const NetworkAllowRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("domain"),
    host: DomainHostSchema,
    ports: NetworkPortsSchema,
  }).strict(),
  z.object({
    type: z.literal("wildcard"),
    suffix: WildcardSuffixSchema,
    ports: NetworkPortsSchema,
  }).strict(),
  z.object({
    type: z.literal("cidr"),
    cidr: CidrSchema,
    ports: NetworkPortsSchema,
  }).strict(),
]);

export const NetworkPolicySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("host"),
  }).strict(),
  z.object({
    mode: z.literal("isolated"),
  }).strict(),
  z.object({
    mode: z.literal("proxy-allowlist"),
    allow: z.array(NetworkAllowRuleSchema).default([]),
    defaultPort: z.literal(443).optional(),
  }).strict(),
]);

function isValidDomainName(value: string): boolean {
  if (value !== value.trim()) return false;
  const trimmed = value.trim().replace(/\.$/, "");
  if (trimmed.length === 0) return false;
  if (/[\s/:?#@[\]\\]/.test(trimmed)) return false;
  // Domain allow rules should not smuggle IP literals. Use CIDR rules
  // for exact IPs (`1.2.3.4/32`, `::1/128`) so matching semantics
  // stay aligned with the sandbox allowlist implementation.
  if (ipaddr.IPv4.isValidFourPartDecimal(trimmed) || ipaddr.IPv6.isValid(trimmed)) {
    return false;
  }
  const ascii = domainToASCII(trimmed.toLowerCase());
  if (ascii.length === 0 || ascii.length > 253) return false;
  const labels = ascii.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) return false;
  return labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function isValidStrictCidr(value: string): boolean {
  return ipaddr.IPv4.isValidCIDRFourPartDecimal(value) ||
    ipaddr.IPv6.isValidCIDR(value);
}

const runtimeSecuritySchema = {
  nautilo_security_level: SecurityLevelSchema.default("standard"),
  // Default picked so a fresh install (no sectioned security block)
  // behaves like a single-user Electron app. Headless/server installs
  // are expected to ship an explicit deployment_mode in their seeded
  // config (written by the first-boot provisioner). If we ever need
  // per-platform defaults we'll move this to a first-boot writer,
  // not a schema-default branch.
  nautilo_deployment_mode: DeploymentModeSchema.default("desktop-permissive"),
  // server-owned network egress policy. No env fallback; this is
  // mutated through the PIN/capability-gated posture API + sidecar.
  nautilo_network_policy: NetworkPolicySchema.optional(),
} satisfies z.ZodRawShape;

const runtimeBackupSchema = {
  /** per-file count cap (evict past this many unpinned revisions). */
  nautilo_backup_per_file_cap: z
    .number()
    .int()
    .positive()
    .default(BACKUP_DEFAULTS.perFileCap),
  /** per-deployment size cap (MB). Hot ceiling above which LRU eviction kicks in. */
  nautilo_backup_total_size_cap_mb: z
    .number()
    .int()
    .positive()
    .default(BACKUP_DEFAULTS.totalSizeCapMb),
  /** interval between hourly GC sweeps (milliseconds). */
  nautilo_backup_gc_interval_ms: z
    .number()
    .int()
    .positive()
    .default(BACKUP_DEFAULTS.gcIntervalMs),
} satisfies z.ZodRawShape;

const runtimeInstanceNetworkSchema = {
  nautilo_instance_network: z
    .object({
      serverPort: z.number().int().positive().max(65535).optional(),
      workbenchPort: z.number().int().positive().max(65535).optional(),
      dbPostgresHostPort: z.number().int().positive().max(65535).optional(),
      neonProxyPort: z.number().int().positive().max(65535).optional(),
      logtoDbPort: z.number().int().positive().max(65535).optional(),
      logtoCorePort: z.number().int().positive().max(65535).optional(),
      logtoAdminPort: z.number().int().positive().max(65535).optional(),
      composeProjectName: z.string().optional(),
    })
    .strict()
    .optional(),
  nautilo_instance_hostname: z
    .object({
      federated: z.string().optional(),
      mdns: z.string().optional(),
      tlsSan: z.string().optional(),
      caddyAuthHost: z.string().optional(),
      caddyAuthAdminHost: z.string().optional(),
    })
    .strict()
    .optional(),
} satisfies z.ZodRawShape;

const runtimeDispatchSchema = {
  /**
   * silent direct-dispatch Accept/Reject master flag.
   *
   * When enabled:
   * - `/api/file/apply-patch-direct` accepts POSTs and runs the
   * handler without a synthetic user message / LLM round-trip.
   * - `/api/capabilities` advertises `directDispatch: true` so the
   * UI knows to use the direct path.
   * - Rejections get appended to `session_notifications`; the
   * pre-model node drains + injects on the next turn.
   *
   * When disabled (safety fallback — default OFF until live-verified):
   * - The route returns 503 so a racing client build surfaces a
   * clean error instead of hanging.
   * - `/api/capabilities` reports `directDispatch: false` so the
   * UI falls back to the legacy `sendText("/accept_changes …")`
   * synthetic-message path.
   * - The pre-model drain / inject is a no-op.
   *
   * One-switch policy: exposing a single-flag-gated pair (server +
   * UI) is intentional — partial enablement (server on, UI off, or
   * vice-versa) leaks into the pending-patch banner showing a state
   * that doesn't match what the agent sees. Keep them correlated by
   * reading the flag through `/api/capabilities` on connect.
   */
  nautilo_direct_dispatch: z.boolean().default(false),
} satisfies z.ZodRawShape;

const runtimeOfficeSchema = {
  /**
   * merge-gate — dark-launch switch for the heavyweight LibreOffice
   * stack. Mirrors `nautilo_direct_dispatch`: one runtime boolean gates both
   * server/agent behavior and the UI-advertised capability.
   */
  nautilo_office_enabled: z.boolean().default(false),
} satisfies z.ZodRawShape;

/**
 * selects only which already-eligible tool schemas reach the model.
 *
 * `eager` is a temporary operational rollback: it restores every tool that
 * passes the catalog's existing policy, relay, namespace, whitelist, and
 * model-capability gates. It must never be used to widen those gates.
 */
export const ToolExposureModeSchema = z.enum(["progressive", "eager"]);

const runtimeToolExposureSchema = {
  nautilo_tool_exposure_mode: ToolExposureModeSchema.default("progressive"),
  nautilo_tool_activation_retention_turns: z.number().int().min(0).max(20).default(3),
} satisfies z.ZodRawShape;

const runtimeConnectedAppsSchema = {
  /** Exact operator-selected OpenConnector origin; credentials are never config values. */
  nautilo_openconnector_base_url: z.string().trim().min(1).default("http://127.0.0.1:3010"),
} satisfies z.ZodRawShape;

export const NautiloConfigSchema = z.object({
  ...runtimeModelSchema,
  ...runtimeHistorySchema,
  ...runtimeMemorySchema,
  ...runtimeResearchSchema,
  ...runtimeSessionSchema,
  ...runtimeHomeSchema,
  ...runtimeStorageSchema,
  ...runtimeSoulSchema,
  ...runtimeVoiceSchema,
  ...runtimeLoggingSchema,
  ...runtimeSecuritySchema,
  ...runtimeBackupSchema,
  ...runtimeInstanceNetworkSchema,
  ...runtimeDispatchSchema,
  ...runtimeOfficeSchema,
  ...runtimeToolExposureSchema,
  ...runtimeConnectedAppsSchema,
});

export type NautiloConfig = z.infer<typeof NautiloConfigSchema>;
const NautiloConfigOverridesSchema = NautiloConfigSchema.partial();
export type NautiloConfigOverrides = z.infer<typeof NautiloConfigOverridesSchema>;

const UserModelsSchema = z.object({
  default: z.string().default(MODEL_DEFAULTS.default),
  sessionSearch: z.string().default(MODEL_DEFAULTS.sessionSearch),
  conductor: z.string().default(MODEL_DEFAULTS.conductor),
  flush: z.string().default(MODEL_DEFAULTS.flush),
  reviewer: z.string().default(MODEL_DEFAULTS.reviewer),
  webSearch: z.string().default(MODEL_DEFAULTS.webSearch),
  /** Optional vision-capable chat model for image summarization when `default` is text-only */
  visionFallback: z.string().optional().default(""),
  /** Ordered pool (comma/newline); used when `textOnlyImagePolicy` is `vision_summary` */
  visionFallbackCandidates: z.string().optional().default(""),
  /** `unsupported` (default) or opt-in `vision_summary` auxiliary model path */
  textOnlyImagePolicy: z.enum(["unsupported", "vision_summary"]).optional().default("unsupported"),
  embedding: z.object({
    model: z.string().default(MODEL_DEFAULTS.embeddingModel),
    dimensions: z.number().int().positive().default(MODEL_DEFAULTS.embeddingDimensions),
  }),
});

const UserHistorySchema = z.object({
  validationEnabled: z.boolean().default(HISTORY_DEFAULTS.validationEnabled),
  pruningEnabled: z.boolean().default(HISTORY_DEFAULTS.pruningEnabled),
  tokenBudgetFraction: z.number().min(0.1).max(0.9).default(HISTORY_DEFAULTS.tokenBudgetFraction),
  windowKeepRecent: z.number().int().positive().max(100).default(HISTORY_DEFAULTS.windowKeepRecent),
});

const UserMemorySchema = z.object({
  briefCharLimit: z.number().int().positive().default(MEMORY_DEFAULTS.briefCharLimit),
  searchLimit: z.number().int().positive().default(MEMORY_DEFAULTS.searchLimit),
  sessionSearchLimit: z.number().int().positive().default(MEMORY_DEFAULTS.sessionSearchLimit),
  dedupSimilarityThreshold: z.number().min(0).max(1).default(MEMORY_DEFAULTS.dedupSimilarityThreshold),
  exitFlushEnabled: z.boolean().default(MEMORY_DEFAULTS.exitFlushEnabled),
  flushMinTurns: z.number().int().nonnegative().default(MEMORY_DEFAULTS.flushMinTurns),
  nudgeThreshold: z.number().int().positive().default(MEMORY_DEFAULTS.nudgeThreshold),
  reviewerEnabled: z.boolean().default(MEMORY_DEFAULTS.reviewerEnabled),
  reviewerMaxIterations: z.number().int().positive().default(MEMORY_DEFAULTS.reviewerMaxIterations),
});

const UserResearchSchema = z.object({
  searchProvider: SearchProviderSchema.default(RESEARCH_DEFAULTS.searchProvider),
  auditFirstProgressTimeoutMs: z.number().int().positive().safe().default(RESEARCH_DEFAULTS.auditFirstProgressTimeoutMs),
  searchMaxResults: z.number().int().positive().default(RESEARCH_DEFAULTS.searchMaxResults),
  searchDepth: SearchDepthSchema.default(RESEARCH_DEFAULTS.searchDepth),
  searchReadPageCount: z.number().int().positive().default(RESEARCH_DEFAULTS.searchReadPageCount),
  readWebpageTimeoutMs: z.number().int().positive().default(RESEARCH_DEFAULTS.readWebpageTimeoutMs),
  readWebpageMaxContentLength: z.number().int().positive().default(RESEARCH_DEFAULTS.readWebpageMaxContentLength),
  searchExcludeDomains: z.array(z.string()).default([...RESEARCH_DEFAULTS.searchExcludeDomains]),
  searchTrustedDomains: z.array(z.string()).default([...RESEARCH_DEFAULTS.searchTrustedDomains]),
  searchQualityMode: SearchQualityModeSchema.default(RESEARCH_DEFAULTS.searchQualityMode),
});

const UserSessionSchema = z.object({
  autoResume: z.boolean().default(SESSION_DEFAULTS.autoResume),
  stateFile: z.string().default(SESSION_DEFAULTS.stateFile),
});

const UserHomeSchema = z.object({
  rootDir: z.string().default(HOME_DEFAULTS.rootDir),
  workspaceDir: z.string().default(HOME_DEFAULTS.workspaceDir),
  researchDir: z.string().default(HOME_DEFAULTS.researchDir),
  notesDir: z.string().default(HOME_DEFAULTS.notesDir),
  exportsDir: z.string().default(HOME_DEFAULTS.exportsDir),
  logsDir: z.string().default(HOME_DEFAULTS.logsDir),
  transcriptsDir: z.string().default(HOME_DEFAULTS.transcriptsDir),
});

const UserStorageSchema = z.object({
  scratchDir: z.string().default(STORAGE_DEFAULTS.scratchDir),
  dataDir: z.string().default(STORAGE_DEFAULTS.dataDir),
  dbDataDir: z.string().default(STORAGE_DEFAULTS.dbDataDir),
  embeddingsDir: z.string().default(STORAGE_DEFAULTS.embeddingsDir),
  voiceCacheDir: z.string().default(STORAGE_DEFAULTS.voiceCacheDir),
  audioCacheDir: z.string().default(STORAGE_DEFAULTS.audioCacheDir),
  vaultDir: z.string().default(STORAGE_DEFAULTS.vaultDir),
});

const UserSoulSchema = z.object({
  charLimit: z.number().int().positive().default(SOUL_DEFAULTS.charLimit),
  generatorModel: z.string().nullable().default(SOUL_DEFAULTS.generatorModel),
  motherEasterEgg: z.boolean().default(SOUL_DEFAULTS.motherEasterEgg),
});

const UserVoiceSchema = z.object({
  enabled: z.boolean().default(VOICE_DEFAULTS.enabled),
  provider: z.enum(["auto", "elevenlabs", "say"]).default(VOICE_DEFAULTS.provider),
  voiceName: z.string().nullable().default(VOICE_DEFAULTS.voiceName),
  speakToolSummaries: z.boolean().default(VOICE_DEFAULTS.speakToolSummaries),
});

const UserLoggingSchema = z.object({
  toolCalls: z.boolean().default(LOGGING_DEFAULTS.toolCalls),
  level: LogLevelSchema.default(LOGGING_DEFAULTS.level),
  historyOperations: z.boolean().default(LOGGING_DEFAULTS.historyOperations),
});

const UserToolsSchema = z.object({
  activationRetentionTurns: z.number().int().min(0).max(20).default(3),
});

// Sectioned user-facing security block. Sprint 1 G5.3.
// `security_level` is the classic level; `deployment_mode` is
// the new v3 field that picks a sandbox profile. Both are optional
// with defaults so existing user configs (pre-G5.3) keep working
// without a migration — we read the absence as "use defaults".
const UserSecuritySchema = z.object({
  level: SecurityLevelSchema.default("standard"),
  deploymentMode: DeploymentModeSchema.default("desktop-permissive"),
  networkPolicy: NetworkPolicySchema.optional(),
});

/** optional local/LAN network overrides (maps to `nautilo_instance_*` runtime fields). */
const UserInstanceNetworkSchema = z
  .object({
    serverPort: z.number().int().positive().max(65535).optional(),
    workbenchPort: z.number().int().positive().max(65535).optional(),
    dbPostgresHostPort: z.number().int().positive().max(65535).optional(),
    neonProxyPort: z.number().int().positive().max(65535).optional(),
    logtoDbPort: z.number().int().positive().max(65535).optional(),
    logtoCorePort: z.number().int().positive().max(65535).optional(),
    logtoAdminPort: z.number().int().positive().max(65535).optional(),
    composeProjectName: z.string().optional(),
  })
  .strict()
  .optional();

const UserInstanceHostnameSchema = z
  .object({
    federated: z.string().optional(),
    mdns: z.string().optional(),
    tlsSan: z.string().optional(),
    caddyAuthHost: z.string().optional(),
    caddyAuthAdminHost: z.string().optional(),
  })
  .strict()
  .optional();

export const NautiloUserConfigSchema = z.object({
  models: UserModelsSchema,
  history: UserHistorySchema,
  memory: UserMemorySchema,
  research: UserResearchSchema,
  session: UserSessionSchema,
  home: UserHomeSchema,
  storage: UserStorageSchema,
  soul: UserSoulSchema,
  voice: UserVoiceSchema,
  logging: UserLoggingSchema,
  tools: UserToolsSchema.default({ activationRetentionTurns: 3 }),
  security: UserSecuritySchema.default({
    level: "standard",
    deploymentMode: "desktop-permissive",
  }),
  network: UserInstanceNetworkSchema,
  hostname: UserInstanceHostnameSchema,
});

export type NautiloUserConfig = z.infer<typeof NautiloUserConfigSchema>;

export type InstanceNetworkConfig = NonNullable<NautiloUserConfig["network"]>;
export type InstanceHostnameConfig = NonNullable<NautiloUserConfig["hostname"]>;

type Env = NodeJS.ProcessEnv;
type RuntimeSource = NautiloConfigOverrides | null | undefined;

let cachedConfig: NautiloConfig | null = null;
let runtimeOverrides: NautiloConfigOverrides | null = null;

function readBooleanEnv(env: Env, key: string): boolean | undefined {
  const value = env[key];
  return value === undefined ? undefined : value === "true";
}

function readIntEnv(env: Env, key: string): number | undefined {
  const value = env[key];
  return value === undefined ? undefined : parseInt(value, 10);
}

function readFloatEnv(env: Env, key: string): number | undefined {
  const value = env[key];
  return value === undefined ? undefined : parseFloat(value);
}

function readStringListEnv(env: Env, key: string): string[] | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  return value
    .split(/[,\n]/)
    .map((item: string) => item.trim())
    .filter((item: string) => item.length > 0);
}



function normalizeModels(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_model: user.models.default,
    nautilo_session_search_model: user.models.sessionSearch,
    nautilo_conductor_model: user.models.conductor,
    nautilo_flush_model: user.models.flush,
    nautilo_reviewer_model: user.models.reviewer,
    nautilo_web_search_model: user.models.webSearch,
    nautilo_embedding_model: user.models.embedding.model,
    nautilo_embedding_dims: user.models.embedding.dimensions,
    nautilo_vision_fallback_model: user.models.visionFallback ?? "",
    nautilo_vision_fallback_candidates: user.models.visionFallbackCandidates ?? "",
    nautilo_text_only_image_policy: user.models.textOnlyImagePolicy ?? "unsupported",
  };
}

function normalizeHistory(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_history_validation_enabled: user.history.validationEnabled,
    nautilo_history_pruning_enabled: user.history.pruningEnabled,
    nautilo_token_budget_fraction: user.history.tokenBudgetFraction,
    nautilo_window_keep_recent: user.history.windowKeepRecent,
  };
}

function normalizeMemory(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_memory_brief_char_limit: user.memory.briefCharLimit,
    nautilo_memory_search_limit: user.memory.searchLimit,
    nautilo_session_search_limit: user.memory.sessionSearchLimit,
    nautilo_memory_dedup_similarity_threshold: user.memory.dedupSimilarityThreshold,
    nautilo_exit_flush_enabled: user.memory.exitFlushEnabled,
    nautilo_flush_min_turns: user.memory.flushMinTurns,
    nautilo_nudge_threshold: user.memory.nudgeThreshold,
    nautilo_reviewer_enabled: user.memory.reviewerEnabled,
    nautilo_reviewer_max_iterations: user.memory.reviewerMaxIterations,
  };
}

function normalizeResearch(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_research_first_progress_timeout_ms: user.research.auditFirstProgressTimeoutMs,
    nautilo_search_provider: user.research.searchProvider,
    nautilo_search_max_results: user.research.searchMaxResults,
    nautilo_search_depth: user.research.searchDepth,
    nautilo_search_read_page_count: user.research.searchReadPageCount,
    nautilo_read_webpage_timeout_ms: user.research.readWebpageTimeoutMs,
    nautilo_read_webpage_max_content_length: user.research.readWebpageMaxContentLength,
    nautilo_search_exclude_domains: user.research.searchExcludeDomains,
    nautilo_search_trusted_domains: user.research.searchTrustedDomains,
    nautilo_search_quality_mode: user.research.searchQualityMode,
  };
}

function normalizeSession(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_session_auto_resume: user.session.autoResume,
    nautilo_session_state_file: user.session.stateFile,
  };
}

function normalizeHome(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_home_root_dir: user.home.rootDir,
    nautilo_home_workspace_dir: user.home.workspaceDir,
    nautilo_home_research_dir: user.home.researchDir,
    nautilo_home_notes_dir: user.home.notesDir,
    nautilo_home_exports_dir: user.home.exportsDir,
    nautilo_home_logs_dir: user.home.logsDir,
    nautilo_home_transcripts_dir: user.home.transcriptsDir,
  };
}

function normalizeStorage(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_scratch_dir: user.storage.scratchDir,
    nautilo_data_dir: user.storage.dataDir,
    nautilo_db_data_dir: user.storage.dbDataDir,
    nautilo_embeddings_dir: user.storage.embeddingsDir,
    nautilo_voice_cache_dir: user.storage.voiceCacheDir,
    nautilo_audio_cache_dir: user.storage.audioCacheDir,
    nautilo_vault_dir: user.storage.vaultDir,
  };
}

function normalizeSoul(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_soul_char_limit: user.soul.charLimit,
    nautilo_soul_generator_model: user.soul.generatorModel,
    nautilo_soul_mother_easter_egg: user.soul.motherEasterEgg,
  };
}

function normalizeVoice(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_voice_enabled: user.voice.enabled,
    nautilo_voice_provider: user.voice.provider,
    nautilo_voice_name: user.voice.voiceName,
    nautilo_voice_speak_tool_summaries: user.voice.speakToolSummaries,
  };
}

function normalizeLogging(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_log_tool_calls: user.logging.toolCalls,
    nautilo_log_level: user.logging.level,
    nautilo_log_history_operations: user.logging.historyOperations,
  };
}

function normalizeTools(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_tool_activation_retention_turns: user.tools.activationRetentionTurns,
  };
}

function normalizeSecurity(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_security_level: user.security.level,
    nautilo_deployment_mode: user.security.deploymentMode,
    nautilo_network_policy: user.security.networkPolicy,
  };
}

function normalizeInstanceSurface(user: NautiloUserConfig): Record<string, unknown> {
  return {
    nautilo_instance_network: user.network,
    nautilo_instance_hostname: user.hostname,
  };
}

function readTextOnlyImagePolicyEnv(env: Env): "unsupported" | "vision_summary" | undefined {
  const raw = env["NAUTILO_TEXT_ONLY_IMAGE_POLICY"]?.trim().toLowerCase();
  if (raw === "vision_summary") return "vision_summary";
  if (raw === "unsupported") return "unsupported";
  return undefined;
}

function readModelsFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  // These are operator/runtime controls. `normalizeUserConfig` materializes
  // the model default and intervention limit even when a user config omits
  // them, so source-first precedence would silently suppress a dev-stack or
  // packaged operator environment opt-in (and an explicit empty model rollback).
  const browserDecisionModel = env["NAUTILO_BROWSER_DECISION_MODEL"];
  const browserDecisionInterventionLimit = env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
  return {
    nautilo_model: source?.nautilo_model ?? env["NAUTILO_MODEL"],
    nautilo_embedding_model: source?.nautilo_embedding_model ?? env["NAUTILO_EMBEDDING_MODEL"],
    nautilo_embedding_dims: source?.nautilo_embedding_dims ?? readIntEnv(env, "NAUTILO_EMBEDDING_DIMS"),
    nautilo_session_search_model: source?.nautilo_session_search_model ?? env["NAUTILO_SESSION_SEARCH_MODEL"],
    nautilo_conductor_model: source?.nautilo_conductor_model ?? env["NAUTILO_CONDUCTOR_MODEL"],
    nautilo_flush_model: source?.nautilo_flush_model ?? env["NAUTILO_FLUSH_MODEL"],
    nautilo_reviewer_model: source?.nautilo_reviewer_model ?? env["NAUTILO_REVIEWER_MODEL"],
    nautilo_web_search_model: source?.nautilo_web_search_model ?? env["NAUTILO_WEB_SEARCH_MODEL"],
    nautilo_browser_decision_model:
      browserDecisionModel !== undefined
        ? browserDecisionModel
        : source?.nautilo_browser_decision_model,
    nautilo_browser_decision_intervention_limit:
      browserDecisionInterventionLimit !== undefined
        ? Number(browserDecisionInterventionLimit)
        : source?.nautilo_browser_decision_intervention_limit,
    nautilo_vision_fallback_model:
      source?.nautilo_vision_fallback_model ?? env["NAUTILO_VISION_FALLBACK_MODEL"] ?? "",
    nautilo_vision_fallback_candidates:
      source?.nautilo_vision_fallback_candidates ?? env["NAUTILO_VISION_FALLBACK_CANDIDATES"] ?? "",
    nautilo_text_only_image_policy:
      source?.nautilo_text_only_image_policy ?? readTextOnlyImagePolicyEnv(env),
  };
}

function readHistoryFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  return {
    nautilo_history_validation_enabled:
      source?.nautilo_history_validation_enabled ?? readBooleanEnv(env, "NAUTILO_HISTORY_VALIDATION_ENABLED"),
    nautilo_history_pruning_enabled:
      source?.nautilo_history_pruning_enabled ?? readBooleanEnv(env, "NAUTILO_HISTORY_PRUNING_ENABLED"),
    nautilo_token_budget_fraction:
      source?.nautilo_token_budget_fraction ?? readFloatEnv(env, "NAUTILO_TOKEN_BUDGET_FRACTION"),
    nautilo_window_keep_recent:
      source?.nautilo_window_keep_recent ?? readIntEnv(env, "NAUTILO_WINDOW_KEEP_RECENT"),
  };
}

function readMemoryFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  return {
    nautilo_memory_brief_char_limit:
      source?.nautilo_memory_brief_char_limit ?? readIntEnv(env, "NAUTILO_MEMORY_BRIEF_CHAR_LIMIT"),
    nautilo_memory_search_limit:
      source?.nautilo_memory_search_limit ?? readIntEnv(env, "NAUTILO_MEMORY_SEARCH_LIMIT"),
    nautilo_session_search_limit:
      source?.nautilo_session_search_limit ?? readIntEnv(env, "NAUTILO_SESSION_SEARCH_LIMIT"),
    nautilo_memory_dedup_similarity_threshold:
      source?.nautilo_memory_dedup_similarity_threshold ?? readFloatEnv(env, "NAUTILO_MEMORY_DEDUP_SIMILARITY_THRESHOLD"),
    nautilo_exit_flush_enabled:
      source?.nautilo_exit_flush_enabled ?? readBooleanEnv(env, "NAUTILO_EXIT_FLUSH_ENABLED"),
    nautilo_flush_min_turns:
      source?.nautilo_flush_min_turns ?? readIntEnv(env, "NAUTILO_FLUSH_MIN_TURNS"),
    nautilo_nudge_threshold:
      source?.nautilo_nudge_threshold ?? readIntEnv(env, "NAUTILO_NUDGE_THRESHOLD"),
    nautilo_reviewer_enabled:
      source?.nautilo_reviewer_enabled ?? readBooleanEnv(env, "NAUTILO_REVIEWER_ENABLED"),
    nautilo_reviewer_max_iterations:
      source?.nautilo_reviewer_max_iterations ?? readIntEnv(env, "NAUTILO_REVIEWER_MAX_ITERATIONS"),
  };
}

function readResearchFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  return {
    // Instance policy can override a materialized sectioned-config default.
    nautilo_research_first_progress_timeout_ms:
      readIntEnv(env, "NAUTILO_RESEARCH_FIRST_PROGRESS_TIMEOUT_MS") ?? source?.nautilo_research_first_progress_timeout_ms,
    // The Settings provider card persists this field in canonical instance.env.
    // normalizeUserConfig materializes a default into runtimeOverrides at boot,
    // so source-first precedence would make every saved provider choice inert.
    nautilo_search_provider: env["NAUTILO_SEARCH_PROVIDER"] ?? source?.nautilo_search_provider,
    nautilo_search_max_results:
      source?.nautilo_search_max_results ?? readIntEnv(env, "NAUTILO_SEARCH_MAX_RESULTS"),
    nautilo_search_depth: source?.nautilo_search_depth ?? env["NAUTILO_SEARCH_DEPTH"],
    nautilo_search_read_page_count:
      source?.nautilo_search_read_page_count ?? readIntEnv(env, "NAUTILO_SEARCH_READ_PAGE_COUNT"),
    nautilo_read_webpage_timeout_ms:
      source?.nautilo_read_webpage_timeout_ms ?? readIntEnv(env, "NAUTILO_READ_WEBPAGE_TIMEOUT_MS"),
    nautilo_read_webpage_max_content_length:
      source?.nautilo_read_webpage_max_content_length ?? readIntEnv(env, "NAUTILO_READ_WEBPAGE_MAX_CONTENT_LENGTH"),
    nautilo_search_exclude_domains:
      source?.nautilo_search_exclude_domains ?? readStringListEnv(env, "NAUTILO_SEARCH_EXCLUDE_DOMAINS"),
    nautilo_search_trusted_domains:
      source?.nautilo_search_trusted_domains ?? readStringListEnv(env, "NAUTILO_SEARCH_TRUSTED_DOMAINS"),
    nautilo_search_quality_mode:
      source?.nautilo_search_quality_mode ?? env["NAUTILO_SEARCH_QUALITY_MODE"],
  };
}

function readSessionFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  return {
    nautilo_session_auto_resume:
      source?.nautilo_session_auto_resume ?? readBooleanEnv(env, "NAUTILO_SESSION_AUTO_RESUME"),
    nautilo_session_state_file:
      source?.nautilo_session_state_file ?? env["NAUTILO_SESSION_STATE_FILE"],
  };
}

function readHomeFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  return {
    nautilo_home_root_dir: source?.nautilo_home_root_dir ?? env["NAUTILO_HOME_ROOT_DIR"],
    nautilo_home_workspace_dir: source?.nautilo_home_workspace_dir ?? env["NAUTILO_HOME_WORKSPACE_DIR"],
    nautilo_home_research_dir: source?.nautilo_home_research_dir ?? env["NAUTILO_HOME_RESEARCH_DIR"],
    nautilo_home_notes_dir: source?.nautilo_home_notes_dir ?? env["NAUTILO_HOME_NOTES_DIR"],
    nautilo_home_exports_dir: source?.nautilo_home_exports_dir ?? env["NAUTILO_HOME_EXPORTS_DIR"],
    nautilo_home_logs_dir: source?.nautilo_home_logs_dir ?? env["NAUTILO_HOME_LOGS_DIR"],
    nautilo_home_transcripts_dir: source?.nautilo_home_transcripts_dir ?? env["NAUTILO_HOME_TRANSCRIPTS_DIR"],
  };
}

function readStorageFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  return {
    nautilo_scratch_dir: source?.nautilo_scratch_dir ?? env["NAUTILO_SCRATCH_DIR"],
    nautilo_data_dir: source?.nautilo_data_dir ?? env["NAUTILO_DATA_DIR"],
    nautilo_db_data_dir: source?.nautilo_db_data_dir ?? env["NAUTILO_DB_DATA_DIR"],
    nautilo_embeddings_dir: source?.nautilo_embeddings_dir ?? env["NAUTILO_EMBEDDINGS_DIR"],
    nautilo_voice_cache_dir: source?.nautilo_voice_cache_dir ?? env["NAUTILO_VOICE_CACHE_DIR"],
    nautilo_audio_cache_dir: source?.nautilo_audio_cache_dir ?? env["NAUTILO_AUDIO_CACHE_DIR"],
    nautilo_vault_dir: source?.nautilo_vault_dir ?? env["NAUTILO_VAULT_DIR"],
  };
}

function readLoggingFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  return {
    nautilo_log_tool_calls:
      source?.nautilo_log_tool_calls ?? readBooleanEnv(env, "NAUTILO_LOG_TOOL_CALLS"),
    nautilo_log_level: source?.nautilo_log_level ?? env["NAUTILO_LOG_LEVEL"],
    nautilo_log_history_operations:
      source?.nautilo_log_history_operations ?? readBooleanEnv(env, "NAUTILO_LOG_HISTORY_OPERATIONS"),
  };
}

function readSoulFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  return {
    nautilo_soul_char_limit:
      source?.nautilo_soul_char_limit ?? readIntEnv(env, "NAUTILO_SOUL_CHAR_LIMIT"),
    nautilo_soul_generator_model:
      source?.nautilo_soul_generator_model ?? env["NAUTILO_SOUL_GENERATOR_MODEL"] ?? null,
    nautilo_soul_mother_easter_egg:
      source?.nautilo_soul_mother_easter_egg ?? readBooleanEnv(env, "NAUTILO_SOUL_MOTHER_EASTER_EGG"),
  };
}

function readVoiceFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  return {
    nautilo_voice_enabled:
      source?.nautilo_voice_enabled ?? readBooleanEnv(env, "NAUTILO_VOICE_ENABLED"),
    nautilo_voice_provider: source?.nautilo_voice_provider ?? env["NAUTILO_VOICE_PROVIDER"],
    nautilo_voice_name: source?.nautilo_voice_name ?? env["NAUTILO_VOICE_NAME"] ?? null,
    nautilo_voice_speak_tool_summaries:
      source?.nautilo_voice_speak_tool_summaries ?? readBooleanEnv(env, "NAUTILO_VOICE_SPEAK_TOOL_SUMMARIES"),
  };
}

/**
 * Parse the user-facing sectioned config into the flat runtime shape.
 */
export function normalizeUserConfig(input: unknown): NautiloConfig {
  const user = NautiloUserConfigSchema.parse(input);

  return NautiloConfigSchema.parse({
    ...normalizeModels(user),
    ...normalizeHistory(user),
    ...normalizeMemory(user),
    ...normalizeResearch(user),
    ...normalizeSession(user),
    ...normalizeHome(user),
    ...normalizeStorage(user),
    ...normalizeSoul(user),
    ...normalizeVoice(user),
    ...normalizeLogging(user),
    ...normalizeTools(user),
    ...normalizeSecurity(user),
    ...normalizeInstanceSurface(user),
  });
}

function readSecurityFromEnv(source: RuntimeSource, _env: Env): Record<string, unknown> {
  // Sprint 1 (security ship plan v3, G5.3/G5.6): BOTH
  // `nautilo_security_level` AND `nautilo_deployment_mode` are
  // server-enforced policy fields — no env-var fallback. They come
  // from the sectioned `security` block in nautilo.config.ts, which
  // the Settings UI mutates (requires `manage_server_security`
  // Capability, landing in G5.5). Unset → Zod schema defaults pick
  // desktop-permissive + standard, which is the Electron-first-boot
  // shape. Headless/server installs ship an explicit deployment_mode
  // in their seeded config.
  return {
    nautilo_security_level: source?.nautilo_security_level,
    nautilo_deployment_mode: source?.nautilo_deployment_mode,
    nautilo_network_policy: source?.nautilo_network_policy,
  };
}

function readBackupFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  return {
    nautilo_backup_per_file_cap:
      source?.nautilo_backup_per_file_cap ??
      readIntEnv(env, "NAUTILO_BACKUP_PER_FILE_CAP"),
    nautilo_backup_total_size_cap_mb:
      source?.nautilo_backup_total_size_cap_mb ??
      readIntEnv(env, "NAUTILO_BACKUP_TOTAL_SIZE_CAP_MB"),
    nautilo_backup_gc_interval_ms:
      source?.nautilo_backup_gc_interval_ms ??
      readIntEnv(env, "NAUTILO_BACKUP_GC_INTERVAL_MS"),
  };
}

function readDispatchFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  // env wins over source because `normalizeUserConfig` runs
  // the full `NautiloConfigSchema.parse`, which materialises zod
  // defaults (`false` for this flag) even when the user's
  // `nautilo.config.ts` doesn't declare a `dispatch` section. With
  // the usual `source ?? env` pattern the env var would never take
  // effect for a boolean default. For a feature-flag field like
  // this one the env-first precedence is the ergonomic choice —
  // `export NAUTILO_DIRECT_DISPATCH=true` needs to Just Work for
  // ops / local-dev flips without requiring a user-config edit.
  // TODO(cleanup): extract a `normalizeUserConfig.parse(partial)`
  // seam so runtime-only fields don't leak into `runtimeOverrides`,
  // then switch this back to the standard source-first pattern.
  const envVal = readBooleanEnv(env, "NAUTILO_DIRECT_DISPATCH");
  return {
    nautilo_direct_dispatch:
      envVal !== undefined ? envVal : source?.nautilo_direct_dispatch,
  };
}

function readOfficeFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  // Env-first, same rationale as `nautilo_direct_dispatch`: dev-stack can
  // enable the dark feature for this process without editing nautilo.config.ts.
  const envVal = readBooleanEnv(env, "NAUTILO_OFFICE_ENABLED");
  return {
    nautilo_office_enabled:
      envVal !== undefined ? envVal : source?.nautilo_office_enabled,
  };
}

function readToolExposureFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  // This is deliberately env-first: an operator needs a temporary rollback
  // without rewriting persisted runtime config that may already materialize
  // the progressive default.
  return {
    nautilo_tool_exposure_mode:
      env["NAUTILO_TOOL_EXPOSURE_MODE"] ?? source?.nautilo_tool_exposure_mode,
    // Persisted config only: retention values must pass the user-config schema.
    nautilo_tool_activation_retention_turns:
      source?.nautilo_tool_activation_retention_turns,
  };
}

function readConnectedAppsFromEnv(source: RuntimeSource, env: Env): Record<string, unknown> {
  // Dev stacks and packaged operators must be able to bind Nautilo to the
  // exact OpenConnector process they started. `normalizeUserConfig`
  // materializes schema defaults, so source-first precedence would silently
  // turn an omitted user setting into port 3000 and ignore the explicit
  // process environment.
  return {
    nautilo_openconnector_base_url:
      env["NAUTILO_OPENCONNECTOR_BASE_URL"] ?? source?.nautilo_openconnector_base_url,
  };
}

/**
 * Set process-local runtime overrides. Used by clients after loading
 * `nautilo.config.ts`, and by tests that need temporary config changes.
 */
export function setConfigOverrides(overrides: NautiloConfigOverrides): void {
  runtimeOverrides =
    Object.keys(overrides).length === 0
      ? null
      : NautiloConfigOverridesSchema.parse(overrides);
  cachedConfig = null;
}

/** Invalidate the process-local projection after a canonical instance.env mutation. */
export function invalidateRuntimeConfigCache(): void {
  cachedConfig = null;
}

/**
 * Resolve the runtime config from:
 * 1. Explicit call-time overrides
 * 2. Previously registered runtime overrides
 * 3. Environment variables (NAUTILO_*)
 * 4. Schema defaults
 */
export function fromRuntimeConfig(runtime?: NautiloConfigOverrides): NautiloConfig {
  const source = runtime ?? runtimeOverrides;
  if (!source && cachedConfig) return cachedConfig;

  const env = process.env;
  const configObject = {
    ...readModelsFromEnv(source, env),
    ...readHistoryFromEnv(source, env),
    ...readMemoryFromEnv(source, env),
    ...readResearchFromEnv(source, env),
    ...readSessionFromEnv(source, env),
    ...readHomeFromEnv(source, env),
    ...readStorageFromEnv(source, env),
    ...readSoulFromEnv(source, env),
    ...readVoiceFromEnv(source, env),
    ...readLoggingFromEnv(source, env),
    ...readSecurityFromEnv(source, env),
    ...readBackupFromEnv(source, env),
    ...readDispatchFromEnv(source, env),
    ...readOfficeFromEnv(source, env),
    ...readToolExposureFromEnv(source, env),
    ...readConnectedAppsFromEnv(source, env),
    nautilo_instance_network: source?.nautilo_instance_network,
    nautilo_instance_hostname: source?.nautilo_instance_hostname,
  };

  const config = NautiloConfigSchema.parse(configObject);
  setLogLevel(config.nautilo_log_level as LogLevel);

  if (!source) cachedConfig = config;
  return config;
}

// ---------------------------------------------------------------------------
// Server posture — Sprint 1 G5.3
// ---------------------------------------------------------------------------

export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;
export type SecurityLevel = z.infer<typeof SecurityLevelSchema>;
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;
export type NetworkAllowRule = z.infer<typeof NetworkAllowRuleSchema>;
export type ToolExposureMode = z.infer<typeof ToolExposureModeSchema>;

/**
 * The resolved server security posture. This is the "what should the
 * sandbox do right now" bundle the Policy Resolver reads before
 * building an envelope for the relay (G5.4). Changing either field
 * via `PUT /api/security/posture` rewrites the sectioned config and
 * broadcasts `policy.changed`; the resolver then re-reads via
 * `resolveServerPosture` on the next turn.
 */
export interface ServerPosture {
  readonly deploymentMode: DeploymentMode;
  readonly securityLevel: SecurityLevel;
  readonly networkPolicy?: NetworkPolicy;
}

export function defaultNetworkPolicyForDeploymentMode(
  mode: DeploymentMode,
): NetworkPolicy {
  if (mode === "desktop-permissive") return { mode: "host" };
  return { mode: "isolated" };
}

/**
 * Read the current server posture from the resolved runtime config.
 * Convenience wrapper around `fromRuntimeConfig` that exposes only
 * the security slice — callers that don't need the rest of the flat
 * runtime shape (server API handlers, audit-log writers, Policy
 * Resolver) avoid touching `nautilo_*` key names.
 */
export function resolveServerPosture(): ServerPosture {
  const config = fromRuntimeConfig();
  return {
    deploymentMode: config.nautilo_deployment_mode,
    securityLevel: config.nautilo_security_level,
    networkPolicy:
      config.nautilo_network_policy ??
      defaultNetworkPolicyForDeploymentMode(config.nautilo_deployment_mode),
  };
}
