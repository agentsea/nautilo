import { desktopVideoEncoderArgs } from "./video-encoder";
import { spawn as nodeSpawn } from "node:child_process";
import { normalizeVideoExportSettings, type VideoExportSettings } from "@nautilo/types";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { rasterizeSequenceText } from "./sequence-text-raster";
import { isTextCompositionKind } from "../../../packages/first-party-apps/video/src/text-composition";
import { validFades, type Fades } from "../../../packages/first-party-apps/video/src/fades";
import { validTransitionRamp, type TransitionRamp } from "../../../packages/first-party-apps/video/src/transitions";

type RenderLayer = Readonly<{
  clipId: string; kind: "video" | "audio" | "image" | "text" | "caption" | "callout";
  trackKind: "video" | "overlay" | "caption" | "audio" | "music";
  mediaId?: string; timelineStartSec: number; durationSec: number; sourceInSec: number;
  visual: boolean; gain: number; text?: string;
  fades?: Fades;
  transitionIn?: TransitionRamp;
  transitionOut?: TransitionRamp;
}>;
export type SequenceRenderPlan = Readonly<{
  version: 1; durationSec: number; width: number; height: number;
  frameRate: Readonly<{ numerator: number; denominator: number }>;
  exportSettings?: VideoExportSettings;
  layers: readonly RenderLayer[];
}>;
export type AuthorizedRenderSource = Readonly<{ canonicalPath: string; format: "mp4" | "wav" | "mp3" | "png" | "jpeg" | "webp"; hasVideo: boolean; hasAudio: boolean }>;
export type SequenceRenderWarning = Readonly<{ code: "missing_audio_stream"; mediaId: string; clipId: string }>;
export type SequenceRenderResult =
  | Readonly<{ status: "succeeded"; sizeBytes: number; warnings: readonly SequenceRenderWarning[] }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "failed"; code: "invalid_plan" | "source_unavailable" | "ffmpeg_unavailable" | "processing_failed" | "invalid_output" | "text_overflow" }>;

export interface SequenceRendererDependencies {
  ffmpegPath: string;
  sources: ReadonlyMap<string, AuthorizedRenderSource>;
  outputPath: string;
  signal?: AbortSignal;
  onProgress?: (processedTimeUs: number) => void;
  spawn?: typeof nodeSpawn;
  stat?: typeof fsp.stat;
  readHeader?: (path: string) => Promise<Uint8Array>;
  rasterizeText?: typeof rasterizeSequenceText;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
function validLayer(value: unknown, durationSec: number): value is RenderLayer {
  if (!record(value)) return false;
  const mediaId = value["mediaId"]; const text = value["text"];
  return exact(value, ["clipId", "kind", "trackKind", ...(mediaId === undefined ? [] : ["mediaId"]), "timelineStartSec", "durationSec", "sourceInSec", "visual", "gain", ...(text === undefined ? [] : ["text"]), ...(value["fades"] === undefined ? [] : ["fades"]), ...["transitionIn", "transitionOut"].filter((key) => value[key] !== undefined)]) &&
    ["transitionIn", "transitionOut"].every((key) => value[key] === undefined || (value["kind"] === "video" && validTransitionRamp(value[key]))) &&
    (value["fades"] === undefined || (validFades(value["fades"]) && (value["kind"] === "video" || (value["kind"] === "audio" && Object.keys(value["fades"]).every((key) => key.startsWith("audio")))))) &&
    typeof value["kind"] === "string" && ["video", "audio", "image", "text", "caption", "callout"].includes(value["kind"]) &&
    typeof value["trackKind"] === "string" && ["video", "overlay", "caption", "audio", "music"].includes(value["trackKind"]) &&
    finite(value["timelineStartSec"]) && value["timelineStartSec"] >= 0 && finite(value["durationSec"]) && value["durationSec"] > 0 &&
    value["timelineStartSec"] + value["durationSec"] <= durationSec + 0.000_001 && finite(value["sourceInSec"]) && value["sourceInSec"] >= 0 &&
    finite(value["gain"]) && value["gain"] >= 0 && value["gain"] <= 1 && typeof value["visual"] === "boolean" && typeof value["clipId"] === "string" && value["clipId"].length > 0 &&
    (["video", "audio", "image"].includes(value["kind"]) ? typeof mediaId === "string" && mediaId.length > 0 && text === undefined : typeof text === "string" && mediaId === undefined && value["gain"] === 0);
}
function validPlan(value: unknown): value is SequenceRenderPlan {
  if (!record(value) || !exact(value, ["version", "durationSec", "width", "height", "frameRate", "layers", ...(value["exportSettings"] === undefined ? [] : ["exportSettings"])]) || !normalizeVideoExportSettings(value["exportSettings"]) || !record(value["frameRate"]) || !exact(value["frameRate"], ["numerator", "denominator"])) return false;
  const durationSec = value["durationSec"]; const width = value["width"]; const height = value["height"];
  const frameRate = value["frameRate"]; const layers = value["layers"];
  if (
      value["version"] !== 1 || !finite(durationSec) || durationSec <= 0 ||
      !Number.isSafeInteger(width) || typeof width !== "number" || width <= 0 || width % 2 !== 0 ||
      !Number.isSafeInteger(height) || typeof height !== "number" || height <= 0 || height % 2 !== 0 ||
      !Number.isSafeInteger(frameRate["numerator"]) || typeof frameRate["numerator"] !== "number" || frameRate["numerator"] <= 0 ||
      !Number.isSafeInteger(frameRate["denominator"]) || typeof frameRate["denominator"] !== "number" || frameRate["denominator"] <= 0 || !Array.isArray(layers)) return false;
  return layers.every((layer) => validLayer(layer, durationSec));
}

function n(value: number): string { return value.toFixed(6).replace(/\.?0+$/u, ""); }
export function buildSequenceFfmpegArgs(plan: SequenceRenderPlan, sources: ReadonlyMap<string, AuthorizedRenderSource>, outputPath: string, textSources: ReadonlyMap<number, AuthorizedRenderSource> = new Map()): { args: string[]; warnings: SequenceRenderWarning[] } | null {
  if (!validPlan(plan) || typeof outputPath !== "string" || outputPath.length === 0) return null;
  const fps = `${plan.frameRate.numerator}/${plan.frameRate.denominator}`;
  const args = ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", `color=c=black:s=${plan.width}x${plan.height}:r=${fps}:d=${n(plan.durationSec)}`, "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${n(plan.durationSec)}`];
  const inputIndex = new Map<number, number>();
  for (let index = 0; index < plan.layers.length; index++) {
    const layer = plan.layers[index]!;
    const synthetic = isTextCompositionKind(layer.kind);
    if (synthetic && !layer.visual) continue;
    const source = synthetic ? textSources.get(index) : layer.mediaId ? sources.get(layer.mediaId) : undefined;
    if (!source || typeof source.canonicalPath !== "string" || source.canonicalPath.length === 0) return null;
    if ((layer.kind === "video" || layer.kind === "image" || synthetic) && !source.hasVideo) return null;
    if (synthetic && (source.format !== "png" || source.hasAudio)) return null;
    if (layer.kind === "audio" && !source.hasAudio) return null;
    inputIndex.set(index, inputIndex.size + 2);
    if (layer.kind === "image" || synthetic) args.push("-loop", "1", "-f", "image2", "-pattern_type", "none", "-c:v", source.format === "jpeg" ? "mjpeg" : source.format);
    else args.push("-f", source.format === "mp4" ? "mov" : source.format);
    args.push("-i", source.canonicalPath);
  }
  const filters: string[] = [`[0:v]setpts=PTS-STARTPTS[v0]`];
  let video = "v0";
  let visualSequence = 0;
  const audioLabels = ["1:a"];
  const warnings: SequenceRenderWarning[] = [];
  for (let index = 0; index < plan.layers.length; index++) {
    const layer = plan.layers[index]!;
    const input = inputIndex.get(index);
    const synthetic = isTextCompositionKind(layer.kind);
    if (layer.visual && input !== undefined && (layer.kind === "video" || layer.kind === "image" || synthetic)) {
      const media = `mv${visualSequence}`;
      const next = `v${visualSequence + 1}`;
      const transparent = layer.trackKind === "overlay" || synthetic ? "black@0" : "black";
      const fades = layer.fades ?? {};
      const videoFades = (["videoIn", "videoOut"] as const).flatMap((key) => fades[key] ? [`fade=t=${key === "videoIn" ? "in" : "out"}:st=${n(fades[key].startSec)}:d=${n(fades[key].durationSec)}:alpha=1`] : []);
      const transition = layer.transitionIn;
      if (transition?.kind === "crossfade") videoFades.push(`fade=t=in:st=${n(transition.startSec)}:d=${n(transition.durationSec)}:alpha=1`);
      if (transition?.kind === "swipe") {
        const progress = `min(1,max(0,(T-${n(transition.startSec)})/${n(transition.durationSec)}))`;
        const reveal = transition.direction === "left" ? `gte(X/W,1-${progress})` : transition.direction === "right" ? `lte(X/W,${progress})` : transition.direction === "up" ? `gte(Y/H,1-${progress})` : `lte(Y/H,${progress})`;
        videoFades.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${reveal}'`);
      }
      filters.push(`[${input}:v]setpts=PTS-STARTPTS,trim=start=${n(synthetic ? 0 : layer.sourceInSec)}:duration=${n(layer.durationSec)},format=rgba,scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=${transparent},${videoFades.length ? `${videoFades.join(",")},` : ""}setpts=PTS-STARTPTS+${n(layer.timelineStartSec)}/TB[${media}]`);
      filters.push(`[${video}][${media}]overlay=eof_action=pass:shortest=0:format=auto:enable='gte(t,${n(layer.timelineStartSec)})*lt(t,${n(layer.timelineStartSec + layer.durationSec)})'[${next}]`);
      video = next; visualSequence++;
    } else if (layer.visual && layer.text !== undefined) {
      return null;
    }
    if (input !== undefined && layer.gain > 0 && (layer.kind === "video" || layer.kind === "audio")) {
      const source = sources.get(layer.mediaId!)!;
      if (!source.hasAudio) warnings.push({ code: "missing_audio_stream", mediaId: layer.mediaId!, clipId: layer.clipId });
      else {
        const label = `a${audioLabels.length}`;
        const delaySamples = Math.round(layer.timelineStartSec * 48_000);
        const fades = layer.fades ?? {};
        const audioFades = (["audioIn", "audioOut"] as const).flatMap((key) => fades[key] ? [`afade=t=${key === "audioIn" ? "in" : "out"}:st=${n(fades[key].startSec)}:d=${n(fades[key].durationSec)}:curve=tri`] : []);
        for (const [key, edge] of [["transitionIn", "in"], ["transitionOut", "out"]] as const) {
          const ramp = layer[key];
          if (ramp) audioFades.push(`afade=t=${edge}:st=${n(ramp.startSec)}:d=${n(ramp.durationSec)}:curve=tri`);
        }
        filters.push(`[${input}:a]asetpts=PTS-STARTPTS,${audioFades.length ? `${audioFades.join(",")},` : ""}atrim=start=${n(layer.sourceInSec)}:duration=${n(layer.durationSec)},asetpts=PTS-STARTPTS,aresample=48000,volume=${n(layer.gain)},adelay=${delaySamples}S:all=1[${label}]`);
        audioLabels.push(label);
      }
    }
  }
  filters.push(`${audioLabels.map((label) => `[${label}]`).join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=duration=${n(plan.durationSec)}[aout]`);
  args.push("-filter_complex", filters.join(";"), "-map", `[${video}]`, "-map", "[aout]", "-t", n(plan.durationSec), ...desktopVideoEncoderArgs(normalizeVideoExportSettings(plan.exportSettings)!), "-c:a", "aac", "-movflags", "+faststart", "-progress", "pipe:2", "-nostats", outputPath);
  return { args, warnings };
}

async function header(path: string): Promise<Uint8Array> {
  const handle = await fsp.open(path, "r");
  try { const bytes = Buffer.alloc(32); const read = await handle.read(bytes, 0, 32, 0); return bytes.subarray(0, read.bytesRead); }
  finally { await handle.close(); }
}
function mp4(bytes: Uint8Array): boolean { return bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString("ascii") === "ftyp"; }

export async function renderSequence(plan: SequenceRenderPlan, dependencies: SequenceRendererDependencies): Promise<SequenceRenderResult> {
  if (dependencies.signal?.aborted) return { status: "cancelled" };
  if (!dependencies.ffmpegPath) return { status: "failed", code: "ffmpeg_unavailable" };
  if (!validPlan(plan)) return { status: "failed", code: "invalid_plan" };
  let textRoot: string | undefined;
  try {
    const textSources = new Map<number, AuthorizedRenderSource>();
    for (let index = 0; index < plan.layers.length; index++) {
      const layer = plan.layers[index]!;
      if (!layer.visual || !isTextCompositionKind(layer.kind)) continue;
      if (dependencies.signal?.aborted) return { status: "cancelled" };
      textRoot ??= await fsp.mkdtemp(path.join(tmpdir(), "nautilo-sequence-text-"));
      const canonicalPath = path.join(textRoot, `layer-${index}.png`);
      await (dependencies.rasterizeText ?? rasterizeSequenceText)({
        kind: layer.kind, text: layer.text!, width: plan.width, height: plan.height, outputPath: canonicalPath,
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      });
      textSources.set(index, { canonicalPath, format: "png", hasVideo: true, hasAudio: false });
    }
    if (dependencies.signal?.aborted) return { status: "cancelled" };
    const built = buildSequenceFfmpegArgs(plan, dependencies.sources, dependencies.outputPath, textSources);
    if (!built) return { status: "failed", code: "source_unavailable" };
    const child = (dependencies.spawn ?? nodeSpawn)(dependencies.ffmpegPath, built.args, { stdio: ["ignore", "ignore", "pipe"] });
    let last = -1; let tail = "";
    child.stderr?.on("data", (chunk: unknown) => {
      const lines = `${tail}${String(chunk)}`.split(/\r?\n/u); tail = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/u.exec(line);
        if (!match) continue;
        const value = Number(match[1]);
        if (Number.isSafeInteger(value) && value > last) { last = value; dependencies.onProgress?.(value); }
      }
    });
    const terminal = new Promise<boolean>((resolve) => { child.once("close", (code, signal) => resolve(code === 0 && signal === null)); child.once("error", () => resolve(false)); });
    // The rendered file is private and disposable until publication. Kill the
    // owned encoder immediately on cancellation, but still wait for its close
    // receipt before callers remove its inputs and output directory.
    const abort = () => { try { child.kill("SIGKILL"); } catch { /* terminal decides */ } };
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    if (dependencies.signal?.aborted) abort();
    const ok = await terminal;
    dependencies.signal?.removeEventListener("abort", abort);
    if (dependencies.signal?.aborted) return { status: "cancelled" };
    if (!ok) return { status: "failed", code: "processing_failed" };
    const stat = await (dependencies.stat ?? fsp.stat)(dependencies.outputPath);
    if (dependencies.signal?.aborted) return { status: "cancelled" };
    const bytes = await (dependencies.readHeader ?? header)(dependencies.outputPath);
    if (dependencies.signal?.aborted) return { status: "cancelled" };
    if (!stat.isFile() || stat.size <= 0 || !mp4(bytes)) return { status: "failed", code: "invalid_output" };
    return { status: "succeeded", sizeBytes: stat.size, warnings: built.warnings };
  } catch (error) { return dependencies.signal?.aborted ? { status: "cancelled" } : { status: "failed", code: error instanceof Error && error.message === "text_overflow" ? "text_overflow" : "processing_failed" }; }
  finally { if (textRoot) await fsp.rm(textRoot, { recursive: true, force: true }).catch(() => undefined); }
}
