import { describe, expect, test } from "bun:test";
import {
  inspectPackageInventory,
  type PackageInventoryViolation,
} from "../../scripts/package-inventory-policy";

const MINIMAL_VALID_INVENTORY = [
  "/assets/icon.png",
  "/dist",
  "/dist/main.js",
  "/node_modules",
  "/node_modules/electron-log/package.json",
  "/node_modules/electron-log/main.js",
  "/package.json",
];

function reasonsFor(paths: string[]): PackageInventoryViolation[] {
  return inspectPackageInventory([...MINIMAL_VALID_INVENTORY, ...paths]).violations;
}

describe("production Desktop package inventory", () => {
  test("accepts the explicit runtime roots and required entry points", () => {
    const report = inspectPackageInventory(MINIMAL_VALID_INVENTORY);

    expect(report.violations).toEqual([]);
    expect(report.rootCounts).toEqual(new Map([
      ["assets", 1],
      ["dist", 2],
      ["node_modules", 3],
      ["package.json", 1],
    ]));
  });

  test("rejects source maps, test payloads, private paths, and signing material", () => {
    const violations = reasonsFor([
      "/node_modules/example/dist/index.js.map",
      "/node_modules/example/tests/fixture.json",
      "/node_modules/example/src/parser.spec.js",
      "/.github/workflows/release.yml",
      "/dist/.env.production",
      "/assets/distribution.p12",
    ]);

    expect(violations).toEqual([
      { path: ".github/workflows/release.yml", reason: "unapproved archive root '.github'" },
      { path: "assets/distribution.p12", reason: "private key or signing material" },
      { path: "dist/.env.production", reason: "environment file" },
      { path: "node_modules/example/dist/index.js.map", reason: "production source map" },
      { path: "node_modules/example/src/parser.spec.js", reason: "test file" },
      { path: "node_modules/example/tests/fixture.json", reason: "test directory" },
    ]);
  });

  test("rejects an unexpected root and missing required runtime files", () => {
    const report = inspectPackageInventory([
      "/assets/icon.png",
      "/source/main.ts",
    ]);

    expect(report.violations).toEqual([
      { path: "source/main.ts", reason: "unapproved archive root 'source'" },
      { path: "dist/main.js", reason: "required runtime file is missing" },
      { path: "package.json", reason: "required runtime file is missing" },
    ]);
  });

  test("normalizes Windows separators and duplicate archive entries", () => {
    const report = inspectPackageInventory([
      "\\dist\\main.js",
      "/dist/main.js",
      "\\package.json",
    ]);

    expect(report.entries).toEqual(["dist/main.js", "package.json"]);
    expect(report.violations).toEqual([]);
  });
});
