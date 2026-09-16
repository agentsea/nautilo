import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { importPickedWorkspaceMedia, importPickedWorkspaceMediaBatch, stageWorkspaceMedia, type WorkspaceMediaDependencies } from "../../electron/workspace-media-streaming";

const row = { id: "00000000-0000-4000-8000-000000000001", artifactId: "00000000-0000-4000-8000-000000000002",
  path: "media/clip.mp4", mimeType: "video/mp4", size: 12, revision: 3 };
const video = { mediaKind: "video" as const, mimeType: "video/mp4" as const, extension: "mp4" as const,
  durationSec: 1, frameRate: { numerator: 60, denominator: 1 } };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
function deps(fetcher: WorkspaceMediaDependencies["fetch"], overrides: Partial<WorkspaceMediaDependencies> = {}): WorkspaceMediaDependencies {
  return { serverUrl: "https://server.test", bearer: "test-bearer", roomId: "00000000-0000-4000-8000-000000000003",
    ffmpegPath: "/unused", signal: new AbortController().signal, isAuthorityCurrent: () => true,
    inspect: async () => video, fetch: fetcher, ...overrides };
}
function byteResponse(size: number, options: { mime?: string; abort?: () => void } = {}) {
  let remaining = size;
  const chunk = new Uint8Array(64 * 1024);
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (!remaining) { controller.close(); return; }
      const n = Math.min(remaining, chunk.length);
      controller.enqueue(chunk.subarray(0, n)); remaining -= n; options.abort?.();
    },
  }), { headers: { "content-type": options.mime ?? row.mimeType } });
  response.arrayBuffer = async () => { throw new Error("whole-file buffering forbidden"); };
  response.blob = async () => { throw new Error("whole-file buffering forbidden"); };
  return response;
}
describe("native Workspace media streaming", () => {
  test("stages over the former 100 MiB ceiling with bounded chunks, exact bytes and revision checks", async () => {
    const artifact = { ...row, size: 101 * 1024 * 1024 };
    let metadataReads = 0;
    const result = await stageWorkspaceMedia(artifact, deps((async (url, input) => {
      expect(input?.redirect).toBe("error");
      expect(new Headers(input?.headers).get("authorization")).toBe("Bearer test-bearer");
      const target = url instanceof Request ? url.url : String(url);
      expect(target).toContain("roomId=00000000-0000-4000-8000-000000000003");
      if (target.includes("/bytes?")) return byteResponse(artifact.size);
      metadataReads++; return Response.json(artifact);
    }) as typeof fetch));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    roots.push(result.data.parentDir);
    expect((await fs.stat(result.data.outputPath)).size).toBe(artifact.size);
    expect(metadataReads).toBe(2);
    expect(JSON.stringify(result)).not.toContain("test-bearer");
  });
  test("digest identifies exact streamed bytes across names and separates same-sized edits", async () => {
    const first = new TextEncoder().encode("same picture");
    const edited = new TextEncoder().encode("new! picture");
    expect(first.byteLength).toBe(edited.byteLength);
    const digests: string[] = [];
    for (const [index, bytes] of [first, first, edited].entries()) {
      const artifact = { ...row, path: `media/copy-${index}.png`, mimeType: "image/png", size: bytes.byteLength };
      let downloads = 0;
      const result = await stageWorkspaceMedia(artifact, deps((async (url) => {
        if (!String(url).includes("/bytes?")) return Response.json(artifact);
        downloads++;
        const response = new Response(new ReadableStream({ start(controller) {
          controller.enqueue(bytes.slice(0, 3)); controller.enqueue(bytes.slice(3)); controller.close();
        } }), { headers: { "content-type": artifact.mimeType } });
        response.arrayBuffer = async () => { throw new Error("whole-file buffering forbidden"); };
        return response;
      }) as typeof fetch, { inspect: async () => ({ mediaKind: "image", mimeType: "image/png", extension: "png" }) }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      roots.push(result.data.parentDir);
      expect(downloads).toBe(1);
      expect(result.data.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      digests.push(result.data.sha256);
    }
    expect(digests[0]).toBe(digests[1]);
    expect(digests[2]).not.toBe(digests[0]);
  });
  test("rejects stale revisions, short or long bytes, wrong MIME, inspection failure and abort", async () => {
    for (const failure of ["revision", "short", "long", "mime", "inspect", "abort"] as const) {
      let metadataReads = 0;
      const controller = new AbortController();
      const result = await stageWorkspaceMedia(row, deps((async (url) => {
        if (!(url instanceof Request ? url.url : String(url)).includes("/bytes?")) {
          metadataReads++;
          return Response.json({ ...row, revision: failure === "revision" && metadataReads === 2 ? 4 : 3 });
        }
        return byteResponse(failure === "short" ? 11 : failure === "long" ? 13 : 12,
          { mime: failure === "mime" ? "image/png" : row.mimeType, abort: failure === "abort" ? () => controller.abort() : undefined });
      }) as typeof fetch, { signal: controller.signal, inspect: async () => failure === "inspect" ? null : video }));
      expect(result).toMatchObject({ ok: false, code: failure === "revision" ? "source_changed" :
        failure === "inspect" ? "source_inspection_unavailable" : "source_bytes_unavailable" });
    }
  });
  test("reports only safe stage and HTTP status diagnostics for rejected metadata or bytes", async () => {
    const metadata = await stageWorkspaceMedia(row, deps((async () => new Response("denied", { status: 403 })) as typeof fetch));
    expect(metadata).toEqual({ ok: false, code: "source_metadata_unavailable", httpStatus: 403 });
    let calls = 0;
    const bytes = await stageWorkspaceMedia(row, deps((async () => ++calls === 1
      ? Response.json(row)
      : new Response("upstream unavailable", { status: 502 })) as typeof fetch));
    expect(bytes).toEqual({ ok: false, code: "source_bytes_unavailable", httpStatus: 502 });
    expect(JSON.stringify([metadata, bytes])).not.toContain("server.test");
    expect(JSON.stringify([metadata, bytes])).not.toContain("test-bearer");
  });
  test("never fetches an unsafe binding or stale authority", async () => {
    let calls = 0;
    const dep = deps((async () => { calls++; throw new Error("no fetch"); }) as typeof fetch);
    expect(await stageWorkspaceMedia({ ...row, path: "../private" }, dep)).toEqual({ ok: false, code: "source_changed" });
    expect(await stageWorkspaceMedia(row, { ...dep, isAuthorityCurrent: () => false })).toEqual({ ok: false, code: "source_changed" });
    expect(calls).toBe(0);
  });
  test("imports a private snapshot through streaming multipart and returns only a committed public receipt", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "workspace-import-test-"))); roots.push(root);
    const source = path.join(root, "clip.mp4");
    await fs.writeFile(source, new Uint8Array(700 * 1024));
    let calls = 0, streamed = 0;
    const result = await importPickedWorkspaceMedia(source, undefined, deps((async (_url, options) => {
      calls++;
      const fields: Buffer[] = [];
      for await (const chunk of options!.body as unknown as Readable) {
        streamed += (chunk as Buffer).length;
        // Only the small multipart field prefix is needed to construct a receipt.
        if (fields.length < 1) fields.push(Buffer.from(chunk as Uint8Array));
      }
      expect(streamed).toBe(Number(new Headers(options?.headers).get("content-length")));
      const workspacePath = fields[0]!.toString().match(/video-imports\/[0-9a-f-]+\.mp4/u)?.[0];
      expect(workspacePath).toBeTruthy();
      return Response.json({ ...row, path: workspacePath, size: 700 * 1024 });
    }) as typeof fetch));
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: true, data: { label: "clip.mp4", mediaKind: "video", artifact: { size: 700 * 1024 } } });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(JSON.stringify(result)).not.toContain("test-bearer");
  });
  test("rejects decoder/type mismatch before upload and never retries uncertain publication", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "workspace-import-test-"))); roots.push(root);
    const source = path.join(root, "clip.mp4"); await fs.writeFile(source, new Uint8Array(12));
    let calls = 0;
    const dep = deps((async () => { calls++; throw new Error("response lost"); }) as typeof fetch);
    expect(await importPickedWorkspaceMedia(source, "image", dep)).toMatchObject({ ok: false, error: { code: "unsupported_type" } });
    expect(await importPickedWorkspaceMedia(source, undefined, { ...dep, inspect: async () => null })).toMatchObject({ ok: false });
    expect(calls).toBe(0);
    expect(await importPickedWorkspaceMedia(source, undefined, dep)).toMatchObject({ ok: false, error: { code: "upload_unknown" } });
    expect(calls).toBe(1);
  });
  test("imports images in selection order and reports basename-only per-file failures", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "workspace-batch-import-test-"))); roots.push(root);
    const sources = [path.join(root, "first.png"), path.join(root, "broken.png"), path.join(root, "third.png")];
    await Promise.all(sources.map((source) => fs.writeFile(source, new Uint8Array(12))));
    let inspection = 0;
    const image = { mediaKind: "image" as const, mimeType: "image/png" as const, extension: "png" as const };
    const result = await importPickedWorkspaceMediaBatch(sources, deps((async (_url, options) => {
      const body = Buffer.from(await new Response(options!.body as BodyInit).arrayBuffer()).toString();
      const workspacePath = body.match(/video-references\/[0-9a-f-]+\.png/u)?.[0];
      return Response.json({ ...row, path: workspacePath, mimeType: "image/png", size: 12 });
    }) as typeof fetch, { inspect: async () => ++inspection === 2 ? null : image }));
    expect(result.results.map((entry) => entry.ok ? entry.data.label : entry.label)).toEqual(["first.png", "broken.png", "third.png"]);
    expect(result.results.map((entry) => entry.ok ? "ok" : entry.error.code)).toEqual(["ok", "unsupported_type", "ok"]);
    expect(JSON.stringify(result)).not.toContain(root);
  });
  test("stops after a committed receipt when the originating authority changes", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "workspace-batch-switch-test-"))); roots.push(root);
    const sources = [path.join(root, "first.png"), path.join(root, "second.png")];
    await Promise.all(sources.map((source) => fs.writeFile(source, new Uint8Array(12))));
    let current = true, uploads = 0;
    const image = { mediaKind: "image" as const, mimeType: "image/png" as const, extension: "png" as const };
    const result = await importPickedWorkspaceMediaBatch(sources, deps((async (_url, options) => {
      uploads++;
      const body = Buffer.from(await new Response(options!.body as BodyInit).arrayBuffer()).toString();
      const workspacePath = body.match(/video-references\/[0-9a-f-]+\.png/u)?.[0];
      current = false;
      return Response.json({ ...row, path: workspacePath, mimeType: "image/png", size: 12 });
    }) as typeof fetch, { inspect: async () => image, isAuthorityCurrent: () => current }));
    expect(uploads).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ ok: true, data: { label: "first.png" } });
    expect(result.results[1]).toEqual({ ok: false, label: "second.png", error: { code: "cancelled" } });
  });
});
