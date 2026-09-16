import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaProxyResponse } from "../../electron/media-proxy-response.ts";

describe("Desktop staged media byte responses", () => {
  let root: string;
  let source: { outputPath: string; mimeType: string; sizeBytes: number };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "media-range-test-"));
    source = { outputPath: join(root, "video.mp4"), mimeType: "video/mp4", sizeBytes: 10 };
    await writeFile(source.outputPath, "0123456789");
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  const request = (range?: string, method = "GET") => ({ method, headers: new Headers(range === undefined ? {} : { Range: range }) });

  test("advertises exact full size and seeking support", async () => {
    const response = await mediaProxyResponse(source, request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Content-Range")).toBe(false);
    expect(await response.text()).toBe("0123456789");
  });

  test.each([
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=8-100", "89", "bytes 8-9/10"],
    ["bytes=-100", "0123456789", "bytes 0-9/10"],
    ["bytes=0-0", "0", "bytes 0-0/10"],
  ])("returns the exact requested slice %s", async (range, body, contentRange) => {
    const response = await mediaProxyResponse(source, request(range));
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Content-Length")).toBe(String(body.length));
    expect(await response.text()).toBe(body);
  });

  test.each(["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=0-1,4-5", "items=0-1", "bytes=9007199254740992-", "bytes=0-9007199254740992"])("rejects an unsupported or unsatisfiable range %s", async (range) => {
    const response = await mediaProxyResponse(source, request(range));
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
    expect(await response.text()).toBe("");
  });

  test("HEAD reports exact headers without reading a body", async () => {
    for (const range of [undefined, "bytes=3-5"]) {
      const response = await mediaProxyResponse(source, request(range, "HEAD"));
      expect(response.status).toBe(range ? 206 : 200);
      expect(response.headers.get("Content-Length")).toBe(range ? "3" : "10");
      expect(response.body).toBeNull();
    }
    expect((await mediaProxyResponse(source, request(undefined, "POST"))).status).toBe(405);
  });

  test("refuses revoked, changed, absent, directory, and symlink sources", async () => {
    const link = join(root, "link.mp4");
    await symlink(source.outputPath, link);
    for (const rejected of [
      { ...source, isAuthorityCurrent: () => false },
      { ...source, sizeBytes: 11 },
      { ...source, outputPath: join(root, "absent") },
      { ...source, outputPath: root },
      { ...source, outputPath: link },
    ]) expect((await mediaProxyResponse(rejected, request())).status).toBe(404);
    let checks = 0;
    expect((await mediaProxyResponse({ ...source, isAuthorityCurrent: () => ++checks === 1 }, request())).status).toBe(404);
    expect(checks).toBe(2);
  });

  test("revoking an output aborts its active response before the remaining bytes are delivered", async () => {
    const outputPath = join(root, "large.mp4");
    const sizeBytes = 2 * 1024 * 1024;
    await writeFile(outputPath, new Uint8Array(sizeBytes));
    const lifetime = new AbortController();
    const bound = { outputPath, sizeBytes, mimeType: "video/mp4", signal: lifetime.signal };
    const response = await mediaProxyResponse(bound, request());
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value!.byteLength).toBeLessThan(sizeBytes);
    lifetime.abort();
    await expect(reader.read()).rejects.toThrow();
    expect((await mediaProxyResponse(bound, request())).status).toBe(404);
  });

  test("an authority change after headers prevents body delivery", async () => {
    let current = true;
    const response = await mediaProxyResponse({ ...source, isAuthorityCurrent: () => current }, request());
    current = false;
    await expect(response.text()).rejects.toThrow("Media preview authority expired");
  });

  test("cancels a body and allows subsequent independent seeks", async () => {
    const response = await mediaProxyResponse(source, request());
    await response.body!.cancel();
    const next = await mediaProxyResponse(source, request("bytes=3-4"));
    expect(await next.text()).toBe("34");
  });
});
