import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const REFLECTION_SOURCE = join(ROOT, "packages/reflection/src");
const RUNTIME_STENOGRAPHER = join(ROOT, "packages/runtime/src/stenographer");
const REFLECTION_BRIDGE_SOURCE = join(ROOT, "packages/reflection-bridge/src");
const RECORD_NON_RUNTIME_INVENTORY_REFERENCES = new Set([
  // Backup/restore inventory only. It names tables for clone portability and
  // owns neither product SQL nor a production Record caller.
  "bin/nautilo-dev/src/lib/docker-db.ts",
  // Encryption review evidence classifies the table's protected payload and
  // owns neither product SQL nor a production Record caller.
  "packages/encryption-invariants/baseline/reviewed-main-2026-08-13-merged.ts",
  "packages/encryption-invariants/baseline/reviewed-main-2026-08-14-m267.ts",
  "packages/encryption-invariants/baseline/reviewed-main-2026-09-12-reflection.ts",
  // Bridge unit evidence asserts the schema-compiled publication query. The
  // production owner remains the adjacent bridge server repository.
  "packages/reflection-bridge/tests/unit/postgres-current-record-publication-binding.test.ts",
  "packages/reflection-bridge/tests/unit/postgres-record-product-store.test.ts",
  "packages/reflection-bridge/tests/unit/protected-stenographer-record-attachment.test.ts",
  // M327 fixtures inspect real bridge-owned publication/reconciliation receipts;
  // none is a production data-access caller.
  "packages/reflection-bridge/tests/unit/postgres-authority-receipts.test.ts",
  "packages/server/tests/lattice-integration/m327-protected-reflection-composition.integration.test.ts",
  // M327 lifecycle fixtures characterize bridge-owned publication settlement
  // SQL; production Server code reaches that owner through bridge composition.
  "packages/server/tests/unit/reflection-semantic-commit-settlement.test.ts",
  "packages/server/tests/unit/reflection-semantic-lifecycle.test.ts",
  "packages/lattice-bridge/tests/integration/wave-10-background-postgres.integration.test.ts",
  // Lattice's source-authority fixture observes the same bridge-owned receipt.
  "packages/lattice-bridge/tests/unit/postgres-native-journal-source-authority.test.ts",
  // Runtime's repository unit fixture characterizes bridge-owned SQL ordering;
  // production Runtime still reaches it only through bridge composition.
  "packages/runtime/tests/unit/protected-journal-publication-repository.test.ts",
]);

function TypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? TypeScriptFiles(path)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [path]
        : [];
  });
}

function imports(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
    .map((match) => match[1]!);
}

describe("M253 Reflection ownership boundary", () => {
  test("Reflection source has no Nautilo product or parent-package imports", () => {
    const violations: string[] = [];
    for (const file of TypeScriptFiles(REFLECTION_SOURCE)) {
      for (const specifier of imports(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("@nautilo/")) {
          violations.push(`${relative(ROOT, file)} imports ${specifier}`);
        }
        if (specifier.startsWith("../") && specifier.includes("../../")) {
          violations.push(`${relative(ROOT, file)} escapes via ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("Runtime has no retired semantic owner or copied prompt contracts", () => {
    for (const retired of [
      "model.ts",
      "evidence-projection.ts",
      "output-validation.ts",
    ]) {
      expect(existsSync(join(RUNTIME_STENOGRAPHER, retired))).toBe(false);
    }

    const duplicateSignatures = [
      "[Required output]",
      'Return one JSON object only: {"content"',
      "ModelStenographerOutputSchema",
      "validateStenographerOutputWithRepair",
    ];
    const violations = TypeScriptFiles(RUNTIME_STENOGRAPHER).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return duplicateSignatures
        .filter((signature) => source.includes(signature))
        .map((signature) => `${relative(ROOT, file)} duplicates ${signature}`);
    });
    expect(violations).toEqual([]);
  });
});

describe("M257 Reflection bridge ownership boundary", () => {
  test("browser-safe bridge root has no DB, lattice, or Node imports", () => {
    const rootFiles = TypeScriptFiles(REFLECTION_BRIDGE_SOURCE)
      .filter((file) => !file.includes(`${join("src", "server")}/`))
      .filter((file) => !file.includes(`${join("src", "testing")}/`));
    const violations = rootFiles.flatMap((file) =>
      imports(readFileSync(file, "utf8"))
        .filter((specifier) =>
          specifier.startsWith("node:")
          || specifier === "@nautilo/db"
          || specifier.startsWith("@nautilo/lattice")
        )
        .map((specifier) => `${relative(ROOT, file)} imports ${specifier}`)
    );
    expect(violations).toEqual([]);
  });

  test("Record product SQL has one bridge owner and no production caller", () => {
    const roots = ["apps", "bin", "packages"];
    const table = "reflection_record_publications";
    const references = roots.flatMap((root) => {
      const directory = join(ROOT, root);
      return existsSync(directory) ? TypeScriptFiles(directory) : [];
    }).filter((file) => readFileSync(file, "utf8").includes(table))
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"))
      .filter((file) =>
        !file.startsWith("packages/db/")
        && !file.startsWith("packages/reflection-bridge/src/server/")
        && !RECORD_NON_RUNTIME_INVENTORY_REFERENCES.has(file)
      );
    expect(references).toEqual([]);
  });
});
