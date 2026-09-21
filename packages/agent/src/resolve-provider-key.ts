type ProviderName = "openai" | "openrouter" | "anthropic" | "google" | "venice" | "typesafe";

interface TenantContext {
  tenantId?: string;
  ownerId?: string;
}

const ENV_BY_PROVIDER: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  venice: "VENICE_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
};

/**
 * Single indirection seam for provider-key resolution.
 * Today: reads `process.env`. Later (nautilo.cloud / per-tenant
 * Secret Manager): switches on `_ctx.tenantId` to look up the key
 * from a backend service. Call sites pass `_ctx` already so the
 * future migration adds zero call-site churn.
 *
 * Returns null when the env var is unset, empty, or whitespace-only
 * (callers consistently treat null as "no key configured" — same
 * semantics as `process.env[...] && process.env[...].trim()`).
 */
export function resolveProviderKey(
  provider: ProviderName,
  _ctx: TenantContext = {},
): string | null {
  const envVar = ENV_BY_PROVIDER[provider];
  const v = process.env[envVar];
  return v && v.trim() !== "" ? v : null;
}

export type { ProviderName, TenantContext };
