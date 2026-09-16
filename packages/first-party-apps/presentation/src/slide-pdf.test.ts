import { rejects } from "node:assert/strict";
import { describe, expect, mock, test } from "bun:test";
import { createSlideDocument } from "./slide-document";
import { prepareSlidesPdf } from "./slide-pdf";

function fontSet(available: Set<string>) {
  return {
    load: mock(async (descriptor: string) =>
      [...available].some((family) => descriptor.includes(`"${family}"`))
        ? [{} as FontFace]
        : []),
    check: mock((descriptor: string) => [...available].some((family) => descriptor.includes(`"${family}"`))),
    ready: Promise.resolve(undefined) as unknown as Promise<FontFaceSet>,
  };
}

describe("prepareSlidesPdf", () => {
  test("returns exact base64 PDF bytes and requests strict asset rendering", async () => {
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const exportPdf = mock(async () => bytes);
    const result = await prepareSlidesPdf(createSlideDocument(), {
      exportPdf,
      fonts: fontSet(new Set(["Inter"])),
    });

    expect(result).toEqual({
      content: "JVBERi0=",
      encoding: "base64",
      mimeType: "application/pdf",
      byteLength: 5,
      warnings: ["PDF pages are rendered as images. Text will look like the presentation but cannot be selected or searched."],
    });
    expect(exportPdf).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ strictAssets: true }),
    );
  });

  test("loads every requested family and warns about unavailable fallback fonts", async () => {
    const doc = createSlideDocument();
    doc.themes[0].fonts = { heading: "Inter", body: "Missing Face" };
    const fonts = fontSet(new Set(["Inter"]));
    const result = await prepareSlidesPdf(doc, {
      exportPdf: async () => Uint8Array.from([1]),
      fonts,
    });

    expect(fonts.load).toHaveBeenCalledTimes(8);
    expect(result.warnings).toContain(
      "Fallback fonts were used because these presentation fonts were unavailable: Missing Face.",
    );
  });

  test("warns when check succeeds but the browser exposes no matching loaded face", async () => {
    const fonts = {
      load: mock(async () => [] as FontFace[]),
      check: mock(() => true),
      ready: Promise.resolve(undefined) as unknown as Promise<FontFaceSet>,
    };
    const result = await prepareSlidesPdf(createSlideDocument(), {
      exportPdf: async () => Uint8Array.from([1]),
      fonts,
    });

    expect(result.warnings).toContain(
      "The browser could not verify loaded regular, bold and italic faces for: Inter. Browser fallback may be used in the PDF.",
    );
  });

  test("loads a CSS generic as a generic family without claiming it is unverifiable", async () => {
    const doc = createSlideDocument();
    doc.themes[0].fonts = { heading: "sans-serif", body: "sans-serif" };
    const fonts = {
      load: mock(async (descriptor: string) =>
        descriptor.includes('"Inter"') ? [{} as FontFace] : []),
      check: mock(() => true),
      ready: Promise.resolve(undefined) as unknown as Promise<FontFaceSet>,
    };
    const result = await prepareSlidesPdf(doc, {
      exportPdf: async () => Uint8Array.from([1]),
      fonts,
    });

    expect(fonts.load.mock.calls[0]?.[0]).toBe("400 16px sans-serif");
    expect(result.warnings.some((warning) => warning.includes("sans-serif"))).toBe(false);
  });

  test("validates self-contained images before invoking the renderer", async () => {
    const doc = createSlideDocument();
    doc.slides[0].elements.push({
      id: "image-1",
      type: "image",
      frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      data: { src: "https://example.invalid/image.png" },
    });
    const exportPdf = mock(async () => Uint8Array.from([1]));

    await rejects(prepareSlidesPdf(doc, { exportPdf, fonts: fontSet(new Set(["Inter"])) }),
      /self-contained base64/);
    expect(exportPdf).not.toHaveBeenCalled();
  });
});


test("base64 transport preserves every byte across multiple conversion chunks", async () => {
  const bytes = Uint8Array.from({ length: 0x10003 }, (_, index) => index % 256);
  const result = await prepareSlidesPdf(createSlideDocument(), {
    exportPdf: async () => bytes, fonts: fontSet(new Set(["Inter"])),
  });
  expect(result.byteLength).toBe(bytes.length);
  expect(new Uint8Array(Buffer.from(result.content, "base64"))).toEqual(bytes);
});


test("unused theme-library fonts are not export requirements", async () => {
  const doc = createSlideDocument();
  const unused = structuredClone(doc.themes[0]);
  unused.id = "unused-font-library"; unused.fonts = { heading: "Not Used", body: "Not Used" };
  doc.themes.push(unused);
  const fonts = fontSet(new Set(["Inter"]));
  const result = await prepareSlidesPdf(doc, { exportPdf: async () => new Uint8Array([37]), fonts });
  expect(fonts.load.mock.calls.some(([descriptor]) => descriptor.includes("Not Used"))).toBe(false);
  expect(result.warnings.join(" ")).not.toContain("Not Used");
});

test("a slide theme override contributes its fonts to PDF preparation", async () => {
  const doc = createSlideDocument();
  const scoped = structuredClone(doc.themes[0]);
  scoped.id = "scoped-theme"; scoped.fonts = { heading: "Scoped Face", body: "Scoped Face" };
  doc.themes.push(scoped);
  doc.slides[0].themeId = scoped.id;
  const fonts = fontSet(new Set(["Scoped Face"]));
  await prepareSlidesPdf(doc, { exportPdf: async () => new Uint8Array([37]), fonts });
  expect(fonts.load.mock.calls.some(([descriptor]) => descriptor.includes("Scoped Face"))).toBe(true);
});
