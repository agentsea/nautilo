import {
  createDnsResolver,
  isPublicRoutableAddress,
  type DnsResolver,
} from "@nautilo/sandbox";
import { isIP } from "node:net";

const MAX_RESEARCH_URL_LENGTH = 8_192;
const MAX_VALIDATED_NAVIGATION_HOSTS = 128;

export type BrowserResearchUrlPurpose = "navigation" | "subresource";

export interface BrowserResearchUrlPolicy {
  assertAllowed(rawUrl: string, purpose?: BrowserResearchUrlPurpose): Promise<URL>;
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/g, "").toLowerCase();
}

export function parseResearchHttpUrl(rawUrl: string): URL {
  if (rawUrl.length > MAX_RESEARCH_URL_LENGTH) {
    throw new Error("Research browser URL is too long");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Research browser requires an absolute HTTP or HTTPS URL");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new Error("Research browser requires a non-credentialed HTTP or HTTPS URL");
  }
  const hostname = normalizedHostname(url);
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || (!hostname.includes(".") && isIP(hostname) === 0)
  ) {
    throw new Error("Research browser requires a public Internet host");
  }
  return url;
}

export function createBrowserResearchUrlPolicy(
  resolver: DnsResolver = createDnsResolver({ ttlMs: 30_000 }),
): BrowserResearchUrlPolicy {
  // Bound document navigation/redirect fan-out, which determines the page the
  // agent is allowed to read. Do not charge every ad, pixel, iframe, or other
  // public subresource to that document budget: a normal rendered page can
  // easily exceed it, and cancelling those requests must not turn an otherwise
  // valid empty response into a fake Desktop transport loss.
  const validatedNavigationHosts = new Set<string>();
  return {
    async assertAllowed(rawUrl: string, purpose: BrowserResearchUrlPurpose = "navigation"): Promise<URL> {
      const url = parseResearchHttpUrl(rawUrl);
      const hostname = normalizedHostname(url);
      const countsAgainstNavigationBudget = purpose === "navigation";
      if (!validatedNavigationHosts.has(hostname)) {
        if (countsAgainstNavigationBudget && validatedNavigationHosts.size >= MAX_VALIDATED_NAVIGATION_HOSTS) {
          throw new Error("Research browser page contacted too many hosts");
        }
        const addresses = await resolver.resolve(hostname);
        if (addresses.length === 0 || addresses.some((address) => !isPublicRoutableAddress(address))) {
          throw new Error("Research browser blocked a non-public network destination");
        }
        if (countsAgainstNavigationBudget) validatedNavigationHosts.add(hostname);
      }
      return url;
    },
  };
}
