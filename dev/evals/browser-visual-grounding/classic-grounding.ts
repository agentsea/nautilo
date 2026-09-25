import path from "node:path";
import sharp from "sharp";
import type { VisualGrounding } from "./visual-grounding.ts";

export type ClassicBackend =
  | "macos-vision"
  | "macos-vision-hybrid"
  | "macos-vision-accurate"
  | "portable"
  | "ppocr-v6-tiny"
  | "ppocr-v6-small";

export interface VisualBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TextObservation {
  readonly text: string;
  readonly box: VisualBox;
  readonly confidence: number;
}

export interface RegionObservation {
  readonly box: VisualBox;
  readonly confidence: number;
  readonly source: "rectangle" | "contour" | "perceptual-edge";
}

export interface ClassicExtraction {
  readonly backend: ClassicBackend;
  readonly image: { readonly width: number; readonly height: number };
  readonly text: readonly TextObservation[];
  readonly regions: readonly RegionObservation[];
  readonly grounding: VisualGrounding;
  readonly timing: Readonly<Record<string, number>>;
  readonly rawCounts: Readonly<Record<string, number>>;
}

export interface MacosVisionRawResult {
  readonly imagePath: string;
  readonly recognitionMode: "fast" | "accurate" | "hybrid";
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly globalDurationMs: number;
  readonly cropDurationMs: number;
  readonly cropRequestCount: number;
  readonly text: readonly TextObservation[];
  readonly rectangles: readonly VisualBox[];
  readonly contours: readonly VisualBox[];
  readonly contourCount: number;
}

export interface PpocrRawResult {
  readonly imagePath: string;
  readonly tier: "tiny" | "small";
  readonly width: number;
  readonly height: number;
  readonly initializationMs: number;
  readonly durationMs: number;
  readonly engineElapsedMs: readonly number[];
  readonly text: readonly TextObservation[];
}

const OCR_MIN_CONFIDENCE = 0.3;
const EDGE_MAX_DIMENSION = 1_084;
const EDGE_COLOR_DISTANCE = 5;
const EDGE_MIN_BOX_AREA = 360;
const EDGE_MIN_WIDTH = 18;
const EDGE_MIN_HEIGHT = 12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeBox(box: VisualBox, image: { readonly width: number; readonly height: number }): VisualBox {
  const x = clamp(Math.round(box.x), 0, image.width - 1);
  const y = clamp(Math.round(box.y), 0, image.height - 1);
  return {
    x,
    y,
    width: clamp(Math.round(box.width), 1, image.width - x),
    height: clamp(Math.round(box.height), 1, image.height - y),
  };
}

function boxArea(box: VisualBox): number {
  return box.width * box.height;
}

function boxCenter(box: VisualBox): { readonly x: number; readonly y: number } {
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

function intersectionArea(left: VisualBox, right: VisualBox): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function intersectionOverUnion(left: VisualBox, right: VisualBox): number {
  const intersection = intersectionArea(left, right);
  return intersection / Math.max(1, boxArea(left) + boxArea(right) - intersection);
}

function containsPoint(box: VisualBox, point: { readonly x: number; readonly y: number }, padding = 0): boolean {
  return point.x >= box.x - padding && point.x <= box.x + box.width + padding
    && point.y >= box.y - padding && point.y <= box.y + box.height + padding;
}

function distanceBetweenBoxes(left: VisualBox, right: VisualBox): number {
  const a = boxCenter(left);
  const b = boxCenter(right);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function readingOrder<T extends { readonly box: VisualBox }>(left: T, right: T): number {
  const lineTolerance = Math.max(8, Math.min(left.box.height, right.box.height));
  if (Math.abs(left.box.y - right.box.y) <= lineTolerance) return left.box.x - right.box.x;
  return left.box.y - right.box.y;
}

function dedupeRegions(regions: readonly RegionObservation[]): RegionObservation[] {
  const accepted: RegionObservation[] = [];
  const sourcePriority: Record<RegionObservation["source"], number> = {
    rectangle: 0,
    "perceptual-edge": 1,
    contour: 2,
  };
  for (const region of [...regions].sort((left, right) =>
    sourcePriority[left.source] - sourcePriority[right.source] || boxArea(left.box) - boxArea(right.box))) {
    if (accepted.some((candidate) => intersectionOverUnion(candidate.box, region.box) >= 0.88)) continue;
    accepted.push(region);
  }
  return accepted.sort(readingOrder);
}

function regionLabel(region: RegionObservation, text: readonly TextObservation[]): {
  readonly name: string;
  readonly context: string;
} {
  const enclosed = text.filter((observation) => containsPoint(region.box, boxCenter(observation.box), 4));
  const nearby = [...text]
    .filter((observation) => !enclosed.includes(observation))
    .sort((left, right) => distanceBetweenBoxes(region.box, left.box) - distanceBetweenBoxes(region.box, right.box))
    .slice(0, 3);
  const enclosedText = enclosed.sort(readingOrder).map(({ text: value }) => value).join(" ").trim();
  const nearbyText = nearby.map(({ text: value }) => value).join(" | ");
  return {
    name: enclosedText || "unlabelled visual region",
    context: nearbyText ? `near ${nearbyText}` : `${region.source} region`,
  };
}

function textLayoutContext(
  observation: TextObservation,
  text: readonly TextObservation[],
  image: { readonly width: number; readonly height: number },
): string {
  const center = boxCenter(observation.box);
  const above = text.filter((candidate) => {
    if (candidate === observation || !/[A-Za-z]/u.test(candidate.text)) return false;
    const candidateCenter = boxCenter(candidate.box);
    return candidate.box.y + candidate.box.height <= observation.box.y + 4
      && observation.box.y - (candidate.box.y + candidate.box.height) <= 320
      && Math.abs(candidateCenter.x - center.x) <= 220;
  }).sort((left, right) => {
    const leftCenter = boxCenter(left.box);
    const rightCenter = boxCenter(right.box);
    return Math.abs(leftCenter.x - center.x) + Math.abs(leftCenter.y - center.y) * 1.5
      - (Math.abs(rightCenter.x - center.x) + Math.abs(rightCenter.y - center.y) * 1.5);
  })[0];
  const section = text.filter((candidate) => {
    if (candidate === observation || !/[A-Za-z]/u.test(candidate.text) || !/\d/u.test(candidate.text)) return false;
    const candidateCenter = boxCenter(candidate.box);
    return candidate.box.y + candidate.box.height <= observation.box.y + 4
      && observation.box.y - (candidate.box.y + candidate.box.height) <= 340
      && candidateCenter.x <= center.x + 40
      && center.x - candidateCenter.x <= 700;
  }).sort((left, right) => observation.box.y - (left.box.y + left.box.height)
    - (observation.box.y - (right.box.y + right.box.height)))[0];
  const parts = [
    `at ${Math.round((center.x / image.width) * 100)}% from left, ${Math.round((center.y / image.height) * 100)}% from top`,
  ];
  if (above) parts.push(`below ${JSON.stringify(above.text)}`);
  if (section && section !== above) parts.push(`in section ${JSON.stringify(section.text)}`);
  return parts.join("; ");
}

export function classicObservationsToGrounding(options: {
  readonly backend: ClassicBackend;
  readonly image: { readonly width: number; readonly height: number };
  readonly text: readonly TextObservation[];
  readonly regions: readonly RegionObservation[];
}): VisualGrounding {
  const text = [...options.text]
    .filter((observation) => observation.text.trim() && observation.confidence >= OCR_MIN_CONFIDENCE)
    .sort(readingOrder);
  const regions = dedupeRegions(options.regions);
  const visibleText = text.map(({ text: value }) => value).filter((value, index, all) => all.indexOf(value) === index);
  const regionTargets = regions.map((region) => {
    const label = regionLabel(region, text);
    const center = boxCenter(region.box);
    return {
      role: "visual region",
      name: label.name,
      interaction: "unknown" as const,
      x: center.x,
      y: center.y,
      context: label.context,
      box: region.box,
      sources: label.name === "unlabelled visual region" ? [region.source] : [region.source, "ocr"],
      confidence: region.confidence,
    };
  });
  const textTargets = text.map((observation) => {
    const center = boxCenter(observation.box);
    const enclosing = regions
      .filter((region) => containsPoint(region.box, center, 3))
      .sort((left, right) => boxArea(left.box) - boxArea(right.box))[0];
    const targetBox = enclosing?.box ?? observation.box;
    const targetCenter = boxCenter(targetBox);
    return {
      role: enclosing ? "labelled visual region" : "visible text",
      name: observation.text,
      interaction: "unknown" as const,
      x: targetCenter.x,
      y: targetCenter.y,
      context: `${enclosing ? `text inside ${enclosing.source} region` : "OCR text box"}; ${textLayoutContext(observation, text, options.image)}`,
      box: targetBox,
      sources: enclosing ? ["ocr", enclosing.source] : ["ocr"],
      confidence: observation.confidence,
    };
  });
  const targets = [...regionTargets, ...textTargets]
    .filter((target, index, all) => all.findIndex((candidate) =>
      candidate.x === target.x && candidate.y === target.y && candidate.name === target.name) === index)
    .sort((left, right) => readingOrder(left, right));
  return {
    summary: `${options.backend} extracted ${text.length} text boxes and ${regions.length} visual regions without a generative model`,
    visibleText,
    targets,
  };
}

export function parseTesseractTsv(tsv: string): TextObservation[] {
  const observations: TextObservation[] = [];
  const lines = tsv.split(/\r?\n/u);
  for (const line of lines.slice(1)) {
    const columns = line.split("\t");
    if (columns.length < 12 || columns[0] !== "5") continue;
    const text = columns.slice(11).join("\t").trim();
    const confidence = Number(columns[10]) / 100;
    const x = Number(columns[6]);
    const y = Number(columns[7]);
    const width = Number(columns[8]);
    const height = Number(columns[9]);
    if (!text || ![confidence, x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    observations.push({ text, confidence: clamp(confidence, 0, 1), box: { x, y, width, height } });
  }
  return observations;
}

async function runTesseract(screenshotPath: string): Promise<{ readonly text: TextObservation[]; readonly durationMs: number }> {
  const started = performance.now();
  const subprocess = Bun.spawn(["tesseract", screenshotPath, "stdout", "--psm", "11", "tsv"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Tesseract failed for ${path.basename(screenshotPath)}: ${stderr.trim()}`);
  return { text: parseTesseractTsv(stdout), durationMs: performance.now() - started };
}

export async function detectPerceptualEdgeRegions(screenshotPath: string): Promise<{
  readonly image: { readonly width: number; readonly height: number };
  readonly regions: readonly RegionObservation[];
  readonly durationMs: number;
  readonly rawComponentCount: number;
  readonly horizontalPairCount: number;
}> {
  const started = performance.now();
  const metadata = await sharp(screenshotPath).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Could not read image dimensions for ${screenshotPath}`);
  const scale = Math.min(1, EDGE_MAX_DIMENSION / Math.max(metadata.width, metadata.height));
  const targetWidth = Math.max(1, Math.round(metadata.width * scale));
  const { data, info } = await sharp(screenshotPath)
    .resize({ width: targetWidth })
    .pipelineColourspace("lab")
    .toColourspace("lab")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;
  const edges = new Uint8Array(pixelCount);
  const thresholdSquared = EDGE_COLOR_DISTANCE * EDGE_COLOR_DISTANCE;
  for (let y = 0; y < info.height - 1; y += 1) {
    for (let x = 0; x < info.width - 1; x += 1) {
      const pixel = y * info.width + x;
      const offset = pixel * info.channels;
      const right = offset + info.channels;
      const below = offset + info.width * info.channels;
      let horizontal = 0;
      let vertical = 0;
      for (let channel = 0; channel < Math.min(3, info.channels); channel += 1) {
        const horizontalDifference = data[offset + channel]! - data[right + channel]!;
        const verticalDifference = data[offset + channel]! - data[below + channel]!;
        horizontal += horizontalDifference * horizontalDifference;
        vertical += verticalDifference * verticalDifference;
      }
      if (horizontal >= thresholdSquared || vertical >= thresholdSquared) edges[pixel] = 1;
    }
  }
  const horizontalRuns: Array<{ x: number; y: number; width: number }> = [];
  for (let y = 0; y < info.height; y += 1) {
    let x = 0;
    while (x < info.width) {
      while (x < info.width && !edges[y * info.width + x]) x += 1;
      const start = x;
      while (x < info.width && edges[y * info.width + x]) x += 1;
      if (x - start >= 24) horizontalRuns.push({ x: start, y, width: x - start });
    }
  }
  const collapsedRuns: typeof horizontalRuns = [];
  for (const run of horizontalRuns) {
    const prior = collapsedRuns.at(-1);
    const overlap = prior
      ? Math.max(0, Math.min(prior.x + prior.width, run.x + run.width) - Math.max(prior.x, run.x))
      : 0;
    if (prior && run.y - prior.y <= 2 && overlap / Math.min(prior.width, run.width) >= 0.85) {
      if (run.width > prior.width) collapsedRuns[collapsedRuns.length - 1] = run;
      continue;
    }
    collapsedRuns.push(run);
  }
  const horizontalPairRegions: RegionObservation[] = [];
  for (let topIndex = 0; topIndex < collapsedRuns.length; topIndex += 1) {
    const top = collapsedRuns[topIndex]!;
    for (let bottomIndex = topIndex + 1; bottomIndex < collapsedRuns.length; bottomIndex += 1) {
      const bottom = collapsedRuns[bottomIndex]!;
      const height = bottom.y - top.y;
      if (height < 10) continue;
      if (height > 220) break;
      const overlap = Math.max(0, Math.min(top.x + top.width, bottom.x + bottom.width) - Math.max(top.x, bottom.x));
      if (overlap / Math.min(top.width, bottom.width) < 0.82) continue;
      if (Math.abs(top.width - bottom.width) > Math.max(10, Math.min(top.width, bottom.width) * 0.18)) continue;
      const inverseScale = metadata.width / info.width;
      horizontalPairRegions.push({
        box: normalizeBox({
          x: Math.min(top.x, bottom.x) * inverseScale,
          y: top.y * inverseScale,
          width: Math.max(top.x + top.width, bottom.x + bottom.width) * inverseScale
            - Math.min(top.x, bottom.x) * inverseScale,
          height: height * inverseScale,
        }, { width: metadata.width, height: metadata.height }),
        confidence: 0.75,
        source: "perceptual-edge",
      });
    }
  }
  const dilated = new Uint8Array(pixelCount);
  for (let y = 1; y < info.height - 1; y += 1) {
    for (let x = 1; x < info.width - 1; x += 1) {
      const pixel = y * info.width + x;
      if (!edges[pixel]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) dilated[pixel + dy * info.width + dx] = 1;
      }
    }
  }
  const stack = new Int32Array(pixelCount);
  const regions: RegionObservation[] = [];
  let rawComponentCount = 0;
  for (let seed = 0; seed < pixelCount; seed += 1) {
    if (!dilated[seed]) continue;
    rawComponentCount += 1;
    let top = 0;
    stack[top++] = seed;
    dilated[seed] = 0;
    let minX = seed % info.width;
    let maxX = minX;
    let minY = Math.floor(seed / info.width);
    let maxY = minY;
    let count = 0;
    while (top > 0) {
      const pixel = stack[--top]!;
      const x = pixel % info.width;
      const y = Math.floor(pixel / info.width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      count += 1;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) continue;
          const next = ny * info.width + nx;
          if (!dilated[next]) continue;
          dilated[next] = 0;
          stack[top++] = next;
        }
      }
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const area = width * height;
    if (width < EDGE_MIN_WIDTH || height < EDGE_MIN_HEIGHT || area < EDGE_MIN_BOX_AREA || count < 20) continue;
    if (width >= info.width * 0.94 || height >= info.height * 0.94 || area >= pixelCount * 0.55) continue;
    const inverseScale = metadata.width / info.width;
    const box = normalizeBox({
      x: minX * inverseScale,
      y: minY * inverseScale,
      width: width * inverseScale,
      height: height * inverseScale,
    }, { width: metadata.width, height: metadata.height });
    const density = count / Math.max(1, area);
    regions.push({ box, confidence: clamp(0.35 + density * 2, 0.35, 0.95), source: "perceptual-edge" });
  }
  return {
    image: { width: metadata.width, height: metadata.height },
    regions: dedupeRegions([...horizontalPairRegions, ...regions]),
    durationMs: performance.now() - started,
    rawComponentCount,
    horizontalPairCount: horizontalPairRegions.length,
  };
}

export async function extractPortableGrounding(screenshotPath: string): Promise<ClassicExtraction> {
  const started = performance.now();
  const [ocr, edges] = await Promise.all([
    runTesseract(screenshotPath),
    detectPerceptualEdgeRegions(screenshotPath),
  ]);
  const text = ocr.text.filter(({ confidence }) => confidence >= OCR_MIN_CONFIDENCE);
  const grounding = classicObservationsToGrounding({
    backend: "portable",
    image: edges.image,
    text,
    regions: edges.regions,
  });
  return {
    backend: "portable",
    image: edges.image,
    text,
    regions: edges.regions,
    grounding,
    timing: { ocrMs: ocr.durationMs, edgesMs: edges.durationMs, totalMs: performance.now() - started },
    rawCounts: {
      ocr: ocr.text.length,
      edgeComponents: edges.rawComponentCount,
      horizontalPairs: edges.horizontalPairCount,
      regions: edges.regions.length,
    },
  };
}

export function extractMacosVisionGrounding(
  raw: MacosVisionRawResult,
  backend: "macos-vision" | "macos-vision-hybrid" | "macos-vision-accurate" = "macos-vision",
): ClassicExtraction {
  const image = { width: raw.width, height: raw.height };
  const text = raw.text
    .map((observation) => ({ ...observation, box: normalizeBox(observation.box, image) }))
    .filter(({ confidence }) => confidence >= OCR_MIN_CONFIDENCE);
  const regions = dedupeRegions([
    ...raw.rectangles.map((box): RegionObservation => ({
      box: normalizeBox(box, image), confidence: 1, source: "rectangle",
    })),
    ...raw.contours.map((box): RegionObservation => ({
      box: normalizeBox(box, image), confidence: 0.5, source: "contour",
    })),
  ]);
  return {
    backend,
    image,
    text,
    regions,
    grounding: classicObservationsToGrounding({ backend, image, text, regions }),
    timing: {
      nativeVisionGlobalMs: raw.globalDurationMs,
      nativeVisionCropMs: raw.cropDurationMs,
      nativeVisionMs: raw.durationMs,
      totalMs: raw.durationMs,
    },
    rawCounts: {
      ocr: raw.text.length,
      rectangles: raw.rectangles.length,
      contours: raw.contourCount,
      filteredContours: raw.contours.length,
      cropRequests: raw.cropRequestCount,
      regions: regions.length,
    },
  };
}

export function extractPpocrGrounding(
  raw: PpocrRawResult,
  edges: Awaited<ReturnType<typeof detectPerceptualEdgeRegions>>,
  backend: "ppocr-v6-tiny" | "ppocr-v6-small",
): ClassicExtraction {
  const image = { width: raw.width, height: raw.height };
  if (image.width !== edges.image.width || image.height !== edges.image.height) {
    throw new Error(`PP-OCR and edge image dimensions differ for ${path.basename(raw.imagePath)}`);
  }
  const text = raw.text
    .map((observation) => ({ ...observation, box: normalizeBox(observation.box, image) }))
    .filter(({ confidence }) => confidence >= OCR_MIN_CONFIDENCE);
  const grounding = classicObservationsToGrounding({ backend, image, text, regions: edges.regions });
  return {
    backend,
    image,
    text,
    regions: edges.regions,
    grounding,
    timing: {
      ocrMs: raw.durationMs,
      engineInitMs: raw.initializationMs,
      edgesMs: edges.durationMs,
      totalMs: raw.durationMs + edges.durationMs,
    },
    rawCounts: {
      ocr: raw.text.length,
      edgeComponents: edges.rawComponentCount,
      horizontalPairs: edges.horizontalPairCount,
      regions: edges.regions.length,
    },
  };
}
