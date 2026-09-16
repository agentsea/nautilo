import { describe, expect, test } from "bun:test";
import {
  DESIGN_BUNDLED_FONT_FAMILIES,
  DESIGN_BUNDLED_MONO_FONT_FAMILY,
  DESIGN_BUNDLED_SERIF_FONT_FAMILY,
} from "./bundled-fonts";
import { createNode } from "./scene-graph";
import { createBrowserTextMeasurer, layoutTextNode, measureBundledText, textRenderStyle, type TextMeasurer } from "./text-layout";

const tenPerCharacter: TextMeasurer = (text) => Array.from(text).length * 10;

describe("text layout", () => {
  test("creates a browser measurer through a DOM-free structural contract", () => {
    const fonts: string[] = [];
    const measurer = createBrowserTextMeasurer({
      createElement: () => ({
        getContext: () => ({
          font: "",
          measureText(text: string) {
            fonts.push(this.font);
            return { width: text.length * 7 };
          },
        }),
      }),
    });
    expect(measurer?.("abc", { fontFamily: "Inter", fontSize: 12, fontWeight: 700 })).toBe(21);
    expect(fonts).toEqual(["700 12px Inter"]);
  });

  test("wraps words and long tokens against measured font width", () => {
    const node = createNode({ id: "text", type: "text", parentId: null, width: 50, text: "one two abcdef", textWrap: true, lineHeight: 1.5, fontSize: 10 });
    expect(layoutTextNode(node, tenPerCharacter)).toEqual({
      lines: ["one", "two", "abcde", "f"],
      lineHeight: 15,
      measuredWidth: 50,
      measured: true,
    });
  });

  test("uses the embedded Noto font deterministically without a browser", () => {
    const node = createNode({
      id: "text",
      type: "text",
      parentId: null,
      width: 70,
      fontSize: 14,
      text: "Nautilo wraps exactly",
      textWrap: true,
    });
    expect(layoutTextNode(node)).toEqual({
      lines: ["Nautilo", "wraps", "exactly"],
      lineHeight: 17.5,
      measuredWidth: 47.894,
      measured: true,
    });
  });

  test("rejects unsupported wrapped font families instead of substituting metrics", () => {
    const node = createNode({ id: "text", type: "text", parentId: null, text: "wrapped", textWrap: true, fontFamily: "Inter" });
    const message = `Wrapped text supports ${DESIGN_BUNDLED_FONT_FAMILIES.join(", ")}; received Inter.`;
    expect(() => layoutTextNode(node)).toThrow(message);
    expect(() => layoutTextNode(node, tenPerCharacter)).toThrow(message);
  });

  test("rejects wrapped font weights without an exact bundled face", () => {
    for (const fontWeight of [500, "600"] as const) {
      const node = createNode({ id: `text-${fontWeight}`, type: "text", parentId: null, text: "wrapped", textWrap: true, fontWeight });
      expect(() => layoutTextNode(node)).toThrow(`does not include an exact ${fontWeight} font face.`);
    }
  });

  test("measures and wraps every catalogued family from its exact face", () => {
    const serif = createNode({
      id: "serif", type: "text", parentId: null, text: "Measured serif text", textWrap: true,
      width: 84, fontFamily: DESIGN_BUNDLED_SERIF_FONT_FAMILY, fontWeight: 400,
    });
    const mono = createNode({
      ...serif, id: "mono", fontFamily: DESIGN_BUNDLED_MONO_FONT_FAMILY,
    });
    expect(textRenderStyle(serif)).toMatchObject({
      bundled: true, fontFamily: DESIGN_BUNDLED_SERIF_FONT_FAMILY, fontWeight: 400,
    });
    expect(textRenderStyle(mono)).toMatchObject({
      bundled: true, fontFamily: DESIGN_BUNDLED_MONO_FONT_FAMILY, fontWeight: 400,
    });
    expect(layoutTextNode(serif)).toEqual(layoutTextNode(serif, measureBundledText));
    expect(layoutTextNode(mono)).toEqual(layoutTextNode(mono, measureBundledText));
    expect(layoutTextNode(serif).measured).toBe(true);
    expect(layoutTextNode(mono).measured).toBe(true);
    expect(layoutTextNode(serif).measuredWidth).not.toBe(layoutTextNode(mono).measuredWidth);
  });

  test("rejects weights that do not have an exact family face", () => {
    for (const fontFamily of [DESIGN_BUNDLED_SERIF_FONT_FAMILY, DESIGN_BUNDLED_MONO_FONT_FAMILY]) {
      const node = createNode({
        id: fontFamily, type: "text", parentId: null, text: "No synthetic bold",
        textWrap: false, fontFamily, fontWeight: 700,
      });
      expect(() => textRenderStyle(node)).toThrow(`${fontFamily} does not include an exact 700 font face.`);
    }
  });

  test("preserves explicit newlines", () => {
    const node = createNode({ id: "text", type: "text", parentId: null, width: 100, text: "one\n\ntwo", textWrap: true });
    expect(layoutTextNode(node, tenPerCharacter).lines).toEqual(["one", "", "two"]);
  });

  test("fails explicitly when wrapped text cannot be measured", () => {
    const node = createNode({ id: "text", type: "text", parentId: null, text: "wrapped", textWrap: true });
    expect(() => layoutTextNode(node, null)).toThrow("requires font measurement");
  });

  test("uses the geometric font stretch for measurement and wrapping", () => {
    const node = createNode({ id: "text", type: "text", parentId: null, width: 50, text: "ab cd", textWrap: true, fontStretch: 2 });
    expect(layoutTextNode(node, tenPerCharacter).lines).toEqual(["ab", "cd"]);
    expect(layoutTextNode({ ...node, textWrap: false }, tenPerCharacter).measuredWidth).toBe(100);
  });
});
