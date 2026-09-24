import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { limitAuditPaths } from "../../src/node/storage";

const packageRoot = resolve(import.meta.dir, "../..");
const paths = limitAuditPaths(packageRoot);

const canonicalArtifacts = [
  paths.legacyLock,
  paths.legacy,
  paths.inventory,
  paths.decisions,
  paths.investigationMap,
  paths.matrix,
  paths.scout,
];

function expectNoMatch(contents: string, pattern: RegExp, path: string, label: string): void {
  const match = contents.match(pattern);
  expect(match?.[0] ?? null, `${path} contains ${label}`).toBeNull();
}

describe("public limit audit artifacts", () => {
  test("are present at stable tracked paths without private provenance or personal data", async () => {
    for (const path of canonicalArtifacts) {
      const contents = await readFile(path, "utf8");
      expect(contents.length, path).toBeGreaterThan(0);
      expectNoMatch(contents, /\b(?:ISSUE-)?[MD]\d{3}(?![A-Za-z0-9])/u, path, "a private planning identifier");
      expectNoMatch(contents, /(?:^|["'\s])\/(?:Users|home)\/[A-Za-z0-9._-]+\//mu, path, "a workstation user path");
      expectNoMatch(contents, /\b[A-Z0-9._%+-]+@[A-Z][A-Z0-9.-]*\.[A-Z]{2,}\b/iu, path, "an email address");
      expect(contents, path).not.toContain(["nautilo", "docs/"].join("-"));
      expectNoMatch(contents, /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, path, "private key material");
    }
  });
});
