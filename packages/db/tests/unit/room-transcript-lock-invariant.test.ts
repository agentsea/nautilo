import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

describe("M219 production Room transcript lock invariant", () => {
  test("every direct production session_messages writer acquires the shared Room lock", () => {
    const glob = new Bun.Glob("packages/*/src/**/*.ts");
    const writers = [...glob.scanSync({ cwd: REPO_ROOT })]
      .filter((path) => {
        const source = readFileSync(resolve(REPO_ROOT, path), "utf8");
        return (
          source.includes(".insert(sessionMessages)") ||
          /INSERT\s+INTO\s+session_messages/i.test(source)
        );
      })
      .sort();

    expect(writers).toEqual([
      "packages/trust/src/canonical-transcript-mutations.ts",
      "packages/trust/src/queries.ts",
      "packages/trust/src/room-silence.ts",
    ]);

    for (const path of writers) {
      const source = readFileSync(resolve(REPO_ROOT, path), "utf8");
      expect(source).toContain("acquireRoomWriteLock");
      expect(source.indexOf("acquireRoomWriteLock")).toBeLessThan(
        source.indexOf(".insert(sessionMessages)"),
      );
    }
  });
});
