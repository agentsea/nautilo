import type { BoardModel } from "@nautilo/office-board";
import { connectionSitesForKind } from "@nautilo/office-slides/node";
import nativeBoardModelSchemaJson from "./generated/native-board-model.schema.json";
import validateGenerated, {
  type ValidationError as GeneratedValidationError,
} from "./generated/native-board-model-validator.mjs";

export const NATIVE_BOARD_MODEL_SCHEMA_VERSION = 1 as const;
const nativeBoardModelSchema = nativeBoardModelSchemaJson as Readonly<Record<string, unknown>>;

type NativeBoardModelValidationError = Readonly<{
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Readonly<Record<string, unknown>>;
}>;

export class NativeBoardModelValidationFailure extends TypeError {
  readonly errors: readonly NativeBoardModelValidationError[];
  readonly errorCount: number;
  readonly affectedPaths: readonly string[];

  constructor(errors: readonly NativeBoardModelValidationError[]) {
    const first = errors[0];
    const affectedPaths = [...new Set(errors.map((error) => error.instancePath || "/"))];
    super(first
      ? `${first.instancePath || "/"}: ${first.message} (${errors.length} validation error${errors.length === 1 ? "" : "s"} across ${affectedPaths.length} path${affectedPaths.length === 1 ? "" : "s"}; full details are available on errors)`
      : "Native Board model is invalid");
    this.name = "NativeBoardModelValidationFailure";
    this.errors = errors;
    this.errorCount = errors.length;
    this.affectedPaths = affectedPaths;
  }
}

type UnknownRecord = Record<string, unknown>;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_IMAGE_SOURCE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function structuralError(
  errors: NativeBoardModelValidationError[],
  instancePath: string,
  keyword: string,
  message: string,
  params: Record<string, unknown> = {},
): void {
  errors.push({ instancePath, schemaPath: `#/x-nautilo-invariants/${keyword}`, keyword, message, params });
}

export function boardImageSourceError(value: unknown): string | undefined {
  const match = typeof value === "string" ? SAFE_IMAGE_SOURCE.exec(value) : null;
  if (!match) return "must be a self-contained base64 PNG, JPEG, GIF, or WebP data URL";
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
  } catch {
    return "contains invalid base64 image data";
  }
  const signature = match[1] === "png"
    ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    : match[1] === "jpeg" ? [0xff, 0xd8, 0xff]
      : match[1] === "gif" ? [0x47, 0x49, 0x46, 0x38]
        : [0x52, 0x49, 0x46, 0x46];
  if (signature.some((byte, index) => bytes[index] !== byte)) return "does not match its declared image format";
  if (match[1] === "webp" && String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") return "does not match its declared image format";
  return undefined;
}

function validateJsonAuthority(value: unknown, errors: NativeBoardModelValidationError[]): void {
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: "" }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      structuralError(errors, current.path || "/", "finite-number", "must be finite");
      continue;
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((entry, index) => pending.push({ value: entry, path: `${current.path}/${index}` }));
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const [key, entry] of Object.entries(current.value)) {
      const path = `${current.path}/${escapePointer(key)}`;
      if (FORBIDDEN_KEYS.has(key)) structuralError(errors, path, "safe-json", "is a forbidden object key");
      if (key === "src") {
        const message = boardImageSourceError(entry);
        if (message) structuralError(errors, path, "image-source", message);
      }
      if (key === "href" && (typeof entry !== "string" || !/^(?:https?:|mailto:)/i.test(entry))) {
        structuralError(errors, path, "link-protocol", "must use http, https, or mailto");
      }
      pending.push({ value: entry, path });
    }
  }
}

function validateElementIntegrity(model: BoardModel, errors: NativeBoardModelValidationError[]): void {
  const ids = new Map<string, { element: UnknownRecord; path: string }>();
  const references: Array<{ id: string; siteIndex: number; path: string }> = [];
  const visit = (elements: unknown[], parentPath: string): void => {
    elements.forEach((candidate, index) => {
      const element = candidate as UnknownRecord;
      const path = `${parentPath}/${index}`;
      const id = element["id"] as string;
      if (id.length === 0) structuralError(errors, `${path}/id`, "element-id", "must be a non-empty string");
      const previous = ids.get(id);
      if (previous) structuralError(errors, `${path}/id`, "unique-element-id", "must be unique across the Board", { id, firstPath: previous.path });
      else ids.set(id, { element, path: `${path}/id` });
      const frame = element["frame"] as UnknownRecord;
      if ((frame["w"] as number) < 0 || (frame["h"] as number) < 0) {
        structuralError(errors, `${path}/frame`, "frame-dimensions", "width and height must be non-negative");
      }
      if (element["type"] === "connector") {
        for (const side of ["start", "end"] as const) {
          const endpoint = element[side] as UnknownRecord;
          if (endpoint["kind"] === "attached") {
            references.push({ id: endpoint["elementId"] as string, siteIndex: endpoint["siteIndex"] as number, path: `${path}/${side}` });
            if (!Number.isSafeInteger(endpoint["siteIndex"]) || (endpoint["siteIndex"] as number) < 0) {
              structuralError(errors, `${path}/${side}/siteIndex`, "connector-endpoint", "must be a non-negative integer");
            }
          }
        }
      }
      if (element["type"] === "group") {
        visit(((element["data"] as UnknownRecord)["children"] as unknown[]), `${path}/data/children`);
      }
    });
  };
  visit(model.elements as unknown[], "/elements");
  for (const reference of references) {
    const target = ids.get(reference.id);
    if (!target) {
      structuralError(errors, `${reference.path}/elementId`, "connector-reference", "must identify an element on this Board", { id: reference.id });
      continue;
    }
    const targetKind = target.element["type"] === "shape"
      ? (target.element["data"] as UnknownRecord)["kind"] as Parameters<typeof connectionSitesForKind>[0]
      : undefined;
    const siteCount = connectionSitesForKind(targetKind).length;
    if (reference.siteIndex >= siteCount) {
      structuralError(errors, `${reference.path}/siteIndex`, "connector-endpoint", "must identify a connection site on the attached element", { siteIndex: reference.siteIndex, siteCount, elementId: reference.id });
    }
  }
}

function generatedErrors(): NativeBoardModelValidationError[] {
  return (validateGenerated.errors ?? []).map((error: GeneratedValidationError) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "is invalid",
    params: error.params,
  }));
}

export function validateNativeBoardModel(value: unknown): readonly NativeBoardModelValidationError[] {
  if (!validateGenerated(value)) return generatedErrors();
  const errors: NativeBoardModelValidationError[] = [];
  validateJsonAuthority(value, errors);
  const model = value as BoardModel;
  if (model.meta.title.length === 0) structuralError(errors, "/meta/title", "board-title", "must be a non-empty string");
  validateElementIntegrity(model, errors);
  return errors;
}

export function assertNativeBoardModel(value: unknown): asserts value is BoardModel {
  const errors = validateNativeBoardModel(value);
  if (errors.length > 0) throw new NativeBoardModelValidationFailure(errors);
}

function malformedLiteralColors(value: BoardModel): Map<string, string[]> {
  const colors = new Map<string, string[]>();
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: "" }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== "object") continue;
    const color = current.value as UnknownRecord;
    if (color["kind"] === "srgb" && typeof color["value"] === "string" &&
        /^(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/iu.test(color["value"].trim())) {
      const literal = color["value"].trim().toLowerCase();
      const paths = colors.get(literal) ?? [];
      paths.push(`${current.path}/value`);
      colors.set(literal, paths);
    }
    for (const [key, entry] of Object.entries(current.value).reverse()) {
      pending.push({ value: entry, path: `${current.path}/${escapePointer(key)}` });
    }
  }
  return colors;
}

/** The native renderer passes literal colors to Canvas as CSS. Reject newly
 * authored bare hex without preventing incremental repair of older boards. */
export function assertBoardAuthoringColors(value: BoardModel, baseline?: BoardModel): void {
  const errors: NativeBoardModelValidationError[] = [];
  const before = baseline ? malformedLiteralColors(baseline) : new Map<string, string[]>();
  for (const [literal, paths] of malformedLiteralColors(value)) {
    for (const path of paths.slice(before.get(literal)?.length ?? 0)) {
      structuralError(errors, path, "color-syntax",
        "hexadecimal CSS colors must start with # (for example #FFF2A8); bare hex renders incorrectly");
    }
  }
  if (errors.length > 0) throw new NativeBoardModelValidationFailure(errors);
}

export function nativeBoardModelSchemaDescriptor(): Readonly<{
  version: typeof NATIVE_BOARD_MODEL_SCHEMA_VERSION;
  schema: Readonly<Record<string, unknown>>;
}> {
  return { version: NATIVE_BOARD_MODEL_SCHEMA_VERSION, schema: nativeBoardModelSchema };
}
