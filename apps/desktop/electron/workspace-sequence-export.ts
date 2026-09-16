import { createHash } from "node:crypto";
import { normalizeVideoExportSettings, type VideoExportSettings } from "@nautilo/types";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseVideoHtml } from "../../../packages/first-party-apps/video/src/video-document";
import { buildSequenceRenderPlan } from "../../../packages/first-party-apps/video/src/render-plan";
import { isProjectRelativeMediaRef } from "../../../packages/first-party-apps/video/src/edl";
import { detectMediaFormat, inspectMediaSource } from "./media-source-inspection";
import { probeSequenceSource, renderAndPublishSequence, type SequenceExportHostResult, type SequenceExportProgress, type SequencePublicationDependencies } from "./sequence-export-host";
import type { AuthorizedRenderSource } from "./sequence-renderer";

export type WorkspaceSequenceSourceBinding = Readonly<{
  mediaId: string;
  artifactRowId: string;
  artifactId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
}>;

export type WorkspaceSequenceExportInput = Readonly<{
  documentContent: string;
  expectedSha256: string;
  roomId: string;
  sources: readonly WorkspaceSequenceSourceBinding[];
  exportSettings?: VideoExportSettings;
}>;

export interface WorkspaceSequenceExportDependencies {
  ffmpegPath: string;
  fetchSource: (source: WorkspaceSequenceSourceBinding, signal?: AbortSignal) => Promise<Response>;
  chooseOutput: (suggestedName: string) => Promise<string | null>;
  signal?: AbortSignal;
  onProgress?: (progress: SequenceExportProgress) => void;
  inspectSource?: typeof inspectMediaSource;
  probeSource?: typeof probeSequenceSource;
  publish?: (deps: SequencePublicationDependencies) => Promise<SequenceExportHostResult>;
  makeSourceTempDir?: () => Promise<string>;
  removeSourceTempDir?: (value: string) => Promise<void>;
  isAuthorityCurrent?: () => boolean;
  workspacePublication?: SequencePublicationDependencies["workspacePublication"];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function mimeForKind(kind: "video" | "audio" | "image", mime: string): boolean {
  return kind === "video" ? mime === "video/mp4" : kind === "audio"
    ? mime === "audio/mp4" || mime === "audio/wav" || mime === "audio/mpeg"
    : mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
}
function safeSuggestedName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").trim();
  return `${cleaned || "video"}.mp4`;
}

export async function downloadExactSource(response: Response, destination: string, expected: Pick<WorkspaceSequenceSourceBinding, "mimeType" | "sizeBytes">, signal?: AbortSignal, onWrittenChunk?: (chunk: Uint8Array) => void): Promise<boolean> {
  const rejectResponse = async (): Promise<false> => { await response.body?.cancel().catch(() => undefined); return false; };
  if (response.status !== 200 || response.redirected || response.type === "opaqueredirect" || response.body === null) return await rejectResponse();
  if ((response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== expected.mimeType) return await rejectResponse();
  const declaredRaw = response.headers.get("content-length");
  if (declaredRaw !== null && !/^\d+$/u.test(declaredRaw)) return await rejectResponse();
  const declared = declaredRaw === null ? null : Number(declaredRaw);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared !== expected.sizeBytes)) return await rejectResponse();
  const reader = response.body.getReader();
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  let complete = false;
  let written = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    handle = await fsp.open(destination, "wx", 0o600);
    while (true) {
      if (signal?.aborted) return false;
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > expected.sizeBytes - written) return false;
      let offset = 0;
      while (offset < next.value.byteLength) {
        if (signal?.aborted) return false;
        const result = await handle.write(next.value, offset, next.value.byteLength - offset, written + offset);
        if (result.bytesWritten <= 0) return false;
        offset += result.bytesWritten;
      }
      onWrittenChunk?.(next.value);
      written += next.value.byteLength;
    }
    complete = !signal?.aborted && written === expected.sizeBytes;
    return complete;
  } catch { return false; }
  finally {
    signal?.removeEventListener("abort", cancel);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await handle?.close().catch(() => undefined);
    if (!complete && handle) await fsp.unlink(destination).catch(() => undefined);
  }
}

export async function exportWorkspaceSequence(input: WorkspaceSequenceExportInput, deps: WorkspaceSequenceExportDependencies): Promise<SequenceExportHostResult> {
  let sourceRoot: string | null = null;
  try {
    if (deps.signal?.aborted || deps.isAuthorityCurrent?.() === false) return { status: "cancelled" };
    if (!/^[a-f0-9]{64}$/u.test(input.expectedSha256) || !UUID.test(input.roomId)) {
      return { status: "failed", code: "invalid_request" };
    }
    const parsed = parseVideoHtml(input.documentContent);
    if (!parsed.ok) return { status: "failed", code: "invalid_document" };
    if (createHash("sha256").update(input.documentContent).digest("hex") !== input.expectedSha256) return { status: "failed", code: "document_changed" };
    if (!normalizeVideoExportSettings(input.exportSettings)) return { status: "failed", code: "invalid_settings" };
    const lowered = buildSequenceRenderPlan(parsed.document.project, undefined, input.exportSettings ? { exportSettings: input.exportSettings } : {});
    if (!lowered.ok || lowered.plan.durationSec <= 0) return { status: "failed", code: lowered.ok ? "empty_sequence" : lowered.error.code };
    const byMedia = new Map<string, WorkspaceSequenceSourceBinding>();
    for (const source of input.sources) {
      if (!source || typeof source !== "object" || Object.keys(source).sort().join("\0") !== ["artifactId", "artifactRowId", "mediaId", "mimeType", "path", "sizeBytes"].join("\0") ||
          typeof source.mediaId !== "string" || byMedia.has(source.mediaId) ||
          typeof source.artifactRowId !== "string" || !UUID.test(source.artifactRowId) || typeof source.artifactId !== "string" || !UUID.test(source.artifactId) ||
          !isProjectRelativeMediaRef(source.path) || typeof source.mimeType !== "string" ||
          !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0) return { status: "failed", code: "invalid_source_binding" };
      byMedia.set(source.mediaId, source);
    }
    const usedIds = new Set(lowered.plan.layers.flatMap((layer) => layer.mediaId ? [layer.mediaId] : []));
    for (const mediaId of usedIds) {
      const asset = parsed.document.project.media.find((item) => item.id === mediaId);
      const binding = byMedia.get(mediaId);
      if (!asset || !binding || asset.lifecycle !== "durable" || !asset.source || asset.ref !== binding.path || asset.source.path !== binding.path ||
          asset.source.artifactId !== binding.artifactId || !mimeForKind(asset.kind, binding.mimeType)) return { status: "failed", code: "invalid_source_binding" };
    }
    if (byMedia.size !== usedIds.size) return { status: "failed", code: "invalid_source_binding" };
    deps.onProgress?.({ stage: "preparing" });
    sourceRoot = await (deps.makeSourceTempDir ?? (() => fsp.mkdtemp(path.join(tmpdir(), "nautilo-workspace-sequence-sources-"))))();
    const sources = new Map<string, AuthorizedRenderSource>();
    for (const mediaId of usedIds) {
      if (deps.signal?.aborted || deps.isAuthorityCurrent?.() === false) return { status: "cancelled" };
      const binding = byMedia.get(mediaId)!;
      const destination = path.join(sourceRoot, `source-${sources.size}`);
      const response = await deps.fetchSource(binding, deps.signal);
      if (!await downloadExactSource(response, destination, binding, deps.signal)) return deps.signal?.aborted ? { status: "cancelled" } : { status: "failed", code: "source_unavailable" };
      if (deps.isAuthorityCurrent?.() === false) return { status: "cancelled" };
      const inspected = await (deps.inspectSource ?? inspectMediaSource)(deps.ffmpegPath, destination, { ...(deps.signal ? { signal: deps.signal } : {}) });
      if (deps.signal?.aborted || deps.isAuthorityCurrent?.() === false) return { status: "cancelled" };
      const asset = parsed.document.project.media.find((item) => item.id === mediaId)!;
      if (!inspected || inspected.mediaKind !== asset.kind || inspected.mimeType !== binding.mimeType) return { status: "failed", code: "unsupported_source_format" };
      if (inspected.mediaKind !== "image" && lowered.plan.layers.some((layer) => layer.mediaId === mediaId && layer.sourceInSec + layer.durationSec > inspected.durationSec)) {
        return { status: "failed", code: "source_changed" };
      }
      const format = await detectMediaFormat(destination);
      if (!format) return { status: "failed", code: "unsupported_source_format" };
      const streams = await (deps.probeSource ?? probeSequenceSource)(deps.ffmpegPath, destination, format, asset.kind, deps.signal);
      if (deps.signal?.aborted || deps.isAuthorityCurrent?.() === false) return { status: "cancelled" };
      if (!streams) return { status: "failed", code: "source_unavailable" };
      sources.set(mediaId, { canonicalPath: destination, format, ...streams });
    }
    if (deps.signal?.aborted || deps.isAuthorityCurrent?.() === false) return { status: "cancelled" };
    const title = parsed.document.project.metadata?.title?.trim() || "video";
    return await (deps.publish ?? renderAndPublishSequence)({
      plan: lowered.plan, sources, ffmpegPath: deps.ffmpegPath, suggestedName: safeSuggestedName(title), chooseOutput: deps.chooseOutput,
      ...(deps.signal ? { signal: deps.signal } : {}), ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      ...(deps.isAuthorityCurrent ? { canPublish: deps.isAuthorityCurrent } : {}),
      ...(deps.workspacePublication ? { workspacePublication: deps.workspacePublication } : {}),
    });
  } catch { return deps.signal?.aborted || deps.isAuthorityCurrent?.() === false ? { status: "cancelled" } : { status: "failed", code: "processing_failed" }; }
  finally { if (sourceRoot) await (deps.removeSourceTempDir ?? ((value) => fsp.rm(value, { recursive: true, force: true })))(sourceRoot).catch(() => undefined); }
}
