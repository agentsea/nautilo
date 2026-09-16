import { expect, test } from "bun:test";

import { selectArtifactEditorRoute } from "./artifact-editor-routing";

test("routes source admissions and nothing else", () => {
  const source = { kind: "source", format: "markdown", content: "# source" } as const;
  expect(selectArtifactEditorRoute(source)).toEqual({ kind: "source" });
  expect(
    selectArtifactEditorRoute({
      kind: "view-only",
      reason: "unsupported_kind",
    }),
  ).toEqual({ kind: "none" });
});

test("generic edit routing and mobile dependencies contain no Writer editor", async () => {
  const route = await Bun.file(
    new URL("../../app/files/artifact/edit/[id].tsx", import.meta.url),
  ).text();
  const viewerRouting = await Bun.file(
    new URL("./artifact-viewer-routing.tsx", import.meta.url),
  ).text();
  const packageJson = await Bun.file(
    new URL("../../../package.json", import.meta.url),
  ).text();
  for (const source of [route, viewerRouting, packageJson]) {
    expect(source).not.toMatch(
      /react-native-enriched-html|WriterArtifactEditor|IosWriterEditor|ios-writer|writer-candidate/,
    );
  }
});
