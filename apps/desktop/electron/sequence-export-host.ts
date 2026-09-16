import { createHash } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { parseVideoHtml } from "../../../packages/first-party-apps/video/src/video-document";
import { buildSequenceRenderPlan } from "../../../packages/first-party-apps/video/src/render-plan";
import { normalizeVideoExportSettings, type VideoExportSettings } from "@nautilo/types";
import { renderSequence, type AuthorizedRenderSource, type SequenceRenderPlan, type SequenceRenderWarning } from "./sequence-renderer";
import { probeVideoMetadataWithFfmpeg } from "./ffmpeg-media-metadata";
import { copyMediaSnapshot, detectMediaFormat, mediaInputArguments } from "./media-source-inspection";

const execFile = promisify(nodeExecFile);
export type SequenceExportProgress = Readonly<{ stage: "preparing" | "rendering" | "saving" | "publishing"; processedTimeUs?: number }>;
export type SequenceWorkspacePublication = Readonly<{ status: "published" | "not_published" | "unknown"; path: string; artifactId?: string }>;
export type SequenceExportHostResult =
  | Readonly<{ status: "succeeded"; label: string; sizeBytes: number; warnings: readonly SequenceRenderWarning[]; workspace?: SequenceWorkspacePublication }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "failed"; code: string }>;

export interface SequenceExportHostDependencies {
  exportSettings?: VideoExportSettings;
  activeRoot: string;
  documentPath: string;
  expectedSha256: string;
  ffmpegPath: string;
  chooseOutput: (suggestedName: string) => Promise<string | null>;
  signal?: AbortSignal;
  onProgress?: (progress: SequenceExportProgress) => void;
  readFile?: typeof fsp.readFile;
  realpath?: typeof fsp.realpath;
  stat?: typeof fsp.stat;
  probeSource?: (ffmpegPath: string, sourcePath: string, format: AuthorizedRenderSource["format"], kind: "video" | "audio" | "image", signal?: AbortSignal) => Promise<{ hasVideo: boolean; hasAudio: boolean } | null>;
  render?: typeof renderSequence;
  makeTempDir?: (destinationDirectory: string) => Promise<string>;
  removeTempDir?: (value: string) => Promise<void>;
  link?: typeof fsp.link;
}

export interface SequencePublicationDependencies {
  plan: SequenceRenderPlan;
  sources: ReadonlyMap<string, AuthorizedRenderSource>;
  ffmpegPath: string;
  suggestedName: string;
  chooseOutput: (suggestedName: string) => Promise<string | null>;
  signal?: AbortSignal;
  onProgress?: (progress: SequenceExportProgress) => void;
  render?: typeof renderSequence;
  stat?: typeof fsp.stat;
  makeTempDir?: (destinationDirectory: string) => Promise<string>;
  removeTempDir?: (value: string) => Promise<void>;
  link?: typeof fsp.link;
  canPublish?: () => boolean;
  workspacePublication?: {
    path: string;
    publish: (stagedPath: string, sizeBytes: number) => Promise<SequenceWorkspacePublication>;
  };
}

/** Render to a private sibling directory and publish with one exclusive link. */
export async function renderAndPublishSequence(deps: SequencePublicationDependencies): Promise<SequenceExportHostResult> {
  let tempDir: string | null = null;
  try {
    if (deps.signal?.aborted || deps.canPublish?.() === false) return { status: "cancelled" };
    const output = await deps.chooseOutput(deps.suggestedName);
    if (!output || deps.signal?.aborted || deps.canPublish?.() === false) return { status: "cancelled" };
    if (path.extname(output).toLowerCase() !== ".mp4") return { status: "failed", code: "destination_must_be_mp4" };
    const stat = deps.stat ?? fsp.stat;
    try { await stat(output); return { status: "failed", code: "destination_exists" }; } catch { /* exclusive link below is authoritative */ }
    const destinationDirectory = path.dirname(output);
    tempDir = deps.makeTempDir ? await deps.makeTempDir(destinationDirectory) : await fsp.mkdtemp(path.join(destinationDirectory, ".nautilo-sequence-export-"));
    const staged = path.join(tempDir, "output.mp4");
    const rendered = await (deps.render ?? renderSequence)(deps.plan, {
      ffmpegPath: deps.ffmpegPath,
      sources: deps.sources,
      outputPath: staged,
      ...(deps.signal ? { signal: deps.signal } : {}),
      onProgress: (processedTimeUs) => deps.onProgress?.({ stage: "rendering", processedTimeUs }),
    });
    if (rendered.status !== "succeeded") return rendered;
    if (deps.signal?.aborted || deps.canPublish?.() === false) return { status: "cancelled" };
    deps.onProgress?.({ stage: "saving" });
    if (deps.signal?.aborted || deps.canPublish?.() === false) return { status: "cancelled" };
    // The local publication is a hard link and may immediately be edited by
    // its owner. Keep independent bytes for the optional Workspace upload.
    const workspaceStaged = path.join(tempDir, "workspace-output.mp4");
    if (deps.workspacePublication) await fsp.copyFile(staged, workspaceStaged, fsp.constants.COPYFILE_EXCL);
    if (deps.signal?.aborted || deps.canPublish?.() === false) return { status: "cancelled" };
    try { await (deps.link ?? fsp.link)(staged, output); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return { status: "failed", code: "destination_exists" };
      if (code === "EPERM" || code === "EOPNOTSUPP" || code === "ENOTSUP" || code === "EXDEV") return { status: "failed", code: "destination_filesystem_unsupported" };
      return { status: "failed", code: "processing_failed" };
    }
    // The completed exclusive link is the commit point. The verified staged
    // output size remains truthful even if a later event removes the pathname.
    let workspace: SequenceWorkspacePublication | undefined;
    if (deps.workspacePublication) {
      workspace = { status: "not_published", path: deps.workspacePublication.path };
      if (!deps.signal?.aborted && deps.canPublish?.() !== false) {
        try {
          deps.onProgress?.({ stage: "publishing" });
          workspace = await deps.workspacePublication.publish(workspaceStaged, rendered.sizeBytes);
        } catch {
          // No automatic retry: a lost response can follow a committed upload.
          workspace = { status: "unknown", path: deps.workspacePublication.path };
        }
      }
    }
    return { status: "succeeded", label: path.basename(output), sizeBytes: rendered.sizeBytes, warnings: rendered.warnings, ...(workspace ? { workspace } : {}) };
  } catch { return deps.signal?.aborted ? { status: "cancelled" } : { status: "failed", code: "processing_failed" }; }
  finally { if (tempDir) await (deps.removeTempDir ?? ((value) => fsp.rm(value, { recursive: true, force: true })))(tempDir).catch(() => {}); }
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function safeRef(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.includes(":") && !value.split("/").some((part) => !part || part === "." || part === "..");
}
export async function probeSequenceSource(ffmpegPath: string, sourcePath: string, format: AuthorizedRenderSource["format"], kind: "video" | "audio" | "image", signal?: AbortSignal): Promise<{ hasVideo: boolean; hasAudio: boolean } | null> {
  try {
    if (signal?.aborted) return null;
    if (kind === "video" && (format !== "mp4" || !await probeVideoMetadataWithFfmpeg(ffmpegPath, sourcePath, { ...(signal ? { signal } : {}) }))) return null;
    if (kind === "audio" && format !== "wav" && format !== "mp3" && format !== "mp4") return null;
    if (kind === "image" && format !== "png" && format !== "jpeg" && format !== "webp") return null;
    const result = await execFile(ffmpegPath, ["-hide_banner", ...mediaInputArguments(format), "-i", sourcePath, "-map", "0:v:0?", "-map", "0:a:0?", "-frames:v", "1", "-frames:a", kind === "image" ? "0" : "1", "-f", "null", "-"], { encoding: "utf8", ...(signal ? { signal } : {}) });
    return { hasVideo: /Stream #\S+.*Video:/u.test(result.stderr), hasAudio: /Stream #\S+.*Audio:/u.test(result.stderr) };
  } catch { return null; }
}

export async function exportCurrentFolderSequence(deps: SequenceExportHostDependencies): Promise<SequenceExportHostResult> {
  if (!normalizeVideoExportSettings(deps.exportSettings)) return { status: "failed", code: "invalid_settings" };
  if (!/^[a-f0-9]{64}$/u.test(deps.expectedSha256) || deps.signal?.aborted) return deps.signal?.aborted ? { status: "cancelled" } : { status: "failed", code: "invalid_request" };
  let sourceTempDir: string | null = null;
  try {
    const realpath = deps.realpath ?? fsp.realpath;
    const root = await realpath(deps.activeRoot);
    const documentPath = await realpath(deps.documentPath);
    if (!within(documentPath, root)) return { status: "failed", code: "document_unavailable" };
    const content = await (deps.readFile ?? fsp.readFile)(documentPath, "utf8");
    const actualSha = createHash("sha256").update(content).digest("hex");
    if (actualSha !== deps.expectedSha256) return { status: "failed", code: "document_changed" };
    const parsed = parseVideoHtml(content);
    if (!parsed.ok) return { status: "failed", code: "invalid_document" };
    const lowered = buildSequenceRenderPlan(parsed.document.project, undefined, deps.exportSettings ? { exportSettings: deps.exportSettings } : {});
    if (!lowered.ok || lowered.plan.durationSec <= 0) return { status: "failed", code: lowered.ok ? "empty_sequence" : lowered.error.code };
    deps.onProgress?.({ stage: "preparing" });
    const sources = new Map<string, AuthorizedRenderSource>();
    sourceTempDir = await fsp.mkdtemp(path.join(tmpdir(), "nautilo-sequence-sources-"));
    for (const layer of lowered.plan.layers) {
      if (!layer.mediaId || sources.has(layer.mediaId)) continue;
      const asset = parsed.document.project.media.find((item) => item.id === layer.mediaId);
      if (!asset || asset.lifecycle === "durable" || asset.source || !safeRef(asset.ref)) return { status: "failed", code: "workspace_media_unsupported" };
      const candidate = await realpath(path.resolve(path.dirname(documentPath), asset.ref));
      if (!within(candidate, root)) return { status: "failed", code: "source_unavailable" };
      const stat = await (deps.stat ?? fsp.stat)(candidate);
      if (!stat.isFile()) return { status: "failed", code: "source_unavailable" };
      const snapshot = path.join(sourceTempDir, `source-${sources.size}`);
      if (!await copyMediaSnapshot(candidate, snapshot, { ...(deps.signal ? { signal: deps.signal } : {}) })) {
        return deps.signal?.aborted ? { status: "cancelled" } : { status: "failed", code: "source_unavailable" };
      }
      const format = await detectMediaFormat(snapshot);
      if (!format) return { status: "failed", code: "unsupported_source_format" };
      const streams = await (deps.probeSource ?? probeSequenceSource)(deps.ffmpegPath, snapshot, format, asset.kind, deps.signal);
      if (deps.signal?.aborted) return { status: "cancelled" };
      if (!streams) return { status: "failed", code: "source_unavailable" };
      sources.set(asset.id, { canonicalPath: snapshot, format, ...streams });
    }
    if (deps.signal?.aborted) return { status: "cancelled" };
    const title = parsed.document.project.metadata?.title?.trim() || path.basename(documentPath).replace(/\.video\.html$/iu, "").replace(/\.html$/iu, "") || "video";
    return await renderAndPublishSequence({
      plan: lowered.plan, sources, ffmpegPath: deps.ffmpegPath, suggestedName: `${title}.mp4`, chooseOutput: deps.chooseOutput,
      ...(deps.signal ? { signal: deps.signal } : {}), ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      ...(deps.render ? { render: deps.render } : {}), ...(deps.stat ? { stat: deps.stat } : {}),
      ...(deps.makeTempDir ? { makeTempDir: deps.makeTempDir } : {}), ...(deps.removeTempDir ? { removeTempDir: deps.removeTempDir } : {}),
      ...(deps.link ? { link: deps.link } : {}),
    });
  } catch { return deps.signal?.aborted ? { status: "cancelled" } : { status: "failed", code: "processing_failed" }; }
  finally {
    if (sourceTempDir) await fsp.rm(sourceTempDir, { recursive: true, force: true }).catch(() => {});
  }
}
