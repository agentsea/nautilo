import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  resolveDownloadTarget,
  sanitizeDownloadFilename,
} from "../../electron/download-target";

describe("sanitizeDownloadFilename", () => {
  test("strips directory components", () => {
    expect(sanitizeDownloadFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadFilename("a\\b\\c.pdf")).toBe("c.pdf");
  });

  test("replaces path-hostile characters", () => {
    expect(sanitizeDownloadFilename('re:po"rt<>.txt')).toBe("re_po_rt__.txt");
  });

  test("drops leading dots and falls back to 'download'", () => {
    expect(sanitizeDownloadFilename(".bashrc")).toBe("bashrc");
    expect(sanitizeDownloadFilename("   ")).toBe("download");
    expect(sanitizeDownloadFilename("")).toBe("download");
  });
});

describe("resolveDownloadTarget", () => {
  const dir = "/downloads";

  test("returns dir/name when nothing collides", () => {
    expect(resolveDownloadTarget(dir, "file.pdf", () => false)).toBe(
      path.join(dir, "file.pdf"),
    );
  });

  test("inserts ' (n)' before the extension on collision", () => {
    const taken = new Set([
      path.join(dir, "file.pdf"),
      path.join(dir, "file (1).pdf"),
    ]);
    expect(resolveDownloadTarget(dir, "file.pdf", (c) => taken.has(c))).toBe(
      path.join(dir, "file (2).pdf"),
    );
  });

  test("handles extensionless names", () => {
    const taken = new Set([path.join(dir, "README")]);
    expect(resolveDownloadTarget(dir, "README", (c) => taken.has(c))).toBe(
      path.join(dir, "README (1)"),
    );
  });

  test("sanitizes before resolving", () => {
    expect(resolveDownloadTarget(dir, "/tmp/evil.bin", () => false)).toBe(
      path.join(dir, "evil.bin"),
    );
  });
});
