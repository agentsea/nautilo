/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  inspectTokenFile,
  parseTokenFileArgument,
} from "./stack309-ios-secure-invite-harness";

describe("Stack 309 iOS Simulator secure invite harness", () => {
  test("accepts only a token-file path and enforces private regular files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nautilo-stack309-ios-invite-harness-"));
    const fixture = path.join(root, "fixture");
    try {
      // Deliberately non-secret: proves only local file-custody admission.
      await writeFile(fixture, "non-secret test fixture", { mode: 0o600 });
      await chmod(fixture, 0o600);
      expect(parseTokenFileArgument(["--token-file", fixture])).toBe(fixture);
      expect(() => parseTokenFileArgument(["--token-file", fixture, "unexpected"])).toThrow();
      expect(() => parseTokenFileArgument(["--token", fixture])).toThrow();
      expect(() => inspectTokenFile(fixture)).not.toThrow();
      await chmod(fixture, 0o644);
      expect(() => inspectTokenFile(fixture)).toThrow("mode 0600");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
