import { isIP } from "node:net";
import { lookup as systemLookup } from "node:dns/promises";

export interface ConnectedWebAccountDnsLookup {
  (hostname: string, options: { readonly all: true; readonly verbatim: true }): Promise<readonly { readonly address: string; readonly family: number }[]>;
}

export interface ValidatedConnectedWebTarget {
  readonly origin: string;
  /** Preserves a Human-provided path/query for the first foreground landing. */
  readonly targetUrl: string;
}

export class ConnectedWebAccountTargetError extends Error {
  constructor() {
    super("invalid_target");
    this.name = "ConnectedWebAccountTargetError";
  }
}

const blockedHostnames = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "metadata.azure.internal",
]);

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result * 256) + octet;
  }
  return result;
}

function inV4Range(address: string, start: string, bits: number): boolean {
  const value = ipv4Number(address);
  const startValue = ipv4Number(start);
  if (value === null || startValue === null) return true;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (startValue & mask);
}

function isPublicIpv4(address: string): boolean {
  const reserved: ReadonlyArray<readonly [string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !reserved.some(([start, bits]) => inV4Range(address, start, bits));
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe8")
    || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")
    || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:")) return false;
  const mapped = /^::ffff:(.+)$/u.exec(normalized);
  if (!mapped) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(mapped[1]!)) return isPublicIpv4(mapped[1]!);
  const hexadecimal = mapped[1]!.split(":");
  if (hexadecimal.length !== 2 || !hexadecimal.every((part) => /^[0-9a-f]{1,4}$/u.test(part))) return false;
  const numeric = (Number.parseInt(hexadecimal[0]!, 16) * 0x10000) + Number.parseInt(hexadecimal[1]!, 16);
  return isPublicIpv4([24, 16, 8, 0].map((shift) => String((numeric >>> shift) & 255)).join("."));
}

export function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function allowedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return normalized.length > 0
    && !blockedHostnames.has(normalized)
    && !normalized.endsWith(".localhost")
    && !normalized.endsWith(".local")
    && !normalized.endsWith(".internal");
}

/**
 * Resolves the exact browser target before provider work starts. This is a
 * navigation guard, not a crawler: redirects are intentionally outside this
 * first-house contract and must be revalidated before a future server fetch.
 */
export async function validateConnectedWebTarget(
  raw: string,
  lookup: ConnectedWebAccountDnsLookup = systemLookup,
): Promise<ValidatedConnectedWebTarget> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConnectedWebAccountTargetError(); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !allowedHostname(url.hostname)) {
    throw new ConnectedWebAccountTargetError();
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const family = isIP(hostname);
  const addresses = family === 0
    ? await lookup(hostname, { all: true, verbatim: true })
    : [{ address: hostname, family }];
  if (addresses.length === 0 || addresses.some((entry) => !isPublicInternetAddress(entry.address))) {
    throw new ConnectedWebAccountTargetError();
  }
  return { origin: url.origin, targetUrl: url.toString() };
}
