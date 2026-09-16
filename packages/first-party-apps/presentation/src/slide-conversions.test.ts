import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { buildPdfFixture } from "../../../office-slides/test/export/build-pdf-fixture";
import { buildMinimalPptx } from "../../../office-slides/test/import/pptx/__fixtures__/build-minimal-pptx";
import { exportPptx, defaultDark } from "../engine/node.js";
import {
  createSlideDocument,
  parseSlideHtml,
  serializeSlideHtml,
} from "./slide-document";
import {
  exportPowerPoint,
  exportPdf,
  importPowerPoint,
  type ConversionContext,
} from "./slide-conversions";

async function sha(bytes: Uint8Array) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  ).toString("hex");
}
async function fixture(bytes: Uint8Array) {
  const source = Buffer.from(bytes);
  const sourceHash = await sha(source);
  const writes: Parameters<
    ConversionContext["nautiloApp"]["document"]["createDocument"]
  >[0][] = [];
  let reads = 0;
  let race = false;
  let writeFailure: "conflict" | "unknown" | "partial" | "ordinary" | "forbidden" | undefined;
  const ctx: ConversionContext = {
    nautiloApp: {
      document: {
        async read(_target, options) {
          reads++;
          return {
            content: source.toString(options?.encoding ?? "utf8"),
            baseSha256: race && reads > 1 ? "f".repeat(64) : sourceHash,
            ...(options?.encoding === "base64"
              ? { encoding: "base64" as const, byteLength: source.length }
              : {}),
          };
        },
        async createDocument(args) {
          writes.push(args);
          if (writeFailure === "forbidden")
            return { ok: false, code: "FORBIDDEN", message: "No writable namespace is shared with the source document." };
          if (writeFailure === "conflict")
            return { ok: false, code: "EXISTS", message: "File exists" };
          if (writeFailure === "ordinary")
            return { ok: false, code: "IO", message: "Could not write" };
          if (writeFailure === "unknown")
            throw new Error("Connection closed after writing");
          if (writeFailure === "partial")
            return {
              ok: false,
              code: "PARTIAL_WRITE",
              message: "Metadata failed",
              stateChanged: true,
              retrySafe: false,
              metadataConfirmed: false,
            };
          const data = Buffer.from(args.content, "base64");
          return {
            ok: true,
            artifactPath: args.path,
            sha256: await sha(data),
            byteLength: data.length,
          };
        },
      },
    },
  };
  return {
    ctx,
    source,
    sourceHash,
    writes,
    set race(value: boolean) {
      race = value;
    },
    set writeFailure(value: typeof writeFailure) {
      writeFailure = value;
    },
  };
}
const source = { surface: "workspace", path: "Original.presentation.html" };
const target = { surface: "workspace", path: "Export.pptx" };
const sourcePptx = { surface: "workspace", path: "Original.pptx" };

describe("PowerPoint conversion copies", () => {

  test("warns only for signed percentage-stacked line and area viewer differences", async () => {
    for (const kind of ["bar", "column", "line", "area"] as const) {
      for (const grouping of ["stacked", "percentStacked"] as const) {
        for (const value of [-5, 5]) {
          const document = createSlideDocument();
          document.slides[0].elements.push({
            id: "chart-sign", type: "chart", frame: { x: 10, y: 10, w: 400, h: 200, rotation: 0 },
            data: { kind, grouping, categories: ["A"], series: [{ values: [value] }] },
          });
          const bytes = Buffer.from(serializeSlideHtml(document));
          const f = await fixture(bytes);
          const preview = await exportPowerPoint({ source, target }, f.ctx);
          expect(preview.status).toBe("confirmation_required");
          expect("warnings" in preview && preview.warnings.some((warning) => warning.includes("display differently in LibreOffice"))).toBe(
            (kind === "line" || kind === "area") && grouping === "percentStacked" && value < 0,
          );
          expect(f.writes).toHaveLength(0);
          expect(await exportPowerPoint({ source, target, acknowledgedSourceSha256: f.sourceHash }, f.ctx)).toMatchObject({ status: "exported" });
          expect(f.source).toEqual(bytes);
          expect(f.writes).toHaveLength(1);
        }
      }
    }
  });

  test("a refused source location offers explicit destination recovery without falling back", async () => {
    const f = await fixture(Buffer.from(serializeSlideHtml(createSlideDocument())));
    f.writeFailure = "forbidden";
    const result = await exportPowerPoint({ source, target, workspaceDestination: "source", acknowledgedSourceSha256: f.sourceHash }, f.ctx);
    expect(result).toMatchObject({ status: "error", code: "FORBIDDEN", retrySafe: false });
    expect("message" in result && result.message).toContain("choose This chat’s workspace");
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].colocateWith).toEqual({ surface: "workspace", path: source.path });
  });

  test("explicit current-workspace placement omits source colocation while legacy placement is retained", async () => {
    for (const placement of ["current", "source", undefined] as const) {
      const f = await fixture(Buffer.from(serializeSlideHtml(createSlideDocument())));
      const args = { source, target, ...(placement ? { workspaceDestination: placement } : {}) };
      expect(await exportPowerPoint(args, f.ctx)).toMatchObject({ status: "confirmation_required" });
      expect(f.writes).toHaveLength(0);
      expect(await exportPowerPoint({ ...args, acknowledgedSourceSha256: f.sourceHash }, f.ctx)).toMatchObject({ status: "exported" });
      if (placement === "current") expect(f.writes[0]).not.toHaveProperty("colocateWith");
      else expect(f.writes[0].colocateWith).toEqual({ surface: "workspace", path: source.path });
    }
  });

  test("rejects invented or local placement modes before writing", async () => {
    const f = await fixture(Buffer.from(serializeSlideHtml(createSlideDocument())));
    for (const args of [
      { source, target, workspaceDestination: "arbitrary-namespace" },
      { source, target: { ...target, surface: "currentFolder" }, workspaceDestination: "current" },
      { source: { ...source, surface: "currentFolder" }, target, workspaceDestination: "current" },
    ]) expect(await exportPowerPoint({ ...args, acknowledgedSourceSha256: f.sourceHash }, f.ctx)).toMatchObject({ status: "error", stateChanged: false });
    expect(f.writes).toHaveLength(0);
  });

  test("exports to Current Folder and imports its bytes into a Workspace copy", async () => {
    const f = await fixture(
      Buffer.from(serializeSlideHtml(createSlideDocument())),
    );
    const localSource = { ...source, surface: "currentFolder" };
    const localTarget = { ...target, surface: "currentFolder" };
    const readTargets: unknown[] = [];
    const read = f.ctx.nautiloApp.document.read;
    f.ctx.nautiloApp.document.read = (target, options) => {
      readTargets.push(target);
      return read(target, options);
    };
    expect(
      await exportPowerPoint(
        { source: localSource, target: localTarget },
        f.ctx,
      ),
    ).toMatchObject({ status: "confirmation_required", stateChanged: false });
    expect(f.writes).toHaveLength(0);
    expect(
      await exportPowerPoint(
        {
          source: localSource,
          target: localTarget,
          acknowledgedSourceSha256: f.sourceHash,
        },
        f.ctx,
      ),
    ).toMatchObject({ ok: true, status: "exported" });
    expect(readTargets).toEqual(
      Array.from({ length: 3 }, () => ({
        surface: "currentFolder",
        relativePath: source.path,
      })),
    );
    expect(f.writes[0]).toMatchObject({
      surface: "currentFolder",
      path: target.path,
      encoding: "base64",
      overwrite: false,
    });
    expect(f.writes[0]).not.toHaveProperty("colocateWith");
    const imported = await fixture(Buffer.from(f.writes[0].content, "base64"));
    expect(
      await importPowerPoint(
        {
          source: { ...sourcePptx, surface: "currentFolder" },
          targetPath: "Local copy.presentation.html",
          acknowledgedSourceSha256: imported.sourceHash,
        },
        imported.ctx,
      ),
    ).toMatchObject({ ok: true, status: "imported" });
    expect(imported.writes[0]).toMatchObject({
      surface: "workspace",
      path: "Local copy.presentation.html",
    });
    expect(imported.writes[0]).not.toHaveProperty("colocateWith");
    expect(
      await exportPowerPoint(
        { source: localSource, target: localSource },
        f.ctx,
      ),
    ).toMatchObject({ status: "error", stateChanged: false });
  });
  test("imports embedded images and a 4:3 canvas without external resources", async () => {
    const bytes = new Uint8Array(
      await buildMinimalPptx({
        imageCount: 2,
        sldSz: { cx: 9144000, cy: 6858000 },
      }),
    );
    const f = await fixture(bytes);
    const result = await importPowerPoint(
      {
        source: sourcePptx,
        targetPath: "Images.presentation.html",
        acknowledgedSourceSha256: f.sourceHash,
      },
      f.ctx,
    );
    expect(result).toMatchObject({ ok: true, status: "imported" });
    const document = parseSlideHtml(
      Buffer.from(f.writes[0].content, "base64").toString("utf8"),
    );
    expect(document.meta.slideHeight).toBe(1440);
    const images = document.slides[0].elements.filter(
      (element) => element.type === "image",
    );
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.data.src).toStartWith("data:image/png;base64,");
      expect(image.frame.w / image.frame.h).toBeCloseTo(2);
    }
    expect(f.source.equals(Buffer.from(bytes))).toBe(true);
  });

  test("export previews warnings without creating; acknowledgment exports exact ZIP and leaves source unchanged", async () => {
    const deck = createSlideDocument();
    deck.meta.title = "Blue deck";
    deck.themes.push(structuredClone(defaultDark));
    deck.meta.themeId = "default-dark";
    const f = await fixture(Buffer.from(serializeSlideHtml(deck)));
    const before = Buffer.from(f.source);
    const preview = await exportPowerPoint({ source, target }, f.ctx);
    expect(preview).toMatchObject({
      status: "confirmation_required",
      stateChanged: false,
      sourceSha256: f.sourceHash,
    });
    expect(f.writes).toHaveLength(0);
    const result = await exportPowerPoint(
      { source, target, acknowledgedSourceSha256: f.sourceHash },
      f.ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      status: "exported",
      originalPreserved: true,
    });
    expect(f.writes).toHaveLength(1);
    const write = f.writes[0];
    expect(write).toMatchObject({
      encoding: "base64",
      overwrite: false,
      colocateWith: source,
    });
    const zip = await JSZip.loadAsync(Buffer.from(write.content, "base64"));
    expect(await zip.file("ppt/presentation.xml")!.async("string")).toContain(
      "p:sldId",
    );
    const xml = await zip.file("ppt/theme/theme1.xml")!.async("string");
    expect(xml).toContain(
      deck.themes.find((theme) => theme.id === "default-dark")!.name,
    );
    expect(f.source.equals(before)).toBe(true);
  });

  test("Node import creates self-contained native HTML only after reviewing the source revision", async () => {
    expect(typeof globalThis.DOMParser).toBe("undefined");
    const deck = createSlideDocument();
    const bytes = await exportPptx(deck);
    const f = await fixture(bytes);
    const args = {
      source: sourcePptx,
      targetPath: "Imported.presentation.html",
    };
    expect(await importPowerPoint(args, f.ctx)).toMatchObject({
      status: "confirmation_required",
      sourceSha256: f.sourceHash,
    });
    expect(f.writes).toHaveLength(0);
    expect(
      await importPowerPoint(
        { ...args, acknowledgedSourceSha256: f.sourceHash },
        f.ctx,
      ),
    ).toMatchObject({ ok: true, status: "imported" });
    const native = parseSlideHtml(
      Buffer.from(f.writes[0].content, "base64").toString("utf8"),
    );
    expect(native.slides).toHaveLength(deck.slides.length);
    expect(native.meta.title).toBe("Original");
    expect(f.source.equals(Buffer.from(bytes))).toBe(true);
    expect(typeof globalThis.DOMParser).toBe("undefined");
  });

  test("stale acknowledgment prompts again, and a later source race prevents any output", async () => {
    const f = await fixture(
      Buffer.from(serializeSlideHtml(createSlideDocument())),
    );
    expect(
      await exportPowerPoint(
        { source, target, acknowledgedSourceSha256: "e".repeat(64) },
        f.ctx,
      ),
    ).toMatchObject({ status: "confirmation_required" });
    // A fresh fixture is needed so the injected race occurs after the first read.
    const raced = await fixture(f.source);
    raced.race = true;
    expect(
      await exportPowerPoint(
        { source, target, acknowledgedSourceSha256: raced.sourceHash },
        raced.ctx,
      ),
    ).toMatchObject({ status: "stale_source", stateChanged: false });
    expect(raced.writes).toHaveLength(0);
  });

  test("collision, partial persistence and unknown completion remain distinct and are never retried", async () => {
    for (const mode of [
      "conflict",
      "partial",
      "unknown",
      "ordinary",
    ] as const) {
      const f = await fixture(
        Buffer.from(serializeSlideHtml(createSlideDocument())),
      );
      f.writeFailure = mode;
      const result = await exportPowerPoint(
        { source, target, acknowledgedSourceSha256: f.sourceHash },
        f.ctx,
      );
      if (mode === "conflict")
        expect(result).toMatchObject({ status: "conflict", target });
      else if (mode === "partial")
        expect(result).toMatchObject({
          status: "error",
          stateChanged: true,
          retrySafe: false,
          metadataConfirmed: false,
        });
      else
        expect(result).toMatchObject({
          status: "error",
          stateChanged: "unknown",
          retrySafe: false,
        });
      expect(f.writes).toHaveLength(1);
    }
  });

  test("invalid source formats and unsafe destinations fail without writing", async () => {
    const f = await fixture(
      Buffer.from(serializeSlideHtml(createSlideDocument())),
    );
    for (const args of [
      { source, target: { ...target, path: "../Export.pptx" } },
      { source, target: { ...target, path: "/Export.pptx" } },
      { source, target: { ...target, surface: "absolute" } },
      { source, target, overwrite: "true" },
      { source, target, acknowledgedSourceSha256: "yes" },
      { source, target, networkUrl: "https://example.invalid" },
    ])
      expect(await exportPowerPoint(args, f.ctx)).toMatchObject({
        status: "error",
        stateChanged: false,
      });
    const bad = await fixture(Buffer.from("not a powerpoint"));
    expect(
      await importPowerPoint(
        {
          source: sourcePptx,
          targetPath: "Imported.presentation.html",
          acknowledgedSourceSha256: bad.sourceHash,
        },
        bad.ctx,
      ),
    ).toMatchObject({ status: "error", stateChanged: false });
    expect(bad.writes).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
  });
});


describe("browser prepared PDF copies", () => {
  async function pdfFixture() {
    const f = await fixture(Buffer.from(serializeSlideHtml(createSlideDocument())));
    const bytes = Buffer.from(await buildPdfFixture());
    const preparedExport = { content: bytes.toString("base64"), encoding: "base64", mimeType: "application/pdf",
      byteLength: bytes.length, sourceSha256: f.sourceHash, warnings: ["Review fallback fonts."] };
    const args = { source, target: { ...target, path: "Export.pdf" }, preparedExport };
    return { f, bytes, args };
  }
  test("warns before writing then preserves PDF bytes and source in either zone", async () => {
    for (const surface of ["workspace", "currentFolder"]) {
      const { f, bytes, args } = await pdfFixture();
      args.source = { ...args.source, surface }; args.target = { ...args.target, surface };
      const preview = await exportPdf(args, f.ctx);
      expect(preview).toMatchObject({ status: "confirmation_required", sourceSha256: f.sourceHash });
      expect(f.writes).toHaveLength(0);
      const result = await exportPdf({ ...args, acknowledgedSourceSha256: f.sourceHash }, f.ctx);
      expect(result).toMatchObject({ status: "exported", sha256: await sha(bytes), originalPreserved: true });
      expect(f.writes[0]).toMatchObject({ surface, mimeType: "application/pdf", encoding: "base64", overwrite: false });
      expect(Buffer.from(f.writes[0].content, "base64")).toEqual(bytes);
      if (surface === "workspace") expect(f.writes[0].colocateWith).toEqual({ surface: "workspace", path: source.path });
      else expect(f.writes[0]).not.toHaveProperty("colocateWith");
    }
  });
  test("PDF current-workspace selection preserves bytes and does not request source namespace attachment", async () => {
    const { f, args, bytes } = await pdfFixture();
    expect(await exportPdf({ ...args, workspaceDestination: "current", acknowledgedSourceSha256: f.sourceHash }, f.ctx)).toMatchObject({ status: "exported", originalPreserved: true });
    expect(f.writes[0]).not.toHaveProperty("colocateWith");
    expect(Buffer.from(f.writes[0].content, "base64")).toEqual(bytes);
  });
  test("PDF source permission refusal offers destination recovery without a fallback write", async () => {
    const { f, args } = await pdfFixture();
    f.writeFailure = "forbidden";
    const result = await exportPdf({ ...args, workspaceDestination: "source", acknowledgedSourceSha256: f.sourceHash }, f.ctx);
    expect(result).toMatchObject({ status: "error", code: "FORBIDDEN", retrySafe: false });
    expect("message" in result && result.message).toContain("choose This chat’s workspace");
    expect(f.writes).toHaveLength(1);
  });
  test("refuses malformed payloads, stale render and canonical change before save", async () => {
    const { f, args } = await pdfFixture();
    for (const patch of [{ content: "JVB ERi0=" }, { byteLength: 1 }, { mimeType: "text/html" },
      { content: Buffer.from("not a PDF").toString("base64"), byteLength: 9 },
      { content: Buffer.from("%PDF-garbage").toString("base64"), byteLength: 12 }, { sourceSha256: "f".repeat(64) }]) {
      expect(await exportPdf({ ...args, preparedExport: { ...args.preparedExport, ...patch }, acknowledgedSourceSha256: f.sourceHash }, f.ctx)).toMatchObject({ status: "error", stateChanged: false });
    }
    expect(f.writes).toHaveLength(0);
    const race = await pdfFixture(); race.f.race = true;
    expect(await exportPdf({ ...race.args, acknowledgedSourceSha256: race.f.sourceHash }, race.f.ctx)).toMatchObject({ status: "error", stateChanged: false });
    expect(race.f.writes).toHaveLength(0);
  });
  test("a mismatched receipt does not claim a verified PDF export", async () => {
    const { f, args } = await pdfFixture();
    f.ctx.nautiloApp.document.createDocument = async () => ({ ok: true, artifactPath: "Export.pdf", sha256: "f".repeat(64), byteLength: 1 });
    expect(await exportPdf({ ...args, acknowledgedSourceSha256: f.sourceHash }, f.ctx)).toMatchObject({ status: "error", code: "UNCONFIRMED_WRITE", stateChanged: true, retrySafe: false });
  });
  test("keeps collision and uncertain-write semantics", async () => {
    const { f, args } = await pdfFixture(); f.writeFailure = "conflict";
    expect(await exportPdf({ ...args, acknowledgedSourceSha256: f.sourceHash }, f.ctx)).toMatchObject({ status: "conflict", stateChanged: false, retrySafe: true });
    f.writeFailure = "unknown";
    expect(await exportPdf({ ...args, acknowledgedSourceSha256: f.sourceHash }, f.ctx)).toMatchObject({ status: "error", stateChanged: "unknown", retrySafe: false });
  });
});


test("PowerPoint preview discloses radial background conversion before any write", async () => {
  const deck = createSlideDocument();
  deck.slides[0].background = { fill: { kind: "gradient", type: "radial", angle: 0, stops: [
    { pos: 0, color: { kind: "srgb", value: "#123456" } },
    { pos: 1, color: { kind: "srgb", value: "#abcdef" } },
  ] } };
  const f = await fixture(Buffer.from(serializeSlideHtml(deck)));
  const preview = await exportPowerPoint({ source, target }, f.ctx);
  expect(preview).toMatchObject({ status: "confirmation_required", stateChanged: false });
  expect("warnings" in preview && preview.warnings.some(warning => /radial/i.test(warning) && /linear/i.test(warning))).toBe(true);
  expect(f.writes).toHaveLength(0);
});
