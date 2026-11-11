export const MINDSWAPPER_API_KEY = "MINDSWAPPER_API_KEY";
export const MINDSWAPPER_BASE_URL = "MINDSWAPPER_BASE_URL";
export const MINDSWAPPER_APPROVED_BASE_URLS = "MINDSWAPPER_APPROVED_BASE_URLS";
type Environment = Readonly<Record<string, string | undefined>>;

/** Canonical API root. The caller appends a fixed operation to the /v1 path. */
export function normalizeMindSwapperBaseUrl(
  value: string | null | undefined,
  env: Environment = process.env,
): string | null {
  const input = value?.trim();
  if (!input || /[\\\s,?#]/.test(input) || !/^https?:\/\//i.test(input)) return null;
  try {
    const url = new URL(input);
    const localTest = env["NAUTILO_TEST_MODE"] === "1" && url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!localTest && url.protocol !== "https:") || url.username || url.password) return null;
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.endsWith("/v1") || !/^\/[a-zA-Z0-9._~/-]+$/.test(path)) return null;
    return url.origin + path;
  } catch {
    return null;
  }
}

export function getApprovedMindSwapperDestinations(env: Environment = process.env): string[] {
  const values = env[MINDSWAPPER_APPROVED_BASE_URLS]?.split(",") ?? [];
  return [...new Set(values.flatMap((value) => {
    const url = normalizeMindSwapperBaseUrl(value, env);
    return url ? [url] : [];
  }))];
}

export function isApprovedMindSwapperDestination(
  value: string | null | undefined,
  env: Environment = process.env,
): boolean {
  const normalized = normalizeMindSwapperBaseUrl(value, env);
  return normalized !== null && getApprovedMindSwapperDestinations(env).includes(normalized);
}
