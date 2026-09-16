import {
  collectFontFamilies,
  getThemeForSlide,
  exportSlidesPdf,
  type SlidesDocument,
} from "../engine/browser.js";
import { validateSlideDocument } from "./slide-document";

export type PreparedSlidesPdf = {
  content: string;
  encoding: "base64";
  mimeType: "application/pdf";
  byteLength: number;
  warnings: string[];
};

type PdfExporter = (
  document: SlidesDocument,
  options: { title?: string; strictAssets: true },
) => Promise<Uint8Array>;

export type SlidesPdfDependencies = {
  exportPdf?: PdfExporter;
  fonts?: Pick<FontFaceSet, "load" | "check" | "ready">;
};

const RASTER_WARNING =
  "PDF pages are rendered as images. Text will look like the presentation but cannot be selected or searched.";
const CSS_GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

async function prepareFonts(
  families: string[],
  fonts: Pick<FontFaceSet, "load" | "check" | "ready"> | undefined,
): Promise<{ unavailable: string[]; unverified: string[] }> {
  if (!fonts || families.length === 0) {
    return { unavailable: [], unverified: fonts ? [] : families };
  }
  const descriptors = (family: string) => {
    const cssFamily = CSS_GENERIC_FAMILIES.has(family.toLowerCase())
      ? family.toLowerCase()
      : JSON.stringify(family);
    return [
      `400 16px ${cssFamily}`,
      `700 16px ${cssFamily}`,
      `italic 400 16px ${cssFamily}`,
      `italic 700 16px ${cssFamily}`,
    ];
  };
  const loads = new Map<string, PromiseSettledResult<FontFace[]>[]>();
  await Promise.all(
    families.map(async (family) => {
      loads.set(
        family,
        await Promise.allSettled(
          descriptors(family).map((descriptor) => fonts.load(descriptor)),
        ),
      );
    }),
  );
  try { await fonts.ready; } catch { /* Report each unavailable face below. */ }
  const unavailable = families.filter((family) =>
    descriptors(family).some((descriptor) => !fonts.check(descriptor)),
  );
  const unverified = families.filter((family) =>
    !unavailable.includes(family) &&
    !CSS_GENERIC_FAMILIES.has(family.toLowerCase()) &&
    loads.get(family)?.every((result) => result.status === "rejected" || result.value.length === 0),
  );
  return { unavailable, unverified };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function prepareSlidesPdf(
  doc: SlidesDocument,
  dependencies: SlidesPdfDependencies = {},
): Promise<PreparedSlidesPdf> {
  const validated = validateSlideDocument(structuredClone(doc));
  // Match drawSlide's active-theme resolution. Imported decks retain a theme
  // library; unused library fonts are not render dependencies or warnings.
  const usedThemes = new Map(
    validated.slides.map((slide) => {
      const theme = getThemeForSlide(validated, slide);
      return [theme.id, theme] as const;
    }),
  );
  const families = collectFontFamilies({ ...validated, themes: [...usedThemes.values()] });
  const fonts = dependencies.fonts ?? (typeof document !== "undefined" ? document.fonts : undefined);
  const fontStatus = await prepareFonts(families, fonts);
  const warnings = [RASTER_WARNING];
  if (fontStatus.unavailable.length > 0) {
    warnings.push(
      `Fallback fonts were used because these presentation fonts were unavailable: ${fontStatus.unavailable.join(", ")}.`,
    );
  }
  if (fontStatus.unverified.length > 0) {
    warnings.push(
      `The browser could not verify loaded regular, bold and italic faces for: ${fontStatus.unverified.join(", ")}. Browser fallback may be used in the PDF.`,
    );
  }
  const exporter = dependencies.exportPdf ?? (exportSlidesPdf as PdfExporter);
  const bytes = await exporter(validated, { title: validated.meta.title, strictAssets: true });
  return {
    content: bytesToBase64(bytes),
    encoding: "base64",
    mimeType: "application/pdf",
    byteLength: bytes.byteLength,
    warnings,
  };
}
