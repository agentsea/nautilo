import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

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
  readonly screenshotSha256: string;
}

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
  return Object.freeze({
    recognitionMode: "hybrid",
    durationMs: finiteNumber(result["durationMs"], "durationMs"),
    globalDurationMs: finiteNumber(result["globalDurationMs"], "globalDurationMs"),
    cropDurationMs: finiteNumber(result["cropDurationMs"], "cropDurationMs"),
    cropRequestCount: integer(result["cropRequestCount"], "cropRequestCount"),
    text,
    rectangles: rawRectangles.map((value, index) => parseBox(value, width, height, `rectangles[${index}]`)),
    contours: rawContours.map((value, index) => parseBox(value, width, height, `contours[${index}]`)),
    contourCount: integer(result["contourCount"], "contourCount"),
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
