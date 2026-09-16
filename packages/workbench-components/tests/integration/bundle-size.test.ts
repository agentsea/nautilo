import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("runtime bundle", () => {
  it("dist/runtime.js exists and gzip size is <= 80 KiB", () => {
    const filePath = path.join(rootDir, "dist", "runtime.js");
    const buf = readFileSync(filePath);
    expect(buf.length).toBeGreaterThan(100);
    const gz = gzipSync(buf);
    expect(gz.length).toBeLessThanOrEqual(80 * 1024);
  });
});
