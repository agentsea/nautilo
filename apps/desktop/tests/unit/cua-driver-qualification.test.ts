import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertQualificationTree, validateQualificationSource } from "../../scripts/build-qualification-cua-driver";
import { vendorForPackaging } from "../../scripts/vendor-cua-driver";

const root = resolve(import.meta.dir, "../../cua-driver/qualification");
const source: unknown = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const patch = readFileSync(resolve(root, "setup-controls.patch"));
const license = readFileSync(resolve(root, "LICENSE.md"));

test("source export retains the exact pinned upstream MIT license beside the patch", () => {
  const expectedSha256 = "c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9";
  expect(createHash("sha256").update(license).digest("hex")).toBe(expectedSha256);
  expect((source as { upstreamLicense?: unknown }).upstreamLicense).toEqual({
    path: "LICENSE.md",
    sha256: expectedSha256,
    source: "https://github.com/trycua/cua/blob/e88e9d899ac5effaeae38619527ebaa46b26ce72/LICENSE.md",
  });
});

test("tester patch preserves every source check", () => {
  const version = "0.0.0-dev";
  const result = validateQualificationSource(source, patch, version);
  expect(result.kind).toBe("qualification-source-patch");
  expect(result.productionPackaging).toBe(false);
  expect(result.effectiveTree).toBe("8baadfc06903fd0be9af4fac637a04f519ed4a45");
  expect(result.patchSha256).toBe("eb4e353ea14cc1d16a38e3c80eba4389468a6b09e9f4648b32bce231a49b225e");
  expect(result.upstreamContribution).toEqual({
    url: "https://github.com/trycua/cua/pull/3404",
    commit: "ad79aa13eb06a52c13cc21a0a87c8cc80d389dd1",
    author: "Zane Chee (injaneity)",
    adaptation: "Original checkbox reader preserved; numeric state comparison tightened to exact zero or one. Native control identity repair is additional work.",
  });
  expect(() => validateQualificationSource(source, Buffer.concat([patch, Buffer.from("tamper")]), version)).toThrow("checksum");
  expect(() => validateQualificationSource({ ...result, baseRevision: "main" }, patch, version)).toThrow("identity");
  expect(() => validateQualificationSource({ ...result, rustToolchain: "stable" }, patch, version)).toThrow("identity");
  expect(() => validateQualificationSource({ ...result, upstreamContribution: null }, patch, version)).toThrow("provenance");
  expect(() => assertQualificationTree(result.effectiveTree, "8baadfc06903fd0be9af4fac637a04f519ed4a45")).not.toThrow();
  expect(() => assertQualificationTree("different", result.effectiveTree)).toThrow("reviewed source");
});

test("checked-in empty-value repair cannot enter production packaging", () => {
  expect(() => validateQualificationSource(source, patch, "0.14.40")).toThrow("qualification-only");
  expect(patch.toString()).toContain("elements_preserve_empty_ax_value_without_inventing_missing_value");
});

test("explicit promotion still requires matching source bytes", () => {
  const tester = validateQualificationSource(source, patch, "0.0.0-dev");
  const promoted = { ...tester, productionPackaging: true };
  expect(validateQualificationSource(promoted, patch, "0.14.40").productionPackaging).toBe(true);
  expect(() => validateQualificationSource(promoted, Buffer.from("changed"), "0.14.40")).toThrow("checksum");
});

test("an unpromoted patch still refuses production packaging without a stock fallback", async () => {
  const reviewed = validateQualificationSource(source, patch, "0.0.0-dev");
  const unpromoted = { ...reviewed, productionPackaging: false };
  expect(validateQualificationSource(unpromoted, patch, "0.0.0-dev").productionPackaging).toBe(false);
  for (const approval of [false, undefined, "true"]) {
    expect(() => validateQualificationSource({ ...unpromoted, productionPackaging: approval }, patch, "0.14.40")).toThrow("qualification-only");
  }
  let released = false;
  const failure: unknown = await vendorForPackaging({
    qualification: true,
    buildQualification: async () => { validateQualificationSource(unpromoted, patch, "0.14.40"); },
    buildRelease: async () => { released = true; },
  }).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("qualification-only");
  expect(released).toBe(false);
});

test("failed qualification never silently consumes the released driver", async () => {
  let releases = 0;
  let failure: unknown;
  try {
    await vendorForPackaging({
      qualification: true,
      buildQualification: async () => { throw new Error("patch/build failure"); },
      buildRelease: async () => { releases++; },
    });
  } catch (error) { failure = error; }
  expect(failure).toEqual(new Error("patch/build failure"));
  expect(releases).toBe(0);
});

test("packaging selects exactly one declared driver source", async () => {
  const calls: string[] = [];
  const buildQualification = async (): Promise<void> => { calls.push("patched"); };
  const buildRelease = async (): Promise<void> => { calls.push("released"); };
  await vendorForPackaging({ qualification: true, buildQualification, buildRelease });
  await vendorForPackaging({ qualification: false, buildQualification, buildRelease });
  expect(calls).toEqual(["patched", "released"]);
});
