import { describe, expect, mock, test } from "bun:test";

mock.module("expo-file-system", () => ({
  Directory: class {},
  File: class {},
  Paths: { cache: "file:///cache" },
}));

const { admitArtifactEditContent, preflightArtifactEdit } = await import(
  "./artifact-edit-admission"
);
const { MAX_NATIVE_SOURCE_EDIT_BYTES, nativeSourceByteLength } = await import(
  "./artifact-edit-limits"
);
type ArtifactEditMetadata = import("./artifact-edit-admission").ArtifactEditMetadata;

const base = (
  overrides: Partial<ArtifactEditMetadata> = {},
): ArtifactEditMetadata => ({
  path: "notes/readme.md",
  mimeType: "text/markdown",
  size: 10,
  writable: true,
  ...overrides,
});

describe("artifact edit admission", () => {
  test("gates authority and source size before content allocation", () => {
    expect(preflightArtifactEdit(base({ writable: false }))).toEqual({
      kind: "view-only",
      reason: "not_writable",
    });
    for (const size of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(preflightArtifactEdit(base({ size }))).toEqual({
        kind: "view-only",
        reason: "invalid_metadata_size",
      });
    }
    expect(
      preflightArtifactEdit(base({ size: MAX_NATIVE_SOURCE_EDIT_BYTES })),
    ).toMatchObject({ kind: "source-candidate", format: "markdown" });
    expect(
      preflightArtifactEdit(base({ size: MAX_NATIVE_SOURCE_EDIT_BYTES + 1 })),
    ).toEqual({ kind: "view-only", reason: "metadata_too_large" });
  });

  test("matches Markdown/text viewer classification and keeps every HTML document view-only", () => {
    expect(
      preflightArtifactEdit(
        base({ path: "README.md", mimeType: "application/octet-stream" }),
      ),
    ).toMatchObject({ kind: "source-candidate", format: "markdown" });
    expect(
      preflightArtifactEdit(
        base({ path: "src/app.ts", mimeType: "application/octet-stream" }),
      ),
    ).toMatchObject({ kind: "source-candidate", format: "text" });
    expect(
      preflightArtifactEdit(base({ path: "x", mimeType: "text/plain" })),
    ).toMatchObject({ kind: "source-candidate", format: "text" });
    expect(
      preflightArtifactEdit(base({ path: "doc.html", mimeType: "text/html" })),
    ).toEqual({ kind: "view-only", reason: "unsupported_kind" });
    for (const path of ["doc.html", "doc.htm"]) {
      for (const mimeType of [
        "text/markdown",
        "application/octet-stream",
        "text/plain",
      ]) {
        expect(
          preflightArtifactEdit(base({ path, mimeType })),
        ).toEqual({ kind: "view-only", reason: "unsupported_kind" });
      }
    }
  });

  test("rechecks actual UTF-8 bytes and returns exact source without presentation copy", () => {
    const oversized = "x".repeat(MAX_NATIVE_SOURCE_EDIT_BYTES + 1);
    expect(nativeSourceByteLength(oversized)).toBe(
      MAX_NATIVE_SOURCE_EDIT_BYTES + 1,
    );
    expect(admitArtifactEditContent(base({ size: 1 }), oversized)).toEqual({
      kind: "view-only",
      reason: "content_too_large",
    });
    expect(
      admitArtifactEditContent(
        base({ path: "plain.txt", mimeType: "text/plain", size: 4 }),
        "text",
      ),
    ).toEqual({ kind: "source", format: "text", content: "text" });
    expect(admitArtifactEditContent(base({ size: 3 }), "# x")).toEqual({
      kind: "source",
      format: "markdown",
      content: "# x",
    });
  });

  test("locks the qualified 10 MiB source envelope independently from Writer viewing", () => {
    expect(MAX_NATIVE_SOURCE_EDIT_BYTES).toBe(10 * 1024 * 1024);
    expect(nativeSourceByteLength("🫖")).toBe(4);
    expect(
      preflightArtifactEdit(
        base({
          path: "writer.html",
          mimeType: "text/html",
          size: 250_000,
        }),
      ),
    ).toEqual({ kind: "view-only", reason: "unsupported_kind" });
  });
});
