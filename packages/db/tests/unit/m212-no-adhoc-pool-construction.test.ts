/**
 * CI pin for `@nautilo/db/m212-no-adhoc-pool-construction` (ISSUE-M212 Phase 5).
 *
 * Exercises AST-only detection: runtime rejection, operator/migration allowance
 * via file allowlist (not inline eslint-disable), `import type` allowance,
 * comments/strings safety, and default `postgres` import/call rejection.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { RuleTester } from "@typescript-eslint/rule-tester";
import type { TSESLint } from "@typescript-eslint/utils";
import { afterAll, describe, test } from "bun:test";

// @ts-expect-error -- rule body is JS+JSDoc; no .d.mts shipped
import { m212NoAdhocPoolConstruction as ruleUntyped } from "../../eslint/m212-no-adhoc-pool-construction.mjs";

const m212NoAdhocPoolConstruction = ruleUntyped as TSESLint.RuleModule<
  | "directFactoryImport"
  | "directFactoryCall"
  | "postgresImport"
  | "postgresCall"
  | "directFactoryDynamicImport",
  []
>;

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = test;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "../..");

// The rule only inspects ESTree import/call nodes; a TypeScript project service
// adds no coverage and can exceed Bun's 5s unit-test timeout under CI load.
const ruleTester = new RuleTester();

const migrationAllowlistFilename = path.join(
  packageRoot,
  "src/utils/ensure-database.ts",
);

ruleTester.run("m212-no-adhoc-pool-construction", m212NoAdhocPoolConstruction, {
  valid: [
    {
      name: "V1: import type { DirectDatabase } from @nautilo/db",
      code: `import type { DirectDatabase } from "@nautilo/db";
export type TrustDb = DirectDatabase;
`,
    },
    {
      name: "V2: inline type-only named import",
      code: `import { type DirectDatabase, eq } from "@nautilo/db";
export type TrustDb = DirectDatabase;
`,
    },
    {
      name: "V3: typeof createDirectDb in type alias without value import",
      code: `import type { createDirectDb } from "@nautilo/db";
export type TrustDb = ReturnType<typeof createDirectDb>;
`,
    },
    {
      name: "V4: comments mentioning createDirectDb(1) do not fire",
      code: `/** createDirectDb(1) was removed from request paths in M212 Phase 4. */
const marker = "postgres('ignored string literal')";
void marker;
`,
    },
    {
      name: "V5: allowlisted migration/bootstrap file may import postgres",
      code: `import postgres from "postgres";
export async function ensureDatabase() {
  const sql = postgres("postgresql://example");
  await sql.end();
}
`,
      filename: migrationAllowlistFilename,
    },
    {
      name: "V6: allowlisted operator CLI may call createDirectDb",
      code: `import { createDirectDb } from "@nautilo/db";
export function run() {
  const db = createDirectDb(1);
  return db;
}
`,
      filename: path.join(packageRoot, "../../bin/nautilo-dev/src/commands/mcp.ts"),
    },
  ],
  invalid: [
    {
      name: "I1: runtime createDirectDb import from @nautilo/db",
      code: `import { createDirectDb } from "@nautilo/db";
const db = createDirectDb(1);
`,
      errors: [{ messageId: "directFactoryImport" }, { messageId: "directFactoryCall" }],
    },
    {
      name: "I2: runtime createDirectAgentDb import and call",
      code: `import { createDirectAgentDb } from "@nautilo/db";
export function open() {
  return createDirectAgentDb(1);
}
`,
      errors: [{ messageId: "directFactoryImport" }, { messageId: "directFactoryCall" }],
    },
    {
      name: "I3: default postgres import and call",
      code: `import postgres from "postgres";
export function open(url: string) {
  return postgres(url);
}
`,
      errors: [{ messageId: "postgresImport" }, { messageId: "postgresCall" }],
    },
    {
      name: "I4: relative direct-database import in non-allowlisted db helper",
      code: `import { createDirectDb } from "../config/direct-database";
export function helper() {
  return createDirectDb(1);
}
`,
      filename: path.join(packageRoot, "src/utils/seed-invitee.ts"),
      errors: [{ messageId: "directFactoryImport" }, { messageId: "directFactoryCall" }],
    },
    {
      name: "I5: dynamic import destructure of createDirectDb",
      code: `export async function mint() {
  const { createDirectDb } = await import("@nautilo/db");
  return createDirectDb(1);
}
`,
      errors: [
        { messageId: "directFactoryDynamicImport" },
        { messageId: "directFactoryCall" },
      ],
    },
  ],
});
