import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVulnerabilityPolicy } from "./vulnerability-policy.ts";

const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));
const historical = read("fixtures/server-vulnerability-exceptions-2026-09-11.json");
const current = read("server-vulnerability-exceptions.input.json");
const bootstrap = read("bootstrap-vulnerability-policy.input.json");
const review = read("fixtures/debian-security-review-2026-09-13.json") as {
  packages: { package: string; previousVersion: string; candidates: Record<string, { version: string }[]>;
    advisories: { id: string; status: string; fixedVersion: string | null }[] }[];
};

describe("Debian 13 security update and exception retirement", () => {
  test("reviews every previous package and CVE against both supported architecture indexes", () => {
    expect(review.packages).toHaveLength(30);
    const reviewed = review.packages.flatMap((p) => p.advisories.map((a) => `${p.package}/${p.previousVersion}/${a.id}`));
    const previous = historical.exceptions.map((e: { packageName: string; installedVersion: string; advisoryId: string }) => `${e.packageName}/${e.installedVersion}/${e.advisoryId}`);
    expect(new Set(reviewed)).toEqual(new Set(previous));
    for (const p of review.packages) {
      expect(p.candidates.amd64!.map((c) => c.version)).toEqual(p.candidates.arm64!.map((c) => c.version));
    }
  });

  test("removes all supported fixed decisions and retains only reviewed open advisory identities", () => {
    let fixed = 0;
    for (const p of review.packages) {
      for (const a of p.advisories) {
        const matches = current.exceptions.filter((e: { packageName: string; advisoryId: string }) => e.packageName === p.package && e.advisoryId === a.id);
        if (a.status === "resolved") {
          expect(a.fixedVersion).toBeTruthy();
          expect(matches).toEqual([]);
          fixed++;
        } else {
          expect(matches.length).toBeGreaterThan(0);
        }
      }
    }
    expect(fixed).toBe(27); // 28 old decisions: one advisory had two scanner severity identities.
    expect(current.exceptions).toHaveLength(232);
    expect(bootstrap.exceptions).toHaveLength(1);
    expect(bootstrap.exceptions[0]).toMatchObject({ advisoryId: "CVE-2026-5435", installedVersion: "2.41-12+deb13u4" });
  });

  test("remaining decisions match reviewed package versions and production schema", () => {
    const floors = new Map(readFileSync(join(import.meta.dir, "server-security-package-floors.txt"), "utf8")
      .split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(" ") as [string, string]));
    expect(floors.size).toBe(7);
    for (const entry of current.exceptions) {
      const p = review.packages.find((p) => p.package === entry.packageName)!;
      expect(entry.installedVersion).toBe(floors.get(entry.packageName) ?? p.previousVersion);
    }
    for (const policy of [current, bootstrap]) {
      expect(() => parseVulnerabilityPolicy(JSON.stringify({ version: 1, ...policy, binding: {
        image: { digest: `sha256:${"a".repeat(64)}`, reference: `ghcr.io/agentsea/nautilo-runtime@sha256:${"a".repeat(64)}` },
        architecture: "linux/arm64", databases: { grype: "b".repeat(64), trivy: "c".repeat(64) },
      } }))).not.toThrow();
    }
  });
});
