import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";

/** Stream the exact staged source, including the byte ranges Chromium needs for seeking. */
export async function mediaProxyResponse(
  source: { outputPath: string; mimeType: string; sizeBytes: number; signal?: AbortSignal; isAuthorityCurrent?: () => boolean },
  request: Pick<Request, "method" | "headers">,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0 || (source.signal?.aborted || source.isAuthorityCurrent?.() === false)) return new Response(null, { status: 404 });
  const headers = new Headers({ "Content-Type": source.mimeType, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
  const range = request.headers.get("range");
  let start = 0;
  let end = source.sizeBytes - 1;
  if (range !== null) {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
    const rejectRange = () => new Response(null, { status: 416, headers: { "Content-Range": `bytes */${source.sizeBytes}`, "Accept-Ranges": "bytes" } });
    if (!match || (!match[1] && !match[2])) return rejectRange();
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return rejectRange();
      start = Math.max(0, source.sizeBytes - suffix);
    } else {
      start = Number(match[1]);
      const requestedEnd = match[2] ? Number(match[2]) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= source.sizeBytes || requestedEnd < start) return rejectRange();
      end = Math.min(end, requestedEnd);
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${source.sizeBytes}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(source.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== source.sizeBytes || (source.signal?.aborted || source.isAuthorityCurrent?.() === false)) return new Response(null, { status: 404 });
    if (request.method === "HEAD") return new Response(null, { status: range === null ? 200 : 206, headers });
    const stream = file.createReadStream({ start, end, autoClose: true, ...(source.signal ? { signal: source.signal } : {}) });
    file = undefined; // The stream owns this descriptor, including cancellation.
    const body = (Readable.toWeb(stream) as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (source.signal?.aborted || source.isAuthorityCurrent?.() === false) throw new Error("Media preview authority expired.");
        controller.enqueue(chunk);
      },
    }), source.signal ? { signal: source.signal } : undefined);
    return new Response(body, { status: range === null ? 200 : 206, headers });
  } catch {
    return new Response(null, { status: 404 });
  } finally {
    await file?.close();
  }
}
