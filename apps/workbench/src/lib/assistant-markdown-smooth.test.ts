import { describe, expect, test } from "bun:test";
import { shouldSmoothAssistantMarkdown } from "./assistant-markdown-smooth";

describe("shouldSmoothAssistantMarkdown (D326)", () => {
  test("keeps smooth streaming for temporary assistant ids", () => {
    expect(shouldSmoothAssistantMarkdown("assistant-123")).toBe(true);
    expect(shouldSmoothAssistantMarkdown("assistant-2026-06-16")).toBe(true);
  });

  test("disables smoothing after temp id reconciles to a numeric DB id", () => {
    expect(shouldSmoothAssistantMarkdown(123)).toBe(false);
    expect(shouldSmoothAssistantMarkdown("123")).toBe(false);
  });

  test("does not treat invalid or placeholder ids as persisted DB ids", () => {
    expect(shouldSmoothAssistantMarkdown(null)).toBe(true);
    expect(shouldSmoothAssistantMarkdown(undefined)).toBe(true);
    expect(shouldSmoothAssistantMarkdown(0)).toBe(true);
    expect(shouldSmoothAssistantMarkdown("0")).toBe(true);
    expect(shouldSmoothAssistantMarkdown("")).toBe(true);
  });
});
