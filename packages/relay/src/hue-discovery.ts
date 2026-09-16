import type { OpenHueExecutor } from "./hue";

export interface HueBridgeCandidate {
  /** A stable mDNS name survives DHCP changes; OpenHue accepts it as --bridge. */
  readonly bridge: string;
  readonly bridgeId: string;
}

/** Parse complete Hue SRV/TXT pairs, never executable arguments from service names. */
export function parseHueDnsSdZone(output: string): HueBridgeCandidate[] {
  const hosts = new Map<string, string>();
  const ids = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const srv = /^(\S+\._hue\._tcp)\s+SRV\s+\d+\s+\d+\s+443\s+([a-z\d](?:[a-z\d-]*[a-z\d])?\.local)\./i.exec(line);
    if (srv) hosts.set(srv[1]!.toLowerCase(), srv[2]!.toLowerCase());
    const txt = /^(\S+\._hue\._tcp)\s+TXT\s+.*"bridgeid=([a-f\d]{16})"/i.exec(line);
    if (txt) ids.set(txt[1]!.toLowerCase(), txt[2]!.toUpperCase());
  }
  const candidates = new Map<string, HueBridgeCandidate>();
  for (const [service, bridge] of hosts) {
    const bridgeId = ids.get(service);
    if (bridgeId) candidates.set(`${bridgeId}:${bridge}`, { bridge, bridgeId });
  }
  return [...candidates.values()];
}

/**
 * OpenHue 0.24 browses for two seconds using a separate multicast stack. macOS's
 * resolver can see bridges that stack misses. Use its fixed, local-only browse
 * command, collecting all complete records within the same discovery window.
 * The executor terminates and reaps dns-sd at the deadline; its partial stdout
 * contains complete records already discovered. This is a retryable observation,
 * not an exhaustive inventory of every bridge that could appear on the network.
 */
export async function discoverMacHueBridges(options: {
  executor: OpenHueExecutor;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  browseWindowMs?: number | undefined;
  platform: NodeJS.Platform;
}): Promise<HueBridgeCandidate[]> {
  const timeoutMs = Math.min(options.timeoutMs, options.browseWindowMs ?? 2_000);
  if (options.platform !== "darwin" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return [];
  const result = await options.executor.execute("/usr/bin/dns-sd", ["-Z", "_hue._tcp", "local."], {
    env: options.env,
    timeoutMs,
  });
  // dns-sd is a continuous browser, so termination at the observation deadline
  // is expected. Invalid/incomplete records never become candidates.
  return parseHueDnsSdZone(result.stdout);
}
