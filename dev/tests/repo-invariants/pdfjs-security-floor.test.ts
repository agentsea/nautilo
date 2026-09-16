import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedSecurityFloor = [6, 2, 108] as const;

function parseExactVersion(value: unknown): [number, number, number] {
  expect(typeof value).toBe("string");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value as string);
  expect(match).not.toBeNull();
  return [Number(match![1]), Number(match![2]), Number(match![3])];
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe("shipped PDF.js security floor", () => {
  test("pins both browser consumers to one patched release and aligns their runtime proof", async () => {
    const [mobileManifest, workbenchManifest, lockfile, exportRuntime, exportProbe] = await Promise.all([
      readFile(join(repositoryRoot, "apps/mobile/package.json"), "utf8"),
      readFile(join(repositoryRoot, "apps/workbench/package.json"), "utf8"),
      readFile(join(repositoryRoot, "bun.lock"), "utf8"),
      readFile(join(repositoryRoot, "apps/mobile/src/lib/shared-browser-viewer-runtime/pdf.web.ts"), "utf8"),
      readFile(join(repositoryRoot, "apps/mobile/scripts/shared-browser-viewer-export-probe.ts"), "utf8"),
    ]);
    const mobileVersion = (JSON.parse(mobileManifest) as { dependencies?: Record<string, unknown> })
      .dependencies?.["pdfjs-dist"];
    const workbenchVersion = (JSON.parse(workbenchManifest) as { dependencies?: Record<string, unknown> })
      .dependencies?.["pdfjs-dist"];

    expect(mobileVersion).toBe(workbenchVersion);
    expect(compareVersions(parseExactVersion(mobileVersion), auditedSecurityFloor)).toBeGreaterThanOrEqual(0);
    expect(lockfile).toContain(`"pdfjs-dist": "${mobileVersion}"`);
    expect(lockfile).toContain(`"pdfjs-dist": ["pdfjs-dist@${mobileVersion}"`);
    expect(exportRuntime).toContain(`pdfjs-dist@${mobileVersion}:WorkerMessageHandler`);
    expect(exportProbe).toContain(`const PDF_VERSION = "${mobileVersion}";`);
  });
});
