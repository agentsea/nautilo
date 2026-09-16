import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { VideoProject } from "../../../packages/first-party-apps/video/src/edl";
import { parseVideoHtml, serializeVideoHtml } from "../../../packages/first-party-apps/video/src/video-document";
import { copyMediaSnapshot, detectMediaFormat, type SourceFormat } from "./media-source-inspection";
import { publishFileToWorkspace, type WorkspaceFilePublication } from "./sequence-workspace-publication";

export type VideoProjectPromotionResult =
  | Readonly<{ status: "succeeded"; document: { id: string; artifactId: string; path: string; mimeType: "text/html" }; mediaCount: number }>
  | Readonly<{ status: "failed" | "unknown" | "cancelled"; code: string; retainedPaths: string[] }>;

/** Losing disclosure authority after effects is uncertainty, not proof of cancellation. */
export function projectVideoPromotionResult(result: VideoProjectPromotionResult, mayDisclose: boolean): VideoProjectPromotionResult {
  return mayDisclose ? result : { status: "unknown", code: "authority_changed", retainedPaths: [] };
}

export type VideoProjectPromotionProgress = Readonly<{
  stage: "preparing" | "uploading_media" | "publishing_document" | "cleaning_up";
  completed?: number;
  total?: number;
}>;

type PromotionAuthority = Readonly<{
  rootPath: string;
  roomId: string;
  serverUrl: string;
  bearer: string;
  isAuthorityCurrent: () => boolean;
  signal?: AbortSignal;
  onProgress?: (progress: VideoProjectPromotionProgress) => void;
  fetch?: typeof fetch;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mediaType(kind: "video" | "audio" | "image", format: SourceFormat): { mimeType: string; extension: string } | null {
  if (kind === "video" && format === "mp4") return { mimeType: "video/mp4", extension: "mp4" };
  if (kind === "audio" && format === "mp4") return { mimeType: "audio/mp4", extension: "m4a" };
  if (kind === "audio" && format === "wav") return { mimeType: "audio/wav", extension: "wav" };
  if (kind === "audio" && format === "mp3") return { mimeType: "audio/mpeg", extension: "mp3" };
  if (kind === "image" && format === "png") return { mimeType: "image/png", extension: "png" };
  if (kind === "image" && format === "jpeg") return { mimeType: "image/jpeg", extension: "jpg" };
  if (kind === "image" && format === "webp") return { mimeType: "image/webp", extension: "webp" };
  return null;
}

function safeTitle(value: string): string {
  return value.replace(/\.video\.html$/iu, "").replace(/\.html$/iu, "")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").trim() || "video";
}

async function removeCreated(
  created: readonly { id: string; path: string }[], authority: PromotionAuthority,
): Promise<string[]> {
  if (created.length === 0) return [];
  if (authority.signal?.aborted || !authority.isAuthorityCurrent()) return created.map((entry) => entry.path);
  authority.onProgress?.({ stage: "cleaning_up", completed: 0, total: created.length });
  const retained: string[] = [];
  const controller = new AbortController();
  const abortCleanup = () => controller.abort(authority.signal?.reason);
  authority.signal?.addEventListener("abort", abortCleanup, { once: true });
  try {
  for (let index = created.length - 1; index >= 0; index--) {
    const item = created[index]!;
    if (controller.signal.aborted || !authority.isAuthorityCurrent()) {
      retained.push(...created.slice(0, index + 1).map((entry) => entry.path));
      break;
    }
    try {
      const response = await (authority.fetch ?? fetch)(`${authority.serverUrl.replace(/\/$/u, "")}/api/workspace/artifacts/${encodeURIComponent(item.id)}?roomId=${encodeURIComponent(authority.roomId)}`, {
        method: "DELETE", headers: { authorization: `Bearer ${authority.bearer}` }, redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected) retained.push(item.path);
      await response.body?.cancel().catch(() => undefined);
    } catch { retained.push(item.path); }
    authority.onProgress?.({ stage: "cleaning_up", completed: created.length - index, total: created.length });
  }
  return retained;
  } finally { authority.signal?.removeEventListener("abort", abortCleanup); }
}

function hasWorkspaceGenerationBindings(project: VideoProject): boolean {
  if (project.generatedTakes && project.generatedTakes.length > 0) return true;
  const brief = project.generationBrief;
  if (!brief) return false;
  const references = [
    ...brief.references,
    ...brief.shots.flatMap((shot) => shot.references),
    ...brief.blocks.flatMap((block) => block.references ?? []),
  ];
  return references.some((reference) => reference.source?.kind === "workspace-artifact");
}

async function sourcePathIdentity(base: string, ref: string): Promise<string[] | null> {
  let cursor = base;
  const identity: string[] = [];
  for (const segment of ref.split("/")) {
    cursor = path.join(cursor, segment);
    const entry = await fsp.lstat(cursor);
    if (entry.isSymbolicLink()) return null;
    identity.push(`${entry.dev}:${entry.ino}:${entry.ctimeMs}`);
  }
  return identity;
}

export async function promoteVideoProject(
  input: Readonly<{ documentPath: string; expectedSha256: string }>,
  authority: PromotionAuthority,
): Promise<VideoProjectPromotionResult> {
  const cancelled = () => authority.signal?.aborted === true || !authority.isAuthorityCurrent();
  const failure = (status: "failed" | "unknown" | "cancelled", code: string, retainedPaths: string[] = []): VideoProjectPromotionResult =>
    ({ status, code, retainedPaths });
  if (!SHA256.test(input.expectedSha256) || !UUID.test(authority.roomId)) return failure("failed", "invalid_request");
  if (cancelled()) return failure("cancelled", "cancelled");

  let tempRoot: string | null = null;
  const created: { id: string; path: string }[] = [];
  try {
    authority.onProgress?.({ stage: "preparing" });
    const root = await fsp.realpath(authority.rootPath);
    const documentPath = await fsp.realpath(input.documentPath);
    if (!within(documentPath, root)) return failure("failed", "document_unavailable");
    const documentContent = await fsp.readFile(documentPath, "utf8");
    if (createHash("sha256").update(documentContent).digest("hex") !== input.expectedSha256) return failure("failed", "document_changed");
    const parsed = parseVideoHtml(documentContent);
    if (!parsed.ok) return failure("failed", "invalid_document");
    // A durable source belongs to another authority. Reject the complete plan
    // before creating anything rather than silently dropping or copying it.
    if (parsed.document.project.media.some((asset) => asset.lifecycle === "durable" || asset.source !== undefined)) {
      return failure("failed", "mixed_workspace_authority_unsupported");
    }
    if (hasWorkspaceGenerationBindings(parsed.document.project)) {
      return failure("failed", "workspace_generation_binding_unsupported");
    }
    const kindsByRef = new Map<string, string>();
    for (const asset of parsed.document.project.media) {
      const prior = kindsByRef.get(asset.ref);
      if (prior !== undefined && prior !== asset.kind) return failure("failed", "conflicting_media_reference");
      kindsByRef.set(asset.ref, asset.kind);
    }
    if (cancelled()) return failure("cancelled", "cancelled");

    tempRoot = await fsp.mkdtemp(path.join(tmpdir(), "nautilo-video-project-promotion-"));
    const runId = randomUUID();
    const byRef = new Map<string, { stagedPath: string; mimeType: string; workspacePath: string }>();
    for (const asset of parsed.document.project.media) {
      if (byRef.has(asset.ref)) continue;
      if (cancelled()) return failure("cancelled", "cancelled");
      const sourceIdentity = await sourcePathIdentity(path.dirname(documentPath), asset.ref);
      if (!sourceIdentity) return failure("failed", "source_unavailable");
      const requested = path.resolve(path.dirname(documentPath), asset.ref);
      const linkEntry = await fsp.lstat(requested);
      if (linkEntry.isSymbolicLink()) return failure("failed", "source_unavailable");
      const candidate = await fsp.realpath(requested);
      if (!within(candidate, root)) return failure("failed", "source_unavailable");
      const stagedPath = path.join(tempRoot, `media-${byRef.size}`);
      if (!await copyMediaSnapshot(candidate, stagedPath, { ...(authority.signal ? { signal: authority.signal } : {}) })) {
        return failure(cancelled() ? "cancelled" : "failed", cancelled() ? "cancelled" : "source_changed");
      }
      const afterIdentity = await sourcePathIdentity(path.dirname(documentPath), asset.ref);
      if (!afterIdentity || afterIdentity.length !== sourceIdentity.length || afterIdentity.some((value, index) => value !== sourceIdentity[index])) {
        return failure("failed", "source_changed");
      }
      const format = await detectMediaFormat(stagedPath);
      const classified = format ? mediaType(asset.kind, format) : null;
      if (!classified) return failure("failed", "unsupported_source_format");
      byRef.set(asset.ref, {
        stagedPath, mimeType: classified.mimeType,
        workspacePath: `video-imports/${runId}/${randomUUID()}.${classified.extension}`,
      });
    }

    const publishedByRef = new Map<string, WorkspaceFilePublication & { id: string; artifactId: string }>();
    let completed = 0;
    for (const [ref, source] of byRef) {
      if (cancelled()) {
        const retained = await removeCreated(created, authority);
        return failure("cancelled", "cancelled", retained);
      }
      authority.onProgress?.({ stage: "uploading_media", completed, total: byRef.size });
      const stat = await fsp.stat(source.stagedPath);
      const result = await publishFileToWorkspace({
        stagedPath: source.stagedPath, sizeBytes: stat.size, workspacePath: source.workspacePath,
        mimeType: source.mimeType, roomId: authority.roomId, serverUrl: authority.serverUrl,
        bearer: authority.bearer, isAuthorityCurrent: authority.isAuthorityCurrent,
        ...(authority.signal ? { signal: authority.signal } : {}),
      }, { ...(authority.fetch ? { fetch: authority.fetch } : {}) });
      if (result.status !== "published" || !result.id || !result.artifactId) {
        const retained = await removeCreated(created, authority);
        if (result.status === "unknown") retained.push(source.workspacePath);
        return failure(result.status === "unknown" ? "unknown" : cancelled() ? "cancelled" : "failed",
          result.status === "unknown" ? "media_publication_unknown" : cancelled() ? "cancelled" : "media_publication_failed", retained);
      }
      created.push({ id: result.id, path: result.path });
      publishedByRef.set(ref, result as WorkspaceFilePublication & { id: string; artifactId: string });
      completed += 1;
    }

    const rewrittenProject = {
      ...parsed.document.project,
      media: parsed.document.project.media.map((asset) => {
        const publication = publishedByRef.get(asset.ref)!;
        return { ...asset, ref: publication.path, lifecycle: "durable" as const,
          source: { kind: "workspace-artifact" as const, artifactId: publication.artifactId, path: publication.path } };
      }),
    };
    const rewritten = serializeVideoHtml(parsed.document.manifest, rewrittenProject);
    if (!parseVideoHtml(rewritten).ok) {
      const retained = await removeCreated(created, authority);
      return failure("failed", "rewritten_document_invalid", retained);
    }
    const documentStaged = path.join(tempRoot, "project.video.html");
    await fsp.writeFile(documentStaged, rewritten, { flag: "wx", mode: 0o600 });
    const documentWorkspacePath = `video-projects/${runId}/${safeTitle(parsed.document.project.metadata?.title ?? path.basename(documentPath))}.video.html`;
    if (cancelled()) {
      const retained = await removeCreated(created, authority);
      return failure("cancelled", "cancelled", retained);
    }
    const latestDocument = await fsp.readFile(documentPath, "utf8");
    if (createHash("sha256").update(latestDocument).digest("hex") !== input.expectedSha256) {
      const retained = await removeCreated(created, authority);
      return failure("failed", "document_changed", retained);
    }
    authority.onProgress?.({ stage: "publishing_document" });
    const documentStat = await fsp.stat(documentStaged);
    const documentResult = await publishFileToWorkspace({
      stagedPath: documentStaged, sizeBytes: documentStat.size, workspacePath: documentWorkspacePath,
      mimeType: "text/html", roomId: authority.roomId, serverUrl: authority.serverUrl,
      bearer: authority.bearer, isAuthorityCurrent: authority.isAuthorityCurrent,
      ...(authority.signal ? { signal: authority.signal } : {}),
    }, { ...(authority.fetch ? { fetch: authority.fetch } : {}) });
    if (documentResult.status === "unknown") {
      return failure("unknown", "document_publication_unknown", [...created.map((item) => item.path), documentWorkspacePath]);
    }
    if (documentResult.status !== "published" || !documentResult.id || !documentResult.artifactId) {
      const retained = await removeCreated(created, authority);
      return failure(cancelled() ? "cancelled" : "failed", cancelled() ? "cancelled" : "document_publication_failed", retained);
    }
    return { status: "succeeded", document: { id: documentResult.id, artifactId: documentResult.artifactId,
      path: documentResult.path, mimeType: "text/html" }, mediaCount: byRef.size };
  } catch {
    const retained = await removeCreated(created, authority);
    return failure(cancelled() ? "cancelled" : "failed", cancelled() ? "cancelled" : "processing_failed", retained);
  } finally {
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
