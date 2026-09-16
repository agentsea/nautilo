import {
  exportPptx,
  validateSlidesPdf,
  importPptx,
  flattenElements,
  type SlidesDocument,
} from "../engine/node.js";
import {
  parseSlideHtml,
  serializeSlideHtml,
  validateSlideDocument,
} from "./slide-document";

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const SHA = /^[a-f0-9]{64}$/;
type Target = { surface: "workspace" | "currentFolder"; path: string };
type ReadTarget =
  | { surface: "workspace"; path: string }
  | { surface: "currentFolder"; relativePath: string };
function readTarget(target: Target): ReadTarget {
  return target.surface === "workspace"
    ? { surface: "workspace", path: target.path }
    : { surface: "currentFolder", relativePath: target.path };
}
type ReadResult = {
  content: string;
  baseSha256: string | null;
  encoding?: "utf8" | "base64";
  byteLength?: number;
};
type CreateResult =
  | { ok: true; artifactPath: string; sha256: string; byteLength: number }
  | {
      ok: false;
      code: string;
      message: string;
      stateChanged?: true;
      retrySafe?: false;
      bytesWritten?: number;
      metadataConfirmed?: false;
    };
export type ConversionContext = {
  nautiloApp: {
    document: {
      read(
        target: ReadTarget,
        options?: { encoding: "base64" },
      ): Promise<ReadResult>;
      createDocument(args: {
        surface: "workspace" | "currentFolder";
        path: string;
        content: string;
        encoding: "base64";
        mimeType: string;
        overwrite: boolean;
        colocateWith?: { surface: "workspace"; path: string };
      }): Promise<CreateResult>;
    };
  };
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`Unknown conversion field: ${extra}`);
}
function path(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.includes(":") ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      "Use a relative file path without traversal or empty segments.",
    );
  }
  return value;
}
function target(value: unknown): Target {
  const x = object(value);
  fields(x, ["surface", "path"]);
  if (x["surface"] !== "workspace" && x["surface"] !== "currentFolder")
    throw new Error("Choose Workspace or Current Folder for conversion.");
  return { surface: x["surface"], path: path(x["path"]) };
}
function request(args: unknown, direction: "import" | "export", pdf = false) {
  const x = object(args);
  fields(x, [
    "source",
    direction === "import" ? "targetPath" : "target",
    "overwrite",
    "acknowledgedSourceSha256",
    ...(pdf ? ["preparedExport"] : []),
    ...(direction === "export" ? ["workspaceDestination"] : []),
  ]);
  const source = target(x["source"]);
  const destination =
    direction === "import"
      ? { surface: "workspace" as const, path: path(x["targetPath"]) }
      : target(x["target"]);
  const workspaceDestination = x["workspaceDestination"];
  if (workspaceDestination !== undefined && (
    source.surface !== "workspace" || destination.surface !== "workspace" ||
    (workspaceDestination !== "current" && workspaceDestination !== "source")
  )) throw new Error("Choose this workspace or the original location for a Workspace export.");
  if (
    source.surface === destination.surface &&
    source.path.normalize("NFC").toLowerCase() ===
      destination.path.normalize("NFC").toLowerCase()
  )
    throw new Error(
      "Conversion must create a separate file so the original is preserved.",
    );
  if (
    !source.path
      .toLowerCase()
      .endsWith(direction === "import" ? ".pptx" : ".presentation.html")
  )
    throw new Error("The source has the wrong presentation file extension.");
  if (
    !destination.path
      .toLowerCase()
      .endsWith(direction === "import" ? ".presentation.html" : pdf ? ".pdf" : ".pptx")
  )
    throw new Error("The output has the wrong presentation file extension.");
  if (x["overwrite"] !== undefined && typeof x["overwrite"] !== "boolean")
    throw new Error("overwrite must be a boolean.");
  const acknowledgment = x["acknowledgedSourceSha256"];
  if (
    acknowledgment !== undefined &&
    (typeof acknowledgment !== "string" || !SHA.test(acknowledgment))
  )
    throw new Error(
      "acknowledgedSourceSha256 must come from the conversion preview.",
    );
  return {
    source,
    destination,
    overwrite: x["overwrite"] === true,
    acknowledgment,
    colocateWithSource: workspaceDestination !== "current",
  };
}
async function hash(bytes: Uint8Array): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  ).toString("hex");
}
async function sourceBytes(read: ReadResult, binary: boolean) {
  if (!read.baseSha256 || !SHA.test(read.baseSha256))
    throw new Error("The source has no exact revision identity.");
  if (binary && read.encoding !== "base64")
    throw new Error(
      "This server does not provide byte-exact binary document reads.",
    );
  const bytes = Buffer.from(read.content, binary ? "base64" : "utf8");
  if (
    binary &&
    (bytes.toString("base64") !== read.content ||
      read.byteLength !== bytes.byteLength)
  )
    throw new Error("The binary source is incomplete or incorrectly encoded.");
  if ((await hash(bytes)) !== read.baseSha256)
    throw new Error("The source bytes do not match their revision identity.");
  return bytes;
}
const IMPORT_WARNING =
  "PowerPoint import creates an editable copy. Fonts, themes, layouts, effects, animations and unsupported objects may change or be omitted. Review every slide against the original before using the copy.";
const EXPORT_WARNING =
  "PowerPoint export creates a copy. Some themes, layouts, backgrounds, table formatting, links and animations may change or be omitted. Fonts are not embedded. Review the exported file in PowerPoint or another presentation viewer.";
function confirmation(sourceSha256: string, warnings: string[]) {
  return {
    ok: false as const,
    status: "confirmation_required" as const,
    sourceSha256,
    warnings,
    stateChanged: false,
    message:
      "Review conversion differences before creating the copy. Your original file will be kept.",
  };
}

/** Select active records without mutating the native original. The exporter
 * retains referenced layout/master relationships under the active document theme. */
function activeExportDocument(document: SlidesDocument): SlidesDocument {
  const copy = structuredClone(document);
  copy.themes.sort(
    (a, b) =>
      Number(b.id === copy.meta.themeId) - Number(a.id === copy.meta.themeId),
  );
  copy.masters.sort(
    (a, b) =>
      Number(b.id === copy.meta.masterId) - Number(a.id === copy.meta.masterId),
  );
  return copy;
}
async function convert(
  args: unknown,
  ctx: ConversionContext,
  direction: "import" | "export",
) {
  let writing = false;
  try {
    const r = request(args, direction);
    const readOptions =
      direction === "import" ? { encoding: "base64" as const } : undefined;
    const source = await ctx.nautiloApp.document.read(
      readTarget(r.source),
      readOptions,
    );
    const bytes = await sourceBytes(source, direction === "import");
    const sourceSha256 = source.baseSha256!;
    const warnings = [direction === "import" ? IMPORT_WARNING : EXPORT_WARNING];
    let converted: Uint8Array;
    if (direction === "import") {
      const imported = await importPptx(new Uint8Array(bytes).buffer, {
        uploadImage: (imageBytes, mime) => {
          if (
            !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
              mime,
            )
          )
            throw new Error(`Unsupported embedded image format: ${mime}`);
          return Promise.resolve(
            `data:${mime};base64,${Buffer.from(imageBytes).toString("base64")}`,
          );
        },
      });
      const summary = imported.report.summary();
      if (summary !== "Imported with no fallbacks.") warnings.push(summary);
      const document = validateSlideDocument(imported.document);
      document.meta.title = r.source.path
        .split("/")
        .pop()!
        .replace(/\.pptx$/i, "");
      converted = Buffer.from(serializeSlideHtml(document), "utf8");
    } else {
      const document = parseSlideHtml(source.content);
      const exportDocument = activeExportDocument(document);
      const exportedLayouts = new Set(document.layouts.map((layout) => layout.id));
      const remapped = document.slides.filter(
        (slide) => !exportedLayouts.has(slide.layoutId),
      ).length;
      if (remapped)
        warnings.push(
          `${remapped} slide(s) reference missing layouts and will use a fallback layout.`,
        );
      const tables = document.slides
        .flatMap((slide) => flattenElements(slide.elements))
        .filter((element) => element.type === "table").length;
      if (tables)
        warnings.push(
          `${tables} table(s) may lose cell padding, vertical alignment, fills and effects.`,
        );
      const hasSignedPercentStacks = document.slides.some((slide) =>
        flattenElements(slide.elements).some((element) =>
          element.type === "chart" &&
          (element.data.kind === "line" || element.data.kind === "area") &&
          element.data.grouping === "percentStacked" &&
          element.data.series.some((series) => series.values.some((value) => value !== null && value < 0)),
        ),
      );
      if (hasSignedPercentStacks)
        warnings.push(
          "Percentage-stacked line and area charts with negative values display differently in LibreOffice and PowerPoint. Review these charts in the app you will present from.",
        );
      converted = await exportPptx(exportDocument, {
        onFidelityWarning: (warning) => { warnings.push(warning); },
        fetchImage: (src) => {
          // Native validation already forbids remote URLs. Keep this adapter
          // independently closed: conversion never fetches a network resource.
          const match =
            /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
              src,
            );
          if (!match)
            throw new Error(
              "An image is not self-contained; export was stopped.",
            );
          return Promise.resolve({
            bytes: Buffer.from(match[2], "base64"),
            mime: match[1],
          });
        },
      });
    }
    if (r.acknowledgment !== sourceSha256)
      return confirmation(sourceSha256, warnings);
    // A conversion preview is tied to exact source bytes, including when the
    // output collision dialog later retries with another name.
    const latest = await ctx.nautiloApp.document.read(
      readTarget(r.source),
      readOptions,
    );
    if (latest.baseSha256 !== sourceSha256)
      return {
        ok: false,
        status: "stale_source",
        stateChanged: false,
        retrySafe: true,
        message:
          "The original changed during conversion. Start conversion again to review the latest file.",
      };
    writing = true;
    const created = await ctx.nautiloApp.document.createDocument({
      ...r.destination,
      content: Buffer.from(converted).toString("base64"),
      encoding: "base64",
      mimeType: direction === "import" ? "text/html" : PPTX_MIME,
      overwrite: r.overwrite,
      ...(r.source.surface === "workspace" &&
      r.destination.surface === "workspace" && r.colocateWithSource
        ? {
            colocateWith: {
              surface: "workspace" as const,
              path: r.source.path,
            },
          }
        : {}),
    });
    if (!created.ok) {
      const conflict = created.code === "EXISTS" || created.code === "CONFLICT";
      return {
        ...created,
        ...(direction === "export" && created.code === "FORBIDDEN" &&
          r.source.surface === "workspace" && r.destination.surface === "workspace" && r.colocateWithSource
          ? { message: "You cannot save a copy beside this original. Export again and choose This chat’s workspace, or ask for access to the original’s location." }
          : {}),
        status: conflict ? "conflict" : "error",
        stateChanged: created.stateChanged ?? (conflict ? false : "unknown"),
        retrySafe: conflict ? true : false,
        target: r.destination,
        warnings,
      };
    }
    return {
      ...created,
      status: direction === "import" ? "imported" : "exported",
      sourceSha256,
      originalPreserved: true,
      warnings,
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      stateChanged: writing ? "unknown" : false,
      retrySafe: !writing,
    };
  }
}
export const importPowerPoint = (args: unknown, ctx: ConversionContext) =>
  convert(args, ctx, "import");
export const exportPowerPoint = (args: unknown, ctx: ConversionContext) =>
  convert(args, ctx, "export");


/** Browser rendering supplies bytes, never filesystem authority. Re-read the
 * canonical source before warning acknowledgment and again immediately before
 * creation; a render from a stale document is never silently relabeled current. */
export async function exportPdf(args: unknown, ctx: ConversionContext) {
  let writing = false;
  try {
    const r = request(args, "export", true);
    const prepared = object(object(args)["preparedExport"]);
    fields(prepared, ["content", "encoding", "mimeType", "byteLength", "sourceSha256", "warnings"]);
    if (prepared["encoding"] !== "base64" || prepared["mimeType"] !== "application/pdf" ||
      typeof prepared["content"] !== "string" || !Array.isArray(prepared["warnings"]) ||
      !prepared["warnings"].every((warning: unknown) => typeof warning === "string")) {
      throw new Error("Prepare this PDF in the open Slides editor.");
    }
    const bytes = Buffer.from(prepared["content"], "base64");
    if (bytes.toString("base64") !== prepared["content"] || bytes.length !== prepared["byteLength"] ||
      !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error("The prepared PDF is incomplete or incorrectly encoded.");
    }
    const source = await ctx.nautiloApp.document.read(readTarget(r.source));
    await sourceBytes(source, false);
    const document = parseSlideHtml(source.content);
    await validateSlidesPdf(new Uint8Array(bytes), document.slides.length);
    const sourceSha256 = source.baseSha256!;
    if (prepared["sourceSha256"] !== sourceSha256) {
      throw new Error("The presentation changed after PDF rendering. Export again from the latest saved version.");
    }
    const warnings = [...new Set([
      "PDF creates a separate copy. Animations, links and speaker notes are not included. Your editable presentation is kept.",
      "PDF pages are rendered as images. Text will look like the presentation but cannot be selected or searched.",
      ...prepared["warnings"],
    ])];
    if (r.acknowledgment !== sourceSha256) return confirmation(sourceSha256, warnings);
    const latest = await ctx.nautiloApp.document.read(readTarget(r.source));
    await sourceBytes(latest, false);
    if (latest.baseSha256 !== sourceSha256) throw new Error("The source changed before export. Prepare a new PDF copy.");
    writing = true;
    const created = await ctx.nautiloApp.document.createDocument({
      ...r.destination, content: bytes.toString("base64"), encoding: "base64",
      mimeType: "application/pdf", overwrite: r.overwrite,
      ...(r.source.surface === "workspace" && r.destination.surface === "workspace" && r.colocateWithSource
        ? { colocateWith: { surface: "workspace" as const, path: r.source.path } } : {}),
    });
    if (!created.ok) {
      const conflict = created.code === "EXISTS" || created.code === "CONFLICT";
      return { ...created, status: conflict ? "conflict" : "error",
        ...(created.code === "FORBIDDEN" && r.source.surface === "workspace" &&
          r.destination.surface === "workspace" && r.colocateWithSource
          ? { message: "You cannot save a copy beside this original. Export again and choose This chat’s workspace, or ask for access to the original’s location." }
          : {}),
        stateChanged: created.stateChanged ?? (conflict ? false : "unknown"),
        retrySafe: conflict, target: r.destination, warnings };
    }
    if (created.sha256 !== await hash(bytes) || created.byteLength !== bytes.length) {
      return { ok: false, status: "error", code: "UNCONFIRMED_WRITE",
        message: "The PDF write receipt did not match the prepared bytes. Check the destination before retrying.",
        stateChanged: true, retrySafe: false };
    }
    return { ...created, status: "exported", sourceSha256, originalPreserved: true, warnings };
  } catch (error) {
    return { ok: false, status: "error", message: error instanceof Error ? error.message : String(error),
      stateChanged: writing ? "unknown" : false, retrySafe: !writing };
  }
}
