/**
 * Shared fixtures for explainer media route tests (unit error paths + integration
 * streamed-response lifecycle).
 */
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  EXPLAINER_CATALOG_VERSION,
  ExplainerCatalogSchema,
  type ExplainerCatalog,
} from "@nautilo/types";
import {
  explainerMediaRoutes,
  type ExplainerMediaRouteDeps,
} from "../../src/routes/explainer-media";
import type { RemoteExplainerCatalogLoader, RemoteExplainerCatalogResult } from "@nautilo/agent";

export const ORIGIN_ENV = "NAUTILO_EXPLAINER_BUNNY_STORAGE_ORIGIN";
export const TEST_ORIGIN = "https://media.test.local/";
export const ENTRY_ID = "test-walkthrough";
const ASSET_KEY = "test/walkthrough.mp4";

/** Build deterministic MP4-like bytes and their SHA-256. */
export function makeMedia(byteLength: number, seed = 0): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.alloc(byteLength);
  for (let i = 0; i < byteLength; i++) bytes[i] = (i + seed) & 0xff;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}

export const media = makeMedia(1024);

function buildCatalog(overrides: Partial<ExplainerCatalog> = {}): ExplainerCatalog {
  return ExplainerCatalogSchema.parse({
    version: EXPLAINER_CATALOG_VERSION,
    catalogVersion: "2026.07.18.1",
    publishedAt: "2026-07-18T10:00:00Z",
    entries: [
      {
        id: ENTRY_ID,
        asset: {
          provider: "bunny-storage",
          key: ASSET_KEY,
          format: "mp4",
          contentSha256: media.sha256,
          byteLength: media.bytes.length,
        },
        title: "Test Walkthrough",
        summary: "A test walkthrough.",
        description: "A test walkthrough for verified playback.",
        tags: ["test", "playback"],
        toolReferences: [{ name: "find_voice", category: "config", tags: ["test"] }],
        durationSeconds: 12,
        publishedAt: "2026-07-18",
        captionsAvailable: false,
      },
    ],
    ...overrides,
  });
}

export function fakeLoader(catalog: ExplainerCatalog = buildCatalog()): RemoteExplainerCatalogLoader {
  return {
    get: async (): Promise<RemoteExplainerCatalogResult> => {
      await Promise.resolve();
      return {
        catalog,
        source: "checked-in-fallback",
        stale: true,
        fetchedAt: null,
        originUrl: null,
        reason: "local-only",
        catalogVersion: catalog.catalogVersion,
      };
    },
    refresh: async (): Promise<RemoteExplainerCatalogResult> => {
      await Promise.resolve();
      return {
        catalog,
        source: "checked-in-fallback",
        stale: true,
        fetchedAt: null,
        originUrl: null,
        reason: "local-only",
        catalogVersion: catalog.catalogVersion,
      };
    },
    clearCache: () => {},
  };
}

export function mp4Response(body: Buffer, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { "content-type": "video/mp4", "content-length": String(body.length), ...(init?.headers ?? {}) },
  });
}

export interface MakeAppOpts {
  deps?: ExplainerMediaRouteDeps;
}

export async function makeApp(opts: MakeAppOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Simulate the trust preHandler: derive sessionUserId from a test header.
  app.addHook("preHandler", (request, _reply, done) => {
    const user = request.headers["x-test-user"];
    (request as { sessionUserId: string | null }).sessionUserId =
      typeof user === "string" && user.length > 0 ? user : null;
    done();
  });
  explainerMediaRoutes(app, opts.deps ?? {});
  await app.ready();
  return app;
}
