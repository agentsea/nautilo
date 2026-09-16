import type { BoardModel } from "@nautilo/office-board";
import {
  parseBoardHtml,
  serializeBoardHtml,
  validateBoardDocument,
} from "./board-document";
import { assertBoardAuthoringColors, nativeBoardModelSchemaDescriptor } from "./board-model-validation";
import { BoardPatchError, patchBoardJson } from "./board-json-patch";
import { prepareBoardAssetOperations, type BoardAssetResources } from "./board-assets";

type BoardDocumentTarget =
  | { surface: "workspace"; path: string }
  | { surface: "currentFolder"; relativePath: string };

type WriteResult =
  | { kind: "saved"; sha256: string; revision?: number | null }
  | { kind: "conflict"; currentSha256: string | null }
  | { kind: "error"; message: string };

export type BoardAppHost = BoardAssetResources & {
  document: {
    createFromAction(id: string, opts: {
      targetSurface: "workspace" | "currentFolder";
      filename: string;
      openAfterCreate?: boolean;
    }): Promise<{ target: BoardDocumentTarget; displayPath: string; opened: boolean }>;
    read(target: BoardDocumentTarget): Promise<{
      content: string;
      displayPath: string;
      baseSha256: string | null;
      baseRevision: number | null;
    }>;
    write(target: BoardDocumentTarget, next: { content: string }, opts: {
      baseSha256: string;
      baseRevision: number | null;
    }): Promise<WriteResult>;
    writeBound(next: { content: string }): Promise<WriteResult>;
  };
};

export type BoardAgentToolContext = { nautiloApp: BoardAppHost };
type Version =
  | { kind: "artifact_revision"; revision: number }
  | { kind: "local_sha"; sha256: string };
type UnknownRecord = Record<string, unknown>;
const SHA256 = /^[a-f0-9]{64}$/u;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as UnknownRecord;
}

function rejectUnknown(value: UnknownRecord, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`unknown field ${extra}`);
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function target(value: unknown): BoardDocumentTarget {
  const input = record(value, "target");
  rejectUnknown(input, ["surface", "path", "relativePath"]);
  if (input["surface"] === "workspace" && typeof input["path"] === "string" && input["path"].length > 0 && input["relativePath"] === undefined)
    return { surface: "workspace", path: input["path"] };
  const relative = input["relativePath"];
  if (input["surface"] === "currentFolder" && typeof relative === "string" && relative.length > 0 && input["path"] === undefined &&
      !relative.startsWith("/") && !relative.startsWith("\\") && !/^[A-Za-z]:/u.test(relative) && !containsControl(relative) &&
      !relative.split(/[\\/]/u).some((part) => part === ".."))
    return { surface: "currentFolder", relativePath: relative };
  throw new Error("target must identify one workspace path or Current Folder relativePath");
}

function version(value: unknown): Version {
  const input = record(value, "documentVersion");
  rejectUnknown(input, ["kind", "revision", "sha256"]);
  if (input["kind"] === "artifact_revision" && Number.isSafeInteger(input["revision"]) && (input["revision"] as number) >= 0 && input["sha256"] === undefined)
    return { kind: "artifact_revision", revision: input["revision"] as number };
  if (input["kind"] === "local_sha" && typeof input["sha256"] === "string" && SHA256.test(input["sha256"]) && input["revision"] === undefined)
    return { kind: "local_sha", sha256: input["sha256"] };
  throw new Error("live Board version is invalid");
}

function failure(status: "invalid_request" | "stale_revision" | "stale_version" | "error", code: string,
  message: string, retrySafe: boolean, stateChanged: false | "unknown" = false) {
  return { ok: false as const, status, code, message, retrySafe, stateChanged };
}

function editFailure(error: unknown) {
  const patch = error instanceof BoardPatchError ? {
    operationIndex: error.operationIndex,
    ...(error.path !== undefined ? { path: error.path } : {}),
  } : {};
  const detail = error && typeof error === "object" ? error as UnknownRecord : {};
  return {
    ...failure("invalid_request", typeof detail["code"] === "string" ? detail["code"] : "invalid_edit",
      error instanceof Error ? error.message : String(error), true),
    ...patch,
    ...(Array.isArray(detail["errors"]) ? { errors: detail["errors"] } : {}),
    ...(Array.isArray(detail["affectedPaths"]) ? { affectedPaths: detail["affectedPaths"] } : {}),
    ...(Number.isSafeInteger(detail["batchOperationIndex"]) ? { operationIndex: detail["batchOperationIndex"] } : {}),
  };
}

function flattenedElements(model: BoardModel): BoardModel["elements"] {
  const elements: BoardModel["elements"] = [];
  const visit = (items: BoardModel["elements"]): void => items.forEach((element) => {
    elements.push(element);
    if (element.type === "group") visit(element.data.children);
  });
  visit(model.elements);
  return elements;
}

function inspect(model: BoardModel, args: UnknownRecord) {
  const selectedIds = args["elementIds"];
  if (selectedIds !== undefined && (!Array.isArray(selectedIds) || selectedIds.length === 0 ||
      selectedIds.some((id) => typeof id !== "string" || id.length === 0) || new Set(selectedIds).size !== selectedIds.length))
    throw new Error("elementIds must be a non-empty array of unique element ids");
  const ids = selectedIds === undefined ? undefined : selectedIds.filter((id): id is string => typeof id === "string");
  const all = flattenedElements(model);
  const counts: Record<string, number> = {};
  all.forEach((element) => { counts[element.type] = (counts[element.type] ?? 0) + 1; });
  if (ids === undefined) return {
    document: model,
    title: model.meta.title,
    topLevelElementCount: model.elements.length,
    elementCount: all.length,
    elementCountsByType: counts,
    returnedElementCount: all.length,
    totalElementCount: all.length,
    completeness: "complete" as const,
  };
  const byId = new Map(all.map((element) => [element.id, element]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`elementIds not found: ${missing.join(", ")}`);
  const elements = ids.map((id) => byId.get(id)!);
  return {
    title: model.meta.title,
    elements,
    selectedElementIds: ids,
    returnedElementCount: elements.length,
    totalElementCount: all.length,
    completeness: "complete" as const,
  };
}

async function apply(model: BoardModel, operations: unknown, resources: BoardAssetResources) {
  const prepared = await prepareBoardAssetOperations(operations, resources);
  const patched = patchBoardJson(model, prepared.operations);
  const document = validateBoardDocument(patched.value);
  assertBoardAuthoringColors(document, model);
  return { document, receipt: { operationCount: prepared.operations.length, changedPaths: patched.paths,
    ...(prepared.receipts.length > 0 ? { resources: prepared.receipts } : {}) } };
}

export async function createFile(args: unknown, ctx: BoardAgentToolContext) {
  let input: UnknownRecord;
  let targetSurface: "workspace" | "currentFolder";
  let filename: string;
  try {
    input = record(args, "arguments");
    rejectUnknown(input, ["targetSurface", "filename", "openAfterCreate"]);
    if (input["targetSurface"] !== "workspace" && input["targetSurface"] !== "currentFolder") throw new Error("targetSurface must be workspace or currentFolder");
    if (typeof input["filename"] !== "string" || !input["filename"].endsWith(".board.html") || input["filename"].includes("/") ||
        input["filename"].includes("\\") || containsControl(input["filename"])) throw new Error("filename must be a safe basename ending in .board.html");
    if (input["openAfterCreate"] !== undefined && typeof input["openAfterCreate"] !== "boolean") throw new Error("openAfterCreate must be a boolean");
    targetSurface = input["targetSurface"];
    filename = input["filename"];
  } catch (error) { return failure("invalid_request", "create_failed", error instanceof Error ? error.message : String(error), true); }
  try {
    const result = await ctx.nautiloApp.document.createFromAction("new-board", {
      targetSurface,
      filename,
      ...(typeof input["openAfterCreate"] === "boolean" ? { openAfterCreate: input["openAfterCreate"] } : {}),
    });
    return { ok: true as const, status: "created" as const, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const parsed = JSON.parse(message) as UnknownRecord;
      if (parsed["ok"] === false && parsed["status"] === "create_failed" && parsed["phase"] === "create"
        && typeof parsed["code"] === "string" && typeof parsed["message"] === "string"
        && Array.isArray(parsed["recoveryActions"])) return parsed;
    } catch { /* An uncertain host error requires inspection before retry. */ }
    return failure("error", "create_failed", message, false, "unknown");
  }
}

export function describeAuthoring(args: unknown) {
  try {
    const input = record(args, "arguments");
    rejectUnknown(input, ["definition", "includeSchema"]);
    const descriptor = nativeBoardModelSchemaDescriptor();
    const schema = descriptor.schema;
    const definitions = record(schema["definitions"] ?? schema["$defs"] ?? {}, "definitions");
    const definitionNames = Object.keys(definitions).sort();
    if (input["definition"] !== undefined) {
      const name = input["definition"];
      if (typeof name !== "string" || !Object.hasOwn(definitions, name)) throw new Error("definition is not in definitionNames");
      const included: UnknownRecord = {};
      const pending = [name];
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (Object.hasOwn(included, current)) continue;
        included[current] = definitions[current];
        const scan: unknown[] = [definitions[current]];
        while (scan.length > 0) {
          const value = scan.pop();
          if (!value || typeof value !== "object") continue;
          const ref = (value as UnknownRecord)["$ref"];
          if (typeof ref === "string" && ref.startsWith("#/definitions/")) {
            const dependency = ref.slice("#/definitions/".length).replace(/~1/gu, "/").replace(/~0/gu, "~");
            if (!Object.hasOwn(definitions, dependency)) throw new Error(`schema reference is unavailable: ${dependency}`);
            pending.push(dependency);
          }
          scan.push(...Object.values(value as UnknownRecord));
        }
      }
      return { ok: true, version: descriptor.version, definition: name,
        schema: { $ref: `#/definitions/${name.replace(/~/gu, "~0").replace(/\//gu, "~1")}`, definitions: included },
        includedDefinitionCount: Object.keys(included).length, completeness: "complete" };
    }
    return { ok: true, version: descriptor.version, definitionNames, definitionCount: definitionNames.length,
      schemaBytes: new TextEncoder().encode(JSON.stringify(schema)).byteLength,
      ...(input["includeSchema"] === true ? { schema, completeness: "complete" } : {
        completeness: "overview", schemaIncluded: false, fullSchemaOption: { includeSchema: true },
      }),
      helpers: { insertImage: { op: "insert-image", required: ["asset", "element"], optional: ["atIndex"],
        generated: ["element.id", "element.type", "element.data.src"], position: "top-level elements index; omitted appends",
        assetAuthority: "asset is passed unchanged to the host-authorized assets.read resolver before any document mutation" } },
      editing: "operations accepts JSON Pointer add, remove, replace, copy, move and test over the complete native Board model. insert-image accepts an authorized asset reference plus a native image element without id, type or data.src, and optional top-level atIndex; it resolves bytes and allocates identity in code. The full result and relationships are validated before one canonical write; there is no creative property allowlist." };
  } catch (error) { return editFailure(error); }
}

export async function inspectBoard(args: unknown, ctx: BoardAgentToolContext) {
  try {
    const input = record(args, "arguments");
    rejectUnknown(input, ["target", "elementIds"]);
    const envelope = await ctx.nautiloApp.document.read(target(input["target"]));
    if (!envelope.baseSha256 || !SHA256.test(envelope.baseSha256)) throw new Error("host did not provide exact revision identity");
    return { ok: true as const, status: "inspected" as const, displayPath: envelope.displayPath,
      expectedSha256: envelope.baseSha256, revision: envelope.baseRevision,
      ...inspect(parseBoardHtml(envelope.content), input) };
  } catch (error) { return failure("invalid_request", "inspection_failed", error instanceof Error ? error.message : String(error), true); }
}

export async function editBoard(args: unknown, ctx: BoardAgentToolContext) {
  let input: UnknownRecord;
  let documentTarget: BoardDocumentTarget;
  try {
    input = record(args, "arguments");
    rejectUnknown(input, ["target", "expectedSha256", "operations"]);
    documentTarget = target(input["target"]);
    if (typeof input["expectedSha256"] !== "string" || !SHA256.test(input["expectedSha256"])) throw new Error("expectedSha256 must come from inspection");
  } catch (error) { return editFailure(error); }
  try {
    const envelope = await ctx.nautiloApp.document.read(documentTarget);
    if (envelope.baseSha256 !== input["expectedSha256"]) return failure("stale_revision", "stale_revision", "The Board changed after inspection.", false);
    const applied = await apply(parseBoardHtml(envelope.content), input["operations"], ctx.nautiloApp);
    let write: WriteResult;
    try {
      write = await ctx.nautiloApp.document.write(documentTarget, { content: serializeBoardHtml(applied.document) },
        { baseSha256: envelope.baseSha256, baseRevision: envelope.baseRevision });
    } catch (error) { return failure("error", "write_failed", error instanceof Error ? error.message : String(error), false, "unknown"); }
    if (write.kind === "conflict") return failure("stale_revision", "write_conflict", "The Board changed before saving.", false);
    if (write.kind === "error") return failure("error", "write_failed", write.message, false);
    return { ok: true as const, status: "saved" as const, sha256: write.sha256, revision: write.revision ?? null, receipt: applied.receipt };
  } catch (error) { return editFailure(error); }
}

function live(args: unknown, allowed: readonly string[]) {
  const input = record(args, "arguments");
  rejectUnknown(input, [...allowed, "sessionToken", "documentVersion", "idempotencyKey", "__canonicalContent"]);
  if (typeof input["sessionToken"] !== "string" || typeof input["__canonicalContent"] !== "string") throw new Error("live Board session is unavailable");
  const documentVersion = version(input["documentVersion"]);
  return { input, documentVersion, versionToken: JSON.stringify(documentVersion), document: parseBoardHtml(input["__canonicalContent"]) };
}

export function inspectOpenBoard(args: unknown, _ctx: BoardAgentToolContext) {
  try {
    const binding = live(args, ["elementIds"]);
    return { ok: true as const, status: "inspected" as const, documentVersion: binding.documentVersion,
      versionToken: binding.versionToken, ...inspect(binding.document, binding.input) };
  } catch (error) { return failure("invalid_request", "inspection_failed", error instanceof Error ? error.message : String(error), true); }
}

function nextVersion(write: Extract<WriteResult, { kind: "saved" }>, prior: Version): Version | undefined {
  if (prior.kind === "artifact_revision" && Number.isSafeInteger(write.revision)) return { kind: "artifact_revision", revision: write.revision! };
  if (prior.kind === "local_sha" && SHA256.test(write.sha256)) return { kind: "local_sha", sha256: write.sha256 };
  return undefined;
}

export async function editOpenBoard(args: unknown, ctx: BoardAgentToolContext) {
  try {
    const binding = live(args, ["expectedVersion", "operations"]);
    if (binding.input["expectedVersion"] !== binding.versionToken)
      return failure("stale_version", "stale_version", "The open Board version differs from inspection.", false);
    const applied = await apply(binding.document, binding.input["operations"], ctx.nautiloApp);
    let write: WriteResult;
    try { write = await ctx.nautiloApp.document.writeBound({ content: serializeBoardHtml(applied.document) }); }
    catch (error) { return failure("error", "bound_write_failed", error instanceof Error ? error.message : String(error), false, "unknown"); }
    if (write.kind === "conflict") return failure("stale_version", "version_conflict", "The open Board changed before saving.", false);
    if (write.kind === "error") return failure("error", "bound_write_failed", write.message, false);
    const documentVersion = nextVersion(write, binding.documentVersion);
    if (!documentVersion) return { ok: true as const, status: "saved" as const, needsReinspect: true as const,
      message: "The Board saved, but the host did not return its new version. Inspect the open Board before another edit.", receipt: applied.receipt };
    return { ok: true as const, status: "saved" as const, documentVersion,
      versionToken: JSON.stringify(documentVersion), receipt: applied.receipt };
  } catch (error) { return editFailure(error); }
}
