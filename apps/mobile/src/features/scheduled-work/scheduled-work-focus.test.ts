import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./use-scheduled-work.ts", import.meta.url)).text();

describe("scheduled work route lifecycle", () => {
  test("reloads the canonical server list whenever the drawer route regains focus", () => {
    expect(source).toContain('import { useFocusEffect } from "expo-router"');
    expect(source).toContain("useFocusEffect(useCallback(() => {");
    expect(source).toContain("if (scope) void controller.load(api);");
  });
});
