import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("keyboard-raised bottom sheets remain below the device safe area", () => {
  const source = readFileSync(resolve(import.meta.dir, "bottom-sheet.tsx"), "utf8");

  expect(source).toContain("useSafeAreaInsets()");
  expect(source).toContain("topInset={insets.top}");
  expect(source).toContain('keyboardBehavior = "interactive"');
  expect(source).toContain("keyboardBehavior={keyboardBehavior}");
  expect(source).toContain('androidKeyboardInputMode = "adjustResize"');
  expect(source).toContain("android_keyboardInputMode={androidKeyboardInputMode}");
});


test("model search expands for the keyboard and sheet actions accept the first tap", () => {
  const picker = readFileSync(resolve(import.meta.dir, "model-switcher-sheet.tsx"), "utf8");
  const sheet = readFileSync(resolve(import.meta.dir, "bottom-sheet.tsx"), "utf8");
  expect(picker).toContain('keyboardBehavior="fillParent"');
  expect(picker).toContain('androidKeyboardInputMode="adjustPan"');
  expect(sheet).toContain('keyboardShouldPersistTaps="handled"');
});
