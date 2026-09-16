import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertStandaloneArchiveBinding,
  createStandaloneDisclosureReport,
  evaluateStandaloneGrypeReport,
} from "../../scripts/audit-standalone.ts";

function grypeReport(matches: unknown[] = []): unknown {
  return {
    matches,
    descriptor: {
      name: "grype",
      version: "0.116.1",
      db: {
        status: {
          schemaVersion: "v6.1.9",
          from: `https://grype.invalid/db?checksum=sha256%3A${"a".repeat(64)}`,
          built: "2026-08-09T06:23:06Z",
          valid: true,
        },
      },
    },
  };
}

describe("standalone release evidence", () => {
  test("rejects archive bytes that do not match the build receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-archive-binding-"));
    try {
      const archive = join(root, "candidate.tar.gz");
      writeFileSync(archive, "candidate bytes");
      expect(assertStandaloneArchiveBinding(archive, new Bun.CryptoHasher("sha256").update("candidate bytes").digest("hex"))).toBe(archive);
      expect(() => assertStandaloneArchiveBinding(archive, "0".repeat(64))).toThrow(/does not match/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts checksum-bound Grype evidence with no high or critical findings", () => {
    const receipt = evaluateStandaloneGrypeReport(grypeReport());
    expect(receipt.passed).toBe(true);
    expect(receipt.highCriticalCount).toBe(0);
    expect(receipt.database.sourceSha256).toBe("a".repeat(64));
  });

  test("rejects high findings and mutable database identity", () => {
    expect(() => evaluateStandaloneGrypeReport(grypeReport([{
      vulnerability: { id: "CVE-1", severity: "High", fix: { versions: ["2.0.0"] } },
      artifact: { name: "fixture", version: "1.0.0" },
    }]))).toThrow(/rejects high or critical/);
    const mutable = grypeReport() as { descriptor: { db: { status: { from: string } } } };
    mutable.descriptor.db.status.from = "https://grype.invalid/latest";
    expect(() => evaluateStandaloneGrypeReport(mutable)).toThrow(/not checksum-bound/);
  });

  test("scans every bundle byte under a bounded disclosure taxonomy", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-disclosure-"));
    try {
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(join(root, "bin/nautilo"), "safe bytes\n");
      const report = createStandaloneDisclosureReport({
        bundleRoot: root,
        source: "a".repeat(40),
        platform: "darwin-arm64",
        archiveSha256: "b".repeat(64),
        forbiddenMarkers: ["/private/build/root"],
      }) as { coverage: { filesInspected: number; bytesInspected: number }; passed: boolean };
      expect(report.passed).toBe(true);
      expect(report.coverage).toEqual({ filesInspected: 1, bytesInspected: 11 });

      writeFileSync(join(root, "bin/nautilo"), "/private/build/root\n");
      expect(() => createStandaloneDisclosureReport({
        bundleRoot: root,
        source: "a".repeat(40),
        platform: "darwin-arm64",
        archiveSha256: "b".repeat(64),
        forbiddenMarkers: ["/private/build/root"],
      })).toThrow(/found prohibited material/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
