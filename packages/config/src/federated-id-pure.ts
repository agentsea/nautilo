/**
 * Browser-safe federated-id helpers — zero imports.
 *
 * Sub-path export `@nautilo/config/federated-id-pure` for consumers that
 * must not pull the main config barrel (which transitively imports
 * `@nautilo/logger` / Node-only modules).
 */

/**
 * Compose `@handle@server` from its two parts. Pure string op; validate
 * inputs upstream if needed.
 */
export function composeFederatedId(handle: string, server: string): string {
  return `@${handle}@${server}`;
}

/**
 * Parse a federated id back into its handle + server parts. Returns
 * `null` on malformed input. Requires the leading `@` to disambiguate
 * from plain email addresses (user@host) that might be carried over
 * from other channels' native external ids.
 *
 * Server must contain at least one dot (e.g. `nautilo.local`,
 * `nautilo.example.com`) so trivial malformed input like `@a@b` is
 * rejected.
 */
export function parseFederatedId(
  raw: string,
): { handle: string; server: string } | null {
  const m = /^@([a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?)@([a-z0-9.-]+)$/.exec(raw);
  if (!m) return null;
  const server = m[3]!;
  if (!server.includes(".")) return null;
  return { handle: m[1]!, server };
}
