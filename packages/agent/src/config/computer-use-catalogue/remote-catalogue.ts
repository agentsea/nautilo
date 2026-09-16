import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  boundedJsonFetch,
  VERIFIED_RELEASE_JSON_MAX_BYTES,
  VERIFIED_RELEASE_TIMEOUT_MS,
  verifiedReleaseUrl,
  verifyEd25519Release,
} from "../../catalog/verified-release-loader";
import { bundledComputerUseContractCatalogue } from "./catalog";
import {
  canonicalComputerUseContractCatalogueSigningPayloadV1,
  compareComputerUseContractCatalogueVersionV1,
  computerUseContractCatalogueReleasePointerV1Schema,
  computerUseContractCatalogueSnapshotV1Schema,
  computerUseContractCatalogueV1Schema,
  immutableComputerUseContractCatalogueFilenameV1,
  type ComputerUseContractCatalogueV1,
} from "./schema";
import { getTrustedComputerUseContractCataloguePublicKey } from "./trusted-keys";

export type ComputerUseContractCatalogueSource =
  | "remote-fresh"
  | "remote-stale"
  | "bundled-fallback";

export type ComputerUseContractCatalogueResult = Readonly<{
  catalogue: ComputerUseContractCatalogueV1;
  source: ComputerUseContractCatalogueSource;
  stale: boolean;
  catalogueVersion: string;
  artifactSha256: string;
  reason: string;
}>;

const { provenance: _bundledProvenance, ...bundledSnapshot } = bundledComputerUseContractCatalogue;
void _bundledProvenance;

export const bundledComputerUseContractCatalogueArtifactSha256 = createHash("sha256")
  .update(`${JSON.stringify(bundledSnapshot)}\n`, "utf8")
  .digest("hex");

export type RemoteComputerUseContractCatalogueConfig = Readonly<{
  pointerUrl?: string;
  allowedHosts?: readonly string[];
  trustedKeys?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  staleMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Optional instance-private, signature-revalidated restart LKG. */
  lkgPath?: string;
}>;

type PersistedComputerUseContractCatalogueV1 = Readonly<{
  schemaVersion: 1;
  pointer: unknown;
  artifactBase64: string;
}>;

function fallback(reason: string): ComputerUseContractCatalogueResult {
  return {
    catalogue: bundledComputerUseContractCatalogue,
    source: "bundled-fallback",
    stale: true,
    catalogueVersion: bundledComputerUseContractCatalogue.catalogueVersion,
    artifactSha256: bundledComputerUseContractCatalogueArtifactSha256,
    reason,
  };
}

export function createRemoteComputerUseContractCatalogueLoader(
  config: RemoteComputerUseContractCatalogueConfig = {},
) {
  const ttlMs = config.ttlMs ?? 900_000;
  const staleMs = config.staleMs ?? 86_400_000;
  const maxBytes = config.maxBytes ?? VERIFIED_RELEASE_JSON_MAX_BYTES;
  const timeoutMs = config.timeoutMs ?? 5_000;
  if (
    ![ttlMs, staleMs, maxBytes, timeoutMs].every(Number.isInteger)
    || ttlMs < 1
    || staleMs < 0
    || maxBytes < 1
    || maxBytes > VERIFIED_RELEASE_JSON_MAX_BYTES
    || timeoutMs < 1
    || timeoutMs > VERIFIED_RELEASE_TIMEOUT_MS
  ) throw new Error("computer use contract catalogue config bounds rejected");
  const lkgPath = config.lkgPath === undefined ? null : resolve(config.lkgPath);
  if (lkgPath !== null && (!isAbsolute(config.lkgPath!) || lkgPath !== config.lkgPath)) {
    throw new Error("computer use contract catalogue LKG path rejected");
  }

  const now = config.now ?? Date.now;
  const fetcher = config.fetchImpl ?? fetch;
  const trustedKeys = config.trustedKeys ?? {};
  let cache: Readonly<{
    result: ComputerUseContractCatalogueResult;
    fetchedAt: number;
    artifactSha256: string;
  }> | null = null;
  const immutableHashes = new Map<string, string>();
  let inflight: Promise<ComputerUseContractCatalogueResult> | null = null;
  const maxLkgBytes = Math.ceil(maxBytes / 3) * 4 + 64 * 1024;

  const retain = (reason: string): ComputerUseContractCatalogueResult => cache === null
    ? fallback(reason)
    : { ...cache.result, source: "remote-stale", stale: true, reason };

  function accept(pointerValue: unknown, artifactText: string, artifactSha256: string): ComputerUseContractCatalogueResult {
    const pointer = computerUseContractCatalogueReleasePointerV1Schema.parse(pointerValue);
    const publicKey = trustedKeys[pointer.signingKeyId]
      ?? getTrustedComputerUseContractCataloguePublicKey(pointer.signingKeyId);
    if (!publicKey) throw new Error("unknown computer use contract catalogue signing key");
    verifyEd25519Release(
      canonicalComputerUseContractCatalogueSigningPayloadV1(
        pointer.catalogueVersion,
        pointer.artifactSha256,
      ),
      pointer.signature,
      publicKey,
    );
    if (artifactSha256 !== pointer.artifactSha256) {
      throw new Error("computer use contract catalogue artifact digest rejected");
    }
    const knownHash = immutableHashes.get(pointer.catalogueVersion);
    if (knownHash !== undefined && knownHash !== artifactSha256) {
      throw new Error("computer use contract catalogue immutable version conflict");
    }
    const snapshot = computerUseContractCatalogueSnapshotV1Schema.parse(JSON.parse(artifactText));
    if (snapshot.catalogueVersion !== pointer.catalogueVersion) {
      throw new Error("computer use contract catalogue pointer version mismatch");
    }
    const published = Date.parse(snapshot.publishedAt);
    const bundledPublished = Date.parse(bundledComputerUseContractCatalogue.publishedAt);
    const bundledVersionComparison = compareComputerUseContractCatalogueVersionV1(
      snapshot.catalogueVersion,
      bundledComputerUseContractCatalogue.catalogueVersion,
    );
    const exactSignedBundledRelease = bundledVersionComparison === 0
      && published === bundledPublished
      && artifactSha256 === bundledComputerUseContractCatalogueArtifactSha256;
    if (!Number.isFinite(published) || (!exactSignedBundledRelease
      && (published <= bundledPublished || bundledVersionComparison <= 0))) {
      throw new Error("computer use contract catalogue rollback rejected");
    }
    if (cache !== null) {
      const previousPublished = Date.parse(cache.result.catalogue.publishedAt);
      const versionComparison = compareComputerUseContractCatalogueVersionV1(snapshot.catalogueVersion, cache.result.catalogue.catalogueVersion);
      if (published < previousPublished || versionComparison < 0
        || (versionComparison === 0 && artifactSha256 !== cache.artifactSha256)
        || (published === previousPublished && snapshot.catalogueVersion !== cache.result.catalogue.catalogueVersion)) {
        throw new Error("computer use contract catalogue rollback rejected");
      }
    }
    const catalogue = computerUseContractCatalogueV1Schema.parse({ ...snapshot, provenance: "remote" });
    immutableHashes.set(pointer.catalogueVersion, artifactSha256);
    return {
      catalogue,
      source: "remote-fresh",
      stale: false,
      catalogueVersion: catalogue.catalogueVersion,
      artifactSha256,
      reason: "verified computer use contract catalogue",
    };
  }

  async function persist(pointer: unknown, artifactText: string): Promise<void> {
    if (lkgPath === null) return;
    const parent = dirname(lkgPath);
    const temporary = `${lkgPath}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
    const body = `${JSON.stringify({
      schemaVersion: 1,
      pointer,
      artifactBase64: Buffer.from(artifactText, "utf8").toString("base64"),
    } satisfies PersistedComputerUseContractCatalogueV1)}\n`;
    if (Buffer.byteLength(body) > maxLkgBytes) throw new Error("computer use contract catalogue LKG too large");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
      await rename(temporary, lkgPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async function loadPersisted(): Promise<ComputerUseContractCatalogueResult | null> {
    if (lkgPath === null) return null;
    try {
      const info = await lstat(lkgPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxLkgBytes) return null;
      const value = JSON.parse(await readFile(lkgPath, "utf8")) as PersistedComputerUseContractCatalogueV1;
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "artifactBase64,pointer,schemaVersion"
        || value.schemaVersion !== 1 || typeof value.artifactBase64 !== "string") return null;
      const artifactBytes = Buffer.from(value.artifactBase64, "base64");
      if (artifactBytes.byteLength > maxBytes || artifactBytes.toString("base64") !== value.artifactBase64) return null;
      const artifactText = new TextDecoder("utf-8", { fatal: true }).decode(artifactBytes);
      const result = accept(value.pointer, artifactText, createHash("sha256").update(artifactBytes).digest("hex"));
      const stale = { ...result, source: "remote-stale" as const, stale: true, reason: "verified restart last-known-good catalogue" };
      cache = { result: stale, fetchedAt: now(), artifactSha256: result.artifactSha256 };
      return stale;
    } catch {
      return null;
    }
  }

  async function attempt(): Promise<ComputerUseContractCatalogueResult> {
    if (!config.pointerUrl) return fallback("remote computer use contract catalogue is disabled");
    try {
      const defaultHost = new URL(config.pointerUrl).hostname.toLowerCase();
      const allowedHosts = config.allowedHosts ?? [defaultHost];
      const pointerUrl = verifiedReleaseUrl(config.pointerUrl, allowedHosts);
      const pointerBody = await boundedJsonFetch(fetcher, pointerUrl, maxBytes, timeoutMs);
      const pointerValue = JSON.parse(pointerBody.text) as unknown;
      const pointer = computerUseContractCatalogueReleasePointerV1Schema.parse(pointerValue);

      const artifactUrl = verifiedReleaseUrl(
        new URL(
          immutableComputerUseContractCatalogueFilenameV1(
            pointer.catalogueVersion,
            pointer.artifactSha256,
          ),
          pointerUrl,
        ).toString(),
        allowedHosts,
      );
      if (artifactUrl.origin !== pointerUrl.origin) {
        throw new Error("computer use contract catalogue artifact origin rejected");
      }
      const artifact = await boundedJsonFetch(fetcher, artifactUrl, maxBytes, timeoutMs);
      const result = accept(pointerValue, artifact.text, artifact.sha256);
      cache = { result, fetchedAt: now(), artifactSha256: artifact.sha256 };
      await persist(pointerValue, artifact.text).catch(() => undefined);
      return result;
    } catch {
      if (cache === null) {
        const persisted = await loadPersisted();
        if (persisted !== null) return persisted;
      }
      return retain("computer use contract catalogue refresh failed");
    }
  }

  return {
    async get(): Promise<ComputerUseContractCatalogueResult> {
      if (cache === null) return await this.refresh();
      const age = now() - cache.fetchedAt;
      if (!Number.isFinite(age) || age < 0) {
        return retain("computer use contract catalogue clock rejected");
      }
      if (age < ttlMs) return cache.result;
      if (age < ttlMs + staleMs) {
        void this.refresh();
        return retain("computer use contract catalogue refresh pending");
      }
      return await this.refresh();
    },
    refresh(): Promise<ComputerUseContractCatalogueResult> {
      inflight ??= attempt().finally(() => { inflight = null; });
      return inflight;
    },
    clearCache(): void {
      cache = null;
    },
  };
}
