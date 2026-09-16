import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import ts from "typescript";
import * as schema from "@nautilo/db/schema";

import { REVIEWED_REFLECTION_REPLAY_COVERAGE } from "../../baseline/reviewed-main-2026-09-12-reflection";

const root = join(import.meta.dir, "../../../..");

test("Reflection replay metadata stays on exact schema fields and closed control values", () => {
  const tables = [schema.reflectionRecordAuthorityDependencies, schema.reflectionRecordPublications, schema.reflectionRecordSemanticWork];
  const locators = new Set(tables.flatMap((table) => {
    const name = getTableConfig(table).name;
    return [`public.${name}`, ...getTableConfig(table).columns.map((column) => `public.${name}.${column.name}`)];
  }));
  for (const entry of REVIEWED_REFLECTION_REPLAY_COVERAGE) expect(locators.has(entry.locator)).toBe(true);
  expect(Object.values(getTableColumns(schema.reflectionRecordAuthorityDependencies)).map((column) => column.name).sort()).toEqual(["dependency_record_id", "record_id"]);
  const checks = getTableConfig(schema.reflectionRecordSemanticWork).checks;
  const fallback = checks.find((check) => check.name === "reflection_record_semantic_work_ordinary_fallback_coherent");
  expect(fallback).toBeDefined();
  const sql = new PgDialect().sqlToQuery(fallback!.value).sql;
  expect(sql).toContain("'recoverable_availability', 'key_waiting'");
  expect(sql).toContain("'complete'");
});

test("every Reflection authority warning contains only a fixed label and the classified failure", () => {
  const path = "packages/server/src/reflection/protected-authority-composition.ts";
  const text = readFileSync(join(root, path), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  let warnings = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "console.warn") {
      warnings++;
      expect(node.arguments.length).toBe(2);
      expect(ts.isStringLiteral(node.arguments[0]!)).toBe(true);
      const fields = node.arguments[1]!;
      expect(ts.isObjectLiteralExpression(fields)).toBe(true);
      if (!ts.isObjectLiteralExpression(fields)) throw new Error("unexpected log fields");
      expect(fields.properties.length).toBe(1);
      const field = fields.properties[0]!;
      expect(field.name?.getText(source)).toBe("failureClass");
      if (ts.isPropertyAssignment(field)) expect(field.initializer.getText(source)).toBe("classifyDataOperationFailure(error)");
      else expect(ts.isShorthandPropertyAssignment(field)).toBe(true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(warnings).toBe(9);
  expect(text).toContain("const failureClass = classifyDataOperationFailure(error);");
  const classifier = readFileSync(join(root, "packages/lattice-bridge/src/transition/encryption-data-operation-owner.ts"), "utf8");
  expect(classifier).toContain('error instanceof ClassifiedDataOperationError\n    ? error.failureClass\n    : "unknown"');
});
