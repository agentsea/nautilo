import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("Writer canvas scroll ownership", () => {
  test("keeps Wafflebase's mount viewport-bounded for long documents", async () => {
    const css = await readFile(join(import.meta.dir, "../styles.css"), "utf8");

    expect(css).toMatch(/\.writer-canvas\s*\{[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(
      /\.writer-canvas__editor\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s,
    );
  });
});
