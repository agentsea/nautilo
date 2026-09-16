/**
 * Pure helper tests for the unified `file` tool's `read` command
 * renderer (`file-read.tsx`) multimodal envelope parsing.
 * React UI is live-verified in Electron.
 */

import { describe, expect, test } from "bun:test";
import {
  parseMultimodalReadEnvelope,
  type MultimodalReadEnvelope,
} from "../../src/components/tool-card/renderers/file-read";

const baseImage: MultimodalReadEnvelope = {
  multimodal: true,
  kind: "image",
  absolutePath: "/Users/x/foo.png",
  mime: "image/png",
  bytes: 412345,
  header: "Image: /Users/x/foo.png (412345 bytes, image/png)",
};

const basePdf: MultimodalReadEnvelope = {
  multimodal: true,
  kind: "pdf",
  absolutePath: "/Users/x/doc.pdf",
  mime: "application/pdf",
  bytes: 999,
  header: "PDF: /Users/x/doc.pdf",
};

describe("parseMultimodalReadEnvelope", () => {
  test("returns null for undefined, empty, non-JSON, malformed JSON", () => {
    expect(parseMultimodalReadEnvelope(undefined)).toBeNull();
    expect(parseMultimodalReadEnvelope("")).toBeNull();
    expect(parseMultimodalReadEnvelope("   ")).toBeNull();
    expect(parseMultimodalReadEnvelope("hello")).toBeNull();
    expect(parseMultimodalReadEnvelope("{}")).toBeNull();
    expect(parseMultimodalReadEnvelope("{ not json")).toBeNull();
  });

  test("returns null when payload lacks multimodal substring (cheap reject)", () => {
    expect(
      parseMultimodalReadEnvelope(
        JSON.stringify({ kind: "image", absolutePath: "/a", mime: "x", bytes: 1, header: "h" }),
      ),
    ).toBeNull();
  });

  test("returns null when multimodal !== true", () => {
    expect(
      parseMultimodalReadEnvelope(
        JSON.stringify({ ...baseImage, multimodal: false }),
      ),
    ).toBeNull();
    expect(
      parseMultimodalReadEnvelope(
        JSON.stringify({ ...baseImage, multimodal: "true" }),
      ),
    ).toBeNull();
  });

  test("returns null when kind is not image or pdf", () => {
    expect(
      parseMultimodalReadEnvelope(
        JSON.stringify({ ...baseImage, kind: "video" }),
      ),
    ).toBeNull();
    expect(
      parseMultimodalReadEnvelope(
        JSON.stringify({ ...baseImage, kind: 1 }),
      ),
    ).toBeNull();
  });

  test("returns null when required fields missing or wrong type", () => {
    expect(
      parseMultimodalReadEnvelope(
        JSON.stringify({
          multimodal: true,
          kind: "image",
          mime: "image/png",
          bytes: 1,
          header: "h",
        }),
      ),
    ).toBeNull();
    expect(
      parseMultimodalReadEnvelope(
        JSON.stringify({
          multimodal: true,
          kind: "image",
          absolutePath: "/a",
          bytes: 1,
          header: "h",
        }),
      ),
    ).toBeNull();
    expect(
      parseMultimodalReadEnvelope(
        JSON.stringify({
          multimodal: true,
          kind: "image",
          absolutePath: "/a",
          mime: "image/png",
          header: "h",
        }),
      ),
    ).toBeNull();
    expect(
      parseMultimodalReadEnvelope(
        JSON.stringify({
          multimodal: true,
          kind: "image",
          absolutePath: "/a",
          mime: "image/png",
          bytes: "1",
          header: "h",
        }),
      ),
    ).toBeNull();
    expect(
      parseMultimodalReadEnvelope(
        JSON.stringify({
          multimodal: true,
          kind: "image",
          absolutePath: 123,
          mime: "image/png",
          bytes: 1,
          header: "h",
        }),
      ),
    ).toBeNull();
  });

  test("happy path: full valid image envelope", () => {
    const raw = JSON.stringify(baseImage);
    expect(parseMultimodalReadEnvelope(raw)).toEqual(baseImage);
  });

  test("happy path: full valid pdf envelope", () => {
    const raw = JSON.stringify(basePdf);
    const out = parseMultimodalReadEnvelope(raw);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("pdf");
    expect(out).toEqual(basePdf);
  });
});
