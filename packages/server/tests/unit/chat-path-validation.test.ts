/**
 * D079 Phase 2 — `validateClientPath` unit tests.
 *
 * Tests the server-side path-validation helper that runs on the
 * `/api/chat` route before `currentFolder` / `workspacePath` enter
 * agent state. The pre-model side has its own sanitizer (strips
 * control chars before prompt injection); this layer is the
 * fail-closed first line: reject bad shapes with a clear error so
 * the agent state never sees them at all.
 */

import { describe, test, expect } from "bun:test";
import { validateClientPath, validateClientPathSafe } from "../../src/messaging/attachments";

describe("validateClientPath (D079 Phase 2)", () => {
  test("null / undefined / empty string → null (absence is legit)", () => {
    expect(validateClientPath(null, "currentFolder")).toBe(null);
    expect(validateClientPath(undefined, "currentFolder")).toBe(null);
    expect(validateClientPath("", "currentFolder")).toBe(null);
    expect(validateClientPath("   ", "currentFolder")).toBe(null);
  });

  test("valid POSIX absolute path passes through trimmed", () => {
    expect(validateClientPath("/Users/john-user/code", "currentFolder")).toBe("/Users/john-user/code");
    expect(validateClientPath("  /Users/john-user/code  ", "currentFolder")).toBe("/Users/john-user/code");
  });

  test("valid Windows absolute path passes through trimmed", () => {
    expect(validateClientPath("C:\\Users\\john-user\\code", "currentFolder")).toBe("C:\\Users\\john-user\\code");
    expect(validateClientPath("C:/Users/john-user/code", "currentFolder")).toBe("C:/Users/john-user/code");
  });

  test("relative path rejected with clear error", () => {
    expect(() => validateClientPath("relative/path", "currentFolder")).toThrow(
      /must be an absolute path/,
    );
    expect(() => validateClientPath("./foo", "currentFolder")).toThrow(
      /must be an absolute path/,
    );
    expect(() => validateClientPath("../../../etc/passwd", "currentFolder")).toThrow(
      /must be an absolute path/,
    );
  });

  test("non-string input rejected", () => {
    expect(() => validateClientPath(123 as unknown as string, "currentFolder")).toThrow(
      /must be a string/,
    );
    expect(() => validateClientPath({} as unknown as string, "currentFolder")).toThrow(
      /must be a string/,
    );
  });

  test("control characters rejected (fail-closed at the route)", () => {
    expect(() => validateClientPath("/path/with\nnewline", "currentFolder")).toThrow(
      /control characters/,
    );
    expect(() => validateClientPath("/path/with\u0000null", "currentFolder")).toThrow(
      /control characters/,
    );
    expect(() => validateClientPath("/path/with\ttab", "currentFolder")).toThrow(
      /control characters/,
    );
  });

  test("system-path blocklist fires on known dangerous roots", () => {
    expect(() => validateClientPath("/etc/passwd", "currentFolder")).toThrow(
      /protected system path/,
    );
    expect(() => validateClientPath("/etc/", "currentFolder")).toThrow(
      /protected system path/,
    );
    expect(() => validateClientPath("/etc", "currentFolder")).toThrow(
      /protected system path/,
    );
    expect(() => validateClientPath("/var/root/secret", "currentFolder")).toThrow(
      /protected system path/,
    );
    expect(() => validateClientPath("/System/Library/Foo", "currentFolder")).toThrow(
      /protected system path/,
    );
    expect(() => validateClientPath("/private/etc/passwd", "currentFolder")).toThrow(
      /protected system path/,
    );
    expect(() => validateClientPath("C:\\Windows\\System32", "currentFolder")).toThrow(
      /protected system path/,
    );
    expect(() => validateClientPath("C:/Windows/System32", "currentFolder")).toThrow(
      /protected system path/,
    );
  });

  test("paths that look like blocked roots but are under user territory are OK", () => {
    // `/etc-notes` isn't under `/etc/` — only exact or prefix matches block
    expect(validateClientPath("/etc-notes", "currentFolder")).toBe("/etc-notes");
    // `/Users/etc` is fine — the blocklist is prefix-based on absolute roots
    expect(validateClientPath("/Users/etc", "currentFolder")).toBe("/Users/etc");
  });

  test("D304 — macOS /System/Volumes/Data user space is NOT a protected path", () => {
    // ~/Documents resolves to a firmlinked /System/Volumes/Data/... path on
    // modern macOS — that's normal user space, must pass through.
    expect(validateClientPath("/System/Volumes/Data/Data/Documents", "currentFolder")).toBe(
      "/System/Volumes/Data/Data/Documents",
    );
    expect(
      validateClientPath("/System/Volumes/Data/Users/john-user/Downloads", "currentFolder"),
    ).toBe("/System/Volumes/Data/Users/john-user/Downloads");
    // ...but a genuine /System/Library path is still blocked.
    expect(() => validateClientPath("/System/Library/Foo", "currentFolder")).toThrow(
      /protected system path/,
    );
  });

  test("label is threaded into error messages so client knows which field failed", () => {
    expect(() => validateClientPath("relative", "workspacePath")).toThrow(/workspacePath/);
    expect(() => validateClientPath("relative", "currentFolder")).toThrow(/currentFolder/);
  });

  test("D304 — validateClientPathSafe never throws: drops bad/blocked to null, passes valid", () => {
    // Advisory prompt-context paths must never block a message.
    expect(validateClientPathSafe("/etc/passwd", "currentFolder")).toBe(null);
    expect(validateClientPathSafe("relative/path", "currentFolder")).toBe(null);
    expect(validateClientPathSafe("/path/with\nnewline", "currentFolder")).toBe(null);
    expect(validateClientPathSafe(123 as unknown as string, "currentFolder")).toBe(null);
    expect(validateClientPathSafe(null, "currentFolder")).toBe(null);
    // Valid paths still pass through.
    expect(validateClientPathSafe("/Users/john/code", "currentFolder")).toBe("/Users/john/code");
    expect(validateClientPathSafe("/System/Volumes/Data/Data/Documents", "currentFolder")).toBe(
      "/System/Volumes/Data/Data/Documents",
    );
  });

  test("error messages are bounded so a long bad path doesn't blow up the log line", () => {
    const huge = "x".repeat(500);
    expect(() => validateClientPath(huge, "currentFolder")).toThrow(
      /must be an absolute path/,
    );
    try {
      validateClientPath(huge, "currentFolder");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 80 char preview + trailing ellipsis in the spec; verify the
      // full 500-char input doesn't get echoed back.
      expect(msg.length).toBeLessThan(200);
    }
  });
});
