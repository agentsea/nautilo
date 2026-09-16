import { describe, expect, test } from "bun:test";
import {
  APPLY_PATCH_UNSUPPORTED_REASONS,
  classifyApplyPatchText,
} from "../../src/tools/apply-patch/text-classifier";

const encoder = new TextEncoder();

function expectExactText(source: string): void {
  const bytes = encoder.encode(source);
  const before = Uint8Array.from(bytes);
  const result = classifyApplyPatchText(bytes);

  expect(result).toMatchObject({
    supported: true,
    kind: "utf8_text",
    byteLength: bytes.byteLength,
  });
  if (result.supported) {
    expect(result.text).toBe(source);
    expect(encoder.encode(result.text)).toEqual(before);
  }
  expect(bytes).toEqual(before);
}

function expectUnsupported(
  bytes: Uint8Array,
  reason: (typeof APPLY_PATCH_UNSUPPORTED_REASONS)[number],
): void {
  const before = Uint8Array.from(bytes);
  const result = classifyApplyPatchText(bytes);

  expect(result).toMatchObject({
    supported: false,
    kind: "unsupported",
    reason,
    byteLength: bytes.byteLength,
    error: { code: "unsupported_encoding_or_type", retryable: false },
  });
  expect(bytes).toEqual(before);
  expect("text" in result).toBe(false);
}

describe("D448 apply_patch UTF-8 text classifier", () => {
  test("accepts source, extensionless, Markdown, and Unicode text byte-exactly", () => {
    expectExactText("export const answer = 42;\n");
    expectExactText("#!/usr/bin/env bash\nprintf 'hello\\n'\n");
    expectExactText("# Plan\n\n日本語 🚀\n");
    expectExactText("");
  });

  test("accepts line-oriented config content without consulting or authorizing a path", () => {
    // These are `.env`, JSON, YAML, TOML, and INI-shaped bytes. The classifier
    // has no path argument, so format support cannot grant access to `.env`.
    expectExactText("TOKEN=placeholder\nENABLED=true\n");
    expectExactText('{"enabled":true}\n');
    expectExactText("enabled: true\n");
    expectExactText('[service]\nenabled = true\n');
    expectExactText("[service]\nenabled=true\n");
  });

  test("accepts text SVG and preserves a UTF-8 BOM", () => {
    expectExactText('<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>\n');
    expectExactText("\ufeffkey=value\n");
  });

  test("pins classifier reasons", () => {
    expect(APPLY_PATCH_UNSUPPORTED_REASONS).toEqual([
      "invalid_utf8",
      "binary_content",
      "png",
      "pdf",
      "zip_container",
      "sqlite",
    ]);
  });

  test("rejects invalid UTF-8 without replacement decoding", () => {
    expectUnsupported(Uint8Array.from([0x66, 0x6f, 0x80, 0x6f]), "invalid_utf8");
    expectUnsupported(Uint8Array.from([0xc3, 0x28]), "invalid_utf8");
  });

  test("rejects NUL and control-heavy bytes even when UTF-8 decoding succeeds", () => {
    expectUnsupported(encoder.encode("text\0tail"), "binary_content");
    expectUnsupported(Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x0a]), "binary_content");
  });

  test("rejects representative PNG, PDF, DOCX/ZIP, and SQLite signatures", () => {
    expectUnsupported(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      "png",
    );
    expectUnsupported(encoder.encode("%PDF-1.7\n1 0 obj\n"), "pdf");
    expectUnsupported(
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      "zip_container",
    );
    expectUnsupported(
      Uint8Array.from([...encoder.encode("SQLite format 3"), 0x00, 0x10, 0x00]),
      "sqlite",
    );
  });

  test("classification is bytes-only and ignores misleading format names", () => {
    // A caller may have resolved either name; bytes remain the sole support
    // signal. Path authority is intentionally outside this API.
    expectExactText("this could be named report.pdf but is plain UTF-8 text\n");
    expectUnsupported(encoder.encode("%PDF-1.7\n"), "pdf");
  });
});
