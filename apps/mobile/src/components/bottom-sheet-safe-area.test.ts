import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("keyboard-raised bottom sheets remain below the device safe area", () => {
  const source = readFileSync(resolve(import.meta.dir, "bottom-sheet.tsx"), "utf8");

  expect(source).toContain("useSafeAreaInsets()");
  expect(source).toContain("topInset={insets.top}");
  expect(source).toContain('keyboardBehavior="interactive"');
  expect(source).toContain('android_keyboardInputMode="adjustResize"');
});
