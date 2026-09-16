/**
 * D392 P1b — generic build-time vendoring helper (fetch + verify + extract).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchAndVerifyVendoredBinary,
  VendoredBinaryFetchError,
} from "../../src/vendored-binary-fetch";
import { sha256HexOfBytes } from "../../src/vendored-binary";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vendored-fetch-"));
}

async function expectFetchError(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(VendoredBinaryFetchError);
}

/** A fetchImpl that returns the given bytes with HTTP 200. */
function okFetch(bytes: Buffer): typeof fetch {
  return (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;
}

/** Build a real .tar.gz containing files at the given relative paths. */
function makeTarGz(entries: Record<string, Buffer>): Buffer {
  const src = tmp();
  for (const [rel, bytes] of Object.entries(entries)) {
    const full = join(src, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, bytes);
  }
  const out = join(tmp(), "a.tar.gz");
  const r = spawnSync("tar", ["-czf", out, "-C", src, "."], { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`tar create failed: ${r.stderr?.toString()}`);
  return readFileSync(out);
}

describe("fetchAndVerifyVendoredBinary", () => {
  test("keeps public downloads unauthenticated", async () => {
    const bytes = Buffer.from("public-payload");
    let authorization: string | null | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAndVerifyVendoredBinary({
      url: "https://example.test/tool",
      sha256: sha256HexOfBytes(bytes),
      destPath: join(tmp(), "tool"),
      fetchImpl,
    });
    expect(authorization).toBeNull();
  });

  test("reads a token only from its file and sends it only to the initial approved release host", async () => {
    const bytes = Buffer.from("private-payload");
    const token = "glpat-private-token-value";
    const tokenFile = join(tmp(), "release-token");
    writeFileSync(tokenFile, `  ${token}\n`);
    const calls: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.example.test/private-tool" },
        });
      }
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAndVerifyVendoredBinary({
      url: "https://gitlab.com/nautilo/generic-tool/-/releases/v0.1/downloads/generic-tool",
      sha256: sha256HexOfBytes(bytes),
      destPath: join(tmp(), "tool"),
      releaseAssetBearerTokenFile: tokenFile,
      fetchImpl,
    });
    expect(calls).toEqual([
      {
        url: "https://gitlab.com/nautilo/generic-tool/-/releases/v0.1/downloads/generic-tool",
        authorization: `Bearer ${token}`,
      },
      { url: "https://release-assets.example.test/private-tool", authorization: null },
    ]);
  });

  test("rejects unapproved authenticated hosts and never leaks token material to logs or errors", async () => {
    const bytes = Buffer.from("private-payload");
    const token = "ghp_private_token_value";
    const tokenFile = join(tmp(), "release-token");
    writeFileSync(tokenFile, `${token}\n`);
    const logs: string[] = [];
    let thrown: unknown;
    try {
      await fetchAndVerifyVendoredBinary({
        url: "https://attacker.example/releases/download/v0.1/tool",
        sha256: sha256HexOfBytes(bytes),
        destPath: join(tmp(), "tool"),
        releaseAssetBearerTokenFile: tokenFile,
        fetchImpl: okFetch(bytes),
        log: (message) => logs.push(message),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VendoredBinaryFetchError);
    expect(String(thrown)).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
    expect(logs).toEqual([]);
  });

  test("validates authenticated URLs before logging so credentials, query, and fragments never surface", async () => {
    const bytes = Buffer.from("private-payload");
    const token = "ghp_private_token_value";
    const credential = "userinfo-secret";
    const query = "query-secret";
    const tokenFile = join(tmp(), "release-token");
    writeFileSync(tokenFile, `${token}\n`);
    const logs: string[] = [];
    let thrown: unknown;
    try {
      await fetchAndVerifyVendoredBinary({
        url: `https://${credential}@github.com/nautilo/generic-tool/releases/download/v0.1/tool?access_token=${query}#fragment-secret`,
        sha256: sha256HexOfBytes(bytes),
        destPath: join(tmp(), "tool"),
        releaseAssetBearerTokenFile: tokenFile,
        fetchImpl: okFetch(bytes),
        log: (message) => logs.push(message),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VendoredBinaryFetchError);
    const surfaced = `${String(thrown)}\n${logs.join("\n")}`;
    expect(surfaced).not.toContain(credential);
    expect(surfaced).not.toContain(query);
    expect(surfaced).not.toContain("fragment-secret");
    expect(surfaced).not.toContain(token);
    expect(logs).toEqual([]);
  });

  test("rejects empty or malformed release token files without fetching", async () => {
    const bytes = Buffer.from("private-payload");
    const tokenFile = join(tmp(), "release-token");
    writeFileSync(tokenFile, "not a token\n");
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
    await expectFetchError(() =>
      fetchAndVerifyVendoredBinary({
        url: "https://github.com/nautilo/generic-tool/releases/download/v0.1/tool",
        sha256: sha256HexOfBytes(bytes),
        destPath: join(tmp(), "tool"),
        releaseAssetBearerTokenFile: tokenFile,
        fetchImpl,
      }),
    );
    expect(called).toBe(false);
  });

  test("raw binary: verifies sha, installs, sets exec bit", async () => {
    const bytes = Buffer.alloc(2_000_000, 7); // > default no-min, sizeable
    const destPath = join(tmp(), "tool");
    const res = await fetchAndVerifyVendoredBinary({
      url: "https://example.test/tool",
      sha256: sha256HexOfBytes(bytes),
      destPath,
      fetchImpl: okFetch(bytes),
    });
    expect(res.destPath).toBe(destPath);
    expect(res.size).toBe(bytes.length);
    expect(readFileSync(destPath).equals(bytes)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(destPath).mode & 0o111).not.toBe(0); // executable
    }
  });

  test("throws on sha256 mismatch (and writes nothing)", async () => {
    const bytes = Buffer.from("actual-payload");
    const destPath = join(tmp(), "tool");
    await expectFetchError(() =>
      fetchAndVerifyVendoredBinary({
        url: "https://example.test/tool",
        sha256: "a".repeat(64),
        destPath,
        fetchImpl: okFetch(bytes),
      }),
    );
    expect(existsSync(destPath)).toBe(false);
  });

  test("throws on HTTP error", async () => {
    const destPath = join(tmp(), "tool");
    const notFound = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expectFetchError(() =>
      fetchAndVerifyVendoredBinary({
        url: "https://example.test/missing",
        sha256: "a".repeat(64),
        destPath,
        fetchImpl: notFound,
      }),
    );
  });

  test("throws when installed binary is below minBytes", async () => {
    const bytes = Buffer.from("tiny");
    const destPath = join(tmp(), "tool");
    await expectFetchError(() =>
      fetchAndVerifyVendoredBinary({
        url: "https://example.test/tool",
        sha256: sha256HexOfBytes(bytes),
        destPath,
        minBytes: 1_000_000,
        fetchImpl: okFetch(bytes),
      }),
    );
  });

  test("tar.gz archive: extracts the named member (recursive) and installs it", async () => {
    const binBytes = Buffer.alloc(1_500_000, 9);
    const tarball = makeTarGz({ "nested/dir/gog": binBytes, "README": Buffer.from("noise") });
    const destPath = join(tmp(), "gog");
    const res = await fetchAndVerifyVendoredBinary({
      url: "https://example.test/gog.tar.gz",
      sha256: sha256HexOfBytes(tarball),
      destPath,
      archive: { format: "tar.gz", member: "gog" },
      binarySha256: sha256HexOfBytes(binBytes),
      minBytes: 1_000_000,
      fetchImpl: okFetch(tarball),
    });
    expect(res.size).toBe(binBytes.length);
    expect(readFileSync(destPath).equals(binBytes)).toBe(true);
    // Returned sha is the DOWNLOADED tarball's sha (matches the manifest pin).
    expect(res.sha256).toBe(sha256HexOfBytes(tarball));
    expect(res.binarySha256).toBe(sha256HexOfBytes(binBytes));
  });

  test("tar.gz archive: rejects an extracted member digest mismatch before install", async () => {
    const binBytes = Buffer.from("real member bytes");
    const tarball = makeTarGz({ "release/rg": binBytes });
    const destPath = join(tmp(), "rg");
    await expectFetchError(() =>
      fetchAndVerifyVendoredBinary({
        url: "https://example.test/rg.tar.gz",
        sha256: sha256HexOfBytes(tarball),
        binarySha256: "a".repeat(64),
        destPath,
        archive: { format: "tar.gz", member: "rg" },
        fetchImpl: okFetch(tarball),
      }),
    );
    expect(existsSync(destPath)).toBe(false);
  });

  test("tar.gz archive: honours explicit candidate paths before recursive search", async () => {
    const binBytes = Buffer.alloc(1_200_000, 3);
    const tarball = makeTarGz({ "tool-macos-arm64/tool": binBytes });
    const destPath = join(tmp(), "tool");
    const res = await fetchAndVerifyVendoredBinary({
      url: "https://example.test/tool.tar.gz",
      sha256: sha256HexOfBytes(tarball),
      destPath,
      archive: {
        format: "tar.gz",
        member: "tool",
        candidates: ["tool", "tool-macos-arm64/tool"],
      },
      minBytes: 1_000_000,
      fetchImpl: okFetch(tarball),
    });
    expect(readFileSync(destPath).equals(binBytes)).toBe(true);
    expect(res.size).toBe(binBytes.length);
  });
});
