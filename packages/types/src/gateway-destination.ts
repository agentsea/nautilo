export const GATEWAY_BASE_URL_ENV = "NAUTILO_GATEWAY_BASE_URL";

/**
 * The OpenAI-compatible gateway base URL the runtime sends requests to: a
 * trimmed http(s) URL without trailing slashes.
 */
export function normalizeGatewayBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const baseUrl = value.trim();
  if (baseUrl.length === 0) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return baseUrl.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/**
 * The destination a gateway bearer key may be checked against or bound to:
 * the normalized base URL, refused when it embeds credentials, a query, or a
 * fragment, so a key is only ever sent to a plain base path.
 */
export function gatewayKeyDestination(value: unknown): string | null {
  const normalized = normalizeGatewayBaseUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  if (url.username || url.password || url.search || url.hash) return null;
  return normalized;
}
