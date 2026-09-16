import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { importSvgFragment, type SvgDomParser } from "./svg-import";
import { pathDataFromVectorNetwork } from "./vector";

function parser(): SvgDomParser {
  const window = new Window();
  return new window.DOMParser() as unknown as SvgDomParser;
}

const measurer = (text: string) => text.length * 8;

describe("safe SVG import", () => {
  test("lowers the allowlisted shape, path, text, and group subset into a canonical fragment", () => {
    const result = importSvgFragment(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
        <g id="art" transform="translate(10 20)" opacity="0.5" fill="#123456">
          <rect id="box" x="0" y="0" width="20" height="10" rx="2" ry="1"/>
          <circle cx="40" cy="10" r="5"/>
          <ellipse cx="60" cy="10" rx="6" ry="3"/>
          <line x1="0" y1="30" x2="20" y2="30" stroke="#000"/>
          <polyline points="30,30 35,35 40,30" fill="none"/>
          <polygon points="50,30 60,30 55,40"/>
          <path id="curve" d="M 70 30 C 75 20 85 20 90 30" fill="none" stroke="red"/>
          <text x="0" y="60" font-size="10" font-family="Inter" font-weight="700">Hi</text>
        </g>
      </svg>`, { parser: parser(), textMeasurer: measurer });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fragment.roots).toEqual(["svg-import-1"]);
    expect(result.fragment.nodes.map((node) => node.type)).toEqual([
      "group", "group", "rectangle", "vector", "vector", "vector", "vector", "vector", "vector", "text",
    ]);
    const group = result.fragment.nodes.find((node) => node.name === "art")!;
    expect(group.opacity).toBe(0.5);
    expect(group.childIds).toHaveLength(8);
    const box = result.fragment.nodes.find((node) => node.name === "box")!;
    expect({ x: box.x, y: box.y, width: box.width, height: box.height, radius: box.radius, radiusY: box.radiusY }).toEqual({ x: 10, y: 20, width: 20, height: 10, radius: 2, radiusY: 1 });
    const curve = result.fragment.nodes.find((node) => node.name === "curve")!;
    expect(curve.vectorNetwork).toBeDefined();
    expect(curve.vectorPath).toBeUndefined();
    expect(pathDataFromVectorNetwork(curve.vectorNetwork!)).toContain("C 5 0 15 0 20 10");
    expect(curve.stroke?.color).toBe("red");
    const text = result.fragment.nodes.find((node) => node.type === "text")!;
    expect({ x: text.x, y: text.y, text: text.text, fontFamily: text.fontFamily, fontWeight: text.fontWeight }).toEqual({
      x: 10, y: 70, text: "Hi", fontFamily: "Inter", fontWeight: "700",
    });
  });

  test("bakes nested affine transforms exactly into imported geometry", () => {
    const result = importSvgFragment(`<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(100 20)"><rect id="turned" x="0" y="0" width="40" height="10" transform="rotate(90 20 5)"/></g></svg>`, { parser: parser() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rect = result.fragment.nodes.find((node) => node.name === "turned")!;
    expect(rect.x).toBeCloseTo(100);
    expect(rect.y).toBeCloseTo(20);
    expect(rect.rotation).toBeCloseTo(90);
  });

  test("maps a root viewBox into its viewport with default xMidYMid meet", () => {
    const result = importSvgFragment(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 100 50" width="200" height="200"><rect id="box" x="10" y="20" width="100" height="50"/></svg>`, { parser: parser() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const box = result.fragment.nodes.find((node) => node.name === "box")!;
    expect({ x: box.x, y: box.y, width: box.width, height: box.height }).toEqual({ x: 0, y: 50, width: 200, height: 100 });
  });

  test("supports explicit meet alignment and nonuniform none viewport mapping", () => {
    const aligned = importSvgFragment(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="300" height="100" preserveAspectRatio="xMaxYMax meet"><rect id="box" width="100" height="100"/></svg>`, { parser: parser() });
    expect(aligned.ok).toBe(true);
    if (aligned.ok) {
      const box = aligned.fragment.nodes.find((node) => node.name === "box")!;
      expect({ x: box.x, y: box.y, width: box.width, height: box.height }).toEqual({ x: 200, y: 0, width: 100, height: 100 });
    }

    const stretched = importSvgFragment(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="50" preserveAspectRatio="none"><rect id="box" width="100" height="100"/></svg>`, { parser: parser() });
    expect(stretched.ok).toBe(true);
    if (stretched.ok) {
      const box = stretched.fragment.nodes.find((node) => node.name === "box")!;
      expect({ x: box.x, y: box.y, width: box.width, height: box.height }).toEqual({ x: 0, y: 0, width: 200, height: 50 });
    }
  });

  test("scales uniform strokes and rejects nonuniform or skewed stroked imports", () => {
    const uniform = importSvgFragment(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200"><path id="line" d="M 0 0 L 10 0" fill="none" stroke="red" stroke-width="2" stroke-dasharray="3 1"/></svg>`, { parser: parser() });
    expect(uniform.ok).toBe(true);
    if (uniform.ok) {
      const line = uniform.fragment.nodes.find((node) => node.name === "line")!;
      expect(line.stroke).toEqual({ color: "red", width: 4, dash: [6, 2] });
      expect(line.vectorNetwork).toBeDefined();
    }

    for (const source of [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="50" preserveAspectRatio="none"><path d="M 0 0 L 10 0" fill="none" stroke="red"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><g transform="skewX(20)"><rect width="10" height="10" fill="none" stroke="red"/></g></svg>`,
    ]) {
      const result = importSvgFragment(source, { parser: parser() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("unsupported-paint");
    }
  });

  test("imports cubic and multi-subpath paths as point-editable canonical networks", () => {
    const result = importSvgFragment(`<svg xmlns="http://www.w3.org/2000/svg"><path id="editable" d="M 10 10 C 20 0 30 0 40 10 L 25 30 Z M 50 10 L 60 20"/></svg>`, { parser: parser() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const path = result.fragment.nodes.find((node) => node.name === "editable")!;
    expect(path.vectorPath).toBeUndefined();
    expect(path.vectorNetwork).toBeDefined();
    expect(path.vectorNetwork?.vertices).toHaveLength(5);
    expect(path.vectorNetwork?.segments).toHaveLength(4);
    expect(path.vectorNetwork?.regions).toEqual([{ id: `${path.id}-r0`, vertexIds: [`${path.id}-v0`, `${path.id}-v1`, `${path.id}-v2`] }]);
    expect(path.vectorNetwork?.segments[0]?.startHandle).toEqual({ x: 10, y: 0 });
    expect(path.vectorNetwork?.segments[0]?.endHandle).toEqual({ x: 20, y: 0 });
    expect(pathDataFromVectorNetwork(path.vectorNetwork!)).toBe("M 0 10 C 10 0 20 0 30 10 L 15 30 Z M 40 10 L 50 20");
  });

  test("rejects scripts, event handlers, references, and CSS without returning a partial fragment", () => {
    const cases = [
      [`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`, "unsafe-document"],
      [`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" onclick="run()"/></svg>`, "unsafe-attribute"],
      [`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="url(#paint)"/></svg>`, "external-reference"],
      [`<svg xmlns="http://www.w3.org/2000/svg"><use href="#shape"/></svg>`, "unsafe-document"],
      [`<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA=="/></svg>`, "external-reference"],
      [`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" style="fill:red"/></svg>`, "unsafe-attribute"],
    ] as const;
    for (const [source, code] of cases) {
      const result = importSvgFragment(source, { parser: parser() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    }
  });

  test("rejects unsupported path grammar and paint with named reasons", () => {
    const quadratic = importSvgFragment(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 Q 5 5 10 0"/></svg>`, { parser: parser() });
    expect(quadratic.ok).toBe(false);
    if (!quadratic.ok) expect(quadratic.error.code).toBe("unsupported-path");

    const gradient = importSvgFragment(`<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="g"/></svg>`, { parser: parser() });
    expect(gradient.ok).toBe(false);
    if (!gradient.ok) expect(gradient.error.code).toBe("unsupported-element");

  });

  test("rejects ambiguous or unsupported root viewport forms atomically", () => {
    const cases = [
      [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200"><rect width="10" height="10"/></svg>`, "svg"],
      [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 100" width="200" height="200"><rect width="10" height="10"/></svg>`, "svg"],
      [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200" preserveAspectRatio="xMidYMid slice"><rect width="10" height="10"/></svg>`, "svg"],
      [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0,,0 100 100" width="200" height="200"><rect width="10" height="10"/></svg>`, "svg"],
      [`<svg xmlns="http://www.w3.org/2000/svg"><polyline points="0,,0 10,10"/></svg>`, "polyline"],
      [`<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" transform="translate(,10)"/></svg>`, "rect"],
      [`<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 0" stroke="red" stroke-dasharray="2,,3"/></svg>`, "path"],
    ] as const;
    for (const [source, element] of cases) {
      const result = importSvgFragment(source, { parser: parser() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.element).toBe(element);
    }
  });

  test("lowers nonuniform text scaling into font size and geometric stretch", () => {
    const result = importSvgFragment(`<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="20" font-size="10" transform="scale(2 3)">Hi</text></svg>`, { parser: parser(), textMeasurer: measurer });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.fragment.nodes.find((node) => node.type === "text")!;
    expect(text.fontSize).toBeCloseTo(30);
    expect(text.fontStretch).toBeCloseTo(2 / 3);
    expect(text.x).toBeCloseTo(20);
    expect(text.y).toBeCloseTo(30);
  });

  test("requires explicit font measurement for SVG text", () => {
    const result = importSvgFragment(`<svg xmlns="http://www.w3.org/2000/svg"><text>Measured</text></svg>`, { parser: parser() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("text-measurement-unavailable");
  });

  test("rejects doctypes before XML parsing", () => {
    const result = importSvgFragment(`<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>`, { parser: parser() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsafe-document");
  });
});
