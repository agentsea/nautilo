import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { publishSequenceToWorkspace, sequenceWorkspaceOutputPath } from "../../electron/sequence-workspace-publication";
import { renderAndPublishSequence } from "../../electron/sequence-export-host";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nautilo-publication-test-")); roots.push(root);
  const stagedPath = path.join(root, "private.mp4"); const bytes = Buffer.alloc(192_001, 42);
  await writeFile(stagedPath, bytes);
  return { root, bytes, input: { stagedPath, sizeBytes: bytes.length, workspacePath: sequenceWorkspaceOutputPath("A film.mp4"), roomId: "10000000-0000-4000-8000-000000000001", serverUrl: "https://server.test", bearer: "unit-test-not-a-secret", isAuthorityCurrent: () => true } };
}
function receipt(input: Awaited<ReturnType<typeof fixture>>["input"]) {
  return { id: "10000000-0000-4000-8000-000000000002", artifactId: "10000000-0000-4000-8000-000000000003", path: input.workspacePath, size: input.sizeBytes, mimeType: "video/mp4" };
}

describe("native Workspace MP4 publication", () => {
  test("the streaming body crosses a real HTTP connection as a complete multipart file", async () => {
    const { input, bytes } = await fixture();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/workspace/artifacts");
      const form = await request.formData();
      expect(Buffer.from(await (form.get("file") as File).arrayBuffer())).toEqual(bytes);
      return Response.json(receipt(input));
    } });
    try {
      expect((await publishSequenceToWorkspace({ ...input, serverUrl: server.url.origin })).status).toBe("published");
    } finally { await server.stop(true); }
  });

  test("streams ordinary multipart admission to the bound room with exact file bytes and verifies receipt", async () => {
    const { input, bytes } = await fixture(); let calls = 0;
    const result = await publishSequenceToWorkspace(input, { fetch: (async (url, options) => {
      calls++;
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      expect(urlString).toBe(`https://server.test/api/workspace/artifacts?roomId=${input.roomId}`);
      expect(options?.redirect).toBe("error");
      expect(options?.body).toBeInstanceOf(Readable);
      const chunks: Buffer[] = [];
      for await (const chunk of options!.body as unknown as Readable) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = Buffer.concat(chunks);
      expect(Number(new Headers(options?.headers).get("content-length"))).toBe(body.length);
      const request = new Request(urlString, { method: "POST", headers: options?.headers, body });
      const form = await request.formData();
      expect(form.get("path")).toBe(input.workspacePath);
      expect(form.get("mimeType")).toBe("video/mp4");
      expect(Buffer.from(await (form.get("file") as File).arrayBuffer())).toEqual(bytes);
      expect(chunks.length).toBeGreaterThan(3);
      return Response.json(receipt(input));
    }) as typeof fetch });
    expect(calls).toBe(1);
    expect(result).toEqual({ status: "published", path: input.workspacePath, artifactId: receipt(input).artifactId });
  });

  test("never submits on cancellation, stale authority or mismatched staged length", async () => {
    const { input } = await fixture(); let calls = 0;
    const deps = { fetch: (async () => { calls++; throw new Error("must not submit"); }) as typeof fetch };
    const controller = new AbortController(); controller.abort();
    expect((await publishSequenceToWorkspace({ ...input, signal: controller.signal }, deps)).status).toBe("not_published");
    expect((await publishSequenceToWorkspace({ ...input, isAuthorityCurrent: () => false }, deps)).status).toBe("not_published");
    expect((await publishSequenceToWorkspace({ ...input, sizeBytes: input.sizeBytes + 1 }, deps)).status).toBe("not_published");
    expect(calls).toBe(0);
  });

  test("reports admission rejection without retry, and does not mistake server failure for rejection", async () => {
    const { input } = await fixture();
    for (const [status, expected] of [[401, "not_published"], [403, "not_published"], [409, "not_published"], [413, "not_published"], [408, "unknown"], [499, "unknown"], [500, "unknown"]] as const) {
      let calls = 0;
      expect((await publishSequenceToWorkspace(input, { fetch: (async () => { calls++; return new Response(null, { status }); }) as typeof fetch })).status).toBe(expected);
      expect(calls).toBe(1);
    }
  });

  test("a lost response or malformed confirmation is unknown and never retried", async () => {
    const { input } = await fixture(); let calls = 0;
    expect((await publishSequenceToWorkspace(input, { fetch: (async () => { calls++; throw new Error("response lost after server commit"); }) as typeof fetch })).status).toBe("unknown");
    expect(calls).toBe(1);
    for (const value of [{ ...receipt(input), path: "other.mp4" }, { ...receipt(input), size: 1 }, { ...receipt(input), artifactId: "bad" }, { ...receipt(input), mimeType: "text/html" }]) {
      expect((await publishSequenceToWorkspace(input, { fetch: (async () => Response.json(value)) as typeof fetch })).status).toBe("unknown");
    }
  });

  test("valid server confirmation remains published even when cancellation arrives after commit", async () => {
    const { input } = await fixture(); const controller = new AbortController();
    expect((await publishSequenceToWorkspace({ ...input, signal: controller.signal }, { fetch: (async () => { controller.abort(); return Response.json(receipt(input)); }) as typeof fetch })).status).toBe("published");
  });

  test("authority loss during streaming stops the body and is never retried", async () => {
    const { input } = await fixture(); let current = true; let calls = 0;
    const result = await publishSequenceToWorkspace({ ...input, isAuthorityCurrent: () => current }, { fetch: (async (_url, options) => {
      calls++;
      for await (const _chunk of options!.body as unknown as Readable) current = false;
      throw new Error("body must stop before receipt");
    }) as typeof fetch });
    expect(result.status).toBe("unknown"); expect(calls).toBe(1);
  });

  test("a failed optional upload retains local success and cannot alter the immutable upload copy", async () => {
    const { root } = await fixture(); const local = path.join(root, "chosen.mp4"); let staged = "";
    const result = await renderAndPublishSequence({
      plan: { version: 1, width: 16, height: 16, frameRate: { numerator: 30, denominator: 1 }, durationSec: 1, layers: [] } as never,
      sources: new Map(), ffmpegPath: "/test/ffmpeg", suggestedName: "chosen.mp4", chooseOutput: async () => local,
      render: async (_plan, deps) => { await writeFile(deps.outputPath, "rendered"); return { status: "succeeded", sizeBytes: 8, warnings: [] }; },
      workspacePublication: { path: "exports/test.mp4", publish: async (source) => {
        staged = source; await writeFile(local, "human-edited local copy");
        expect(await readFile(source, "utf8")).toBe("rendered");
        throw new Error("response lost");
      } },
    });
    expect(result).toEqual({ status: "succeeded", label: "chosen.mp4", sizeBytes: 8, warnings: [], workspace: { status: "unknown", path: "exports/test.mp4" } });
    expect(await readFile(local, "utf8")).toBe("human-edited local copy");
    expect(await readFile(staged).then(() => true, () => false)).toBe(false);
  });
});
