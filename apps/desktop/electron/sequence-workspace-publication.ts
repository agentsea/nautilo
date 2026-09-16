import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { SequenceWorkspacePublication } from "./sequence-export-host";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKSPACE_UPLOAD_MIME_TYPES = new Set([
  "video/mp4", "audio/mp4", "audio/mpeg", "audio/wav",
  "image/png", "image/jpeg", "image/webp", "text/html",
]);

export type WorkspaceFilePublication = Readonly<{
  status: "published" | "not_published" | "unknown";
  path: string;
  id?: string;
  artifactId?: string;
}>;

/** Only main creates the logical destination; neither the iframe nor a file
 * pathname can select an upload endpoint or another room. */
export function sequenceWorkspaceOutputPath(suggestedName: string): string {
  const stem = suggestedName.replace(/\.mp4$/iu, "").replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").trim() || "video";
  return `exports/${stem}-${randomUUID()}.mp4`;
}

export async function publishFileToWorkspace(input: {
  stagedPath: string;
  sizeBytes: number;
  workspacePath: string;
  mimeType: string;
  roomId: string;
  serverUrl: string;
  bearer: string;
  signal?: AbortSignal;
  isAuthorityCurrent: () => boolean;
}, deps: { fetch?: typeof fetch } = {}): Promise<WorkspaceFilePublication> {
  const result = (status: WorkspaceFilePublication["status"]): WorkspaceFilePublication => ({ status, path: input.workspacePath });
  if (input.signal?.aborted || !input.isAuthorityCurrent()) return result("not_published");
  if (!UUID.test(input.roomId) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 ||
      !WORKSPACE_UPLOAD_MIME_TYPES.has(input.mimeType) || /[\r\n"\\:\p{Cc}]/u.test(input.workspacePath) || input.workspacePath.startsWith("/") ||
      input.workspacePath.split("/").some((part) => !part || part === "." || part === "..")) return result("not_published");
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let body: Readable | undefined;
  let sourceStream: ReturnType<Awaited<ReturnType<typeof open>>["createReadStream"]> | undefined;
  let started = false;
  try {
    file = await open(input.stagedPath, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== input.sizeBytes) return result("not_published");
    const boundary = `nautilo-${randomUUID()}`;
    const filename = input.workspacePath.split("/").at(-1)!;
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${input.workspacePath}\r\n--${boundary}\r\nContent-Disposition: form-data; name="mimeType"\r\n\r\n${input.mimeType}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const length = prefix.length + input.sizeBytes + suffix.length;
    if (!Number.isSafeInteger(length)) return result("not_published");
    const stream = file.createReadStream({ autoClose: false, start: 0, end: input.sizeBytes - 1 });
    sourceStream = stream;
    body = Readable.from((async function* () {
      yield prefix;
      let sent = 0;
      for await (const chunk of stream) {
        if (input.signal?.aborted || !input.isAuthorityCurrent()) throw new Error("authority_changed");
        sent += (chunk as Buffer).length;
        yield chunk;
      }
      if (sent !== input.sizeBytes) throw new Error("source_changed");
      yield suffix;
    })());
    if (input.signal?.aborted || !input.isAuthorityCurrent()) { stream.destroy(); return result("not_published"); }
    const endpoint = `${input.serverUrl.replace(/\/$/u, "")}/api/workspace/artifacts?roomId=${encodeURIComponent(input.roomId)}`;
    started = true;
    const response = await (deps.fetch ?? fetch)(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${input.bearer}`, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(length) },
      body: body as unknown as BodyInit,
      duplex: "half",
      redirect: "error",
      ...(input.signal ? { signal: input.signal } : {}),
    } as RequestInit & { duplex: "half" });
    // An explicit admission rejection is safe to report; transport failure,
    // server failure, or malformed success can hide a committed artifact.
    if ([400, 401, 403, 409, 413, 415].includes(response.status)) {
      await response.body?.cancel();
      return result("not_published");
    }
    if (!response.ok || response.redirected) { await response.body?.cancel(); return result("unknown"); }
    const value = await response.json() as Record<string, unknown>;
    if (typeof value["id"] !== "string" || !UUID.test(value["id"]) || typeof value["artifactId"] !== "string" || !UUID.test(value["artifactId"]) ||
        value["path"] !== input.workspacePath || value["size"] !== input.sizeBytes || value["mimeType"] !== input.mimeType) return result("unknown");
    return { status: "published", path: input.workspacePath, id: value["id"], artifactId: value["artifactId"] };
  } catch { return result(started ? "unknown" : "not_published"); }
  finally {
    body?.destroy();
    sourceStream?.destroy();
    await file?.close().catch(() => undefined);
  }
}

export async function publishSequenceToWorkspace(input: {
  stagedPath: string; sizeBytes: number; workspacePath: string; roomId: string;
  serverUrl: string; bearer: string; signal?: AbortSignal; isAuthorityCurrent: () => boolean;
}, deps: { fetch?: typeof fetch } = {}): Promise<SequenceWorkspacePublication> {
  const published = await publishFileToWorkspace({ ...input, mimeType: "video/mp4" }, deps);
  return published.status === "published"
    ? { status: "published", path: published.path, ...(published.artifactId ? { artifactId: published.artifactId } : {}) }
    : { status: published.status, path: published.path };
}
