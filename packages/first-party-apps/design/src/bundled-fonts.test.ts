import { describe, expect, test } from "bun:test";
import { create } from "fontkit";
import {
  DESIGN_BUNDLED_FONT_CATALOG,
  DESIGN_BUNDLED_FONT_FAMILIES,
  DESIGN_BUNDLED_FONT_FAMILY,
  DESIGN_BUNDLED_MONO_FONT_FAMILY,
  DESIGN_BUNDLED_SERIF_FONT_FAMILY,
  designBundledFontFaceCss,
  designBundledFontFaceKey,
  designBundledFontForStyle,
  designBundledFontWeights,
} from "./bundled-fonts";

describe("bundled design fonts", () => {
  test("emits a standalone browser font with its Unicode character map", () => {
    const css = designBundledFontFaceCss(new Map([[400, "Nautilo"]]));
    const encoded = css.match(/base64,([A-Za-z0-9+/=]+)/)?.[1];
    expect(encoded).toBeTruthy();
    const font = create(Uint8Array.from(Buffer.from(encoded!, "base64")));
    expect(font.hasGlyphForCodePoint("A".codePointAt(0)!)).toBe(true);
    expect(font.layout("Nautilo").glyphs).toHaveLength(7);
  });

  test("emits only the requested non-empty weights", () => {
    const css = designBundledFontFaceCss(new Map([[400, ""], [700, "Bold"]]));
    expect(css).not.toContain("font-weight:400");
    expect(css).toContain("font-weight:700");
  });

  test("publishes the exact deterministic family and face catalogue", () => {
    expect(DESIGN_BUNDLED_FONT_FAMILIES).toEqual([
      DESIGN_BUNDLED_FONT_FAMILY,
      DESIGN_BUNDLED_SERIF_FONT_FAMILY,
      DESIGN_BUNDLED_MONO_FONT_FAMILY,
    ]);
    expect(DESIGN_BUNDLED_FONT_CATALOG.map(({ family, label, weights, faces }) => ({
      family,
      label,
      weights: [...weights],
      faces: faces.map(({ weight, sourcePath, sha256, byteLength }) => ({
        weight,
        sourcePath,
        sha256,
        byteLength,
      })),
    }))).toEqual([
      {
        family: DESIGN_BUNDLED_FONT_FAMILY,
        label: "Noto Sans",
        weights: [400, 700],
        faces: [
          { weight: 400, sourcePath: "packages/fonts/assets/core/sans/NotoSans-Regular.ttf", sha256: "b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5", byteLength: 569_208 },
          { weight: 700, sourcePath: "packages/fonts/assets/core/sans/NotoSans-Bold.ttf", sha256: "c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a", byteLength: 575_740 },
        ],
      },
      {
        family: DESIGN_BUNDLED_SERIF_FONT_FAMILY,
        label: "Noto Serif",
        weights: [400],
        faces: [
          { weight: 400, sourcePath: "packages/fonts/assets/core/serif/NotoSerif-Regular.ttf", sha256: "c8f669ceb2c9c60ccf55198b305e08a997ffca79a38cc7eeb551e643cbe66505", byteLength: 616_196 },
        ],
      },
      {
        family: DESIGN_BUNDLED_MONO_FONT_FAMILY,
        label: "Noto Sans Mono",
        weights: [400],
        faces: [
          { weight: 400, sourcePath: "packages/fonts/assets/core/mono/NotoSansMono-Regular.ttf", sha256: "d9e2b23d19f8230be7146f409a52b1d23117e635e28f2e2892cf91b7382f325b", byteLength: 512_836 },
        ],
      },
    ]);
    expect(designBundledFontWeights(DESIGN_BUNDLED_FONT_FAMILY)).toEqual([400, 700]);
    expect(designBundledFontWeights(DESIGN_BUNDLED_SERIF_FONT_FAMILY)).toEqual([400]);
    expect(designBundledFontWeights(DESIGN_BUNDLED_MONO_FONT_FAMILY)).toEqual([400]);
  });

  test("loads every catalogued face with Latin glyph coverage", () => {
    for (const entry of DESIGN_BUNDLED_FONT_CATALOG) {
      for (const face of entry.faces) {
        const font = designBundledFontForStyle(entry.family, face.weight);
        expect(font).not.toBeNull();
        expect(font?.hasGlyphForCodePoint("é".codePointAt(0)!)).toBe(true);
        expect(font?.layout("Nautilo café").glyphs).toHaveLength(12);
      }
    }
  });

  test("embeds only requested family and weight faces", () => {
    const css = designBundledFontFaceCss(new Map([
      [designBundledFontFaceKey(DESIGN_BUNDLED_FONT_FAMILY, 400), ""],
      [designBundledFontFaceKey(DESIGN_BUNDLED_SERIF_FONT_FAMILY, 400), "Serif"],
    ]));
    expect(css).toContain(`font-family:${JSON.stringify(DESIGN_BUNDLED_SERIF_FONT_FAMILY)}`);
    expect(css).not.toContain(`font-family:${JSON.stringify(DESIGN_BUNDLED_FONT_FAMILY)}`);
    expect(css).not.toContain(`font-family:${JSON.stringify(DESIGN_BUNDLED_MONO_FONT_FAMILY)}`);
    expect(css.match(/@font-face/g)).toHaveLength(1);
  });
});
