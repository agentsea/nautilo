import { checkKeysHealth } from "./health-checker";
import { computeHasLlmFromKeys } from "./compute-has-llm";
import { firstDoctorHint, getAllKeyDefinitions, maskValue } from "./key-registry";
import { MODE_REGISTRY } from "./mode-registry";
import { parseCheckInput } from "./schemas";
import { isCloudMode } from "@nautilo/config";
import type {
  CheckResult,
  CheckSummary,
  KeyReport,
  KeyStatus,
  ModeReport,
  ModeReportEntry,
} from "./types";

export type {
  AuditActor,
  AuditEntry,
  AuditOperationType,
  CheckInput,
  CheckResult,
  CheckSummary,
  ConfigGuardErrorKind,
  ConfigOperation,
  KeyDefinition,
  KeyReport,
  KeyStatus,
  ModeReport,
  ModeReportEntry,
  SnapshotMeta,
  TransactionActor,
  TransactionDetail,
  TransactionInput,
  TransactionResult,
} from "./types";
export { ConfigGuardError } from "./types";

export {
  getAllKeyDefinitions,
  getKeyByEnvVar,
  getKeyDefinition,
  BROWSER_USE_API_KEY_ENV_VAR,
  KEY_REGISTRY,
  maskValue,
} from "./key-registry";

export {
  classifyForbiddenInInstanceEnv,
  FORBIDDEN_IN_INSTANCE_ENV_EXACT,
  FORBIDDEN_IN_INSTANCE_ENV_PREFIXES,
  getModeById,
  getModeByEnvVar,
  isForbiddenInInstanceEnv,
  LOGTO_REQUIRED_KEYS,
  MODE_REGISTRY,
} from "./mode-registry";
export type { ForbiddenInstanceEnvReason } from "./mode-registry";
export type { ModeDefinition } from "./mode-registry";
export { assertLogtoConfigComplete, crossKeyInvariants } from "./validator";

export { readAuditLog, appendAuditEntry, appendAuditEntrySync } from "./audit-log";
export {
  createSnapshot,
  listSnapshots,
  readSnapshotEnv,
  updateSnapshotMeta,
  pruneSnapshots,
} from "./snapshot-store";
export { checkProviderHealth, checkServerHealth, checkKeysHealth } from "./health-checker";
export {
  buildConnectionAuditPlan,
  type BuildConnectionAuditPlanInput,
} from "./connection-audit";
export type {
  ConnectionAuditFinding,
  ConnectionAuditFindingKind,
} from "@nautilo/types";
export type {
  ConnectionAuditPlan,
} from "./types";
export { validateOperations } from "./validator";
export {
  CheckInputSchema,
  ConfigOperationSchema,
  parseCheckInput,
  parseTransactionInput,
  TransactionInputSchema,
} from "./schemas";
export { transaction, resetConfigGuardRateLimitForTests } from "./transaction";
export {
  CLOUD_MANAGED_PROVIDER_KEYS,
  isCloudManagedDeployment,
  isCloudManagedProviderKey,
} from "./managed-provider-keys";

export function isConfigWritable(): boolean {
  // The generic config surface remains closed in cloud. transaction() owns a
  // narrower exception for registered provider-key sets only.
  return !isCloudMode();
}
export { isLocalhostIp } from "./localhost-guard";
export { computeHasLlmFromKeys } from "./compute-has-llm";
export {
  migrateConfigEnvToInstanceEnv,
  resolveAuditLogPath,
  resolveDotenvPath,
  resolveHealthCheckUrl,
  resolveSnapshotDir,
  stripForbiddenKeysFromInstanceEnv,
  stripRetiredIdentityEnvVars,
} from "./paths";
export {
  migrateSetupTomlToDeployToml,
  type MigrateSetupTomlStatus,
  type MigrateSetupTomlToDeployTomlResult,
} from "./setup-toml-migration";
export {
  parseEnvFile,
  serializeEnvFile,
  getValueFromEntries,
  setValueInEntries,
  removeKeyFromEntries,
} from "./env-parser";
export {
  writeFileAtomic,
  reloadEnvAndStripRemovedRegistryKeys,
  reloadEnvOverlay,
  subscribeEnvReload,
} from "./env-writer";
export {
  GOOGLE_OAUTH_CLIENT_JSON_ENV,
  decodeGoogleOAuthClientJsonFromEnv,
  encodeGoogleOAuthClientJsonForEnv,
  maskGoogleOAuthClientId,
  validateGoogleOAuthClientJsonBase64Env,
  validateGoogleOAuthClientJsonText,
} from "./google-oauth-client-json";
export type {
  GoogleOAuthClientJsonValidationFailure,
  GoogleOAuthClientJsonValidationResult,
  GoogleOAuthClientJsonValidationSuccess,
} from "./google-oauth-client-json";

function buildSummary(keys: KeyReport[]): CheckSummary {
  let configured = 0;
  let verified = 0;
  let missing = 0;
  let invalid = 0;
  for (const k of keys) {
    if (k.status === "missing") {
      missing += 1;
    } else {
      configured += 1;
    }
    if (k.status === "verified") {
      verified += 1;
    }
    if (k.status === "invalid_format" || k.status === "invalid_key") {
      invalid += 1;
    }
  }

  const ok = (id: string) => {
    const r = keys.find((x) => x.id === id);
    return r?.status === "verified" || r?.status === "present";
  };

  const hasLlm = computeHasLlmFromKeys(keys);
  const hasEmbeddings = ok("openai") || ok("openrouter") || ok("venice");
  const hasVoice = ok("elevenlabs");
  const hasSearch = ok("tavily");
  const hasConversion = ok("cloudconvert");

  return {
    total: keys.length,
    configured,
    verified,
    missing,
    invalid,
    hasLlm,
    hasEmbeddings,
    hasVoice,
    hasSearch,
    hasConversion,
  };
}

export async function check(input?: unknown): Promise<CheckResult> {
  const { validate } = parseCheckInput(input);
  const validateKeys = validate ?? false;
  const env = process.env;
  const keys: KeyReport[] = [];

  for (const def of getAllKeyDefinitions()) {
    const raw = env[def.envVar];
    let status: KeyStatus;
    let hint: string | null = null;
    let masked: string | null = null;

    if (!raw?.trim()) {
      status = "missing";
    } else {
      const v = raw.trim();
      masked = maskValue(v);
      if (!def.formatCheck(v)) {
        status = "invalid_format";
        hint = firstDoctorHint(def, v);
      } else {
        status = "present";
      }
    }

    keys.push({
      id: def.id,
      name: def.name,
      envVar: def.envVar,
      category: def.category,
      purpose: def.purpose,
      required: def.required,
      signupUrl: def.signupUrl,
      formatHint: def.formatHint,
      status,
      masked,
      hint,
    });
  }

  if (validateKeys) {
    const health = await checkKeysHealth(
      env,
      getAllKeyDefinitions().map((k) => k.id),
    );
    for (const k of keys) {
      if (k.status !== "present") {
        continue;
      }
      const h = health[k.id];
      if (!h) {
        continue;
      }
      if (h.status === "verified") {
        k.status = "verified";
      } else if (h.status === "invalid_key") {
        k.status = "invalid_key";
        k.hint = h.detail ?? "Provider rejected the key";
      } else {
        k.status = "unreachable";
        k.hint = h.detail ?? "Provider unreachable";
      }
    }
  }

  return { keys, summary: buildSummary(keys) };
}

/**
 * M051: redaction-aware view of `MODE_REGISTRY` entries against the current
 * `process.env`. The single source for any UI / CLI surface that wants to
 * render the Logto / instance mode block without leaking the M2M secret. Never returns
 * raw `process.env`; entries with `redact: true` go through `maskValue`.
 *
 * `status: "missing"` if the env var is unset or whitespace-only;
 * `"set"` with `value` populated otherwise. The `value` field is what
 * displays in the UI — it has been masked when appropriate.
 */
export function getModeReport(
  env: NodeJS.ProcessEnv = process.env,
): ModeReport {
  const entries: ModeReportEntry[] = MODE_REGISTRY.map((def) => {
    const raw = env[def.envVar];
    if (!raw || raw.trim() === "") {
      return {
        id: def.id,
        envVar: def.envVar,
        description: def.description,
        deprecated: def.deprecated === true,
        status: "missing",
        value: null,
        redacted: Boolean(def.redact),
      };
    }
    const trimmed = raw.trim();
    return {
      id: def.id,
      envVar: def.envVar,
      description: def.description,
      deprecated: def.deprecated === true,
      status: "set",
      value: def.redact ? maskValue(trimmed) : trimmed,
      redacted: Boolean(def.redact),
    };
  });

  return { entries };
}
