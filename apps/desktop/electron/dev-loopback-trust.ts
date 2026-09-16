import { isLoopbackHostname } from "@nautilo/config/loopback-origin";

export function shouldTrustExplicitDevLoopbackServer(input: {
  readonly isPackaged: boolean;
  readonly explicitServerUrl: string | undefined;
  readonly resolvedServerUrl: string;
}): boolean {
  if (input.isPackaged || !input.explicitServerUrl?.trim()) return false;
  try {
    const explicit = new URL(input.explicitServerUrl);
    const resolved = new URL(input.resolvedServerUrl);
    return (
      isLoopbackHostname(explicit.hostname) &&
      isLoopbackHostname(resolved.hostname) &&
      explicit.origin === resolved.origin
    );
  } catch {
    return false;
  }
}
