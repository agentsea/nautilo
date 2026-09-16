import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

describe("shared package boundary", () => {
  test("does not import CLI presentation, browser, process, or keyring modules", async () => {
    const sourceRoot = join(import.meta.dir, "../../src");
    const sources = await Promise.all(
      (await readdir(sourceRoot))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => readFile(join(sourceRoot, name), "utf8")),
    );
    const combined = sources.join("\n");
    for (const forbidden of [
      "apps/cli", "@nautilo/cli-auth", "@napi-rs/keyring", "yargs",
      "process.stdout", "process.stderr", "process.exit", "process.on(",
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });
});
