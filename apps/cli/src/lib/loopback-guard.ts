/**
 * Loopback-only guard for `nautilo setup` (D115 — IPv4 + IPv6 + localhost).
 * Unix domain HTTP sockets are allowed as non-TCP operator deployments.
 */
export function requireLoopback(serverUrl: string): void {
  const raw = serverUrl.trim();
  if (raw.startsWith("/")) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid server URL: ${serverUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  const ok =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";
  if (!ok) {
    throw new Error(
      `nautilo setup requires a loopback server URL (127.0.0.1, ::1, localhost, or a unix socket path); got host=${parsed.hostname}`,
    );
  }
}
