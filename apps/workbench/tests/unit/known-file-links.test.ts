import { describe, expect, test } from "bun:test";
import {
  decodeKnownFileHref,
  getKnownFileRef,
  linkKnownFileMentions,
  setKnownArtifacts,
  type KnownFileRef,
} from "../../src/lib/known-file-links";

function ref(path: string): KnownFileRef {
  return {
    kind: "fs",
    path,
    rootPath: "/workspace",
    label: path.split("/").pop() ?? path,
    source: "tool",
  };
}

function artifactRef(path: string, id = `int-${path}`): KnownFileRef {
  return {
    kind: "artifact",
    path,
    artifactId: id,
    mimeType: "text/html",
    label: path.split("/").pop() ?? path,
    source: "artifact-list",
  };
}

describe("known file mention linking", () => {
  test("links exact known absolute paths", () => {
    const path = "/workspace/out/summary.pdf";
    expect(linkKnownFileMentions(`Wrote ${path}`, [ref(path)])).toBe(
      `Wrote [${path}](#nautilo-file:%2Fworkspace%2Fout%2Fsummary.pdf)`,
    );
  });

  test("links unambiguous known basenames", () => {
    const path = "/workspace/out/summary.pdf";
    expect(linkKnownFileMentions("Open summary.pdf now.", [ref(path)])).toBe(
      "Open [summary.pdf](#nautilo-file:%2Fworkspace%2Fout%2Fsummary.pdf) now.",
    );
  });

  test("links unambiguous known workspace-relative paths", () => {
    const path = "/workspace/drafts/pdf-render-test.pdf";
    expect(linkKnownFileMentions("Staged drafts/pdf-render-test.pdf.", [ref(path)])).toBe(
      "Staged [drafts/pdf-render-test.pdf](#nautilo-file:%2Fworkspace%2Fdrafts%2Fpdf-render-test.pdf).",
    );
  });

  test("does not relink basename inside an already-linked relative path", () => {
    const path = "/workspace/drafts/pdf-render-test.pdf";
    expect(
      linkKnownFileMentions(
        "Staged drafts/pdf-render-test.pdf and pdf-render-test.pdf.",
        [ref(path)],
      ),
    ).toBe(
      "Staged [drafts/pdf-render-test.pdf](#nautilo-file:%2Fworkspace%2Fdrafts%2Fpdf-render-test.pdf) and [pdf-render-test.pdf](#nautilo-file:%2Fworkspace%2Fdrafts%2Fpdf-render-test.pdf).",
    );
  });

  test("does not link ambiguous basenames", () => {
    const refs = [
      ref("/workspace/a/summary.pdf"),
      ref("/workspace/b/summary.pdf"),
    ];
    expect(linkKnownFileMentions("Open summary.pdf now.", refs)).toBe(
      "Open summary.pdf now.",
    );
  });

  test("does not link unknown filename-like text", () => {
    expect(linkKnownFileMentions("Open mystery.pdf now.", [])).toBe(
      "Open mystery.pdf now.",
    );
  });

  test("links artifact mentions by logical path", () => {
    const path = "artifacts/leveraged-etfs.html";
    expect(linkKnownFileMentions(`See artifacts/leveraged-etfs.html.`, [artifactRef(path)])).toBe(
      "See [artifacts/leveraged-etfs.html](#nautilo-file:artifacts%2Fleveraged-etfs.html).",
    );
  });

  test("links artifact mentions by unambiguous basename", () => {
    const path = "artifacts/leveraged-etfs.html";
    expect(linkKnownFileMentions("Open leveraged-etfs.html now.", [artifactRef(path)])).toBe(
      "Open [leveraged-etfs.html](#nautilo-file:artifacts%2Fleveraged-etfs.html) now.",
    );
  });

  test("does not link ambiguous artifact basenames", () => {
    const refs = [
      artifactRef("artifacts/a/report.html", "int-a"),
      artifactRef("artifacts/b/report.html", "int-b"),
    ];
    expect(linkKnownFileMentions("Open report.html now.", refs)).toBe(
      "Open report.html now.",
    );
  });

  test("links a backticked known path as a clickable monospace link", () => {
    const path = "artifacts/leveraged-etfs.html";
    expect(
      linkKnownFileMentions("Here it is: `artifacts/leveraged-etfs.html`", [artifactRef(path)]),
    ).toBe(
      "Here it is: [`artifacts/leveraged-etfs.html`](#nautilo-file:artifacts%2Fleveraged-etfs.html)",
    );
  });

  test("links a backticked FS path too", () => {
    const path = "/workspace/out/summary.pdf";
    expect(linkKnownFileMentions("See `summary.pdf` now.", [ref(path)])).toBe(
      "See [`summary.pdf`](#nautilo-file:%2Fworkspace%2Fout%2Fsummary.pdf) now.",
    );
  });

  test("does not inject link markup inside a code span (no flat-text breakage)", () => {
    const path = "artifacts/leveraged-etfs.html";
    const out = linkKnownFileMentions("`artifacts/leveraged-etfs.html`", [artifactRef(path)]);
    expect(out).not.toContain("`[");
    expect(out).not.toContain("](#nautilo-file:artifacts%2Fleveraged-etfs.html)`");
  });

  test("leaves non-path code spans untouched", () => {
    const path = "artifacts/leveraged-etfs.html";
    expect(linkKnownFileMentions("Run `npm install` first.", [artifactRef(path)])).toBe(
      "Run `npm install` first.",
    );
  });

  test("does not linkify known paths inside fenced code blocks", () => {
    const path = "artifacts/leveraged-etfs.html";
    const input = "```\nopen artifacts/leveraged-etfs.html\n```";
    expect(linkKnownFileMentions(input, [artifactRef(path)])).toBe(input);
  });

  describe("setKnownArtifacts (list-based registration)", () => {
    test("registers artifacts resolvable by path with internal id + mime", () => {
      setKnownArtifacts([
        { id: "int-1", path: "artifacts/report.html", mimeType: "text/html" },
      ]);
      const r = getKnownFileRef("artifacts/report.html");
      expect(r).toEqual({
        kind: "artifact",
        path: "artifacts/report.html",
        artifactId: "int-1",
        mimeType: "text/html",
        label: "report.html",
        source: "artifact-list",
      });
    });

    test("full-list replace drops artifacts no longer present (delete/rename)", () => {
      setKnownArtifacts([
        { id: "int-1", path: "artifacts/report.html", mimeType: "text/html" },
      ]);
      setKnownArtifacts([
        { id: "int-2", path: "artifacts/renamed.html", mimeType: "text/html" },
      ]);
      expect(getKnownFileRef("artifacts/report.html")).toBeNull();
      expect(getKnownFileRef("artifacts/renamed.html")?.path).toBe("artifacts/renamed.html");
    });
  });

  test("decodes generated hrefs", () => {
    expect(decodeKnownFileHref("#nautilo-file:%2Fworkspace%2Fout%2Fa.docx")).toBe(
      "/workspace/out/a.docx",
    );
    expect(decodeKnownFileHref("http://localhost/#nautilo-file:%2Fworkspace%2Fout%2Fa.docx")).toBe(
      "/workspace/out/a.docx",
    );
    expect(decodeKnownFileHref("https://example.com/a.docx")).toBeNull();
  });
});
