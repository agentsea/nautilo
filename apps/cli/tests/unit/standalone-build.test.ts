import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertEmptyStandaloneOutputDirectory,
  assertStandaloneVersionBinding,
  assertStandaloneHostPlanReceipt,
  createDeterministicArchive,
  parseExactBooleanReceipt,
  parseStandaloneBuildOptions,
  standaloneQualificationInstanceId,
} from "../../scripts/build-standalone.ts";

describe("standalone server-admin build", () => {
  test("rejects a release label that differs from the compiled CLI version", () => {
    expect(() => assertStandaloneVersionBinding("0.1.6", "0.1.5")).toThrow(
      "Standalone candidate version 0.1.6 does not match compiled CLI version 0.1.5.",
    );
    expect(() => assertStandaloneVersionBinding("0.1.6", "0.1.6")).not.toThrow();
  });
  test("qualification creates its Compose profile through the public binary", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../scripts/build-standalone.ts")).text();

    expect(source).toContain('"profile",\n      "add"');
    expect(source).toContain('"profile", "list"');
    expect(source).not.toContain('"profile", "current"');
    expect(source).not.toContain('"--host=127.0.0.1"');
    expect(source).not.toContain('"--port=3001"');
    expect(source).not.toContain('join(profiles, "qualification.toml")');
    expect(source).not.toContain('join(profiles, ".active")');
    expect(source).toContain("status expected clean absence");
    expect(source).not.toContain("status expected local HTTP failure");
    expect(source).toContain("did not inspect the isolated Compose project");
    expect(source).not.toContain("did not hand Docker the packaged Compose template path");
    expect(source).not.toContain("did not execute the packaged native host-port probe");
  });

  test("qualification isolates its Compose identity from retained developer stacks", () => {
    const first = standaloneQualificationInstanceId("/tmp/qualification-one");
    const second = standaloneQualificationInstanceId("/tmp/qualification-two");

    expect(first).toMatch(/^q-[a-f0-9]{12}$/);
    expect(first.length).toBeLessThanOrEqual(16);
    expect(second).not.toBe(first);
    expect(standaloneQualificationInstanceId("/tmp/qualification-one")).toBe(first);
  });

  test("produces byte-stable archive bytes from unordered inputs", () => {
    const entries = [
      { path: "share/nautilo/infra/postgres-init.sh", bytes: Buffer.from("init\n"), mode: 0o755 },
      { path: "bin/nautilo", bytes: Buffer.from("binary\n"), mode: 0o755 },
      { path: "artifact-manifest.json", bytes: Buffer.from("{}\n"), mode: 0o644 },
    ];
    const first = createDeterministicArchive(entries);
    const second = createDeterministicArchive([...entries].reverse());

    expect(first.equals(second)).toBe(true);
    expect(gunzipSync(first).subarray(0, 100).toString("utf8").replace(/\0+$/, "")).toBe(
      "artifact-manifest.json",
    );
  });

  test("requires an explicit output directory and only supports declared native targets", () => {
    const nativeTarget = "bun-darwin-arm64";
    expect(() => parseStandaloneBuildOptions([], nativeTarget)).toThrow(/requires --output/);
    expect(() => parseStandaloneBuildOptions(["--output", "/tmp/nautilo", "--target", "bun-linux-x64"], nativeTarget)).toThrow(
      /cross-target builds are not accepted/,
    );
    expect(() => parseStandaloneBuildOptions([
      "--output=/tmp/nautilo",
      "--source=not-a-commit",
    ], nativeTarget)).toThrow(/40-character git commit ID/);
    expect(parseStandaloneBuildOptions([
      "--output=/tmp/nautilo",
      `--target=${nativeTarget}`,
      "--version=0.1.0",
      `--source=${"e".repeat(40)}`,
    ], nativeTarget)).toEqual({
      output: "/tmp/nautilo",
      target: nativeTarget,
      version: "0.1.0",
      source: "e".repeat(40),
    });
  });

  test("refuses to place a candidate in a non-empty output directory", () => {
    const output = mkdtempSync(join(tmpdir(), "nautilo-standalone-output-"));
    try {
      writeFileSync(join(output, "existing"), "do not overwrite\n");
      expect(() => assertEmptyStandaloneOutputDirectory(output)).toThrow(/must be empty/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("accepts only exact redacted native qualification receipts", () => {
    const valid = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      platform: "darwin-arm64",
      callback: true,
      tokenRedacted: true,
    }));
    expect(() => parseExactBooleanReceipt({
      stdout: valid,
      expectedPlatform: "darwin-arm64",
      booleanFields: ["callback", "tokenRedacted"],
      label: "test",
    })).not.toThrow();
    expect(() => parseExactBooleanReceipt({
      stdout: Buffer.from(JSON.stringify({
        schemaVersion: 1,
        platform: "darwin-arm64",
        callback: true,
        tokenRedacted: true,
        authority: "must-not-pass",
      })),
      expectedPlatform: "darwin-arm64",
      booleanFields: ["callback", "tokenRedacted"],
      label: "test",
    })).toThrow(/invalid receipt/);
    expect(() => parseExactBooleanReceipt({
      stdout: valid,
      expectedPlatform: "darwin-x64",
      booleanFields: ["callback", "tokenRedacted"],
      label: "test",
    })).toThrow(/invalid receipt/);
  });

  test("requires a typed mutation-free host-plan failure and rejects provider disclosure", () => {
    const canary = "provider-secret-canary";
    const stdout = JSON.stringify({
      schemaVersion: 1,
      operation: "plan",
      backend: "railway",
      outcome: "authorization-required",
      mutationAuthorized: false,
    });
    expect(() => assertStandaloneHostPlanReceipt({
      exitCode: 2,
      stdout,
      stderr: "",
      providerCanary: canary,
    })).not.toThrow();
    expect(() => assertStandaloneHostPlanReceipt({
      exitCode: 2,
      stdout: JSON.stringify({
        schemaVersion: 1,
        operation: "plan",
        backend: "railway",
        outcome: canary,
        mutationAuthorized: false,
      }),
      stderr: "",
      providerCanary: canary,
    })).toThrow(/redacted mutation-free/);
    expect(() => assertStandaloneHostPlanReceipt({
      exitCode: 0,
      stdout,
      stderr: "",
      providerCanary: canary,
    })).toThrow(/redacted mutation-free/);
  });
});
