import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

describe("ordinary message delete callers", () => {
  test("remain limited to the two explicit conversation action surfaces", async () => {
    const callers: string[] = [];
    const glob = new Bun.Glob("{apps,packages}/**/*.{ts,tsx}");
    for await (const path of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
      if (
        path.includes("/node_modules/") ||
        path.includes("/dist/") ||
        /(?:\.test|\.spec)\.[^.]+$/.test(path)
      ) continue;
      if (readFileSync(resolve(repoRoot, path), "utf8").includes(".deleteRoomMessage(")) {
        callers.push(relative(repoRoot, resolve(repoRoot, path)));
      }
    }

    expect(callers.sort()).toEqual([
      "apps/mobile/src/hooks/use-room-chat-controller.ts",
      "apps/workbench/src/components/conversation.tsx",
    ]);
  });
});
