import { describe, expect, test } from "bun:test";
import presentationManifest from "../../../../packages/first-party-apps/presentation/app.json";
import { readFileSync } from "node:fs";
import type { PublicMiniAppDto } from "@nautilo/api-client/browser";
import {
  appMatchesFile,
  extensionCandidatesForPath,
  matchingImportActionsForFile,
  matchingReadyAppsForFileWithContent,
  matchingReadyAppsForFile,
} from "./app-associations";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
} from "../components/browser-column/open-file-target";

function sheetsApp(overrides?: Partial<PublicMiniAppDto>): PublicMiniAppDto {
  return {
    id: "nautilo-spreadsheet",
    name: "Sheets",
    version: "0.1.0",
    status: "ready",
    sourceHash: "a".repeat(64),
    fileAssociations: {
      extensions: [],
      mimeTypes: [],
    },
    contentAssociations: [
      {
        id: "spreadsheet-html",
        kind: "html-script-json",
        scriptId: "manifest",
        scriptType: "application/vnd.nautilo.document+json",
        match: {
          documentType: "spreadsheet",
          editor: "wafflebase",
          payloadFormat: "application/vnd.wafflebase.spreadsheet+json",
        },
      },
    ],
    canEditSource: false,
    ...overrides,
  };
}

describe("extensionCandidatesForPath", () => {
  test("returns compound extensions most-specific first", () => {
    expect(extensionCandidatesForPath("dir/Budget.SPREADSHEET.JSON")).toEqual([
      ".spreadsheet.json",
      ".json",
    ]);
  });

  test("returns a single candidate for a simple extension", () => {
    expect(extensionCandidatesForPath("notes/readme.md")).toEqual([".md"]);
  });

  test("returns empty when the basename has no extension", () => {
    expect(extensionCandidatesForPath("dir/README")).toEqual([]);
  });
});

describe("appMatchesFile", () => {
  test("does not match spreadsheet documents by extension alone", () => {
    const app = sheetsApp();
    const file = fsOpenFileTarget("workspace/budget.html", "/data");
    expect(appMatchesFile(app, file)).toBeNull();
  });

  test("matches HTML spreadsheet documents by embedded manifest content", () => {
    const app = sheetsApp();
    const file = fsOpenFileTarget("Budget.HTML", "/data");
    const html = `<script type="application/vnd.nautilo.document+json" id="manifest">
      {"documentType":"spreadsheet","editor":"wafflebase","payloadId":"wafflebase-spreadsheet","payloadFormat":"application/vnd.wafflebase.spreadsheet+json","version":"1.0"}
    </script>`;
    expect(matchingReadyAppsForFileWithContent([app], file, html)).toEqual([
      { app, reason: "content" },
    ]);
  });

  test("matches any app with a declared HTML JSON content association", () => {
    const app = sheetsApp({
      id: "kanban",
      name: "Kanban",
      contentAssociations: [
        {
          id: "kanban-html",
          kind: "html-script-json",
          scriptId: "manifest",
          scriptType: "application/vnd.nautilo.document+json",
          match: {
            documentType: "kanban",
            editor: "cards",
          },
        },
      ],
    });
    const file = fsOpenFileTarget("board.html", "/data");
    const html = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"kanban","editor":"cards","version":"1.0"}</script>`;
    expect(matchingReadyAppsForFileWithContent([app], file, html)).toEqual([
      { app, reason: "content" },
    ]);
  });

  test("does not match .xlsx against the first-party spreadsheet manifest", () => {
    const app = sheetsApp();
    const fsFile = fsOpenFileTarget("reports/summary.xlsx", "/data");
    expect(appMatchesFile(app, fsFile)).toBeNull();

    const artifactFile = artifactOpenFileTarget({
      id: "artifact-xlsx",
      path: "reports/summary.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(appMatchesFile(app, artifactFile)).toBeNull();
  });

  test("does not match when fileAssociations is null", () => {
    const app = sheetsApp({ fileAssociations: null });
    const file = fsOpenFileTarget("budget.html", "/data");
    expect(appMatchesFile(app, file)).toBeNull();
  });

  test("does not match when fileAssociations is empty", () => {
    const app = sheetsApp({ fileAssociations: {} });
    const file = fsOpenFileTarget("budget.html", "/data");
    expect(appMatchesFile(app, file)).toBeNull();
  });

  test("does not match non-ready apps", () => {
    const file = fsOpenFileTarget("budget.html", "/data");
    expect(
      appMatchesFile(sheetsApp({ status: "invalid_manifest" }), file),
    ).toBeNull();
    expect(
      appMatchesFile(sheetsApp({ status: "needs_dependencies" }), file),
    ).toBeNull();
  });

  test("FS targets do not match by MIME type alone", () => {
    const app = sheetsApp({ fileAssociations: { mimeTypes: ["text/html"] } });
    const file = fsOpenFileTarget("budget.html", "/data");
    expect(appMatchesFile(app, file)).toBeNull();
  });
});

describe("D390 — manifest owner beats bare-.html extension claim", () => {
  // A generic HTML app that claims .html by EXTENSION (the hijack vector).
  const htmlGrabberApp = (): PublicMiniAppDto =>
    sheetsApp({
      id: "nautilo-design",
      name: "Nautilo Design",
      fileAssociations: { extensions: [".html"], mimeTypes: ["text/html"] },
      contentAssociations: [],
    });

  const manifestHtml = `<script type="application/vnd.nautilo.document+json" id="manifest">
    {"documentType":"spreadsheet","editor":"wafflebase","payloadId":"wafflebase-spreadsheet","payloadFormat":"application/vnd.wafflebase.spreadsheet+json","version":"1.0"}
  </script>`;

  test("suppresses an extension-only claimant for a manifest-bearing doc; content owner wins", () => {
    const owner = sheetsApp(); // claims by content (manifest)
    const grabber = htmlGrabberApp(); // claims by .html extension only
    const file = fsOpenFileTarget("Budget.HTML", "/data");
    // Owner resolves by content; the extension grabber is excluded entirely.
    expect(matchingReadyAppsForFileWithContent([grabber, owner], file, manifestHtml)).toEqual([
      { app: owner, reason: "content" },
    ]);
  });

  test("plain HTML with no Nautilo manifest still matches an extension claimant (generic HTML app preserved)", () => {
    const grabber = htmlGrabberApp();
    const file = fsOpenFileTarget("notes.html", "/data");
    const plainHtml = "<!doctype html><html><body><p>hello</p></body></html>";
    expect(matchingReadyAppsForFileWithContent([grabber], file, plainHtml)).toEqual([
      { app: grabber, reason: "extension" },
    ]);
  });

  test("artifact MIME (text/html) claim is also suppressed for a manifest doc", () => {
    const owner = sheetsApp();
    const grabber = htmlGrabberApp();
    const file = artifactOpenFileTarget({
      id: "artifact-doc",
      path: "budget.html",
      mimeType: "text/html",
    });
    expect(matchingReadyAppsForFileWithContent([grabber, owner], file, manifestHtml)).toEqual([
      { app: owner, reason: "content" },
    ]);
  });

  test("app-specific Design provenance beats every broad HTML claimant", () => {
    const design = sheetsApp({
      id: "nautilo-design",
      name: "Nautilo Design",
      contentAssociations: [
        {
          id: "design-html",
          kind: "html-script-json",
          scriptId: "manifest",
          scriptType: "application/vnd.nautilo.design+json",
          match: {
            documentType: "design",
            editor: "nautilo-design",
            payloadFormat: "application/vnd.nautilo.design-scene+json",
          },
        },
      ],
    });
    const grabber = htmlGrabberApp();
    const file = artifactOpenFileTarget({
      id: "design-artifact",
      path: "launch.design.html",
      mimeType: "text/html",
    });
    const html = `<script type="application/vnd.nautilo.design+json" id="manifest">
      {"documentType":"design","editor":"nautilo-design","payloadId":"scene","payloadFormat":"application/vnd.nautilo.design-scene+json","version":"1.0"}
    </script>`;

    expect(matchingReadyAppsForFileWithContent([grabber, design], file, html)).toEqual([
      { app: design, reason: "content" },
    ]);
  });
});

describe("matchingReadyAppsForFile", () => {
  test("returns only ready apps that match the file", () => {
    const ready = sheetsApp();
    const invalid = sheetsApp({
      id: "broken",
      status: "invalid_manifest",
    });
    const other = sheetsApp({
      id: "notes",
      fileAssociations: { extensions: [".md"] },
    });
    const file = fsOpenFileTarget("budget.html", "/data");

    expect(matchingReadyAppsForFile([ready, invalid, other], file)).toEqual([]);
  });
});

describe("matchingImportActionsForFile", () => {
  test("matches .docx imports but not native Nautilo HTML documents", () => {
    const writer = sheetsApp({
      id: "writer",
      name: "Writer",
      conversions: {
        import: [
          {
            id: "import-docx",
            label: "Import Word document",
            from: { extensions: [".docx"] },
            sourceSurfaces: ["workspace", "currentFolder"],
            tool: "importDocx",
            target: { surface: "workspace", extension: ".html" },
          },
        ],
      },
    });
    const action = writer.conversions?.import?.[0];
    const docx = artifactOpenFileTarget({
      id: "artifact-docx",
      path: "report.DOCX",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const nativeDoc = artifactOpenFileTarget({
      id: "artifact-native",
      path: "report.doc.html",
      mimeType: "text/html",
    });

    expect(matchingImportActionsForFile([writer], docx)).toEqual([
      { app: writer, action },
    ]);
    expect(matchingImportActionsForFile([writer], nativeDoc)).toEqual([]);
  });
});


describe("native Slides content routing", () => {
  const slides = sheetsApp({
    id: presentationManifest.id,
    name: presentationManifest.name,
    contentAssociations: presentationManifest.contentAssociations as PublicMiniAppDto["contentAssociations"],
    fileAssociations: presentationManifest.fileAssociations,
  });
  const html = readFileSync(new URL("../../../../packages/first-party-apps/presentation/templates/empty-presentation.html", import.meta.url), "utf8");
  test("opens the real Slides template from either document surface", () => {
    for (const file of [fsOpenFileTarget("Launch.presentation.html", "/data"), artifactOpenFileTarget({ id: "launch", path: "Launch.presentation.html", mimeType: "text/html" })]) {
      expect(matchingReadyAppsForFileWithContent([slides], file, html)).toEqual([{ app: slides, reason: "content" }]);
    }
  });
  test("requires the exact native identity and a ready enabled app", () => {
    const file = fsOpenFileTarget("Launch.presentation.html", "/data");
    for (const [before, after] of [["presentation", "spreadsheet"], ["wafflebase", "other-editor"], ["application/vnd.wafflebase.presentation+json", "application/other+json"]]) {
      expect(matchingReadyAppsForFileWithContent([slides], file, html.replaceAll(before, after))).toEqual([]);
    }
    expect(matchingReadyAppsForFileWithContent([{ ...slides, status: "disabled" }], file, html)).toEqual([]);
    expect(appMatchesFile(slides, fsOpenFileTarget("Launch.pptx", "/data"))).toBeNull();
  });
});

test("Board claims only its native manifest and supports a read-only native preview", async () => {
  const { default: manifest } = await import("../../../../packages/first-party-apps/board/app.json");
  const { supportsMiniAppPreview } = await import("../adapters/open-mini-app-ref");
  const board = { ...sheetsApp(), id: manifest.id, name: manifest.name,
    contentAssociations: manifest.contentAssociations } as PublicMiniAppDto;
  const content = readFileSync(new URL("../../../../packages/first-party-apps/board/templates/empty-board.html", import.meta.url), "utf8");
  expect(supportsMiniAppPreview(board.id)).toBe(true);
  expect(matchingReadyAppsForFileWithContent([board], artifactOpenFileTarget({ id: "ideas", path: "Ideas.board.html", mimeType: "text/html" }), content).map(match => match.app.id)).toEqual([board.id]);
  expect(matchingReadyAppsForFileWithContent([board], artifactOpenFileTarget({ id: "ideas", path: "Ideas.board.html", mimeType: "text/html" }), "<html>ordinary content</html>")).toEqual([]);
});
