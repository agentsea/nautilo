import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  REVIEWED_WAVE_15_COVERAGE_ENTRIES,
} from "../../baseline/reviewed-wave-15";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("Wave 15 encryption coverage registry", () => {
  test("classifies every new writer and scope-close schema coordinate", () => {
    const writers = REVIEWED_WAVE_15_COVERAGE_ENTRIES.filter((entry) =>
      entry.locator.includes(":raw_sql:")
    );
    const schema = REVIEWED_WAVE_15_COVERAGE_ENTRIES.filter((entry) =>
      entry.locator.startsWith("public.agent_scope_close_")
      || entry.locator.startsWith("public.agent_scopes.")
    );

    expect(REVIEWED_WAVE_15_COVERAGE_ENTRIES).toHaveLength(62);
    expect(writers).toHaveLength(21);
    expect(schema).toHaveLength(41);
    expect(REVIEWED_WAVE_15_COVERAGE_ENTRIES.filter((entry) =>
      entry.classification === "protected"
    )).toHaveLength(3);
    expect(REVIEWED_WAVE_15_COVERAGE_ENTRIES.filter((entry) =>
      entry.classification === "bounded_metadata"
    )).toHaveLength(59);
    expect(new Set(
      REVIEWED_WAVE_15_COVERAGE_ENTRIES.map((entry) => entry.locator),
    ).size).toBe(REVIEWED_WAVE_15_COVERAGE_ENTRIES.length);
  });

  test("binds every declaration to checked-in behavioral evidence", () => {
    for (const entry of REVIEWED_WAVE_15_COVERAGE_ENTRIES) {
      expect(entry.testEvidence.length).toBeGreaterThan(0);
      for (const evidence of entry.testEvidence) {
        expect(existsSync(resolve(repositoryRoot, evidence))).toBeTrue();
      }
      if (entry.classification === "protected") {
        expect(entry.negativeTestEvidence.length).toBeGreaterThan(0);
        expect(entry.keyFamily).toBe("namespace_ai");
      } else {
        expect(entry.classification).toBe("bounded_metadata");
        if (entry.classification !== "bounded_metadata") {
          throw new Error("Wave 15 declaration classification widened");
        }
        expect(entry.metadataAllowlist.length).toBeGreaterThan(0);
        expect(entry.plaintextReason.length).toBeGreaterThan(0);
      }
    }
  });
});
