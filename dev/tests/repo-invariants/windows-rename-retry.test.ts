import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

// Windows refuses a rename while a scanner, an indexer or a sync client holds
// the source or the target open. Product code and tests therefore rename
// through `renameWithWindowsRetry(Sync)` in `@nautilo/config/private-filesystem`,
// the one module that may call Node's rename directly. Injected filesystem
// ports are covered at their production wiring, which this scan sees as a call
// too. Tests are included: a test helper's bare rename fails the Windows gate
// just like product code would.

const repositoryRoot = join(import.meta.dir, "../../..");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "release",
  "reports",
  "scratch",
  "target",
  "vendor",
]);
const scanRoots = ["apps", "bin", "deploy", "dev", "packages"];
const allowedFiles = new Set([
  // The one module that may call Node's rename directly.
  "packages/config/src/private-filesystem.ts",
  // Expo's generated template reset script, kept verbatim.
  "apps/mobile/scripts/reset-project.js",
  // This scan's own fixture spells out every import form as text.
  "dev/tests/repo-invariants/windows-rename-retry.test.ts",
  // Root-level evaluation tooling without a workspace dependency on @nautilo/config.
  "dev/evals/browser-visual-grounding/capture.ts",
  // These tests probe whether Windows blocks a replacement while the code
  // under test holds the file open. That holder never lets go during the
  // call, so a retry would only wait out the deadline.
  "apps/desktop/tests/unit/binary-read-sessions.test.ts",
  "packages/server/tests/unit-isolated/connected-app-artifact-input.test.ts",
]);

const fsModule = String.raw`["'](?:node:)?fs(?:\/promises)?["']`;
const namedImport = new RegExp(String.raw`import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*${fsModule}`, "g");
const namespaceImport = new RegExp(String.raw`import\s*(?:\*\s*as\s+(\w+)|(\w+))\s+from\s*${fsModule}`, "g");
const requireNamespace = new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*${fsModule}\s*\)`, "g");
const requireNamed = new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*${fsModule}\s*\)`, "g");

function importedRenameNames(binding: string): string[] {
  return binding.split(",").flatMap((entry) => {
    const [imported, alias] = entry.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/);
    if (imported !== "rename" && imported !== "renameSync") return [];
    return [alias ?? imported];
  });
}

/** Lines that call Node's rename directly, each as `line: text`. */
function bareRenameCalls(source: string): string[] {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const match of source.matchAll(namedImport)) for (const name of importedRenameNames(match[1]!)) names.add(name);
  for (const match of source.matchAll(requireNamed)) for (const name of importedRenameNames(match[1]!)) names.add(name);
  for (const match of source.matchAll(namespaceImport)) namespaces.add(match[1] ?? match[2]!);
  for (const match of source.matchAll(requireNamespace)) namespaces.add(match[1]!);
  // `import { promises as fsp } from "node:fs"` exposes the namespace under an alias.
  for (const match of source.matchAll(namedImport)) {
    for (const entry of match[1]!.split(",")) {
      const [imported, alias] = entry.trim().split(/\s+as\s+/);
      if (imported === "promises") namespaces.add(alias ?? imported);
    }
  }
  if (names.size === 0 && namespaces.size === 0) return [];

  const patterns = [
    ...[...names].map((name) => new RegExp(String.raw`(?<![\w.$])${name}\s*\((?!\d)`)),
    ...[...namespaces].map((namespace) => new RegExp(String.raw`\b${namespace}\.(?:promises\.)?rename(?:Sync)?\s*\(`)),
  ];
  // A method or interface member named like the import opens its line and
  // continues with a body or a type; a call inside an expression does not.
  const definition = /^\s*(?:(?:public|private|protected|static|override|readonly|async)\s+)*rename(?:Sync)?\s*\([^()]*\)\s*(?:\{|:)/;
  const findings: string[] = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (definition.test(line)) return;
    if (patterns.some((pattern) => pattern.test(line))) findings.push(`${index + 1}: ${trimmed}`);
  });
  return findings;
}

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

describe("Windows rename retry", () => {
  test("the scan recognizes every import form and ignores comments, ports and method definitions", () => {
    expect(bareRenameCalls([
      'import { rename, renameSync as moveSync } from "node:fs";',
      'import * as fsp from "node:fs/promises";',
      'import nodeFs from "fs";',
      'import { promises as pfs } from "node:fs";',
      'const cjs = require("node:fs");',
      "await rename(a, b);",
      "moveSync(a, b);",
      "await fsp.rename(a, b);",
      "nodeFs.renameSync(a, b);",
      "await pfs.rename(a, b);",
      "cjs.renameSync(a, b);",
      "// rename(a, b) in a comment",
      " * uses `rename(2)` atomically",
      "deps.fs.rename(a, b);",
      "async rename(from, to) {",
      "rename(from: string, to: string): Promise<void>;",
      "const moved = ready ? rename(a, b) : null;",
    ].join("\n")).map((finding) => finding.split(":")[0])).toEqual(["6", "7", "8", "9", "10", "11", "17"]);
    expect(bareRenameCalls('import { readFile } from "node:fs/promises";\nawait rename(a, b);')).toEqual([]);
  });

  test("product code and tests rename only through renameWithWindowsRetry", () => {
    const findings: string[] = [];
    for (const root of scanRoots) {
      for (const file of walkSourceFiles(join(repositoryRoot, root))) {
        const path = relative(repositoryRoot, file).replaceAll("\\", "/");
        if (allowedFiles.has(path)) continue;
        for (const finding of bareRenameCalls(readFileSync(file, "utf8"))) findings.push(`${path}:${finding}`);
      }
    }
    expect(
      findings,
      "Call renameWithWindowsRetry or renameWithWindowsRetrySync from @nautilo/config/private-filesystem instead of Node's rename, or wire an injected filesystem port to them.",
    ).toEqual([]);
  });
});
