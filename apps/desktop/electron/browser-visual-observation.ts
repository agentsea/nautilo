import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  inferBrowserVisualLayouts,
  type BrowserVisualLayoutMembership,
} from "./browser-visual-layout.ts";

const BROWSER_VISUAL_GROUNDING_HELPER = "nautilo-browser-visual-grounding";
// Process-safety boundaries, not product truncation: the measured eight-case
// corpus stayed below 8 KiB and 270 ms. Overflow/timeout rejects the whole
// read-only observation before any browser action; Genie can retry or use DOM.
export const BROWSER_VISUAL_GROUNDING_OUTPUT_MAX_BYTES = 1024 * 1024;
const BROWSER_VISUAL_GROUNDING_TIMEOUT_MS = 10_000;

export interface BrowserVisualBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserVisualTextObservation {
  readonly text: string;
  readonly box: BrowserVisualBox;
  readonly confidence: number;
}

export interface BrowserVisualExtraction {
  readonly recognitionMode: "hybrid";
  readonly durationMs: number;
  readonly globalDurationMs: number;
  readonly cropDurationMs: number;
  readonly cropRequestCount: number;
  readonly text: readonly BrowserVisualTextObservation[];
  readonly rectangles: readonly BrowserVisualBox[];
  readonly contours: readonly BrowserVisualBox[];
  readonly contourCount: number;
  readonly layouts: readonly BrowserVisualLayoutMembership[];
}

export interface BrowserVisualObservationEnvelope {
  readonly version: 1;
  readonly pageUrl: string;
  readonly browserSessionId: string;
  readonly observationId: string;
  readonly image: { readonly width: number; readonly height: number };
  readonly viewport: {
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly dpr: number;
  };
  readonly extraction: BrowserVisualExtraction;
}

export interface BrowserVisualObservationBinding {
  readonly observationId: string;
  readonly browserSessionId: string;
  readonly pageUrl: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
  readonly xScale: number;
  readonly yScale: number;
}

/** Relay-internal target selected from a visual observation. Never model-visible. */
export interface BrowserVisualTargetBinding {
  readonly version: 1;
  readonly visualRef: string;
  readonly role: string;
  readonly name: string;
  readonly interaction: "click" | "focus" | "unknown";
  readonly context: string;
  readonly sources?: readonly string[];
  readonly confidence?: number;
  readonly layout?: Omit<BrowserVisualLayoutMembership, "box">;
  readonly point: { readonly x: number; readonly y: number };
  readonly box?: BrowserVisualBox;
}

export interface BrowserVisualGroundedTarget {
  readonly role: string;
  readonly name: string;
  readonly interaction: "unknown";
  readonly context: string;
  readonly sources: readonly string[];
  readonly confidence: number;
  readonly layout?: Omit<BrowserVisualLayoutMembership, "box">;
  readonly point: { readonly x: number; readonly y: number };
  readonly box: BrowserVisualBox;
}

export type BrowserVisualTargetResolution =
  | { readonly status: "matched"; readonly target: BrowserVisualGroundedTarget }
  | { readonly status: "missing" | "ambiguous" };

export function resolveBrowserVisualGroundingHelper(options: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string | null;
  readonly devVendorRoot: string;
  readonly exists?: (path: string) => boolean;
}): string | null {
  if (options.platform !== "darwin" || !isAbsolute(options.devVendorRoot)) return null;
  const candidate = options.isPackaged
    ? options.resourcesPath !== null && isAbsolute(options.resourcesPath)
      ? join(options.resourcesPath, "tools-browser-vision", BROWSER_VISUAL_GROUNDING_HELPER)
      : null
    : join(options.devVendorRoot, "browser-visual-grounding", BROWSER_VISUAL_GROUNDING_HELPER);
  return candidate !== null && (options.exists ?? existsSync)(candidate) ? candidate : null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`browser visual helper returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`browser visual helper returned invalid ${label} keys`);
  }
}

function finiteNumber(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`browser visual helper returned invalid ${label}`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  const parsed = finiteNumber(value, label, minimum);
  if (!Number.isInteger(parsed)) throw new Error(`browser visual helper returned non-integer ${label}`);
  return parsed;
}

function parseBox(value: unknown, imageWidth: number, imageHeight: number, label: string): BrowserVisualBox {
  const box = record(value, label);
  exactKeys(box, ["x", "y", "width", "height"], label);
  const x = integer(box["x"], `${label}.x`);
  const y = integer(box["y"], `${label}.y`);
  const width = integer(box["width"], `${label}.width`, 1);
  const height = integer(box["height"], `${label}.height`, 1);
  if (x >= imageWidth || y >= imageHeight) throw new Error(`browser visual helper returned out-of-image ${label}`);
  return {
    x,
    y,
    width: Math.min(width, imageWidth - x),
    height: Math.min(height, imageHeight - y),
  };
}

function parseStrictBox(value: unknown, imageWidth: number, imageHeight: number, label: string): BrowserVisualBox {
  const box = record(value, label);
  exactKeys(box, ["x", "y", "width", "height"], label);
  const parsed = {
    x: integer(box["x"], `${label}.x`),
    y: integer(box["y"], `${label}.y`),
    width: integer(box["width"], `${label}.width`, 1),
    height: integer(box["height"], `${label}.height`, 1),
  };
  if (parsed.x + parsed.width > imageWidth || parsed.y + parsed.height > imageHeight) {
    throw new Error(`browser visual target returned out-of-image ${label}`);
  }
  return parsed;
}

/** Strictly validate the opaque target metadata injected after Jev chooses an action. */
export function parseBrowserVisualTargetBinding(
  value: unknown,
  image: { readonly width: number; readonly height: number },
): BrowserVisualTargetBinding {
  const target = record(value, "target");
  exactKeys(target, [
    "version", "visualRef", "role", "name", "interaction", "context", "point",
    ...(Object.hasOwn(target, "sources") ? ["sources"] : []),
    ...(Object.hasOwn(target, "confidence") ? ["confidence"] : []),
    ...(Object.hasOwn(target, "layout") ? ["layout"] : []),
    ...(Object.hasOwn(target, "box") ? ["box"] : []),
  ], "target");
  if (target["version"] !== 1) throw new Error("browser visual target returned invalid version");
  if (typeof target["visualRef"] !== "string" || !/^v\d+$/.test(target["visualRef"])) {
    throw new Error("browser visual target returned invalid visualRef");
  }
  const role = target["role"];
  const name = target["name"];
  const context = target["context"];
  if (typeof role !== "string" || !role.trim()
    || typeof name !== "string" || !name.trim()
    || typeof context !== "string") {
    throw new Error("browser visual target returned invalid semantics");
  }
  const interaction = target["interaction"];
  if (interaction !== "click" && interaction !== "focus" && interaction !== "unknown") {
    throw new Error("browser visual target returned invalid interaction");
  }
  const rawPoint = record(target["point"], "target.point");
  exactKeys(rawPoint, ["x", "y"], "target.point");
  const point = {
    x: integer(rawPoint["x"], "target.point.x"),
    y: integer(rawPoint["y"], "target.point.y"),
  };
  if (point.x >= image.width || point.y >= image.height) {
    throw new Error("browser visual target returned out-of-image point");
  }
  let sources: readonly string[] | undefined;
  if (Object.hasOwn(target, "sources")) {
    const rawSources: unknown = target["sources"];
    if (!Array.isArray(rawSources) || !rawSources.every((source: unknown): source is string =>
      typeof source === "string" && source.trim().length > 0)) {
      throw new Error("browser visual target returned invalid sources");
    }
    sources = Object.freeze([...rawSources]);
  }
  let confidence: number | undefined;
  if (Object.hasOwn(target, "confidence")) {
    confidence = finiteNumber(target["confidence"], "target.confidence");
    if (confidence > 1) throw new Error("browser visual target returned invalid confidence");
  }
  let layout: Omit<BrowserVisualLayoutMembership, "box"> | undefined;
  if (Object.hasOwn(target, "layout")) {
    const rawLayout = record(target["layout"], "target.layout");
    exactKeys(rawLayout, [
      "groupId", "kind", "ordinal", "itemCount", "row", "column", "rows", "columns",
    ], "target.layout");
    const kind = rawLayout["kind"];
    const groupId = rawLayout["groupId"];
    if ((kind !== "grid" && kind !== "row" && kind !== "column")
      || typeof groupId !== "string" || !/^(?:grid|row|column)-\d+$/.test(groupId)
      || !groupId.startsWith(`${kind}-`)) {
      throw new Error("browser visual target returned invalid target.layout identity");
    }
    layout = Object.freeze({
      groupId,
      kind,
      ordinal: integer(rawLayout["ordinal"], "target.layout.ordinal", 1),
      itemCount: integer(rawLayout["itemCount"], "target.layout.itemCount", 1),
      row: integer(rawLayout["row"], "target.layout.row", 1),
      column: integer(rawLayout["column"], "target.layout.column", 1),
      rows: integer(rawLayout["rows"], "target.layout.rows", 1),
      columns: integer(rawLayout["columns"], "target.layout.columns", 1),
    });
    if (layout.ordinal > layout.itemCount || layout.row > layout.rows || layout.column > layout.columns) {
      throw new Error("browser visual target returned inconsistent target.layout");
    }
  }
  const box = Object.hasOwn(target, "box")
    ? parseStrictBox(target["box"], image.width, image.height, "target.box")
    : undefined;
  return Object.freeze({
    version: 1,
    visualRef: target["visualRef"],
    role,
    name,
    interaction,
    context,
    ...(sources === undefined ? {} : { sources }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(layout === undefined ? {} : { layout }),
    point: Object.freeze(point),
    ...(box === undefined ? {} : { box: Object.freeze(box) }),
  });
}

function boxArea(box: BrowserVisualBox): number {
  return box.width * box.height;
}

function boxCenter(box: BrowserVisualBox): { readonly x: number; readonly y: number } {
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

function intersectionOverUnion(left: BrowserVisualBox, right: BrowserVisualBox): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  return intersection / Math.max(1, boxArea(left) + boxArea(right) - intersection);
}

function containsPoint(box: BrowserVisualBox, point: { readonly x: number; readonly y: number }, padding = 0): boolean {
  return point.x >= box.x - padding && point.x <= box.x + box.width + padding
    && point.y >= box.y - padding && point.y <= box.y + box.height + padding;
}

function readingOrder<T extends { readonly box: BrowserVisualBox }>(left: T, right: T): number {
  const lineTolerance = Math.max(8, Math.min(left.box.height, right.box.height));
  return Math.abs(left.box.y - right.box.y) <= lineTolerance
    ? left.box.x - right.box.x
    : left.box.y - right.box.y;
}

function distance(left: BrowserVisualBox, right: BrowserVisualBox): number {
  const a = boxCenter(left);
  const b = boxCenter(right);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function boxKey(box: BrowserVisualBox): string {
  return `${box.x}:${box.y}:${box.width}:${box.height}`;
}

function layoutWithoutBox(
  layout: BrowserVisualLayoutMembership | undefined,
): Omit<BrowserVisualLayoutMembership, "box"> | undefined {
  if (layout === undefined) return undefined;
  const { box: _box, ...semantic } = layout;
  return semantic;
}

function layoutContext(layout: Omit<BrowserVisualLayoutMembership, "box"> | undefined): string | null {
  if (layout === undefined) return null;
  if (layout.kind === "grid") {
    return `${layout.groupId}; grid item ${layout.ordinal} of ${layout.itemCount}; row ${layout.row} of ${layout.rows}; column ${layout.column} of ${layout.columns}`;
  }
  return `${layout.groupId}; ${layout.kind} item ${layout.ordinal} of ${layout.itemCount}`;
}

type RegionObservation = {
  readonly box: BrowserVisualBox;
  readonly confidence: number;
  readonly source: "rectangle" | "contour";
};

function dedupeRegions(regions: readonly RegionObservation[]): RegionObservation[] {
  const accepted: RegionObservation[] = [];
  for (const region of [...regions].sort((left, right) =>
    (left.source === "rectangle" ? 0 : 1) - (right.source === "rectangle" ? 0 : 1)
      || boxArea(left.box) - boxArea(right.box))) {
    if (!accepted.some((candidate) => intersectionOverUnion(candidate.box, region.box) >= 0.88)) {
      accepted.push(region);
    }
  }
  return accepted.sort(readingOrder);
}

function categoricalPosition(
  point: { readonly x: number; readonly y: number },
  image: { readonly width: number; readonly height: number },
): string {
  const horizontal = point.x < image.width / 3 ? "left"
    : point.x > image.width * 2 / 3 ? "right" : "center";
  const vertical = point.y < image.height / 3 ? "upper"
    : point.y > image.height * 2 / 3 ? "lower" : "middle";
  return horizontal === "center" && vertical === "middle"
    ? "center area"
    : `${vertical}-${horizontal} area`;
}

function targetContext(
  observation: BrowserVisualTextObservation,
  text: readonly BrowserVisualTextObservation[],
  image: { readonly width: number; readonly height: number },
): string {
  const center = boxCenter(observation.box);
  const nearest = text.filter((candidate) => candidate !== observation)
    .sort((left, right) => distance(observation.box, left.box) - distance(observation.box, right.box))[0];
  const position = categoricalPosition(center, image);
  return nearest ? `${position}; near ${JSON.stringify(nearest.text)}` : position;
}

/**
 * Recreate the semantic target set locally so execution never trusts old
 * coordinates. Keep this intentionally equivalent to the Agent's
 * browserVisualObservationFromRelay target construction.
 */
function browserVisualTargetsFromExtraction(
  extraction: BrowserVisualExtraction,
  image: { readonly width: number; readonly height: number },
): readonly BrowserVisualGroundedTarget[] {
  const text = extraction.text.filter((item) => item.confidence >= 0.3).sort(readingOrder);
  const regions = dedupeRegions([
    ...extraction.rectangles.map((box) => ({ box, confidence: 1, source: "rectangle" as const })),
    ...extraction.contours.map((box) => ({ box, confidence: 0.5, source: "contour" as const })),
  ]);
  const layoutByBox = new Map(extraction.layouts.map((layout) => [boxKey(layout.box), layout]));
  const regionTargets: BrowserVisualGroundedTarget[] = regions.map((region) => {
    const enclosed = text.filter((item) => containsPoint(region.box, boxCenter(item.box), 4));
    const nearby = text.filter((item) => !enclosed.includes(item))
      .sort((left, right) => distance(region.box, left.box) - distance(region.box, right.box))
      .slice(0, 3);
    const name = enclosed.sort(readingOrder).map((item) => item.text).join(" ").trim()
      || "unlabelled visual region";
    const location = categoricalPosition(boxCenter(region.box), image);
    const layout = layoutWithoutBox(layoutByBox.get(boxKey(region.box)));
    const structuralContext = layoutContext(layout);
    return Object.freeze({
      role: layout === undefined ? "visual region" : `${layout.kind} item`,
      name,
      interaction: "unknown",
      context: [structuralContext, nearby.length
        ? `${location}; near ${nearby.map((item) => item.text).join(" | ")}`
        : `${location}; ${region.source} region`].filter(Boolean).join("; "),
      sources: Object.freeze(name === "unlabelled visual region" ? [region.source] : [region.source, "ocr"]),
      confidence: region.confidence,
      ...(layout === undefined ? {} : { layout: Object.freeze(layout) }),
      point: Object.freeze(boxCenter(region.box)),
      box: Object.freeze({ ...region.box }),
    });
  });
  const textTargets: BrowserVisualGroundedTarget[] = text.map((item) => {
    const center = boxCenter(item.box);
    const enclosing = regions.filter((region) => containsPoint(region.box, center, 3))
      .sort((left, right) => boxArea(left.box) - boxArea(right.box))[0];
    const box = enclosing?.box ?? item.box;
    const layout = layoutWithoutBox(layoutByBox.get(boxKey(box)));
    const structuralContext = layoutContext(layout);
    return Object.freeze({
      role: layout === undefined ? (enclosing ? "labelled visual region" : "visible text") : `${layout.kind} item`,
      name: item.text,
      interaction: "unknown",
      context: [structuralContext, `${enclosing ? `text inside ${enclosing.source} region` : "OCR text box"}; ${targetContext(item, text, image)}`]
        .filter(Boolean).join("; "),
      sources: Object.freeze(enclosing ? ["ocr", enclosing.source] : ["ocr"]),
      confidence: item.confidence,
      ...(layout === undefined ? {} : { layout: Object.freeze(layout) }),
      point: Object.freeze(boxCenter(box)),
      box: Object.freeze({ ...box }),
    });
  });
  return Object.freeze([...regionTargets, ...textTargets]
    .filter((target, index, all) => all.findIndex((candidate) =>
      candidate.point.x === target.point.x && candidate.point.y === target.point.y && candidate.name === target.name) === index)
    .sort(readingOrder));
}

function normalizedSemantic(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function sourceSignature(sources: readonly string[] | undefined): string {
  return [...(sources ?? [])].map(normalizedSemantic).sort().join("\u0000");
}

function nearestByOriginalGeometry(
  matches: readonly BrowserVisualGroundedTarget[],
  original: BrowserVisualTargetBinding,
): BrowserVisualGroundedTarget | null {
  const originalBox = original.box ?? { x: original.point.x, y: original.point.y, width: 1, height: 1 };
  const ranked = [...matches].map((target) => ({ target, distance: distance(originalBox, target.box) }))
    .sort((left, right) => left.distance - right.distance);
  if (!ranked[0]) return null;
  const targetScale = Math.max(originalBox.width, originalBox.height);
  const maximumDisplacement = Math.max(64, targetScale * 6);
  const requiredRunnerUpMargin = Math.max(8, targetScale * 0.5);
  if (ranked[0].distance > maximumDisplacement
    || ranked[1] && ranked[1].distance - ranked[0].distance < requiredRunnerUpMargin) return null;
  return ranked[0].target;
}

/** Resolve an opaque semantic target against a fresh extraction, failing closed on ambiguity. */
export function resolveBrowserVisualTarget(
  original: BrowserVisualTargetBinding,
  extraction: BrowserVisualExtraction,
  image: { readonly width: number; readonly height: number },
): BrowserVisualTargetResolution {
  const candidates = browserVisualTargetsFromExtraction(extraction, image);
  let matches = candidates.filter((candidate) =>
    normalizedSemantic(candidate.role) === normalizedSemantic(original.role)
      && normalizedSemantic(candidate.name) === normalizedSemantic(original.name));
  if (matches.length === 0) return { status: "missing" };
  if (matches.length === 1) return { status: "matched", target: matches[0]! };

  if (original.layout !== undefined) {
    const layoutMatches = matches.filter((candidate) => candidate.layout !== undefined
      && candidate.layout.kind === original.layout!.kind
      && candidate.layout.groupId === original.layout!.groupId
      && candidate.layout.row === original.layout!.row
      && candidate.layout.column === original.layout!.column);
    if (layoutMatches.length === 1) return { status: "matched", target: layoutMatches[0]! };
    if (layoutMatches.length > 1) matches = layoutMatches;
    else {
      const structuralMatches = matches.filter((candidate) => candidate.layout !== undefined
        && candidate.layout.kind === original.layout!.kind
        && candidate.layout.rows === original.layout!.rows
        && candidate.layout.columns === original.layout!.columns
        && candidate.layout.row === original.layout!.row
        && candidate.layout.column === original.layout!.column);
      if (structuralMatches.length === 1) return { status: "matched", target: structuralMatches[0]! };
      if (structuralMatches.length > 1) matches = structuralMatches;
    }
  }

  const context = normalizedSemantic(original.context);
  const contextMatches = matches.filter((candidate) => normalizedSemantic(candidate.context) === context);
  if (contextMatches.length === 1) return { status: "matched", target: contextMatches[0]! };
  if (contextMatches.length > 1) matches = contextMatches;

  const sources = sourceSignature(original.sources);
  if (sources) {
    const sourceMatches = matches.filter((candidate) => sourceSignature(candidate.sources) === sources);
    if (sourceMatches.length === 1) return { status: "matched", target: sourceMatches[0]! };
    if (sourceMatches.length > 1) matches = sourceMatches;
  }

  const nearest = nearestByOriginalGeometry(matches, original);
  return nearest === null ? { status: "ambiguous" } : { status: "matched", target: nearest };
}

export function parseBrowserVisualGroundingOutput(
  stdout: string,
  expectedImagePath: string,
  expectedImage: { readonly width: number; readonly height: number },
): BrowserVisualExtraction {
  if (Buffer.byteLength(stdout) > BROWSER_VISUAL_GROUNDING_OUTPUT_MAX_BYTES) {
    throw new Error("browser visual helper output exceeded its 1 MiB limit");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(stdout.trim()); } catch { throw new Error("browser visual helper returned invalid JSON"); }
  const result = record(decoded, "result");
  exactKeys(result, [
    "imagePath", "recognitionMode", "width", "height", "durationMs", "globalDurationMs",
    "cropDurationMs", "cropRequestCount", "text", "rectangles", "contours", "contourCount",
  ], "result");
  if (typeof result["imagePath"] !== "string" || resolve(result["imagePath"]) !== resolve(expectedImagePath)) {
    throw new Error("browser visual helper returned an unexpected image path");
  }
  if (result["recognitionMode"] !== "hybrid") throw new Error("browser visual helper returned an unexpected mode");
  const width = integer(result["width"], "width", 1);
  const height = integer(result["height"], "height", 1);
  if (width !== expectedImage.width || height !== expectedImage.height) {
    throw new Error("browser visual helper returned unexpected image dimensions");
  }
  const rawText = result["text"];
  const rawRectangles = result["rectangles"];
  const rawContours = result["contours"];
  if (!Array.isArray(rawText) || !Array.isArray(rawRectangles) || !Array.isArray(rawContours)) {
    throw new Error("browser visual helper returned an invalid observation set");
  }
  const text = rawText.map((value, index): BrowserVisualTextObservation => {
    const observation = record(value, `text[${index}]`);
    exactKeys(observation, ["text", "box", "confidence"], `text[${index}]`);
    const textValue = observation["text"];
    if (typeof textValue !== "string" || !textValue.trim()) {
      throw new Error(`browser visual helper returned invalid text[${index}].text`);
    }
    const confidence = finiteNumber(observation["confidence"], `text[${index}].confidence`);
    if (confidence > 1) throw new Error(`browser visual helper returned invalid text[${index}].confidence`);
    return { text: textValue, confidence, box: parseBox(observation["box"], width, height, `text[${index}].box`) };
  });
  const rectangles = rawRectangles.map((value, index) => parseBox(value, width, height, `rectangles[${index}]`));
  return Object.freeze({
    recognitionMode: "hybrid",
    durationMs: finiteNumber(result["durationMs"], "durationMs"),
    globalDurationMs: finiteNumber(result["globalDurationMs"], "globalDurationMs"),
    cropDurationMs: finiteNumber(result["cropDurationMs"], "cropDurationMs"),
    cropRequestCount: integer(result["cropRequestCount"], "cropRequestCount"),
    text,
    rectangles,
    contours: rawContours.map((value, index) => parseBox(value, width, height, `contours[${index}]`)),
    contourCount: integer(result["contourCount"], "contourCount"),
    layouts: inferBrowserVisualLayouts({ rectangles, image: { width, height } }),
  });
}

const execFileAsync = promisify(execFile);

export async function extractBrowserVisualObservation(options: {
  readonly helperPath: string;
  readonly imagePath: string;
  readonly image: { readonly width: number; readonly height: number };
  readonly signal?: AbortSignal;
}): Promise<BrowserVisualExtraction> {
  if (!isAbsolute(options.helperPath) || !isAbsolute(options.imagePath)) {
    throw new Error("browser visual extraction requires absolute owned paths");
  }
  const { stdout } = await execFileAsync(
    options.helperPath,
    ["--recognition", "hybrid", options.imagePath],
    {
      encoding: "utf8",
      maxBuffer: BROWSER_VISUAL_GROUNDING_OUTPUT_MAX_BYTES,
      timeout: BROWSER_VISUAL_GROUNDING_TIMEOUT_MS,
      killSignal: "SIGKILL",
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return parseBrowserVisualGroundingOutput(stdout, options.imagePath, options.image);
}
