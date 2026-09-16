import type {
  SecurityScannerArtifact,
  SecurityScannerManifest,
  SecurityScannerPlatform,
} from "./contracts.ts";

const HEX = /^[a-f0-9]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const PLATFORM = new Set<SecurityScannerPlatform>(["darwin-arm64", "darwin-x64"]);
const safeRelativePath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 &&
  !value.startsWith("/") && !value.includes("\\") &&
  !value.split("/").some((part) => !part || part === "." || part === "..");
const exactKeys = (input: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key));
const secureUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash ? value : null;
  } catch { return null; }
};

/**
 * Parses a release-reviewed scanner manifest fail-closed.  This accepts no
 * convenience aliases, redirects, wildcard hosts, ambient PATH, or automatic
 * "latest" selector.  A release pipeline must provide every immutable byte
 * identity before an artifact can reach acquisition.
 */
export function validateSecurityScannerManifest(value: unknown): SecurityScannerManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ["schemaVersion", "allowedDownloadHosts", "allowedDownloadPrefixes", "artifacts"]) || root["schemaVersion"] !== 1 || !Array.isArray(root["allowedDownloadHosts"]) || !root["allowedDownloadPrefixes"] || typeof root["allowedDownloadPrefixes"] !== "object" || Array.isArray(root["allowedDownloadPrefixes"]) || !Array.isArray(root["artifacts"])) return null;
  const hosts = root["allowedDownloadHosts"];
  if (hosts.length === 0 || !hosts.every((host): host is string => typeof host === "string" && /^[a-z0-9.-]+$/.test(host) && !host.includes(".."))) return null;
  const uniqueHosts = [...new Set(hosts)].sort();
  if (uniqueHosts.length !== hosts.length) return null;
  const prefixInput = root["allowedDownloadPrefixes"] as Record<string, unknown>;
  if (!exactKeys(prefixInput, uniqueHosts)) return null;
  const prefixes: Record<string, readonly string[]> = {};
  for (const host of uniqueHosts) {
    const item = prefixInput[host];
    if (!Array.isArray(item) || item.length === 0 || !item.every((prefix): prefix is string => typeof prefix === "string" && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(prefix) && !prefix.includes("//"))) return null;
    const unique = [...new Set(item)].sort();
    if (unique.length !== item.length) return null;
    prefixes[host] = Object.freeze(unique);
  }
  const artifacts: SecurityScannerArtifact[] = [];
  const seen = new Set<string>();
  for (const item of root["artifacts"]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    const kind = raw["kind"];
    const keys = kind === "engine"
      ? ["component", "kind", "version", "platform", "url", "archiveBytes", "sha256", "format", "entrypoint", "entrypointSha256", "license", "source", "notices"]
      : kind === "rules"
        ? ["component", "kind", "version", "platform", "url", "archiveBytes", "sha256", "format", "license", "source", "notices"]
        : [];
    if (!exactKeys(raw, keys)) return null;
    const component = raw["component"];
    const version = raw["version"];
    const platform = raw["platform"];
    const url = raw["url"];
    const bytes = raw["archiveBytes"];
    const sha256 = raw["sha256"];
    const format = raw["format"];
    const license = raw["license"];
    const source = raw["source"];
    const notices = raw["notices"];
    const sourceUrl = secureUrl(source);
    if (typeof component !== "string" || !NAME.test(component) || (kind !== "engine" && kind !== "rules") || typeof version !== "string" || !VERSION.test(version) || typeof platform !== "string" || !PLATFORM.has(platform as SecurityScannerPlatform) || typeof url !== "string" || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1_073_741_824 || typeof sha256 !== "string" || !HEX.test(sha256) || (format !== "binary" && format !== "tar.gz") || (kind === "rules" && format !== "tar.gz") || typeof license !== "string" || license.trim().length === 0 || !sourceUrl || !notices || typeof notices !== "object" || Array.isArray(notices)) return null;
    const notice = notices as Record<string, unknown>;
    const noticeUrl = secureUrl(notice["url"]);
    if (!exactKeys(notice, ["url", "sha256", "bytes"]) || !noticeUrl || typeof notice["sha256"] !== "string" || !HEX.test(notice["sha256"]) || typeof notice["bytes"] !== "number" || !Number.isSafeInteger(notice["bytes"]) || notice["bytes"] < 1 || notice["bytes"] > 1_048_576) return null;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !uniqueHosts.includes(parsed.hostname) || !prefixes[parsed.hostname]!.some((prefix) => parsed.pathname.startsWith(prefix))) return null;
    const identity = `${component}:${kind}:${version}:${platform}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    if (kind === "engine") {
      if (!safeRelativePath(raw["entrypoint"]) || typeof raw["entrypointSha256"] !== "string" || !HEX.test(raw["entrypointSha256"])) return null;
      artifacts.push(Object.freeze({ component, kind, version, platform: platform as SecurityScannerPlatform, url, archiveBytes: bytes, sha256, format, entrypoint: raw["entrypoint"], entrypointSha256: raw["entrypointSha256"], license: license.trim(), source: sourceUrl, notices: Object.freeze({ url: noticeUrl, sha256: notice["sha256"], bytes: notice["bytes"] }) }));
    } else {
      // Content packages have no executable admission path.  In particular,
      // this prevents a rule bundle becoming a Semgrep engine by accident.
      artifacts.push(Object.freeze({ component, kind, version, platform: platform as SecurityScannerPlatform, url, archiveBytes: bytes, sha256, format, license: license.trim(), source: sourceUrl, notices: Object.freeze({ url: noticeUrl, sha256: notice["sha256"], bytes: notice["bytes"] }) }));
    }
  }
  return Object.freeze({ schemaVersion: 1, allowedDownloadHosts: Object.freeze(uniqueHosts), allowedDownloadPrefixes: Object.freeze(prefixes), artifacts: Object.freeze(artifacts) });
}

export function platformForSecurityScanner(platform: NodeJS.Platform, arch: string): SecurityScannerPlatform | null {
  if (platform !== "darwin") return null;
  return arch === "arm64" ? "darwin-arm64" : arch === "x64" ? "darwin-x64" : null;
}
