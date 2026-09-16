import { describe, expect, test } from "bun:test";
import {
  isDarkFromDocument,
  shikiLangFor,
  shikiThemeForDark,
} from "../../src/lib/use-highlighted-code";

describe("shikiLangFor", () => {
  test("returns text when language is null", () => {
    expect(shikiLangFor(null)).toBe("text");
  });

  test("maps common aliases", () => {
    expect(shikiLangFor("js")).toBe("javascript");
    expect(shikiLangFor("ts")).toBe("typescript");
    expect(shikiLangFor("py")).toBe("python");
    expect(shikiLangFor("md")).toBe("markdown");
    expect(shikiLangFor("sh")).toBe("bash");
    expect(shikiLangFor("yml")).toBe("yaml");
  });

  test("passes through unknown languages", () => {
    expect(shikiLangFor("Rust")).toBe("rust");
    expect(shikiLangFor("rust")).toBe("rust");
    expect(shikiLangFor("go")).toBe("go");
  });
});

describe("shikiThemeForDark", () => {
  test("selects github-dark in dark mode", () => {
    expect(shikiThemeForDark(true)).toBe("github-dark");
  });

  test("selects github-light in light mode", () => {
    expect(shikiThemeForDark(false)).toBe("github-light");
  });
});

describe("isDarkFromDocument", () => {
  test("returns false when element is unavailable", () => {
    expect(isDarkFromDocument(null)).toBe(false);
    expect(isDarkFromDocument(undefined)).toBe(false);
  });

  test("reads the dark class from documentElement", () => {
    const el = { classList: { contains: (name: string) => name === "dark" } };
    expect(isDarkFromDocument(el)).toBe(true);

    const light = { classList: { contains: () => false } };
    expect(isDarkFromDocument(light)).toBe(false);
  });
});
