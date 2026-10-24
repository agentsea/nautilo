import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  decisions,
  evaluateAudit,
  review,
  validateReview,
  verifyCandidate,
} from "../../scripts/openmls-audit-policy.ts";

const registry = "registry+https://github.com/rust-lang/crates.io-index";
function fixture() {
  return {
    database: { "last-commit": "a".repeat(40) },
    settings: {
      ignore: [],
      target_arch: [],
      target_os: [],
      severity: null,
      informational_warnings: ["unmaintained", "unsound", "notice"],
    },
    vulnerabilities: {
      found: true,
      count: decisions.length,
      list: decisions.map((entry) => ({
        advisory: {
          id: entry.id,
          package: entry.name,
          withdrawn: null,
          cvss: entry.cvss,
          informational: null,
        },
        package: {
          name: entry.name,
          version: entry.version,
          checksum: entry.checksum,
          source: registry,
          replace: null,
        },
        versions: { patched: [...entry.patched], unaffected: [] as string[] },
      })),
    },
    warnings: {
      unmaintained: [
        [
          "RUSTSEC-2024-0384",
          "instant",
          "0.1.13",
          "e0242819d153cba4b4b05a5a8f2a7e9bbf97b6055b2a002b395c96b5ff3c0222",
        ],
        [
          "RUSTSEC-2026-0210",
          "libcrux-aesgcm",
          "0.0.7",
          "99f2a019dab4097585a7d4f5b9deebe46cd1e628b16a5bc4cb0ce35e1da334e6",
        ],
        [
          "RUSTSEC-2026-0173",
          "proc-macro-error2",
          "2.0.1",
          "11ec05c52be0a07b08061f7dd003e7d7092e0472bc731b4af7bb1ef876109802",
        ],
      ].map(([id, name, version, checksum]) => ({
        kind: "unmaintained",
        advisory: {
          id,
          package: name,
          withdrawn: null,
          cvss: null,
          informational: "unmaintained",
        },
        package: { name, version, checksum, source: registry, replace: null },
        versions: { patched: [], unaffected: [] },
      })),
    },
  };
}

describe("exact expiring OpenMLS risk decisions", () => {
  test("retains all nine findings and three visible warnings without mutating raw input", () => {
    const report = fixture();
    const before = JSON.stringify(report);
    const result = evaluateAudit(report);
    expect(result.exceptions).toEqual(decisions.map((entry) => entry.id));
    expect(result.visibleWarnings).toHaveLength(3);
    expect(JSON.stringify(report)).toBe(before);
  });

  test("requires exact current wrapper, manifest, lock and WASM bytes", () => {
    const hashes: Record<string, string> = {};
    for (const [path, expected] of Object.entries(review.hashes)) {
      const actual = createHash("sha256")
        .update(readFileSync(new URL(`../../${path}`, import.meta.url)))
        .digest("hex");
      expect(actual).toBe(expected);
      hashes[path] = actual;
    }
    expect(() =>
      validateReview(new Date(review.reviewedAt), hashes),
    ).not.toThrow();
    for (const path of Object.keys(hashes)) {
      expect(() =>
        validateReview(new Date(review.reviewedAt), {
          ...hashes,
          [path]: "0".repeat(64),
        }),
      ).toThrow("bytes changed");
    }
  });

  test("fails at the exact expiry, before review, or for invalid time", () => {
    for (const now of [
      new Date(review.expiresAt),
      new Date(Date.parse(review.reviewedAt) - 1),
      new Date(NaN),
    ]) {
      expect(() => validateReview(now, { ...review.hashes })).toThrow(
        "expired or not yet valid",
      );
    }
  });

  test("rejects every newly reported, duplicate or removed finding", () => {
    const added = fixture();
    added.vulnerabilities.list.push({
      ...added.vulnerabilities.list[0]!,
      advisory: {
        ...added.vulnerabilities.list[0]!.advisory,
        id: "RUSTSEC-2099-0001",
      },
    });
    added.vulnerabilities.count++;
    expect(() => evaluateAudit(added)).toThrow("Unreviewed");
    const duplicate = fixture();
    duplicate.vulnerabilities.list.push(duplicate.vulnerabilities.list[0]!);
    duplicate.vulnerabilities.count++;
    expect(() => evaluateAudit(duplicate)).toThrow("duplicate");
    const missing = fixture();
    missing.vulnerabilities.list.pop();
    missing.vulnerabilities.count--;
    expect(() => evaluateAudit(missing)).toThrow("Unused exception");
  });

  test.each(["version", "checksum", "source", "name"] as const)(
    "rejects a changed package %s",
    (field) => {
      const report = fixture();
      report.vulnerabilities.list[0]!.package[field] = "changed";
      expect(() => evaluateAudit(report)).toThrow();
    },
  );

  test("does not downgrade raw severity, fixability or unaffected ranges", () => {
    const severity = fixture();
    severity.vulnerabilities.list[0]!.advisory.cvss = "changed";
    expect(() => evaluateAudit(severity)).toThrow("Changed Rust finding");
    const fixed = fixture();
    fixed.vulnerabilities.list[0]!.versions.patched = [">=0.5.6"];
    expect(() => evaluateAudit(fixed)).toThrow("Changed Rust finding");
    const unaffected = fixture();
    unaffected.vulnerabilities.list[0]!.versions.unaffected = ["=0.5.5"];
    expect(() => evaluateAudit(unaffected)).toThrow("unaffected range");
  });

  test("rejects filtered, inconsistent, absent or malformed scanner reports", () => {
    for (const input of [null, {}, { vulnerabilities: [] }])
      expect(() => evaluateAudit(input)).toThrow();
    const filtered = fixture();
    Object.assign(filtered.settings, { ignore: [decisions[0]!.id] });
    expect(() => evaluateAudit(filtered)).toThrow("complete lock");
    const severity = fixture();
    Object.assign(severity.settings, { severity: 7 });
    expect(() => evaluateAudit(severity)).toThrow("every severity");
    const target = fixture();
    Object.assign(target.settings, { target_arch: ["wasm32"] });
    expect(() => evaluateAudit(target)).toThrow("complete lock");
    const count = fixture();
    count.vulnerabilities.count--;
    expect(() => evaluateAudit(count)).toThrow("count mismatch");
    const found = fixture();
    found.vulnerabilities.found = false;
    expect(() => evaluateAudit(found)).toThrow("found flag");
  });

  test("keeps warnings visible and rejects new or changed warnings", () => {
    const report = fixture();
    report.warnings.unmaintained[0]!.advisory.id = "RUSTSEC-2099-0002";
    expect(() => evaluateAudit(report)).toThrow("Unreviewed");
    const missing = fixture();
    missing.warnings.unmaintained.pop();
    expect(() => evaluateAudit(missing)).toThrow("Missing reviewed warning");
    expect(() =>
      evaluateAudit({ ...fixture(), warnings: { unsound: [] } }),
    ).toThrow("category");
  });
});

describe("fresh supported-compatible candidates", () => {
  const release = (vers: string, yanked = false) =>
    JSON.stringify({
      name: "crypto-bigint",
      vers,
      yanked,
      cksum: "a".repeat(64),
    });
  test("retains the complete index hash and uses semantic order, not index order", () => {
    const raw = [release("0.7.6"), release("0.5.5"), release("0.5.4")].join(
      "\n",
    );
    expect(verifyCandidate(raw, "crypto-bigint", "^0.5", "0.5.5")).toBe(
      createHash("sha256").update(raw).digest("hex"),
    );
  });
  test("fails when a newer compatible candidate is published", () => {
    expect(() =>
      verifyCandidate(
        [release("0.5.5"), release("0.5.6")].join("\n"),
        "crypto-bigint",
        "^0.5",
        "0.5.5",
      ),
    ).toThrow("patch or review required");
  });
  test("fails if the reviewed candidate is yanked or metadata is malformed", () => {
    for (const raw of [
      release("0.5.5", true),
      "",
      "{}",
      "not json",
      release("0.5.5").replace("crypto-bigint", "other"),
    ]) {
      expect(() =>
        verifyCandidate(raw, "crypto-bigint", "^0.5", "0.5.5"),
      ).toThrow();
    }
  });
  test("does not mistake an incompatible patch for a compatible update", () => {
    const raw = [release("0.0.7"), release("0.0.10")].join("\n");
    expect(() =>
      verifyCandidate(raw, "crypto-bigint", "^0.0.7", "0.0.7"),
    ).not.toThrow();
  });
});
