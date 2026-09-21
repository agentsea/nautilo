import { describe, expect, test } from "bun:test";
import {
  classicObservationsToGrounding,
  parseTesseractTsv,
  type TextObservation,
} from "./classic-grounding.ts";
import { parseClassicBaselineArgs } from "./run-classic-baseline.ts";

describe("classic local visual grounding", () => {
  test("parses Tesseract word boxes and confidence", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t1\t1\t1\t100\t200\t80\t30\t96.5\tDog",
      "5\t1\t1\t1\t1\t2\t190\t200\t0\t30\t80\tignored",
      "4\t1\t1\t1\t1\t0\t100\t200\t170\t30\t-1\t",
    ].join("\n");
    expect(parseTesseractTsv(tsv)).toEqual([{
      text: "Dog",
      confidence: 0.965,
      box: { x: 100, y: 200, width: 80, height: 30 },
    }]);
  });

  test("labels an enclosing visual region and preserves image coordinates", () => {
    const text: TextObservation[] = [{
      text: "Dog",
      confidence: 0.97,
      box: { x: 120, y: 220, width: 60, height: 24 },
    }];
    const grounding = classicObservationsToGrounding({
      backend: "portable",
      image: { width: 1_000, height: 800 },
      text,
      regions: [{
        box: { x: 100, y: 200, width: 200, height: 60 },
        confidence: 0.8,
        source: "perceptual-edge",
      }],
    });
    expect(grounding.targets[0]).toMatchObject({
      role: "visual region",
      name: "Dog",
      interaction: "unknown",
      x: 200,
      y: 230,
      box: { x: 100, y: 200, width: 200, height: 60 },
    });
    expect(grounding.targets.some(({ sources }) => sources?.includes("ocr"))).toBe(true);
  });

  test("parses both experiment backends", () => {
    const defaults = parseClassicBaselineArgs([]);
    expect(defaults.live).toBe(false);
    expect(defaults.backends).toContain("portable");
    expect(parseClassicBaselineArgs(["--backend", "portable", "--case", "room2-initial", "--live"]))
      .toMatchObject({ live: true, caseId: "room2-initial", backends: ["portable"] });
    expect(() => parseClassicBaselineArgs(["--backend", "unknown"])).toThrow(/requires/);
  });
});
