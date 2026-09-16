import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("browser-safe root does not expose server, DB, or lattice imports", () => {
  const root = readFileSync(resolve(import.meta.dir, "../../src/index.ts"), "utf8");
  const codec = readFileSync(
    resolve(import.meta.dir, "../../src/record-payload-v1.ts"),
    "utf8",
  );
  const source = `${root}\n${codec}`;
  expect(source).not.toContain("@nautilo/db");
  expect(source).not.toContain("@nautilo/lattice");
  expect(source).not.toContain("node:");
  expect(source).not.toContain("./server");
});

test("package metadata keeps browser-safe root and server composition distinct", () => {
  const packageJson = readFileSync(
    resolve(import.meta.dir, "../../package.json"),
    "utf8",
  );
  expect(packageJson).toContain('"import": "./src/index.ts"');
  expect(packageJson).toContain('"types": "./src/index.ts"');
  expect(packageJson).toContain('"./server"');
  expect(packageJson).toContain('"import": "./src/server/index.ts"');
  expect(packageJson).toContain('"types": "./src/server/index.ts"');
});
