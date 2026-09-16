import { workspaceMediaMimeMatchesInspection } from "@nautilo/types";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { WorkspaceMediaArtifact, WorkspaceMediaBatchImportData, WorkspaceMediaImportData } from "@nautilo/types";
import { copyMediaSnapshot, inspectMediaSource, type InspectedMedia } from "./media-source-inspection";
import { publishFileToWorkspace } from "./sequence-workspace-publication";
import { downloadExactSource } from "./workspace-sequence-export";
import { inspectMediaWaveform, type MediaWaveform } from "./media-waveform";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const isWorkspaceMediaRoom = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export interface WorkspaceMediaDependencies {
  serverUrl: string; bearer: string; roomId: string; ffmpegPath: string;
  signal: AbortSignal; isAuthorityCurrent: () => boolean;
  fetch?: typeof fetch; inspect?: typeof inspectMediaSource;
  waveform?: typeof inspectMediaWaveform;
}
function current(deps: WorkspaceMediaDependencies): boolean { return !deps.signal.aborted && deps.isAuthorityCurrent(); }
function endpoint(deps: WorkspaceMediaDependencies, id: string, suffix = ""): string {
  return `${deps.serverUrl.replace(/\/$/u, "")}/api/workspace/artifacts/${encodeURIComponent(id)}${suffix}?roomId=${encodeURIComponent(deps.roomId)}`;
}
async function getArtifact(deps: WorkspaceMediaDependencies, id: string): Promise<{ artifact: WorkspaceMediaArtifact | null; httpStatus?: number }> {
  if (!current(deps)) return { artifact: null };
  const response = await (deps.fetch ?? fetch)(endpoint(deps, id), {
    headers: { authorization: `Bearer ${deps.bearer}` }, redirect: "error", signal: deps.signal,
  });
  if (!response.ok || response.redirected) { await response.body?.cancel(); return { artifact: null, httpStatus: response.status }; }
  const value: unknown = await response.json();
  return { artifact: isWorkspaceMediaArtifact(value) ? value : null, httpStatus: response.status };
}
export function isWorkspaceMediaArtifact(value: unknown): value is WorkspaceMediaArtifact {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v["id"] === "string" && UUID.test(v["id"]) && typeof v["artifactId"] === "string" && UUID.test(v["artifactId"]) &&
    typeof v["path"] === "string" && !v["path"].startsWith("/") && !/[\\\p{Cc}]/u.test(v["path"]) && !v["path"].split("/").some((p) => !p || p === "." || p === "..") &&
    typeof v["mimeType"] === "string" && ["video/mp4", "audio/mp4", "audio/wav", "audio/x-wav", "audio/mpeg", "image/png", "image/jpeg", "image/webp"].includes(v["mimeType"]) &&
    Number.isSafeInteger(v["size"]) && (v["size"] as number) > 0 && Number.isSafeInteger(v["revision"]) && (v["revision"] as number) >= 0;
}
function sameArtifact(a: WorkspaceMediaArtifact | null, b: WorkspaceMediaArtifact): boolean {
  return a !== null && a.id === b.id && a.artifactId === b.artifactId && a.path === b.path &&
    a.mimeType === b.mimeType && a.size === b.size && a.revision === b.revision;
}

/** Private immutable staging, reused by the range-serving preview protocol. Caller owns cleanup only on success. */
export type WorkspaceMediaStageFailureCode = "source_metadata_unavailable" | "source_changed" | "source_bytes_unavailable" | "source_inspection_unavailable";
export type WorkspaceMediaStageResult =
  | { ok: true; data: { parentDir: string; outputPath: string; sha256: string; metadata: InspectedMedia; waveform?: MediaWaveform } }
  | { ok: false; code: WorkspaceMediaStageFailureCode; httpStatus?: number };

export async function stageWorkspaceMedia(artifact: WorkspaceMediaArtifact, deps: WorkspaceMediaDependencies): Promise<WorkspaceMediaStageResult> {
  const fail = (code: WorkspaceMediaStageFailureCode, httpStatus?: number): WorkspaceMediaStageResult =>
    ({ ok: false, code, ...(httpStatus !== undefined ? { httpStatus } : {}) });
  if (!isWorkspaceMediaRoom(deps.roomId) || !isWorkspaceMediaArtifact(artifact) || !current(deps)) return fail("source_changed");
  let parentDir: string | undefined;
  let retained = false;
  let phase: WorkspaceMediaStageFailureCode = "source_metadata_unavailable";
  try {
    const initial = await getArtifact(deps, artifact.id);
    if (!initial.artifact) return fail("source_metadata_unavailable", initial.httpStatus);
    if (!sameArtifact(initial.artifact, artifact) || !current(deps)) return fail("source_changed");
    parentDir = await fs.mkdtemp(path.join(tmpdir(), "nautilo-workspace-preview-"));
    const outputPath = path.join(parentDir, "source");
    phase = "source_bytes_unavailable";
    const response = await (deps.fetch ?? fetch)(endpoint(deps, artifact.id, "/bytes"), {
      headers: { authorization: `Bearer ${deps.bearer}` }, redirect: "error", signal: deps.signal,
    });
    // Hash only the exact chunks already written to the private snapshot.
    const contentHash = createHash("sha256");
    if (!await downloadExactSource(response, outputPath, { mimeType: artifact.mimeType, sizeBytes: artifact.size }, deps.signal, (chunk) => { contentHash.update(chunk); })) return fail("source_bytes_unavailable", response.status);
    // A same-sized replacement is still a different revision. Never promote a
    // mixed or stale download to a playable capability.
    phase = "source_metadata_unavailable";
    const final = await getArtifact(deps, artifact.id);
    if (!final.artifact) return fail("source_metadata_unavailable", final.httpStatus);
    if (!sameArtifact(final.artifact, artifact) || !current(deps)) return fail("source_changed");
    phase = "source_inspection_unavailable";
    const metadata = await (deps.inspect ?? inspectMediaSource)(deps.ffmpegPath, outputPath, { signal: deps.signal });
    if (!metadata || !workspaceMediaMimeMatchesInspection(artifact.mimeType, metadata.mimeType)) return fail("source_inspection_unavailable");
    if (!current(deps)) return fail("source_changed");
    const waveform = metadata.mediaKind === "image" ? null : await (deps.waveform ?? inspectMediaWaveform)(deps.ffmpegPath, outputPath, deps.signal);
    if (!current(deps)) return fail("source_changed");
    retained = true;
    return { ok: true, data: { parentDir, outputPath, sha256: contentHash.digest("hex"), metadata, ...(waveform ? { waveform } : {}) } };
  } catch { return fail(current(deps) ? phase : "source_changed"); }
  finally { if (parentDir && !retained) await fs.rm(parentDir, { recursive: true, force: true }).catch(() => undefined); }
}

/** The native picker is the authority for this source; only a private snapshot is inspected/uploaded. */
export async function importPickedWorkspaceMedia(sourcePath: string, mediaKind: WorkspaceMediaImportData["mediaKind"] | undefined, deps: WorkspaceMediaDependencies): Promise<
  { ok: true; data: WorkspaceMediaImportData } | { ok: false; error: { code: string } }
> {
  const fail = (code: string) => ({ ok: false as const, error: { code } });
  if (!current(deps) || !isWorkspaceMediaRoom(deps.roomId)) return fail("cancelled");
  const root = await fs.mkdtemp(path.join(tmpdir(), "nautilo-workspace-import-"));
  try {
    const stagedPath = path.join(root, "source");
    if (!await copyMediaSnapshot(sourcePath, stagedPath, { signal: deps.signal })) return fail("source_unavailable");
    const metadata = await (deps.inspect ?? inspectMediaSource)(deps.ffmpegPath, stagedPath, { signal: deps.signal });
    if (!metadata || (mediaKind !== undefined && metadata.mediaKind !== mediaKind)) return fail("unsupported_type");
    if (!current(deps)) return fail("cancelled");
    const sizeBytes = (await fs.stat(stagedPath)).size;
    const workspacePath = `${mediaKind ? "video-references" : "video-imports"}/${randomUUID()}.${metadata.extension}`;
    const published = await publishFileToWorkspace({
      stagedPath, sizeBytes, workspacePath, mimeType: metadata.mimeType, roomId: deps.roomId,
      serverUrl: deps.serverUrl, bearer: deps.bearer, signal: deps.signal, isAuthorityCurrent: deps.isAuthorityCurrent,
    }, deps.fetch ? { fetch: deps.fetch } : {});
    if (published.status !== "published" || !published.id || !published.artifactId) return fail(published.status === "unknown" ? "upload_unknown" : "upload_unavailable");
    // Return a committed receipt even if cancellation won afterwards. The
    // Workbench can remove this exact unattached upload instead of replaying it.
    return { ok: true, data: {
      label: path.basename(sourcePath), mediaKind: metadata.mediaKind,
      artifact: { id: published.id, artifactId: published.artifactId, path: workspacePath, mimeType: metadata.mimeType, size: sizeBytes },
      ...(metadata.mediaKind !== "image" ? { durationSec: metadata.durationSec } : {}),
      ...(metadata.mediaKind === "video" ? { frameRate: metadata.frameRate } : {}),
    } };
  } catch { return fail(current(deps) ? "upload_unavailable" : "cancelled"); }
  finally { await fs.rm(root, { recursive: true, force: true }).catch(() => undefined); }
}

/** Imports native-picked media in picker order and stops when authority is lost. */
export async function importPickedWorkspaceMediaBatch(
  sourcePaths: readonly string[],
  deps: WorkspaceMediaDependencies,
  mediaKind: "image" | "video" | "audio" | null = "image",
): Promise<WorkspaceMediaBatchImportData> {
  const results: WorkspaceMediaBatchImportData["results"][number][] = [];
  for (const sourcePath of sourcePaths) {
    if (!current(deps)) {
      results.push({ ok: false, label: path.basename(sourcePath), error: { code: "cancelled" } });
      continue;
    }
    const result = await importPickedWorkspaceMedia(sourcePath, mediaKind ?? undefined, deps);
    results.push(result.ok ? result : { ...result, label: path.basename(sourcePath) });
  }
  return { results };
}
