import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

import { normalizeHost } from "./allowlist";

export type DnsLookupFn = (host: string) => Promise<readonly string[]>;

export interface DnsResolverOptions {
  readonly ttlMs?: number;
  readonly lookup?: DnsLookupFn;
  readonly now?: () => number;
}

export interface DnsResolver {
  resolve(host: string): Promise<readonly string[]>;
  clear(): void;
}

export class DnsResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsResolutionError";
  }
}

const DEFAULT_DNS_TTL_MS = 60_000;

export function createDnsResolver(opts: DnsResolverOptions = {}): DnsResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_DNS_TTL_MS;
  const lookup = opts.lookup ?? defaultLookup;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { readonly expiresAt: number; readonly addresses: readonly string[] }>();

  return {
    async resolve(inputHost: string): Promise<readonly string[]> {
      const host = normalizeHost(inputHost);
      if (host === null) {
        throw new DnsResolutionError(`invalid host: ${inputHost}`);
      }
      if (isStrictIpLiteral(host)) {
        return [ipaddr.parse(host).toString()];
      }

      const cached = cache.get(host);
      const t = now();
      if (cached !== undefined && cached.expiresAt > t) {
        return cached.addresses;
      }

      const addresses = uniqueAddresses(await lookup(host));
      if (addresses.length === 0) {
        throw new DnsResolutionError(`no DNS records for ${host}`);
      }
      cache.set(host, { expiresAt: t + ttlMs, addresses });
      return addresses;
    },
    clear(): void {
      cache.clear();
    },
  };
}

async function defaultLookup(host: string): Promise<readonly string[]> {
  const records = await dnsLookup(host, { all: true, verbatim: false });
  return records.map((r) => r.address);
}

function uniqueAddresses(input: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of input) {
    if (isStrictIpLiteral(raw)) out.add(ipaddr.parse(raw).toString());
  }
  return [...out];
}

function isStrictIpLiteral(host: string): boolean {
  return ipaddr.IPv4.isValidFourPartDecimal(host) || ipaddr.IPv6.isValid(host);
}
