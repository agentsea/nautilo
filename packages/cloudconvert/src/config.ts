/**
 * CloudConvert configuration from environment variables.
 *
 * Does not throw at import time — callers check `isCloudConvertConfigured()`
 * or handle errors from `convert()`.
 *
 * Environment variables:
 * - CLOUDCONVERT_API_KEY — API key (task.read + task.write scopes)
 * - CLOUDCONVERT_SANDBOX — "true" for sandbox API (no credit burn)
 * - CLOUDCONVERT_REGION — optional region pin ("us-east" | "eu-central")
 */

export interface CloudConvertConfig {
  apiKey: string;
  sandbox: boolean;
  region: string | null;
}

const VALID_REGIONS = new Set(["us-east", "eu-central"]);

/**
 * Defensive env-value cleanup. A hand-edited `instance.env` is NOT guaranteed
 * clean: config-guard validates writes, but a direct file edit bypasses it,
 * and the dotenv loader does not reliably strip inline `# comments`. So a line
 * like `CLOUDCONVERT_REGION=eu-central   # or us-east` can arrive as the literal
 * value `eu-central   # or us-east`, which then gets interpolated into the
 * CloudConvert region endpoint URL and breaks every request. Strip an inline
 * comment, surrounding quotes, and whitespace before use. (Pass
 * `stripComment: false` for opaque secrets like the API key, which must never
 * be mangled.)
 */
function cleanEnvValue(raw: string | undefined, opts?: { stripComment?: boolean }): string {
  if (!raw) return "";
  const stripComment = opts?.stripComment ?? true;
  const base = stripComment ? (raw.split("#")[0] ?? "") : raw;
  return base.trim().replace(/^["']|["']$/g, "").trim();
}

export function getCloudConvertConfig(): CloudConvertConfig {
  // API key is opaque — trim/unquote only, never comment-strip (a `#` could in
  // principle be part of a token; truncating it would silently break auth).
  const apiKey = cleanEnvValue(process.env["CLOUDCONVERT_API_KEY"], { stripComment: false });
  const sandbox = cleanEnvValue(process.env["CLOUDCONVERT_SANDBOX"]).toLowerCase() === "true";
  const region = cleanEnvValue(process.env["CLOUDCONVERT_REGION"]).toLowerCase();
  return {
    apiKey,
    sandbox,
    // Unknown / malformed region → null (SDK auto-selects nearest), never a
    // garbage value spliced into the endpoint URL.
    region: VALID_REGIONS.has(region) ? region : null,
  };
}

export function isCloudConvertConfigured(): boolean {
  return getCloudConvertConfig().apiKey.length > 0;
}

export interface ResolvedConvertConfig {
  apiKey: string;
  sandbox: boolean;
  region: string | undefined;
}

/**
 * Resolve runtime config, allowing per-call overrides for sandbox/region.
 */
export function resolveConvertConfig(opts?: {
  sandbox?: boolean;
  region?: string;
}): ResolvedConvertConfig {
  const env = getCloudConvertConfig();
  return {
    apiKey: env.apiKey,
    sandbox: opts?.sandbox ?? env.sandbox,
    region: opts?.region ?? env.region ?? undefined,
  };
}
