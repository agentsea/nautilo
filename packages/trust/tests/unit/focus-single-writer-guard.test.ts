import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");

const SOURCE_ROOTS = [
  "packages/runtime/src",
  "packages/trust/src",
  "packages/server/src",
  "packages/agent/src",
].map((rel) => path.join(REPO_ROOT, rel));

const FOCUS_WRITER_IMPORT = /from\s+["'][^"']*focus\/writer["']/;
const FOCUS_RELATIVE_WRITER = /from\s+["']\.\/writer["']/;

/** Paths or patterns that may import focus/writer (substring or RegExp on full path). */
const ALLOW_LIST: Array<string | RegExp> = [
  path.join(REPO_ROOT, "packages/trust/src/focus/writer.ts"),
  path.join(REPO_ROOT, "packages/trust/src/focus/index.ts"),
  path.join(REPO_ROOT, "packages/trust/src/focus/read.ts"),
  path.join(REPO_ROOT, "packages/trust/src/index.ts"),
  /packages\/runtime\/src\/conductor\//,
  /packages\/server\/src\/.*focus/i,
];

function isAllowed(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join("/");
  if (normalized.includes("/tests/") || normalized.endsWith(".test.ts")) {
    return true;
  }
  for (const rule of ALLOW_LIST) {
    if (typeof rule === "string") {
      if (filePath === rule || normalized.includes(rule.split(path.sep).join("/"))) {
        return true;
      }
    } else if (rule.test(normalized)) {
      return true;
    }
  }
  return false;
}

function walkTsFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

function importsFocusWriter(filePath: string, content: string): boolean {
  if (FOCUS_WRITER_IMPORT.test(content)) return true;
  const normalized = filePath.split(path.sep).join("/");
  if (normalized.includes("focus") && FOCUS_RELATIVE_WRITER.test(content)) {
    return true;
  }
  return false;
}

describe("focus single-writer guard", () => {
  test("repo root resolves to monorepo with packages/", () => {
    expect(fs.existsSync(PACKAGE_JSON)).toBe(true);
    expect(fs.existsSync(PACKAGES_DIR)).toBe(true);
  });

  test("only allow-listed modules import focus/writer", () => {
    const offenders: string[] = [];

    for (const root of SOURCE_ROOTS) {
      const files: string[] = [];
      walkTsFiles(root, files);
      for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        if (!importsFocusWriter(file, content)) continue;
        if (!isAllowed(file)) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }

    if (offenders.length > 0) {
      console.error(
        "Files import focus/writer but are not on the allow-list:\n",
        offenders.join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});
