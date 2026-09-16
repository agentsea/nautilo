import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dir, "artifact-image-inspector.tsx"), "utf8");

test("gestures attach to a stable interactive native view instead of the transformed image", () => {
  expect(source).toContain("<GestureDetector gesture={gestures}>");
  expect(source).toContain('<View collapsable={false} pointerEvents="box-only" style={styles.gestureSurface}>');
  expect(source).toContain("style={[styles.image, animatedStyle]}");
  expect(source).toContain('gestureSurface: { width: "100%", height: "100%"');
});
