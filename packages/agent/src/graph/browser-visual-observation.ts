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

const visualLayoutKindSchema = z.enum(["grid", "row", "column"]);
const visualLayoutSemanticSchema = z.object({
  groupId: z.string().regex(/^(?:grid|row|column)-\d+$/),
  kind: visualLayoutKindSchema,
  ordinal: positiveInteger,
  itemCount: positiveInteger,
  row: positiveInteger,
  column: positiveInteger,
  rows: positiveInteger,
  columns: positiveInteger,
}).strict().superRefine((layout, ctx) => {
  if (!layout.groupId.startsWith(`${layout.kind}-`)) {
    ctx.addIssue({ code: "custom", path: ["groupId"], message: "Layout group id does not match kind" });
  }
  if (layout.ordinal > layout.itemCount) {
    ctx.addIssue({ code: "custom", path: ["ordinal"], message: "Layout ordinal exceeds item count" });
  }
  if (layout.row > layout.rows || layout.column > layout.columns) {
    ctx.addIssue({ code: "custom", path: ["row"], message: "Layout position exceeds dimensions" });
  }
});

const visualLayoutMembershipSchema = visualLayoutSemanticSchema.safeExtend({ box: visualBoxSchema });

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
    layouts: z.array(visualLayoutMembershipSchema).optional(),
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
  layout: visualLayoutSemanticSchema.optional(),
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
export type BrowserVisualTarget = BrowserVisualObservation["targets"][number];

/**
 * Private binding sent only to the trusted Desktop relay after the selected
 * tool call has passed its normal pending-decision validation. The decision
 * model sees the opaque visualRef and semantic fields, never this geometry.
 */
export const browserVisualTargetBindingSchema = z.object({
  version: z.literal(1),
  visualRef: z.string().regex(/^v\d+$/),
  role: nonBlank,
  name: nonBlank,
  interaction: z.enum(["click", "focus", "unknown"]),
  context: z.string(),
  sources: z.array(nonBlank).optional(),
  confidence: z.number().min(0).max(1).optional(),
  layout: visualLayoutSemanticSchema.optional(),
  point: z.object({ x: nonnegativeInteger, y: nonnegativeInteger }).strict(),
  box: visualBoxSchema.optional(),
}).strict();

export type BrowserVisualTargetBinding = z.infer<typeof browserVisualTargetBindingSchema>;

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

function boxKey(box: BrowserVisualBox): string {
  return `${box.x}:${box.y}:${box.width}:${box.height}`;
}

type VisualLayoutMembership = z.infer<typeof visualLayoutMembershipSchema>;
type VisualLayoutSemantic = z.infer<typeof visualLayoutSemanticSchema>;

function layoutWithoutBox(layout: VisualLayoutMembership | undefined): VisualLayoutSemantic | undefined {
  if (layout === undefined) return undefined;
  const { box: _box, ...semantic } = layout;
  return semantic;
}

function layoutContext(layout: VisualLayoutSemantic | undefined): string | null {
  if (layout === undefined) return null;
  if (layout.kind === "grid") {
    return `${layout.groupId}; grid item ${layout.ordinal} of ${layout.itemCount}; row ${layout.row} of ${layout.rows}; column ${layout.column} of ${layout.columns}`;
  }
  return `${layout.groupId}; ${layout.kind} item ${layout.ordinal} of ${layout.itemCount}`;
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
  observation: TextObservation,
  text: readonly TextObservation[],
  image: { readonly width: number; readonly height: number },
): string {
  const center = boxCenter(observation.box);
  const nearest = text.filter((candidate) => candidate !== observation)
    .sort((left, right) => distance(observation.box, left.box) - distance(observation.box, right.box))[0];
  const position = categoricalPosition(center, image);
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
  const layoutByBox = new Map((parsed.extraction.layouts ?? []).map((layout) => [boxKey(layout.box), layout]));
  const regionTargets = regions.map((region) => {
    const enclosed = text.filter((item) => containsPoint(region.box, boxCenter(item.box), 4));
    const nearby = text.filter((item) => !enclosed.includes(item))
      .sort((left, right) => distance(region.box, left.box) - distance(region.box, right.box))
      .slice(0, 3);
    const name = enclosed.sort(readingOrder).map((item) => item.text).join(" ").trim()
      || "unlabelled visual region";
    const center = boxCenter(region.box);
    const location = categoricalPosition(center, image);
    const layout = layoutWithoutBox(layoutByBox.get(boxKey(region.box)));
    const structuralContext = layoutContext(layout);
    return {
      role: layout === undefined ? "visual region" : `${layout.kind} item`,
      name,
      interaction: "unknown" as const,
      x: center.x,
      y: center.y,
      context: [structuralContext, nearby.length
        ? `${location}; near ${nearby.map((item) => item.text).join(" | ")}`
        : `${location}; ${region.source} region`].filter(Boolean).join("; "),
      box: region.box,
      sources: name === "unlabelled visual region" ? [region.source] : [region.source, "ocr"],
      confidence: region.confidence,
      ...(layout === undefined ? {} : { layout }),
    };
  });
  const textTargets = text.map((item) => {
    const center = boxCenter(item.box);
    const enclosing = regions.filter((region) => containsPoint(region.box, center, 3))
      .sort((left, right) => boxArea(left.box) - boxArea(right.box))[0];
    const box = enclosing?.box ?? item.box;
    const targetCenter = boxCenter(box);
    const layout = layoutWithoutBox(layoutByBox.get(boxKey(box)));
    const structuralContext = layoutContext(layout);
    return {
      role: layout === undefined ? (enclosing ? "labelled visual region" : "visible text") : `${layout.kind} item`,
      name: item.text,
      interaction: "unknown" as const,
      x: targetCenter.x,
      y: targetCenter.y,
      context: [structuralContext, `${enclosing ? `text inside ${enclosing.source} region` : "OCR text box"}; ${targetContext(item, text, image)}`]
        .filter(Boolean).join("; "),
      box,
      sources: enclosing ? ["ocr", enclosing.source] : ["ocr"],
      confidence: item.confidence,
      ...(layout === undefined ? {} : { layout }),
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
  const groups = [...new Map(targets.filter((target) => target.layout !== undefined)
    .map((target) => [target.layout!.groupId, target.layout!])).values()];
  const snapshot = [
    "- visual viewport",
    `  - summary ${quoted(summary)}`,
    ...visibleText.map((value) => `  - visible_text ${quoted(value)}`),
    ...groups.map((group) => `  - visual_group ${quoted(group.groupId)} [kind=${group.kind}, rows=${group.rows}, columns=${group.columns}, items=${group.itemCount}]`),
    ...targets.map((target) => `  - ${target.role} ${quoted(target.name)} [visual_ref=${target.visualRef}, interaction=${target.interaction}${target.layout === undefined ? "" : `, group=${target.layout.groupId}, row=${target.layout.row}, column=${target.layout.column}`}] sources=${quoted(target.sources.join(","))} context=${quoted(target.context)}`),
  ].join("\n");
  return {
    pageUrl: parsed.pageUrl,
    browserSessionId: parsed.browserSessionId,
    observationId: parsed.observationId,
    snapshot,
    visual,
  };
}
