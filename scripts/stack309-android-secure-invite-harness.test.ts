import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspectTokenFile,
  parseTokenFileArgument,
} from "./stack309-android-secure-invite-harness";

describe("Stack 309 Android secure invite harness", () => {
  test("accepts only a token-file path and enforces private regular files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nautilo-stack309-invite-harness-"));
    const fixture = path.join(root, "fixture");
    try {
      // This is deliberately a non-secret fixture; the test only proves file
      // custody checks and never invokes ADB or an Android receiver.
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

  test("creates only the fixed app-private directory before streaming", async () => {
    const source = await readFile(new URL("./stack309-android-secure-invite-harness.ts", import.meta.url), "utf8");
    expect(source).toContain("mkdir -p files && umask 077; cat > ${INCOMING} && mv ${INCOMING} ${STAGED}");
    expect(source).toContain('"shell",\n      "-T",');
    expect(source).toContain("keeps the pipe non-interactive while preserving stdin");
    expect(source).not.toContain('["exec-out"');
    expect(source).not.toContain("adb push");
  });
});
