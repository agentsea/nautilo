import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ConflictError } from "@nautilo/api-client/browser";

const loadAppSourceFile = mock(async () => ({
  kind: "ready" as const,
  content: "export {}",
  baseSha256: "a".repeat(64),
  baseRevision: null,
}));
const saveAppSourceFile = mock(async () => ({
  kind: "saved" as const,
  newSha256: "b".repeat(64),
  sourceHash: "c".repeat(64),
}));
const requestOpenMiniApp = mock(() => true);

mock.module("./app-source-io", () => ({
  loadAppSourceFile,
  saveAppSourceFile,
}));

mock.module("../adapters/open-mini-app-ref", () => ({
  requestOpenMiniApp,
}));

const { AppSourceEditorSurface } = await import("./app-source-editor-surface");

const target = {
  kind: "app-source" as const,
  appId: "sample-app",
  path: "src/index.ts",
};

beforeEach(() => {
  reapplyHappyDomGlobals();
  loadAppSourceFile.mockClear();
  saveAppSourceFile.mockClear();
  requestOpenMiniApp.mockClear();
  loadAppSourceFile.mockImplementation(async () => ({
    kind: "ready" as const,
    content: "export {}",
    baseSha256: "a".repeat(64),
    baseRevision: null,
  }));
  saveAppSourceFile.mockImplementation(async () => ({
    kind: "saved" as const,
    newSha256: "b".repeat(64),
    sourceHash: "c".repeat(64),
  }));
});

describe("AppSourceEditorSurface", () => {
  test("loads source file on mount", async () => {
    render(<AppSourceEditorSurface target={target} onClose={() => {}} />);

    await waitFor(() => {
      expect(loadAppSourceFile).toHaveBeenCalledWith(target);
    });
    expect(document.body.textContent).toContain("src/index.ts");
  });

  test("save sends baseSha256 and updates status on success", async () => {
    render(<AppSourceEditorSurface target={target} onClose={() => {}} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("export {}");
    });

    const saveButton = [...document.querySelectorAll("button")].find(
      (btn) => btn.textContent === "Save",
    );
    expect(saveButton).toBeTruthy();
    fireEvent.click(saveButton!);

    await waitFor(() => {
      expect(saveAppSourceFile).toHaveBeenCalledWith(target, "export {}", "a".repeat(64));
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Saved");
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="app-source-reload-banner"]')).not.toBeNull();
    });
  });

  test("reload app button opens the saved app preview", async () => {
    render(<AppSourceEditorSurface target={target} onClose={() => {}} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("export {}");
    });

    const saveButton = [...document.querySelectorAll("button")].find(
      (btn) => btn.textContent === "Save",
    );
    fireEvent.click(saveButton!);

    const reloadButton = await waitFor(() => {
      const button = [...document.querySelectorAll("button")].find(
        (btn) => btn.textContent === "Reload app",
      );
      expect(button).toBeTruthy();
      return button!;
    });
    fireEvent.click(reloadButton);

    expect(requestOpenMiniApp).toHaveBeenCalledWith("sample-app");
  });

  test("does not reload when rerendered with an equivalent target object", async () => {
    const { rerender } = render(<AppSourceEditorSurface target={target} onClose={() => {}} />);

    await waitFor(() => {
      expect(loadAppSourceFile).toHaveBeenCalledTimes(1);
    });

    rerender(
      <AppSourceEditorSurface
        target={{ kind: "app-source", appId: "sample-app", path: "src/index.ts" }}
        onClose={() => {}}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadAppSourceFile).toHaveBeenCalledTimes(1);
  });

  test("shows visible conflict UI and preserves draft content", async () => {
    saveAppSourceFile.mockImplementationOnce(async () => ({
      kind: "conflict" as const,
      currentSha256: "f".repeat(64),
    }));
    loadAppSourceFile.mockImplementation(async () => ({
      kind: "ready" as const,
      content: "export {}",
      baseSha256: "a".repeat(64),
      baseRevision: null,
    }));

    render(<AppSourceEditorSurface target={target} onClose={() => {}} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("export {}");
    });

    const saveButton = [...document.querySelectorAll("button")].find((btn) => btn.textContent === "Save");
    fireEvent.click(saveButton!);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="app-source-conflict"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain("export {}");
    expect(document.body.textContent).toContain("changed elsewhere");
  });

  test("surfaces load errors from ConflictError as generic load failure", async () => {
    loadAppSourceFile.mockImplementationOnce(async () => ({
      kind: "error" as const,
      message: new ConflictError("x".repeat(64)).message,
    }));

    const view = render(<AppSourceEditorSurface target={target} onClose={() => {}} />);

    await waitFor(() => {
      expect(view.getByText("Workspace artifact changed externally")).toBeTruthy();
    });
  });
});
