/**
 * @nautilo/mcp-client — SEC1 secret scrubbing for the MCP host's OWN logs and
 * error strings.
 *
 * Deliberately LOCAL (not a `@nautilo/vault` dependency): this package is
 * destined for the compiled relay binary (D213) and must stay lean — it must
 * not drag vault's native deps (argon2, etc.). The patterns mirror the
 * high-signal subset of `@nautilo/vault`'s leak-scanner (the canonical
 * redactor). Tool *results* are already scrubbed server-side by the canonical
 * `scanToolResult` pipeline (`@nautilo/security` → vault `redactSecrets`); this
 * util only guards host log/error message strings so a token echoed by an SDK
 * error or a URL never lands in a log line.
 *
 * If the canonical patterns change materially, reconcile here.
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  // Authorization: Bearer/Basic <token>
  /\bAuthorization:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Bare Bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // OpenAI / Anthropic style keys
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g,
  // GitHub tokens (ghp_/gho_/ghs_/ghr_/ghu_)
  /\bgh[posru]_[A-Za-z0-9]{16,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

/** Replace recognized secret shapes in a free-text string with `[redacted]`. */
export function redactSecretsInText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

/** Redact secrets from an error/thrown value's message for safe logging. */
export function redactError(e: unknown): string {
  return redactSecretsInText(e instanceof Error ? e.message : String(e));
}
