export const MANAGED_GATEWAY_API_KEY_ENV_VAR = "NAUTILO_MANAGED_GATEWAY_API_KEY";
export const MANAGED_GATEWAY_BASE_URL_ENV_VAR = "NAUTILO_MANAGED_GATEWAY_BASE_URL";

function localhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "127.0.0.1"
    || normalized === "[::1]"
    || normalized === "::1";
}

export function isManagedGatewayKey(value: unknown): boolean {
  return typeof value === "string" && /^ngw_[A-Za-z0-9_-]{43}$/.test(value);
}

/** Production Gateway origins require HTTPS; explicit loopback QA may use HTTP. */
export function normalizeManagedGatewayBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost(url.hostname))) {
      return null;
    }
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.endsWith("/v1")) return null;
    url.pathname = path;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function managedGatewayKeyUrl(value: unknown): string | null {
  const baseUrl = normalizeManagedGatewayBaseUrl(value);
  return baseUrl ? `${baseUrl}/key` : null;
}
