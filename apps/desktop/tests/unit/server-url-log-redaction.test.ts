import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("desktop server URL log redaction", () => {
  test("never writes first-run server URLs or parsing details to the rotating log", async () => {
    const source = await readFile(
      resolve(import.meta.dir, "../../electron/main.ts"),
      "utf8",
    );

    expect(source).not.toContain('canonicalized server URL "${userInput}"');
    expect(source).not.toContain('canonicalize failed for "${userInput}"');
    expect(source).not.toContain("server-declared: ${declared");
    expect(source).not.toContain("persisting verbatim: ${String(err)}");
  });
});
