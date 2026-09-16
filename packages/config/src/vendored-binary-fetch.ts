// Generic build-time vendoring helper (D392 P1b) — node-only, build-scripts only.
//
// One audited "download → sha256-verify → (optionally tar-extract a member) →
// install (write + chmod)" path, shared by every vendor-*.ts script (OfficeCLI
// + desktop tool runtimes such as agent-browser and gog). Before this, each
// script inlined its own copy of the security-sensitive fetch+verify logic.
//
// This is the BUILD-TIME sibling of `./vendored-binary` (runtime verify-once).
// It is intentionally in a separate subpath so its fetch / child_process(tar)
// surface never reaches a runtime import.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { normalizeSha256Hex, sha256HexOfBytes } from "./vendored-binary";

export class VendoredBinaryFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendoredBinaryFetchError";
  }
}

export interface FetchVendoredBinaryArchive {
  /** Only `tar.gz` today (what all current tools ship). */
  readonly format: "tar.gz";
  /**
   * Binary basename to locate inside the extracted tree (recursive search),
   * e.g. "gog" / "agent-browser". Ignored when `candidates` matches first.
   */
  readonly member: string;
  /**
   * Optional explicit relative candidate paths (checked in order before the
   * recursive search) — supports upstream archives with nested layouts.
   */
  readonly candidates?: readonly string[];
}

export interface FetchVendoredBinaryInput {
  /** Upstream artifact URL (raw binary, or a tarball when `archive` is set). */
  readonly url: string;
  /** Expected sha256 of the DOWNLOADED artifact (raw binary or the tarball). */
  readonly sha256: string;
  /** Optional expected sha256 of the FINAL extracted/installed binary bytes. */
  readonly binarySha256?: string;
  /** Absolute path to write the final binary to. */
  readonly destPath: string;
  /** When set, the download is a tarball and this describes how to extract. */
  readonly archive?: FetchVendoredBinaryArchive;
  /** Minimum acceptable size of the FINAL binary (guards truncated extracts). */
  readonly minBytes?: number;
  /** chmod 0o755 the final binary. Default true (set false for win/.exe). */
  readonly executable?: boolean;
  /** Injectable fetch for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional trusted file containing a bearer token for one private immutable
   * GitHub/GitLab release asset. The token itself is never accepted from argv,
   * environment, URL, manifest, logger, or return value.
   */
  readonly releaseAssetBearerTokenFile?: string;
  /** Optional progress logger. */
  readonly log?: (msg: string) => void;
}

export interface FetchVendoredBinaryResult {
  readonly destPath: string;
  /** Size of the installed binary in bytes. */
  readonly size: number;
  /** sha256 of the downloaded artifact (matches the pinned manifest value). */
  readonly sha256: string;
  /** sha256 of the final installed binary bytes. */
  readonly binarySha256: string;
}

const RELEASE_TOKEN_MAX_BYTES = 4_096;

function parseAuthenticatedReleaseAssetUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VendoredBinaryFetchError("authenticated release asset URL is invalid");
  }
  const path = parsed.pathname.toLowerCase();
  const isReleaseAsset = path.includes("/releases/download/") || (path.includes("/-/releases/") && path.includes("/downloads/"));
  if (
    parsed.protocol !== "https:" ||
    (parsed.hostname !== "github.com" && parsed.hostname !== "gitlab.com") ||
    parsed.port.length > 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    !isReleaseAsset ||
    path.split("/").includes("latest") ||
    /\/(?:refs|heads|branches)\//.test(path)
  ) {
    throw new VendoredBinaryFetchError("authenticated downloads require an immutable HTTPS GitHub or GitLab release-asset URL without credentials, query, or fragment");
  }
  return parsed;
}

function readReleaseBearerToken(tokenFile: string): string {
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new VendoredBinaryFetchError("release asset token file is unreadable");
  }
  if (
    token.length === 0 ||
    Buffer.byteLength(token, "utf8") > RELEASE_TOKEN_MAX_BYTES ||
    !/^[A-Za-z0-9._~+/-]+$/.test(token)
  ) {
    throw new VendoredBinaryFetchError("release asset token file is empty or malformed");
  }
  return token;
}

/**
 * Authenticated release assets are fetched with manual redirects so the token
 * is attached to the initial approved GitHub/GitLab URL only. Release hosts
 * commonly redirect to object storage, which must never receive the header.
 */
async function fetchAuthenticatedReleaseAsset(
  initial: URL,
  tokenFile: string,
  doFetch: typeof fetch,
): Promise<Response> {
  const token = readReleaseBearerToken(tokenFile);
  let current = initial.toString();
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    let response: Response;
    try {
      response = await doFetch(current, {
        redirect: "manual",
        ...(redirectCount === 0 ? { headers: { authorization: `Bearer ${token}` } } : {}),
      });
    } catch {
      throw new VendoredBinaryFetchError("authenticated release asset download failed");
    }
    if (response.status < 300 || response.status > 399) return response;
    const location = response.headers.get("location");
    if (location === null) throw new VendoredBinaryFetchError("authenticated release asset redirect is missing a location");
    let redirected: URL;
    try {
      redirected = new URL(location, current);
    } catch {
      throw new VendoredBinaryFetchError("authenticated release asset redirect is invalid");
    }
    if (redirected.protocol !== "https:") {
      throw new VendoredBinaryFetchError("authenticated release asset redirect must use HTTPS");
    }
    current = redirected.toString();
  }
  throw new VendoredBinaryFetchError("authenticated release asset exceeded redirect limit");
}

function recursiveFindByBasename(root: string, member: string): string | null {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = recursiveFindByBasename(full, member);
      if (nested) return nested;
    } else if (entry.isFile() && basename(full) === member) {
      return full;
    }
  }
  return null;
}

function extractMember(tarBytes: Buffer, archive: FetchVendoredBinaryArchive, destPath: string): Buffer {
  const tmpDir = join(dirname(destPath), `.vendored-tmp-${process.pid}-${Date.now()}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    const tarPath = join(tmpDir, "artifact.tar.gz");
    writeFileSync(tarPath, tarBytes);
    const result = spawnSync("tar", ["-xzf", tarPath, "-C", tmpDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new VendoredBinaryFetchError(
        `tar extraction failed (status ${result.status}): ${result.stderr?.toString() ?? "(no stderr)"}`,
      );
    }
    let found: string | null = null;
    for (const rel of archive.candidates ?? []) {
      const candidate = join(tmpDir, rel);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
    found = found ?? recursiveFindByBasename(tmpDir, archive.member);
    if (found === null) {
      throw new VendoredBinaryFetchError(
        `extraction produced no "${archive.member}" binary under ${tmpDir}`,
      );
    }
    return readFileSync(found);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Download, sha256-verify, optionally tar-extract, and install a vendored
 * binary. Throws `VendoredBinaryFetchError` on any failure (HTTP, empty body,
 * checksum mismatch, extraction failure, undersized result). Never leaves a
 * partial file at `destPath` on a verification failure (write happens last).
 */
export async function fetchAndVerifyVendoredBinary(
  input: FetchVendoredBinaryInput,
): Promise<FetchVendoredBinaryResult> {
  const log = input.log ?? (() => {});
  const expected = normalizeSha256Hex(input.sha256);
  if (expected === null) {
    throw new VendoredBinaryFetchError(`invalid expected sha256: ${JSON.stringify(input.sha256)}`);
  }
  const doFetch = input.fetchImpl ?? fetch;
  // An authenticated URL is untrusted until it passes the credential-free
  // release-asset parser. Do this before logging any URL-derived text.
  const authenticatedUrl = input.releaseAssetBearerTokenFile === undefined
    ? undefined
    : parseAuthenticatedReleaseAssetUrl(input.url);

  log(`GET ${authenticatedUrl?.toString() ?? input.url}`);
  let response: Response;
  try {
    response = input.releaseAssetBearerTokenFile === undefined
      ? await doFetch(input.url, { redirect: "follow" })
      : await fetchAuthenticatedReleaseAsset(authenticatedUrl!, input.releaseAssetBearerTokenFile, doFetch);
  } catch (err) {
    if (err instanceof VendoredBinaryFetchError) throw err;
    throw new VendoredBinaryFetchError(
      `download failed for ${input.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new VendoredBinaryFetchError(
      `download failed for ${input.url}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const downloaded = Buffer.from(await response.arrayBuffer());
  if (downloaded.length === 0) {
    throw new VendoredBinaryFetchError(`download returned an empty body for ${input.url}`);
  }

  const actual = sha256HexOfBytes(downloaded);
  if (actual !== expected) {
    throw new VendoredBinaryFetchError(
      `sha256 mismatch for ${input.url}\n  expected ${expected}\n  got      ${actual}`,
    );
  }

  const binaryBytes = input.archive
    ? extractMember(downloaded, input.archive, input.destPath)
    : downloaded;

  const binarySha256 = sha256HexOfBytes(binaryBytes);
  if (input.binarySha256 !== undefined) {
    const expectedBinarySha256 = normalizeSha256Hex(input.binarySha256);
    if (expectedBinarySha256 === null) {
      throw new VendoredBinaryFetchError(
        `invalid expected binary sha256: ${JSON.stringify(input.binarySha256)}`,
      );
    }
    if (binarySha256 !== expectedBinarySha256) {
      throw new VendoredBinaryFetchError(
        `binary sha256 mismatch after extracting ${input.url}\n  expected ${expectedBinarySha256}\n  got      ${binarySha256}`,
      );
    }
  }

  if (input.minBytes !== undefined && binaryBytes.length < input.minBytes) {
    throw new VendoredBinaryFetchError(
      `installed binary size ${binaryBytes.length} is below minimum ${input.minBytes} (${input.destPath})`,
    );
  }

  mkdirSync(dirname(input.destPath), { recursive: true });
  writeFileSync(input.destPath, binaryBytes);
  if (input.executable !== false) {
    chmodSync(input.destPath, 0o755);
  }

  log(`installed ${input.destPath} (${(binaryBytes.length / 1_000_000).toFixed(1)} MB)`);
  return {
    destPath: input.destPath,
    size: binaryBytes.length,
    sha256: actual,
    binarySha256,
  };
}
