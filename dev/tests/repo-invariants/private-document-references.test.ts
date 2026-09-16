import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const privateRepository = /nautilo-docs/i;
const inventorySentinel = "dev/tests/repo-invariants/private-document-references.test.ts";

// Exact lines that prohibit private material. A new reference anywhere else,
// including elsewhere in these files, must fail. Hashes avoid repeating the
// forbidden text in the exception list itself.
const prohibitionLines: Readonly<Record<string, string>> = {
  "apps/desktop/scripts/package-inventory-policy.ts:b6a709e8b4c84e7fb3b55316586f56073969d915def9e340378b270267bf4705":
    "Reject private documentation in Desktop packages.",
  "dev/tests/repo-invariants/contribution-governance.test.ts:2552ae170f3acf2bb89f86cc14cd4528438401ef01607ea88e29b68460ac896e":
    "Reject private dependencies in contributor templates.",
  "dev/tests/repo-invariants/public-documentation.test.ts:18f3f0ee19b241ceff38b66af2eaeeebd9d41af029848057c910bf4cb54e0a0c":
    "Reject private paths in canonical public documents.",
  "dev/tests/repo-invariants/private-document-references.test.ts:0df44b8aad77b68e820905e935c128b505713f5f0b640373a99b2d6927ddcd0e":
    "Recognize the forbidden private repository name.",
};

function matchingLines(text: string): string[] {
  return text.split(/\r?\n/u).filter((line) => privateRepository.test(line));
}

function receiptKey(path: string, line: string): string {
  return `${path}:${createHash("sha256").update(line).digest("hex")}`;
}

function parseTrackedPaths(stdout: string): string[] {
  const paths = stdout.split("\0").filter(Boolean);
  if (!paths.includes(inventorySentinel)) {
    throw new Error(
      "private-reference scan received an empty or wrong-repository tracked-file inventory",
    );
  }
  return paths;
}

describe("private documentation references", () => {
  test("detects URLs, sibling paths, comments, and case variations", () => {
    for (const text of [
      `https://example.com/${privateRepository.source}/guide.md`,
      `../${privateRepository.source}/guide.md`,
      `// See ${privateRepository.source.toUpperCase()}/plan.md`,
    ]) {
      expect(matchingLines(text)).toEqual([text]);
      expect(prohibitionLines[receiptKey("example.ts", text)]).toBeUndefined();
    }
    expect(matchingLines("See docs/relay-host-ownership.md")).toEqual([]);
  });

  test("refuses an empty or wrong-repository tracked-file inventory", () => {
    expect(() => parseTrackedPaths("")).toThrow("empty or wrong-repository");
    expect(() => parseTrackedPaths("README.md\0")).toThrow("empty or wrong-repository");
    expect(parseTrackedPaths(`${inventorySentinel}\0README.md\0`)).toEqual([
      inventorySentinel,
      "README.md",
    ]);
  });

  test("tracked text and symlink targets contain only exact prohibition lines", () => {
    const paths = parseTrackedPaths(
      execFileSync("git", ["ls-files", "-z"], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    const seen = new Set<string>();
    const unexpected: string[] = [];
    for (const path of paths) {
      const absolute = resolve(root, path);
      // Deleted files may still be in the index during local iteration.
      if (!existsSync(absolute) && !readlinkIfPresent(absolute)) continue;
      const bytes = lstatSync(absolute).isSymbolicLink()
        ? Buffer.from(readlinkSync(absolute))
        : readFileSync(absolute);
      // Binary/media clearance is a separate audit, not a text-scan claim.
      if (bytes.includes(0)) continue;
      for (const line of matchingLines(bytes.toString("utf8"))) {
        const key = receiptKey(path, line);
        if (!prohibitionLines[key] || seen.has(key)) unexpected.push(`${path}: ${line.trim()}`);
        seen.add(key);
      }
    }
    expect(unexpected).toEqual([]);
    expect([...seen].sort()).toEqual(Object.keys(prohibitionLines).sort());
  });
});

function readlinkIfPresent(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
