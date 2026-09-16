import type { SlidesDocument } from "../engine/node.js";
import nativeSlideModelSchemaJson from "./generated/native-slide-model.schema.json";
import validateGenerated, {
  type ValidationError as GeneratedValidationError,
} from "./generated/native-slide-model-validator.mjs";

export const NATIVE_SLIDE_MODEL_SCHEMA_VERSION = 1 as const;
export const nativeSlideModelSchema = nativeSlideModelSchemaJson as Readonly<Record<string, unknown>>;

export type NativeSlideModelValidationError = Readonly<{
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Readonly<Record<string, unknown>>;
}>;

export class NativeSlideModelValidationFailure extends TypeError {
  readonly errors: readonly NativeSlideModelValidationError[];
  readonly errorCount: number;
  readonly affectedPaths: readonly string[];

  constructor(errors: readonly NativeSlideModelValidationError[]) {
    const first = errors[0];
    const affectedPaths = [...new Set(errors.map((error) => error.instancePath || "/"))];
    super(first
      ? `${first.instancePath || "/"}: ${first.message} (${errors.length} validation error${errors.length === 1 ? "" : "s"} across ${affectedPaths.length} path${affectedPaths.length === 1 ? "" : "s"}; full details are available on errors)`
      : "Native slide model is invalid");
    this.name = "NativeSlideModelValidationFailure";
    this.errors = errors;
    this.errorCount = errors.length;
    this.affectedPaths = affectedPaths;
  }
}

type UnknownRecord = Record<string, unknown>;

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function structuralError(
  errors: NativeSlideModelValidationError[],
  instancePath: string,
  keyword: string,
  message: string,
  params: Record<string, unknown> = {},
): void {
  errors.push({
    instancePath,
    schemaPath: `#/x-nautilo-invariants/${keyword}`,
    keyword,
    message,
    params,
  });
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right));
}

function validateTable(
  element: UnknownRecord,
  path: string,
  errors: NativeSlideModelValidationError[],
): void {
  const frame = element["frame"] as UnknownRecord;
  const data = element["data"] as UnknownRecord;
  const widths = data["columnWidths"] as number[];
  const rows = data["rows"] as UnknownRecord[];
  if (widths.length === 0) {
    structuralError(errors, `${path}/data/columnWidths`, "table-grid", "must contain at least one column");
    return;
  }
  if (rows.length === 0) {
    structuralError(errors, `${path}/data/rows`, "table-grid", "must contain at least one row");
    return;
  }
  widths.forEach((width, index) => {
    if (!(width > 0)) structuralError(errors, `${path}/data/columnWidths/${index}`, "table-grid", "must be positive");
  });
  rows.forEach((row, rowIndex) => {
    if (!((row["height"] as number) > 0)) {
      structuralError(errors, `${path}/data/rows/${rowIndex}/height`, "table-grid", "must be positive");
    }
    const cells = row["cells"] as UnknownRecord[];
    if (cells.length !== widths.length) {
      structuralError(errors, `${path}/data/rows/${rowIndex}/cells`, "table-grid", "cell count must equal column count", {
        expected: widths.length,
        actual: cells.length,
      });
    }
  });
  if (!approximatelyEqual(frame["w"] as number, widths.reduce((sum, width) => sum + width, 0))) {
    structuralError(errors, `${path}/frame/w`, "table-frame", "must equal the sum of column widths");
  }
  if (!approximatelyEqual(frame["h"] as number, rows.reduce((sum, row) => sum + (row["height"] as number), 0))) {
    structuralError(errors, `${path}/frame/h`, "table-frame", "must equal the sum of row heights");
  }

  const occupied = new Set<string>();
  const covered = new Set<string>();
  rows.forEach((row, rowIndex) => {
    const cells = row["cells"] as UnknownRecord[];
    cells.forEach((cell, columnIndex) => {
      const gridSpan = cell["gridSpan"] === undefined ? 1 : cell["gridSpan"] as number;
      const rowSpan = cell["rowSpan"] === undefined ? 1 : cell["rowSpan"] as number;
      const cellPath = `${path}/data/rows/${rowIndex}/cells/${columnIndex}`;
      for (const [name, span] of [["gridSpan", gridSpan], ["rowSpan", rowSpan]] as const) {
        if (!Number.isSafeInteger(span) || span < 0) {
          structuralError(errors, `${cellPath}/${name}`, "table-merge", "must be zero or a positive integer");
        }
      }
      if (gridSpan === 0 || rowSpan === 0) return;
      if (columnIndex + gridSpan > widths.length || rowIndex + rowSpan > rows.length) {
        structuralError(errors, cellPath, "table-merge", "merge span exceeds the table grid");
        return;
      }
      if (gridSpan === 1 && rowSpan === 1) return;
      for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
        for (let c = columnIndex; c < columnIndex + gridSpan; c += 1) {
          const key = `${r}:${c}`;
          if (occupied.has(key)) structuralError(errors, cellPath, "table-merge", "merge spans overlap");
          occupied.add(key);
          if (r !== rowIndex || c !== columnIndex) covered.add(key);
        }
      }
    });
  });
  rows.forEach((row, rowIndex) => {
    (row["cells"] as UnknownRecord[]).forEach((cell, columnIndex) => {
      const markedCovered = cell["gridSpan"] === 0 || cell["rowSpan"] === 0;
      const coveredByAnchor = covered.has(`${rowIndex}:${columnIndex}`);
      if (markedCovered !== coveredByAnchor) {
        structuralError(
          errors,
          `${path}/data/rows/${rowIndex}/cells/${columnIndex}`,
          "table-merge",
          markedCovered ? "covered cell has no merge anchor" : "cell covered by a merge must carry a zero span marker",
        );
      }
    });
  });
}

function validateChart(
  element: UnknownRecord,
  path: string,
  errors: NativeSlideModelValidationError[],
): void {
  const data = element["data"] as UnknownRecord;
  const categories = data["categories"] as string[];
  const series = data["series"] as UnknownRecord[];
  series.forEach((item, index) => {
    const values = item["values"] as Array<number | null>;
    if (values.length !== categories.length) {
      structuralError(errors, `${path}/data/series/${index}/values`, "chart-points", "value count must equal category count", {
        expected: categories.length,
        actual: values.length,
      });
    }
  });
  const indices = data["categoryIndices"] as number[] | undefined;
  if (indices) {
    if (indices.length !== categories.length) {
      structuralError(errors, `${path}/data/categoryIndices`, "chart-points", "index count must equal category count");
    }
    indices.forEach((index, position) => {
      if (!Number.isSafeInteger(index) || index < 0) {
        structuralError(errors, `${path}/data/categoryIndices/${position}`, "chart-points", "must be a non-negative integer");
      }
      if (position > 0 && index <= indices[position - 1]) {
        structuralError(errors, `${path}/data/categoryIndices/${position}`, "chart-points", "must be strictly increasing");
      }
    });
  }
  const axis = data["valueAxis"] as UnknownRecord | undefined;
  if (axis && typeof axis["min"] === "number" && typeof axis["max"] === "number" && axis["min"] >= axis["max"]) {
    structuralError(errors, `${path}/data/valueAxis`, "chart-axis", "minimum must be less than maximum");
  }
}

function validateElements(
  elements: UnknownRecord[],
  path: string,
  errors: NativeSlideModelValidationError[],
): Map<string, UnknownRecord> {
  const indexed = new Map<string, UnknownRecord>();
  const visit = (items: UnknownRecord[], parentPath: string): void => {
    items.forEach((element, index) => {
      const elementPath = `${parentPath}/${index}`;
      if (typeof element["id"] === "string") indexed.set(element["id"], element);
      if (element["type"] === "table") validateTable(element, elementPath, errors);
      if (element["type"] === "chart") validateChart(element, elementPath, errors);
      if (element["type"] === "connector") {
        for (const side of ["start", "end"] as const) {
          const endpoint = element[side] as UnknownRecord;
          if (endpoint["kind"] === "attached" && (!Number.isSafeInteger(endpoint["siteIndex"]) || (endpoint["siteIndex"] as number) < 0)) {
            structuralError(errors, `${elementPath}/${side}/siteIndex`, "connector-endpoint", "must be a non-negative integer");
          }
        }
      }
      if (element["type"] === "group") {
        visit(((element["data"] as UnknownRecord)["children"] as UnknownRecord[]), `${elementPath}/data/children`);
      }
    });
  };
  visit(elements, path);
  return indexed;
}

function structuralErrors(value: SlidesDocument): NativeSlideModelValidationError[] {
  const errors: NativeSlideModelValidationError[] = [];
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: "" }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      structuralError(errors, current.path || "/", "finite-number", "must be finite");
    } else if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => pending.push({ value: item, path: `${current.path}/${index}` }));
    } else if (typeof current.value === "object" && current.value !== null) {
      Object.entries(current.value).forEach(([key, item]) => pending.push({
        value: item,
        path: `${current.path}/${escapePointer(key)}`,
      }));
    }
  }
  if (value.meta.pxPerPt !== undefined && !(value.meta.pxPerPt > 0)) {
    structuralError(errors, "/meta/pxPerPt", "deck-scale", "must be positive");
  }
  if (value.meta.slideHeight !== undefined && !(value.meta.slideHeight > 0)) {
    structuralError(errors, "/meta/slideHeight", "deck-scale", "must be positive");
  }
  value.slides.forEach((slide, slideIndex) => {
    const slidePath = `/slides/${slideIndex}`;
    const elements = validateElements(slide.elements as unknown as UnknownRecord[], `${slidePath}/elements`, errors);
    if (slide.transition && slide.transition.durationMs < 0) {
      structuralError(errors, `${slidePath}/transition/durationMs`, "animation-time", "must be non-negative");
    }
    slide.animations?.forEach((animation, animationIndex) => {
      const path = `${slidePath}/animations/${animationIndex}`;
      if (animation.durationMs < 0) structuralError(errors, `${path}/durationMs`, "animation-time", "must be non-negative");
      if (animation.delayMs !== undefined && animation.delayMs < 0) structuralError(errors, `${path}/delayMs`, "animation-time", "must be non-negative");
      const target = elements.get(animation.elementId);
      if (!target) structuralError(errors, `${path}/elementId`, "animation-target", "must identify an element on the same slide");
      if (animation.byParagraph === true && target?.["type"] !== "text") {
        structuralError(errors, `${path}/byParagraph`, "animation-target", "paragraph animation requires a text element");
      }
    });
  });
  value.guides.forEach((guide, index) => {
    if (!Number.isFinite(guide.position)) structuralError(errors, `/guides/${index}/position`, "finite-number", "must be finite");
  });
  return errors;
}

function generatedErrors(): NativeSlideModelValidationError[] {
  return (validateGenerated.errors ?? []).map((error: GeneratedValidationError) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "is invalid",
    params: error.params,
  }));
}

export function validateNativeSlideModel(value: unknown): readonly NativeSlideModelValidationError[] {
  if (!validateGenerated(value)) return generatedErrors();
  return structuralErrors(value as SlidesDocument);
}

export function assertNativeSlideModel(value: unknown): asserts value is SlidesDocument {
  const errors = validateNativeSlideModel(value);
  if (errors.length > 0) throw new NativeSlideModelValidationFailure(errors);
}

export function nativeSlideModelSchemaDescriptor(): Readonly<{
  version: typeof NATIVE_SLIDE_MODEL_SCHEMA_VERSION;
  schema: Readonly<Record<string, unknown>>;
}> {
  return { version: NATIVE_SLIDE_MODEL_SCHEMA_VERSION, schema: nativeSlideModelSchema };
}
