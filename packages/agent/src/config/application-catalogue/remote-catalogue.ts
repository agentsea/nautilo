import {
  applicationCatalogueMetadataSnapshotV1Schema,
  applicationCatalogueV1Schema,
  applicationCatalogueReleasePointerV1Schema,
  canonicalApplicationCatalogueSigningPayloadV1,
  compareApplicationCatalogueVersionV1,
  immutableApplicationCatalogueFilenameV1,
  type ApplicationCatalogueV1,
} from "@nautilo/types";
import { boundedJsonFetch, verifiedReleaseUrl, verifyEd25519Release } from "../../catalog/verified-release-loader";
import { bundledApplicationCatalogue } from "./catalog";
import { getTrustedApplicationCataloguePublicKey } from "./trusted-keys";

export type ApplicationCatalogueSource = "remote-fresh" | "remote-stale" | "checked-in-fallback";
export type ApplicationCatalogueResult = Readonly<{ catalogue: ApplicationCatalogueV1; source: ApplicationCatalogueSource; stale: boolean; catalogueVersion: string | null; reason: string }>;
export type RemoteApplicationCatalogueConfig = Readonly<{ pointerUrl?: string; allowedHosts?: string[]; trustedKeys?: Record<string, string>; fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number; staleMs?: number; timeoutMs?: number; maxBytes?: number }>;
const MAX_RELEASE_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_TIMEOUT_MS = 60_000;
const MAX_CACHE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const FALLBACK = (reason: string): ApplicationCatalogueResult => ({
  catalogue: bundledApplicationCatalogue,
  source: "checked-in-fallback",
  stale: true,
  catalogueVersion: bundledApplicationCatalogue.catalogueVersion,
  reason,
});
const cleanReason = (reason: string) => reason.length > 160 ? "application catalogue refresh failed" : reason;

export function createRemoteApplicationCatalogueLoader(config: RemoteApplicationCatalogueConfig = {}) {
  const ttlMs = config.ttlMs ?? 900_000, staleMs = config.staleMs ?? 86_400_000, maxBytes = config.maxBytes ?? 1_048_576, timeoutMs = config.timeoutMs ?? 5_000;
  if (
    ![ttlMs, staleMs, maxBytes, timeoutMs].every(Number.isInteger)
    || ttlMs < 1
    || staleMs < 0
    || maxBytes < 1
    || maxBytes > MAX_RELEASE_BYTES
    || timeoutMs < 1
    || timeoutMs > MAX_RELEASE_TIMEOUT_MS
    || ttlMs > MAX_CACHE_WINDOW_MS
    || staleMs > MAX_CACHE_WINDOW_MS
    || ttlMs + staleMs > MAX_CACHE_WINDOW_MS * 2
  ) {
    throw new Error("application catalogue config bounds rejected");
  }
  const now = config.now ?? Date.now, fetcher = config.fetchImpl ?? fetch, keys = config.trustedKeys ?? {};
  let cache: { result: ApplicationCatalogueResult; fetchedAt: number; sha256: string } | null = null;
  const immutableHashes = new Map<string, string>();
  let inflight: Promise<ApplicationCatalogueResult> | null = null;
  const retain = (reason: string): ApplicationCatalogueResult => cache ? { ...cache.result, source: "remote-stale", stale: true, reason: cleanReason(reason) } : FALLBACK(cleanReason(reason));
  async function attempt(): Promise<ApplicationCatalogueResult> {
    if (!config.pointerUrl) return FALLBACK("remote application catalogue is disabled");
    try {
      const pointerUrl = verifiedReleaseUrl(config.pointerUrl, config.allowedHosts ?? [new URL(config.pointerUrl).hostname.toLowerCase()]);
      const pointerBody = await boundedJsonFetch(fetcher, pointerUrl, maxBytes, timeoutMs);
      const pointer = applicationCatalogueReleasePointerV1Schema.parse(JSON.parse(pointerBody.text));
      const publicKey = keys[pointer.signingKeyId] ?? getTrustedApplicationCataloguePublicKey(pointer.signingKeyId);
      if (!publicKey) throw new Error("unknown application catalogue signing key");
      verifyEd25519Release(canonicalApplicationCatalogueSigningPayloadV1(pointer.catalogueVersion, pointer.artifactSha256), pointer.signature, publicKey);
      const artifactUrl = verifiedReleaseUrl(new URL(immutableApplicationCatalogueFilenameV1(pointer.catalogueVersion), pointerUrl).toString(), config.allowedHosts ?? [pointerUrl.hostname.toLowerCase()]);
      if (artifactUrl.origin !== pointerUrl.origin) throw new Error("application catalogue artifact origin rejected");
      const artifact = await boundedJsonFetch(fetcher, artifactUrl, maxBytes, timeoutMs);
      if (artifact.sha256 !== pointer.artifactSha256) throw new Error("application catalogue artifact hash rejected");
      const knownHash = immutableHashes.get(pointer.catalogueVersion);
      if (knownHash && knownHash !== artifact.sha256) throw new Error("application catalogue immutable version conflict");
      const snapshot = applicationCatalogueMetadataSnapshotV1Schema.parse(JSON.parse(artifact.text));
      if (snapshot.catalogueVersion !== pointer.catalogueVersion) throw new Error("application catalogue version mismatch");
      const published = Date.parse(snapshot.publishedAt), bundled = Date.parse(bundledApplicationCatalogue.publishedAt), previous = cache ? Date.parse(cache.result.catalogue.publishedAt) : -Infinity;
      const versionComparedToBundled = compareApplicationCatalogueVersionV1(
        snapshot.catalogueVersion,
        bundledApplicationCatalogue.catalogueVersion,
      );
      if (!Number.isFinite(published) || published <= bundled || versionComparedToBundled <= 0) {
        throw new Error("application catalogue rollback rejected");
      }
      if (cache) {
        const versionComparedToCache = compareApplicationCatalogueVersionV1(
          snapshot.catalogueVersion,
          cache.result.catalogue.catalogueVersion,
        );
        if (
          published < previous
          || versionComparedToCache < 0
          || (versionComparedToCache === 0 && artifact.sha256 !== cache.sha256)
          || (published === previous && snapshot.catalogueVersion !== cache.result.catalogue.catalogueVersion)
        ) {
          throw new Error("application catalogue rollback rejected");
        }
      }
      const served = applicationCatalogueV1Schema.parse({ ...snapshot, provenance: "remote" });
      const result: ApplicationCatalogueResult = { catalogue: served, source: "remote-fresh", stale: false, catalogueVersion: snapshot.catalogueVersion, reason: "verified application catalogue" };
      cache = { result, fetchedAt: now(), sha256: artifact.sha256 };
      immutableHashes.set(pointer.catalogueVersion, artifact.sha256);
      return result;
    } catch { return retain("application catalogue refresh failed"); }
  }
  return {
    async get(): Promise<ApplicationCatalogueResult> { if (!cache) return this.refresh(); const age = now() - cache.fetchedAt; if (!Number.isFinite(age) || age < 0) return retain("application catalogue clock rejected"); if (age < ttlMs) return cache.result; if (age < ttlMs + staleMs) { void this.refresh(); return retain("application catalogue refresh pending"); } return this.refresh(); },
    refresh(): Promise<ApplicationCatalogueResult> { inflight ??= attempt().finally(() => { inflight = null; }); return inflight; },
    clearCache(): void { cache = null; },
  };
}
