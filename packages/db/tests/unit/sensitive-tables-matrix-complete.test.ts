import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getTableName, isTable } from "drizzle-orm";
import * as schema from "../../src/schema/index.ts";

/** Versioned alongside the schema; a clean checkout has no private fallback. */
const MATRIX_RELATIVE = "../../audits/sensitive-tables-matrix.md";

function drizzleTableName(value: unknown): string | undefined {
  return isTable(value) ? getTableName(value) : undefined;
}

function pathToSensitiveTablesMatrix(): string {
  return resolve(import.meta.dir, MATRIX_RELATIVE);
}

function parseNautiloTableNamesFromMatrix(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    const m = trimmed.match(/^\|\s*`([a-z_]+)`\s*\|\s*nautilo\s*\|/u);
    if (m?.[1]) {
      names.add(m[1]);
    }
  }
  return names;
}

function exportedPgTableNames(): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    const name = drizzleTableName(value);
    if (name) {
      names.add(name);
    }
  }
  return names;
}

describe("sensitive-tables-matrix completeness (D129 P2)", () => {
  it("lists every exported Drizzle pgTable in packages/db/audits/sensitive-tables-matrix.md (nautilo rows)", () => {
    const matrixPath = pathToSensitiveTablesMatrix();
    expect(existsSync(matrixPath)).toBe(true);

    const markdown = readFileSync(matrixPath, "utf8");
    const matrixNames = parseNautiloTableNamesFromMatrix(markdown);
    const schemaNames = exportedPgTableNames();

    const missingInMatrix = [...schemaNames].filter((t) => !matrixNames.has(t)).sort();
    const extraInMatrix = [...matrixNames].filter((t) => !schemaNames.has(t)).sort();

    if (missingInMatrix.length > 0 || extraInMatrix.length > 0) {
      throw new Error(
        [
          "Schema tables must match `nautilo` matrix rows exactly.",
          `Matrix file: ${matrixPath}`,
          `Missing in matrix (${missingInMatrix.length}): ${missingInMatrix.join(", ") || "—"}`,
          `Extra in matrix, not in schema (${extraInMatrix.length}): ${extraInMatrix.join(", ") || "—"}`,
        ].join("\n"),
      );
    }
  });

  it("resolves matrix from packages/db/audits (CI layout)", () => {
    const p = resolve(import.meta.dir, MATRIX_RELATIVE);
    expect(p.endsWith("packages/db/audits/sensitive-tables-matrix.md")).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});
