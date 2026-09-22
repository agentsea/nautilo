import { z } from "zod";

const nonBlank = z.string().refine((value) => value.trim().length > 0);
const positiveInteger = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();

const visualBoxSchema = z.object({
  x: nonnegativeInteger,
  y: nonnegativeInteger,
  width: positiveInteger,
  height: positiveInteger,
}).strict();

const rawTextObservationSchema = z.object({
  text: nonBlank,
  box: visualBoxSchema,
  confidence: z.number().min(0).max(1),
}).strict();

/** Trusted Desktop result for one locally-extracted embedded-browser screenshot. */
const relayBrowserVisualObservationSchema = z.object({
  version: z.literal(1),
  pageUrl: z.url(),
  browserSessionId: nonBlank,
  observationId: nonBlank,
  image: z.object({ width: positiveInteger, height: positiveInteger }).strict(),
  viewport: z.object({
    cssWidth: z.number().positive(),
    cssHeight: z.number().positive(),
    dpr: z.number().positive(),
  }).strict(),
  extraction: z.object({
    recognitionMode: z.enum(["fast", "accurate", "hybrid"]),
    durationMs: z.number().nonnegative(),
    globalDurationMs: z.number().nonnegative(),
    cropDurationMs: z.number().nonnegative(),
    cropRequestCount: nonnegativeInteger,
    text: z.array(rawTextObservationSchema),
    rectangles: z.array(visualBoxSchema),
    contours: z.array(visualBoxSchema),
    contourCount: nonnegativeInteger,
  }).strict(),
}).strict();

export type BrowserVisualBox = z.infer<typeof visualBoxSchema>;

const browserVisualTargetSchema = z.object({
  visualRef: z.string().regex(/^v\d+$/),
  role: nonBlank,
  name: nonBlank,
  interaction: z.enum(["click", "focus", "unknown"]),
  x: nonnegativeInteger,
  y: nonnegativeInteger,
  context: z.string(),
  box: visualBoxSchema.optional(),
  sources: z.array(nonBlank).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

export const browserVisualObservationSchema = z.object({
  viewport: z.object({
    imageWidth: positiveInteger,
    imageHeight: positiveInteger,
    cssWidth: z.number().positive(),
    cssHeight: z.number().positive(),
    dpr: z.number().positive(),
  }).strict(),
  targets: z.array(browserVisualTargetSchema),
}).strict().superRefine((visual, ctx) => {
  const refs = new Set<string>();
  for (const [index, target] of visual.targets.entries()) {
    if (refs.has(target.visualRef)) {
      ctx.addIssue({ code: "custom", path: ["targets", index, "visualRef"], message: "Duplicate visual ref" });
    }
    refs.add(target.visualRef);
    if (target.x >= visual.viewport.imageWidth || target.y >= visual.viewport.imageHeight) {
      ctx.addIssue({ code: "custom", path: ["targets", index], message: "Visual target is outside the image" });
    }
    if (target.box && (target.box.x + target.box.width > visual.viewport.imageWidth
      || target.box.y + target.box.height > visual.viewport.imageHeight)) {
      ctx.addIssue({ code: "custom", path: ["targets", index, "box"], message: "Visual target box is outside the image" });
    }
  }
});

export type BrowserVisualObservation = z.infer<typeof browserVisualObservationSchema>;

type TextObservation = z.infer<typeof rawTextObservationSchema>;
type RegionObservation = {
  readonly box: BrowserVisualBox;
  readonly confidence: number;
  readonly source: "rectangle" | "contour";
};

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

function containsPoint(
  box: BrowserVisualBox,
  point: { readonly x: number; readonly y: number },
  padding = 0,
): boolean {
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

function targetContext(
  observation: TextObservation,
  text: readonly TextObservation[],
  image: { readonly width: number; readonly height: number },
): string {
  const center = boxCenter(observation.box);
  const nearest = text.filter((candidate) => candidate !== observation)
    .sort((left, right) => distance(observation.box, left.box) - distance(observation.box, right.box))[0];
  const position = `at ${Math.round((center.x / image.width) * 100)}% from left, ${Math.round((center.y / image.height) * 100)}% from top`;
  return nearest ? `${position}; near ${JSON.stringify(nearest.text)}` : position;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/** Deterministic local-Vision result -> Jev-safe visual observation. */
export function browserVisualObservationFromRelay(raw: unknown): {
  readonly pageUrl: string;
  readonly browserSessionId: string;
  readonly observationId: string;
  readonly snapshot: string;
  readonly visual: BrowserVisualObservation;
} {
  const parsed = relayBrowserVisualObservationSchema.parse(raw);
  const image = parsed.image;
  const text = parsed.extraction.text.filter((item) => item.confidence >= 0.3).sort(readingOrder);
  const regions = dedupeRegions([
    ...parsed.extraction.rectangles.map((box) => ({ box, confidence: 1, source: "rectangle" as const })),
    ...parsed.extraction.contours.map((box) => ({ box, confidence: 0.5, source: "contour" as const })),
  ]);
  const regionTargets = regions.map((region) => {
    const enclosed = text.filter((item) => containsPoint(region.box, boxCenter(item.box), 4));
    const nearby = text.filter((item) => !enclosed.includes(item))
      .sort((left, right) => distance(region.box, left.box) - distance(region.box, right.box))
      .slice(0, 3);
    const name = enclosed.sort(readingOrder).map((item) => item.text).join(" ").trim()
      || "unlabelled visual region";
    const center = boxCenter(region.box);
    return {
      role: "visual region",
      name,
      interaction: "unknown" as const,
      x: center.x,
      y: center.y,
      context: nearby.length ? `near ${nearby.map((item) => item.text).join(" | ")}` : `${region.source} region`,
      box: region.box,
      sources: name === "unlabelled visual region" ? [region.source] : [region.source, "ocr"],
      confidence: region.confidence,
    };
  });
  const textTargets = text.map((item) => {
    const center = boxCenter(item.box);
    const enclosing = regions.filter((region) => containsPoint(region.box, center, 3))
      .sort((left, right) => boxArea(left.box) - boxArea(right.box))[0];
    const box = enclosing?.box ?? item.box;
    const targetCenter = boxCenter(box);
    return {
      role: enclosing ? "labelled visual region" : "visible text",
      name: item.text,
      interaction: "unknown" as const,
      x: targetCenter.x,
      y: targetCenter.y,
      context: `${enclosing ? `text inside ${enclosing.source} region` : "OCR text box"}; ${targetContext(item, text, image)}`,
      box,
      sources: enclosing ? ["ocr", enclosing.source] : ["ocr"],
      confidence: item.confidence,
    };
  });
  const rawTargets = [...regionTargets, ...textTargets]
    .filter((target, index, all) => all.findIndex((candidate) =>
      candidate.x === target.x && candidate.y === target.y && candidate.name === target.name) === index)
    .sort(readingOrder);
  const targets = rawTargets.map((target, index) => ({ ...target, visualRef: `v${index + 1}` }));
  const visual = browserVisualObservationSchema.parse({
    viewport: {
      imageWidth: image.width,
      imageHeight: image.height,
      cssWidth: parsed.viewport.cssWidth,
      cssHeight: parsed.viewport.cssHeight,
      dpr: parsed.viewport.dpr,
    },
    targets,
  });
  const visibleText = text.map((item) => item.text).filter((value, index, all) => all.indexOf(value) === index);
  const summary = `macOS Vision ${parsed.extraction.recognitionMode} extracted ${text.length} text boxes and ${regions.length} visual regions without a generative model`;
  const snapshot = [
    `- visual viewport [image_width=${image.width}, image_height=${image.height}]`,
    `  - summary ${quoted(summary)}`,
    ...visibleText.map((value) => `  - visible_text ${quoted(value)}`),
    ...targets.map((target) => `  - ${target.role} ${quoted(target.name)} [visual_ref=${target.visualRef}, interaction=${target.interaction}, image_x=${target.x}, image_y=${target.y}, image_box=${target.box.x},${target.box.y},${target.box.width},${target.box.height}] sources=${quoted(target.sources.join(","))} context=${quoted(target.context)}`),
  ].join("\n");
  return {
    pageUrl: parsed.pageUrl,
    browserSessionId: parsed.browserSessionId,
    observationId: parsed.observationId,
    snapshot,
    visual,
  };
}
