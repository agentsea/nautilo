import { describe, test, expect } from "bun:test";
import { validateGenieLiveV1 } from "../../src/semantic/validate";
import { canonicalJson, computeRecordHash, computeSemanticRoot } from "../../src/canonical";
import { FORBIDDEN_FIELD_NAMES } from "../../src/semantic/types";
import { validGenieLiveV1, buildValidFramesAndManifest } from "../fixtures/valid";

type HashManifest = {
  readonly records: readonly { readonly sha256: string }[];
};

function parseJson(json: string): unknown {
  return JSON.parse(json) as unknown;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isHashManifest(value: unknown): value is HashManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const records = (value as Record<string, unknown>)["records"];
  return isUnknownArray(records) && records.every((record) =>
    typeof record === "object" &&
    record !== null &&
    !Array.isArray(record) &&
    typeof (record as Record<string, unknown>)["sha256"] === "string"
  );
}

describe("round-trip parse/serialize validation", () => {
  test("valid fixture serializes, parses, and re-validates", () => {
    const serialized = canonicalJson(validGenieLiveV1);
    const parsed = parseJson(serialized);
    expect(validateGenieLiveV1(parsed).ok).toBe(true);
  });

  test("per-record hashes are stable across serialize/parse round-trip", () => {
    const before = validGenieLiveV1.records.map((r) => computeRecordHash(r));
    const parsed = JSON.parse(canonicalJson(validGenieLiveV1)) as typeof validGenieLiveV1;
    const after = parsed.records.map((r) => computeRecordHash(r));
    expect(after).toEqual(before);
  });

  test("semantic root is stable across serialize/parse round-trip", () => {
    const { manifest } = buildValidFramesAndManifest();
    const rootBefore = computeSemanticRoot(manifest.records.map((r) => r.sha256));
    const parsedManifest = parseJson(canonicalJson(manifest));
    expect(isHashManifest(parsedManifest)).toBe(true);
    if (!isHashManifest(parsedManifest)) {
      throw new Error("canonical manifest did not retain record hashes");
    }
    const rootAfter = computeSemanticRoot(parsedManifest.records.map((r) => r.sha256));
    expect(rootAfter).toBe(rootBefore);
  });
});

describe("no secret / ID leak invariant", () => {
  test("serialized valid fixture contains no forbidden field names", () => {
    const serialized = canonicalJson(validGenieLiveV1);
    for (const name of FORBIDDEN_FIELD_NAMES) {
      expect(serialized).not.toContain(`"${name}"`);
    }
  });

  test("serialized fixture contains no source-filesystem paths", () => {
    const serialized = canonicalJson(validGenieLiveV1);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("/home/");
    expect(serialized).not.toContain("\\\\");
  });
});
