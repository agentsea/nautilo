import { describe, expect, test } from "bun:test";
import { shouldCaptureComposerSubmit } from "./MentionAdapter";

describe("shared composer Enter contract (M230)", () => {
  test("captures plain Enter before Lexical can insert a paragraph", () => {
    expect(shouldCaptureComposerSubmit({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      pickerOpen: false,
    })).toBe(true);
  });

  test("preserves Shift+Enter, IME composition, and picker precedence", () => {
    expect(shouldCaptureComposerSubmit({
      key: "Enter",
      shiftKey: true,
      isComposing: false,
      pickerOpen: false,
    })).toBe(false);
    expect(shouldCaptureComposerSubmit({
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      pickerOpen: false,
    })).toBe(false);
    expect(shouldCaptureComposerSubmit({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      pickerOpen: true,
    })).toBe(false);
  });
});
