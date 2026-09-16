import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import ts from "typescript";

import {
  CRYPTO_STORAGE_TABLE_NAMES,
} from "../../../packages/db/src/schema/crypto-storage";

const repositoryRoot = join(import.meta.dir, "../../..");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "reports",
  "target",
  "tests",
]);
const productRoots = [
  "apps",
  "bin",
  "deploy",
  "infra",
  "native",
  "ops",
  "packages",
  "packaging",
];

function walkSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) visit(join(path, entry.name));
      } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
        files.push(join(path, entry.name));
      }
    }
  };
  visit(root);
  return files.sort();
}

function repositoryPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function isAllowedSchemaOwner(path: string): boolean {
  return path.startsWith("packages/db/src/")
    || path.startsWith("packages/lattice-bridge/src/server/");
}

function isAllowedSchemaContractConsumer(path: string): boolean {
  return path === "packages/lattice-bridge/scripts/run-postgres-integration.ts";
}

function isAllowedOperationalTableReference(path: string): boolean {
  return path === "bin/nautilo-dev/src/lib/docker-db.ts"
    || path ===
      "packages/db/scripts/finalize-crypto-delivery-migration.ts"
    || path ===
      "packages/db/scripts/finalize-m237-message-crypto-lifecycle.ts"
    || path ===
      "packages/db/scripts/finalize-m241-background-authorization.ts"
    || path ===
      "packages/db/scripts/finalize-m244-background-authority-sets.ts"
    || path ===
      "packages/db/scripts/finalize-m290-namespace-key-authority.ts"
    || path ===
      "packages/db/scripts/finalize-m301-domain-key-authority.ts"
    // M304's generator finalizer only reorders generated constraints and adds
    // the crypto role's column-scoped SELECT grant. It does not execute or own
    // runtime crypto storage queries.
    || path ===
      "packages/db/scripts/finalize-m304-human-device-membership.ts"
    || path ===
      "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts"
    || path === "packages/lattice-bridge/scripts/run-postgres-integration.ts";
}

function isGovernanceDeclaration(path: string): boolean {
  return path.startsWith("packages/encryption-invariants/baseline/");
}

function cryptoSchemaImportNames(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names: string[] = [];
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || (
        statement.moduleSpecifier.text !== "@nautilo/db"
        && statement.moduleSpecifier.text !== "@nautilo/db/schema"
      )
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (
        imported.startsWith("crypto")
        || imported.startsWith("Crypto")
        || imported.startsWith("CRYPTO_STORAGE")
        || imported === "nautiloCryptoRole"
      ) {
        names.push(`${statement.moduleSpecifier.text}#${imported}`);
      }
    }
  }
  return names.sort();
}

export function cryptoStorageBoundaryViolations(root: string): string[] {
  const violations: string[] = [];
  for (const rootName of productRoots) {
    for (const path of walkSourceFiles(join(root, rootName))) {
      const repoPath = repositoryPath(root, path);
      if (isGovernanceDeclaration(repoPath)) continue;
      if (
        !isAllowedSchemaOwner(repoPath)
        && !isAllowedSchemaContractConsumer(repoPath)
      ) {
        for (const imported of cryptoSchemaImportNames(path)) {
          violations.push(`${repoPath} imports ${imported}`);
        }
      }
      if (
        !isAllowedSchemaOwner(repoPath)
        && !isAllowedOperationalTableReference(repoPath)
        && CRYPTO_STORAGE_TABLE_NAMES.some((table) =>
          readFileSync(path, "utf8").includes(table)
        )
      ) {
        for (const table of CRYPTO_STORAGE_TABLE_NAMES) {
          if (readFileSync(path, "utf8").includes(table)) {
            violations.push(`${repoPath} references public.${table}`);
          }
        }
      }
    }
  }
  return [...new Set(violations)].sort();
}

function writeFixture(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

describe("lattice storage ownership", () => {
  test("only bridge server repositories own crypto schema access and table SQL", () => {
    expect(cryptoStorageBoundaryViolations(repositoryRoot)).toEqual([]);
  });

  test("reports schema imports and raw table access with actionable paths", () => {
    const root = mkdtempSync(join(tmpdir(), "m231-storage-boundary-"));
    try {
      writeFixture(
        root,
        "packages/server/src/crypto.ts",
        [
          'import { cryptoObjects, CRYPTO_STORAGE_TABLE_NAMES } from "@nautilo/db/schema";',
          "void cryptoObjects;",
          "void CRYPTO_STORAGE_TABLE_NAMES;",
          'export const sql = "INSERT INTO crypto_objects DEFAULT VALUES";',
          "",
        ].join("\n"),
      );
      writeFixture(
        root,
        "packages/lattice-bridge/src/server/device/postgres-device.ts",
        [
          'import { cryptoObjects } from "@nautilo/db/schema";',
          'export const sql = "INSERT INTO crypto_objects DEFAULT VALUES";',
          "void cryptoObjects;",
          "",
        ].join("\n"),
      );
      writeFixture(
        root,
        "packages/lattice-bridge/src/client/browser/leak.ts",
        'export const sql = "SELECT * FROM crypto_objects";\n',
      );
      writeFixture(
        root,
        "packages/runtime/src/protected-execution/background-authorization/other-postgres-repository.ts",
        'export const sql = "SELECT * FROM background_crypto_authorization_requests";\n',
      );

      expect(cryptoStorageBoundaryViolations(root)).toEqual([
        "packages/lattice-bridge/src/client/browser/leak.ts references public.crypto_objects",
        "packages/runtime/src/protected-execution/background-authorization/other-postgres-repository.ts references public.background_crypto_authorization_requests",
        "packages/server/src/crypto.ts imports @nautilo/db/schema#CRYPTO_STORAGE_TABLE_NAMES",
        "packages/server/src/crypto.ts imports @nautilo/db/schema#cryptoObjects",
        "packages/server/src/crypto.ts references public.crypto_objects",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
