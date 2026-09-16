import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { workspaceArtifactsRoutes } from "../../src/routes/workspace-artifacts";
import { ArtifactWriteDeniedError } from "@nautilo/trust";

/**
 * D423 Phase 2 — route-level proof that a malformed `.mp4` (no ISO-BMFF
 * `ftyp` header) creates no workspace artifact.
 *
 * The route handler writes the uploaded bytes to a temp file under the
 * artifacts root, sniffs the head, and calls `classifyArtifactUpload`. On
 * rejection it returns 415 BEFORE `insertArtifact` and the `finally` block
 * removes the uploaded file, so no artifact row and no orphaned byte file
 * remain. We exercise that end-to-end with a real Fastify + `@fastify/multipart`
 * app and a temp `NAUTILO_ARTIFACTS_ROOT`, with no DB dependency: the envelope
 * carries a writable namespace (passes the 403 gate) but an empty mutable set,
 * so `findArtifactByPathForNamespaces` short-circuits to `null` (its
 * empty-namespace fast path) and the upload reaches the classify guard
 * without ever touching the database proxy.
 */

const apps: FastifyInstance[] = [];
const artifactRoots: string[] = [];

const ENVELOPE = {
  memoryMode: "namespace",
  ownerId: "owner-1",
  actorId: "actor-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: [],
  mutableNamespaces: [],
  writableNamespaces: ["ns-1"],
  toolPolicy: {},
} as const;

function installEnvelopePreHandler(app: FastifyInstance): void {
  app.decorateRequest("memoryEnvelope", null);
  app.addHook("preHandler", (request, _reply, done) => {
    request.memoryEnvelope = ENVELOPE as never;
    done();
  });
}

async function makeApp(
  assertCanWriteArtifacts: NonNullable<
    Parameters<typeof workspaceArtifactsRoutes>[1]
  >["assertCanWriteArtifacts"] = async () => {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  installEnvelopePreHandler(app);
  await app.register(multipart);
  workspaceArtifactsRoutes(app, { assertCanWriteArtifacts });
  await app.ready();
  apps.push(app);
  return app;
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "wa-routes-mp4-"));
  artifactRoots.push(root);
  process.env["NAUTILO_ARTIFACTS_ROOT"] = root;
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of artifactRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  delete process.env["NAUTILO_ARTIFACTS_ROOT"];
});

describe("workspace-artifacts routes module", () => {
  test("streams beyond 100 MiB by default, while honoring an explicitly configured upload policy", async () => {
    const previous = process.env["NAUTILO_ARTIFACT_UPLOAD_MAX_MB"];
    const app = await makeApp();
    try {
      for (const configured of [undefined, "1"]) {
        if (configured === undefined) delete process.env["NAUTILO_ARTIFACT_UPLOAD_MAX_MB"];
        else process.env["NAUTILO_ARTIFACT_UPLOAD_MAX_MB"] = configured;
        const boundary = "streaming-workspace-upload";
        // Deliberately malformed media reaches classification only AFTER the
        // complete stream is accepted, proving admission without a DB fixture.
        async function* multipartBody() {
          yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\nmedia/bad.mp4\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bad.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
          const chunk = Buffer.alloc(64 * 1024, 0x61);
          for (let i = 0; i < 101 * 16; i++) yield chunk;
          yield Buffer.from(`\r\n--${boundary}--\r\n`);
        }
        const response = await app.inject({ method: "POST", url: "/api/workspace/artifacts",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Readable.from(multipartBody()) });
        expect(response.statusCode).toBe(configured === undefined ? 415 : 413);
        if (configured === undefined) {
          expect(response.json()).toMatchObject({ code: "mp4_ftyp_missing" });
        }
        expect(readdirSync(artifactRoots.at(-1)!)).toEqual([]);
      }
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_ARTIFACT_UPLOAD_MAX_MB"];
      else process.env["NAUTILO_ARTIFACT_UPLOAD_MAX_MB"] = previous;
    }
  });
  test("exports workspaceArtifactsRoutes", async () => {
    const mod = await import("../../src/routes/workspace-artifacts");
    expect(typeof mod.workspaceArtifactsRoutes).toBe("function");
  });

  test("a malformed .mp4 upload is rejected with 415 mp4_ftyp_missing and creates no artifact", async () => {
    const app = await makeApp();
    const root = artifactRoots[artifactRoots.length - 1]!;

    // Benign text bytes renamed to .mp4: no executable/archive magic, and
    // critically no ISO-BMFF `ftyp` box at offset 4..8. The route classifies
    // by the logical `path` field, so the .mp4 extension comes from `path`.
    const malformed = new TextEncoder().encode("not an mp4 file — no ISO-BMFF ftyp box here");
    const fd = new FormData();
    fd.set("file", new Blob([malformed], { type: "video/mp4" }), "bad.mp4");
    fd.set("path", "media/bad.mp4");

    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts",
      payload: fd,
    });

    expect(res.statusCode).toBe(415);
    const body = JSON.parse(res.body) as { error: string; code: string };
    expect(body.code).toBe("mp4_ftyp_missing");

    // No artifact byte file is left behind under the artifacts root — the
    // route's `finally` orphan-cleanup removed the uploaded file because
    // `attached` stayed false (insertArtifact was never reached).
    expect(readdirSync(root)).toEqual([]);
  });

  test("Artifact upload denies before multipart bytes reach disk without write_artifacts", async () => {
    const app = await makeApp(async (input) => {
      throw new ArtifactWriteDeniedError(input);
    });
    const root = artifactRoots[artifactRoots.length - 1]!;
    const fd = new FormData();
    fd.set("file", new Blob(["secret"], { type: "text/plain" }), "secret.txt");
    fd.set("path", "secret.txt");

    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts",
      payload: fd,
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "write_artifacts_required",
      code: "write_artifacts_required",
      capability: "write_artifacts",
    });
    expect(readdirSync(root)).toEqual([]);
  });
});
