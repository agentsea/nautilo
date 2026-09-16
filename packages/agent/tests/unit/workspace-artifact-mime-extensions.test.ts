import { describe, expect, test } from "bun:test";
import { mimeFromExtensionOr } from "@nautilo/attachments";

/** Paths used by workspace `file.write`; mime is stamped on `WorkspaceArtifactPatchMeta` from the logical path (D136 P1). */
const VIEWER_EXTENSIONS = [
  { leaf: "a.pdf", mime: "application/pdf" },
  { leaf: "b.png", mime: "image/png" },
  { leaf: "c.jpg", mime: "image/jpeg" },
  { leaf: "d.jpeg", mime: "image/jpeg" },
  {
    leaf: "e.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    leaf: "f.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  { leaf: "g.md", mime: "text/markdown" },
  { leaf: "h.txt", mime: "text/plain" },
  { leaf: "i.html", mime: "text/html" },
] as const;

describe("workspace artifact write mimeFromExtensionOr (D136 P1)", () => {
  for (const { leaf, mime } of VIEWER_EXTENSIONS) {
    test(`${leaf} → non-empty concrete mime (not octet-stream fallback)`, () => {
      const logical = `artifacts/deep/${leaf}`;
      const m = mimeFromExtensionOr(logical);
      expect(m).toBe(mime);
      expect(m.trim().length).toBeGreaterThan(0);
      expect(m).not.toBe("application/octet-stream");
    });
  }
});
