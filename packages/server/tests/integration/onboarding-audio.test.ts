/**
 * Integration test — `GET /api/onboarding/audio/<lang>/<track>.mp3`
 * round-trips a real MP3 from `packages/server/src/onboarding/audio/`
 * through `@fastify/static`.
 *
 * Originally lived in `tests/unit/health-keys.test.ts`, moved here
 * 2026-04-27 because it's not a unit test by any sensible definition:
 *
 *   - `createApp` registers the entire production app (cors,
 *     websocket, multipart, static, all 20+ routes, the global
 *     preHandler, error handlers, ensureDirectoryTree filesystem
 *     touches, backup GC scheduler, TTS service).
 *   - The static-file plugin streams a real ~150 KB binary off disk.
 *   - The streaming pipe doesn't compose with Fastify's `app.inject`:
 *     the request reaches the framework, the static plugin starts
 *     producing the response stream, but the body never drains back
 *     through inject's Promise resolver — `inject` deadlocks at
 *     whatever timeout the test runner enforces (5 s in the unit
 *     suite). Switching to a real HTTP round-trip via
 *     `app.listen({ port: 0 }) + fetch` exercises Node's actual
 *     stream→socket plumbing, which is the path production uses, and
 *     resolves cleanly.
 *
 * What this test verifies:
 *   1. The static mount at `/api/onboarding/` serves files from
 *      `packages/server/src/onboarding/`.
 *   2. The MP3 fixture under `audio/en/` is bundled with the package.
 *   3. The Content-Type advertises an audio media type the renderer
 *      expects (browsers + Electron's <audio> element treat
 *      `audio/mpeg` and `audio/mp3` interchangeably).
 *   4. The body is non-empty (file actually streamed, not 0 bytes).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../src/app";

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = await createApp({ silent: true });
  // Port 0 → OS picks a free ephemeral port. Bind to 127.0.0.1 only
  // so the test can't accidentally expose the harness on a LAN.
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = address;
});

afterAll(async () => {
  if (app) await app.close();
});

describe("GET /api/onboarding/audio/<lang>/<track>.mp3", () => {
  test("serves a bundled audio fixture with audio Content-Type and a non-empty body", async () => {
    const res = await fetch(
      `${baseUrl}/api/onboarding/audio/en/02-privacy.mp3`,
    );
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toMatch(/audio\/(mpeg|mp3)/);
    const buf = await res.arrayBuffer();
    // Sanity floor: the bundled fixture is ~148 KB; if it ever drops
    // to a few hundred bytes that's a regression worth flagging.
    expect(buf.byteLength).toBeGreaterThan(10_000);
  });

  test("returns 404 for a missing track (sanity check that the mount is real)", async () => {
    const res = await fetch(
      `${baseUrl}/api/onboarding/audio/en/does-not-exist.mp3`,
    );
    expect(res.status).toBe(404);
  });
});
