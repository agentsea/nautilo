import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const browserColumnSource = readFileSync(
  `${repoRoot}src/components/browser-column/browser-column.tsx`,
  "utf8",
);
const workbenchShellSource = readFileSync(
  `${repoRoot}src/layouts/workbench-shell.tsx`,
  "utf8",
);
const filesTabSource = readFileSync(
  `${repoRoot}src/components/browser-column/files-tab.tsx`,
  "utf8",
);
const artifactTreeSource = readFileSync(
  `${repoRoot}src/components/browser-column/artifact-tree-view.tsx`,
  "utf8",
);

describe("create-new wiring (M181)", () => {
  test("BrowserColumn passes onOpenFileEdit through TabBody to tabs", () => {
    expect(browserColumnSource).toContain("onOpenFileEdit?: (target: OpenFileTarget) => void");
    expect(browserColumnSource).toContain("onOpenFileEdit={onOpenFileEdit}");
    expect(browserColumnSource).toContain("<WorkspaceTab");
    expect(browserColumnSource).toContain("activeArtifact={activeArtifact}");
    expect(browserColumnSource).toContain(
      "<FilesTab onOpenFile={onOpenFile} onOpenFileEdit={onOpenFileEdit} />",
    );
  });

  test("WorkbenchShell wires focusFileInEditMode to BrowserColumn", () => {
    expect(workbenchShellSource).toContain("const focusFileInEditMode = useCallback");
    expect(workbenchShellSource).toContain("mode: \"edit\"");
    expect(workbenchShellSource).toContain("onOpenFileEdit={focusFileInEditMode}");
  });

  test("FilesTab create uses writeFile with baseSha256 null for new files", () => {
    expect(filesTabSource).toContain("baseSha256: null");
  });

  test("create-new uses in-app dialogs rather than browser prompt", () => {
    expect(filesTabSource).toContain("<NewFileDialog");
    expect(artifactTreeSource).toContain("<NewFileDialog");
    expect(filesTabSource).not.toContain("prompt(");
    expect(artifactTreeSource).not.toContain("prompt(");
  });
});
