import { describe, expect, test } from "bun:test";
import {
  detectScripts,
  hasArabic,
  hasCjk,
  hasEmoji,
} from "../../src/detect-script";

describe("font script detection", () => {
  test("detects Latin", () => {
    expect(detectScripts("Hello café").scripts.has("latin")).toBe(true);
  });

  test("detects Chinese and Japanese", () => {
    expect(hasCjk("你好")).toBe(true);
    const jp = detectScripts("こんにちは");
    expect(jp.scripts.has("japanese")).toBe(true);
  });

  test("detects Arabic", () => {
    expect(hasArabic("مرحبا بالعالم")).toBe(true);
  });

  test("detects emoji separately", () => {
    expect(hasEmoji("hello 😀")).toBe(true);
    expect(detectScripts("hello 😀").scripts.has("emoji")).toBe(true);
  });
});
