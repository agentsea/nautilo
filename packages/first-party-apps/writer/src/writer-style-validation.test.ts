import { describe, expect, test } from "bun:test";
import {
  validateBlockStyle,
  validateInlineStyle,
  validateTableCellStyle,
} from "./writer-style-validation";

describe("shared Writer style validation", () => {
  test("accepts intended inline style values in both profiles", () => {
    const style = {
      bold: true,
      fontSize: 12,
      fontFamily: "Inter",
      color: "#abc",
      backgroundColor: "aabbccdd",
      href: "https://example.com",
    };
    expect(validateInlineStyle(style, "proposal")).toEqual({ ok: true, value: style });
    expect(validateInlineStyle(style, "closed")).toEqual({ ok: true, value: style });
    expect(validateInlineStyle({ superscript: true, clear: false }, "closed").ok).toBe(true);
    expect(validateInlineStyle({ superscript: true }, "proposal")).toMatchObject({
      ok: false,
      field: "superscript",
    });
  });

  test("rejects invalid inline scalars, bounds, colors, and strings", () => {
    for (const style of [
      { bold: "yes" },
      { fontSize: Number.NaN },
      { fontSize: Number.POSITIVE_INFINITY },
      { fontSize: 0 },
      { fontSize: 201 },
      { fontFamily: "" },
      { fontFamily: "x".repeat(101) },
      { fontFamily: "bad\u0000font" },
      { color: "#12" },
      { color: "#12345" },
      { backgroundColor: "orange" },
      { href: "" },
      { href: "x".repeat(2001) },
      { href: "https://example.com/\nunsafe" },
      { arbitrary: true },
    ]) {
      expect(validateInlineStyle(style, "proposal").ok).toBe(false);
      expect(validateInlineStyle(style, "closed").ok).toBe(false);
    }
  });

  test("enforces block enums, finite bounds, and known keys", () => {
    const valid = {
      alignment: "justify",
      lineHeight: 1.5,
      marginTop: 0,
      marginBottom: 1000,
      textIndent: 12,
      marginLeft: 36,
    };
    expect(validateBlockStyle(valid)).toEqual({ ok: true, value: valid });
    for (const style of [
      { alignment: "start" },
      { lineHeight: Number.NaN },
      { marginTop: Number.POSITIVE_INFINITY },
      { marginBottom: -1 },
      { textIndent: 1001 },
      { arbitrary: 1 },
    ]) {
      expect(validateBlockStyle(style).ok).toBe(false);
    }
  });

  test("enforces cell colors, vertical alignment, padding, and known keys", () => {
    const valid = { backgroundColor: "#1234", verticalAlign: "bottom", padding: 100 };
    expect(validateTableCellStyle(valid)).toEqual({ ok: true, value: valid });
    for (const style of [
      { backgroundColor: "#12345" },
      { verticalAlign: "baseline" },
      { padding: Number.NaN },
      { padding: Number.NEGATIVE_INFINITY },
      { padding: -1 },
      { padding: 101 },
      { arbitrary: "value" },
    ]) {
      expect(validateTableCellStyle(style).ok).toBe(false);
    }
  });

  test("can require a non-empty style for live proposals", () => {
    expect(validateInlineStyle({}, "proposal", true)).toMatchObject({ ok: false, field: "style" });
    expect(validateBlockStyle({}, true)).toMatchObject({ ok: false, field: "style" });
    expect(validateTableCellStyle({}, true)).toMatchObject({ ok: false, field: "style" });
  });
});
