import { isDeterministicallyLocalServerHost, normalizeServerUrl } from "./server-url";

export const IOS_LOCAL_NETWORK_RECOVERY_TITLE = "Can’t reach your local server?";
export const IOS_LOCAL_NETWORK_RECOVERY_MESSAGE =
  "Local Network access may be turned off for Nautilo. Open Settings, enable Local Network, then try again.";

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  return isDeterministicallyLocalServerHost(normalized) ||
    normalized.endsWith(".local") ||
    !normalized.includes(".");
}

export function isLocalNetworkServerUrl(rawUrl: string): boolean {
  const normalized = normalizeServerUrl(rawUrl);
  if (!normalized) return false;
  try {
    return isLocalHostname(new URL(normalized).hostname);
  } catch {
    return false;
  }
}

export function shouldOfferIosLocalNetworkRecovery(input: {
  platform: string;
  serverUrl: string;
  error: string | null;
}): boolean {
  if (input.platform !== "ios" || !input.error) return false;
  if (!isLocalNetworkServerUrl(input.serverUrl)) return false;
  return /unreachable|network|fetch failed|failed to fetch|timeout|couldn.t (?:connect|reach)/i.test(
    input.error,
  );
}
