import { describe, test, expect } from "bun:test";
import { isExternalUnknownBinary } from "../../src/external-binary";

describe("isExternalUnknownBinary", () => {
  test.each([
    ["", false],
    ["   ", false],
  ])("empty/whitespace command → %p returns %p", (cmd, expected) => {
    expect(isExternalUnknownBinary(cmd)).toBe(expected);
  });

  describe("relative paths — flagged", () => {
    test.each([
      "./install.sh",
      "./install.sh --yes",
      "./build/run",
      "../scripts/deploy",
      "../../boho",
      "scripts/run.sh",
      "build/dist/entrypoint",
    ])("%s → external", (cmd) => {
      expect(isExternalUnknownBinary(cmd)).toBe(true);
    });
  });

  describe("home-relative paths — flagged", () => {
    test.each([
      "~/Downloads/installer",
      "~/bin/custom",
      "~/.local/bin/foo",
    ])("%s → external", (cmd) => {
      expect(isExternalUnknownBinary(cmd)).toBe(true);
    });
  });

  describe("absolute paths in non-system dirs — flagged", () => {
    test.each([
      "/tmp/installer",
      "/tmp/x.sh arg1 arg2",
      "/var/tmp/script.sh",
      "/Users/someone/code/script",
      "/home/dev/scripts/run",
      "/opt/vendor-tool/bin/run",
    ])("%s → external", (cmd) => {
      expect(isExternalUnknownBinary(cmd)).toBe(true);
    });
  });

  describe("absolute paths in system dirs — trusted", () => {
    test.each([
      "/usr/bin/git clone",
      "/usr/local/bin/node server.js",
      "/bin/sh -c 'echo hi'",
      "/sbin/ifconfig",
      "/opt/homebrew/bin/bun run dev",
      "/home/linuxbrew/.linuxbrew/bin/rg pattern",
    ])("%s → trusted", (cmd) => {
      expect(isExternalUnknownBinary(cmd)).toBe(false);
    });
  });

  describe("bare names (PATH lookup) — not flagged", () => {
    test.each([
      "git push",
      "npm install",
      "node server.js",
      "bun run dev",
      "ls -la",
      "echo hello",
      "mycustomtool",
      "custom-binary --help",
    ])("%s → not external", (cmd) => {
      expect(isExternalUnknownBinary(cmd)).toBe(false);
    });
  });

  describe("quoted first token", () => {
    test("double-quoted path flagged", () => {
      expect(isExternalUnknownBinary(`"./install.sh" --yes`)).toBe(true);
    });
    test("single-quoted path flagged", () => {
      expect(isExternalUnknownBinary(`'./install.sh' --yes`)).toBe(true);
    });
    test("quoted bare name not flagged", () => {
      expect(isExternalUnknownBinary(`"git" push`)).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("just a tilde → flagged (home marker without path)", () => {
      expect(isExternalUnknownBinary("~")).toBe(true);
    });

    test("leading whitespace is trimmed", () => {
      expect(isExternalUnknownBinary("   ./run.sh")).toBe(true);
      expect(isExternalUnknownBinary("   git status")).toBe(false);
    });

    test("no token / only quotes → not flagged", () => {
      expect(isExternalUnknownBinary("''")).toBe(false);
      expect(isExternalUnknownBinary(`""`)).toBe(false);
    });
  });

  describe("defense-in-depth normalization", () => {
    test("NFKC: fullwidth slash obfuscation is caught", () => {
      // U+FF0F FULLWIDTH SOLIDUS normalizes to "/". Someone attempting
      // to hide a relative path from the heuristic via this character
      // still gets flagged.
      expect(isExternalUnknownBinary(".\uFF0Finstall.sh")).toBe(true);
      expect(isExternalUnknownBinary("\uFF0Etmp\uFF0Fx.sh")).toBe(true); // fullwidth . and /
    });

    test("ANSI escape sequences stripped before detection", () => {
      // Leading ANSI color reset should not hide the first token.
      expect(isExternalUnknownBinary("\x1b[0m./install.sh")).toBe(true);
    });

    test("null bytes stripped", () => {
      expect(isExternalUnknownBinary("\0./install.sh")).toBe(true);
    });

    test("normalization does NOT lowercase (path case matters)", () => {
      // ~/Downloads/Installer on case-sensitive filesystems is distinct
      // from ~/downloads/installer. We flag both (home-relative) but we
      // must not silently lowercase paths.
      expect(isExternalUnknownBinary("~/Downloads/Installer.sh")).toBe(true);
      expect(isExternalUnknownBinary("/tmp/MyScript.sh")).toBe(true);
    });
  });

  describe("known bypasses — documented, intentional scope limit", () => {
    // These are called out in the file header. Tests serve as executable
    // documentation of the current scope boundary; flip expectations
    // (and expand the heuristic) when we address these in Phase 6.

    test("bash ./install.sh — first token is bash, not external (bypass)", () => {
      expect(isExternalUnknownBinary("bash ./install.sh")).toBe(false);
    });

    test("source ./foo.sh — first token is source, not external (bypass)", () => {
      expect(isExternalUnknownBinary("source ./foo.sh")).toBe(false);
    });

    test("env FOO=1 ./x.sh — first token is env, not external (bypass)", () => {
      expect(isExternalUnknownBinary("env FOO=1 ./x.sh")).toBe(false);
    });
  });
});
