/**
 * D429 Phase 7.4.2 — integration tests for the authenticated, verified-byte
 * explainer media route (`GET /api/explainers/:id/media`) streamed responses.
 *
 * No network I/O: the runtime catalog is a fake loader returning a tiny custom
 * entry, and the upstream MP4 fetch is a test seam. Verifies verified response
 * streaming, temp cleanup, digest-cache reuse, and that no direct CDN/media URL
 * or origin leaks in the response.
 *
 * Successful responses stream verified bytes via `createReadStream`. Under
 * light-my-request (`app.inject`), the stream never drains back through inject's
 * Promise resolver and the request hangs until timeout. These cases exercise
 * Node's actual stream→socket plumbing via `app.listen({ port: 0 }) + fetch`,
 * matching production and the onboarding-audio integration precedent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FastifyInstance } from "fastify";
import {
  configureRuntimeExplainerCatalog,
  resetRuntimeExplainerCatalog,
} from "@nautilo/agent";
import {
  ENTRY_ID,
  ORIGIN_ENV,
  TEST_ORIGIN,
  fakeLoader,
  makeApp,
  makeMedia,
  media,
  mp4Response,
} from "../helpers/explainer-media-route-fixture";
import type { ExplainerMediaRouteDeps } from "../../src/routes/explainer-media";

const originalOriginEnv = process.env[ORIGIN_ENV];
let scratchDir: string;

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}

async function startApp(app: FastifyInstance): Promise<string> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return address.replace(/\/$/, "");
}

async function fetchMedia(
  baseUrl: string,
  explainerId: string,
  userId = "user-1",
): Promise<HttpResponse> {
  const res = await fetch(`${baseUrl}/api/explainers/${explainerId}/media`, {
    headers: { "x-test-user": userId },
  });
  const body = Buffer.from(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { statusCode: res.status, headers, body };
}

beforeEach(() => {
  process.env[ORIGIN_ENV] = TEST_ORIGIN;
  scratchDir = mkdtempSync(join(tmpdir(), "nautilo-explainer-route-"));
  configureRuntimeExplainerCatalog({ loader: fakeLoader() });
});

afterEach(async () => {
  resetRuntimeExplainerCatalog();
  if (originalOriginEnv === undefined) delete process.env[ORIGIN_ENV];
  else process.env[ORIGIN_ENV] = originalOriginEnv;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("GET /api/explainers/:id/media (D429 Phase 7.4.2) — streamed responses", () => {
  const instances: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  function depsFor(
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  ): ExplainerMediaRouteDeps {
    return {
      fetchImpl,
      cacheDir: join(scratchDir, "cache"),
      tmpDir: join(scratchDir, "tmp"),
      timeoutMs: 1000,
      maxBytes: 1024 * 1024,
    };
  }

  function cachePath(): string {
    return join(scratchDir, "cache", `${media.sha256}.mp4`);
  }

  function seedCache(bytes: Buffer): void {
    mkdirSync(join(scratchDir, "cache"), { recursive: true });
    writeFileSync(cachePath(), bytes);
  }

  test("streams verified MP4 bytes with exact content-type and content-length", async () => {
    const app = await makeApp({ deps: depsFor(async () => mp4Response(media.bytes)) });
    instances.push(app);
    const base = await startApp(app);
    const res = await fetchMedia(base, ENTRY_ID);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-length"]).toBe(String(media.bytes.length));
    expect(res.body.equals(media.bytes)).toBe(true);
  });

  test("cleans up the temp spool dir after a verified response", async () => {
    const tmp = join(scratchDir, "tmp");
    const app = await makeApp({ deps: depsFor(async () => mp4Response(media.bytes)) });
    instances.push(app);
    const base = await startApp(app);
    await fetchMedia(base, ENTRY_ID);
    // The temp spool dir must be empty after promotion to the digest cache.
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("never exposes a direct CDN/media URL or raw origin in the response", async () => {
    const app = await makeApp({ deps: depsFor(async () => mp4Response(media.bytes)) });
    instances.push(app);
    const base = await startApp(app);
    const res = await fetchMedia(base, ENTRY_ID);
    expect(res.statusCode).toBe(200);
    const headerBlob = JSON.stringify(res.headers);
    expect(headerBlob).not.toContain("media.test.local");
    expect(headerBlob).not.toContain("media.nautilo.ai");
    // Binary body must not contain the origin string either.
    expect(res.body.toString("utf8")).not.toContain(TEST_ORIGIN);
  });

  test("same-size wrong-hash cache corruption is evicted and refetched", async () => {
    const corrupt = makeMedia(media.bytes.length, 99);
    seedCache(corrupt.bytes);
    let fetches = 0;
    const app = await makeApp({
      deps: depsFor(async () => {
        fetches++;
        return mp4Response(media.bytes);
      }),
    });
    instances.push(app);
    const base = await startApp(app);
    const res = await fetchMedia(base, ENTRY_ID);

    expect(res.statusCode).toBe(200);
    expect(fetches).toBe(1);
    expect(res.body.equals(media.bytes)).toBe(true);
    expect(Buffer.from(await Bun.file(cachePath()).arrayBuffer()).equals(media.bytes)).toBe(true);
  });

  test("a pre-existing valid digest cache file avoids network", async () => {
    seedCache(media.bytes);
    let fetches = 0;
    const app = await makeApp({
      deps: depsFor(async () => {
        fetches++;
        return mp4Response(media.bytes);
      }),
    });
    instances.push(app);
    const base = await startApp(app);
    const res = await fetchMedia(base, ENTRY_ID);

    expect(res.statusCode).toBe(200);
    expect(fetches).toBe(0);
    expect(res.body.equals(media.bytes)).toBe(true);
  });

  test("accepts a concurrent valid winner after atomic promotion loses", async () => {
    const deps = depsFor(async () => mp4Response(media.bytes));
    deps.renameImpl = (_tmpPath, finalPath) => {
      writeFileSync(finalPath, media.bytes);
      const error = new Error("destination exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    };
    const app = await makeApp({ deps });
    instances.push(app);
    const base = await startApp(app);
    const res = await fetchMedia(base, ENTRY_ID);

    expect(res.statusCode).toBe(200);
    expect(res.body.equals(media.bytes)).toBe(true);
    expect(readdirSync(join(scratchDir, "tmp"))).toEqual([]);
  });

  test("reuses a newly populated digest cache on a second request", async () => {
    let fetches = 0;
    const app = await makeApp({
      deps: depsFor(async () => {
        fetches++;
        return mp4Response(media.bytes);
      }),
    });
    instances.push(app);
    const base = await startApp(app);
    const first = await fetchMedia(base, ENTRY_ID);
    const second = await fetchMedia(base, ENTRY_ID);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(fetches).toBe(1);
    // The digest cache file is retained, keyed by the verified digest.
    expect(existsSync(cachePath())).toBe(true);
  });
});
