import "../bun-dom-preload";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolRendererProps } from "../../src/components/tool-card/renderers/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const requestOpenMiniApp = mock(() => true);
let currentFolder: string | null = "/projects/original";
let renderer: (typeof import("../../src/components/tool-card/renderers/app-create"))["appCreateRenderer"];
let isEnvelope: (typeof import("../../src/components/tool-card/renderers/app-create"))["isAppCreatePresentationEnvelope"];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(async () => {
  mock.module("../../src/adapters/open-mini-app-ref", () => ({ requestOpenMiniApp }));
  ({ appCreateRenderer: renderer, isAppCreatePresentationEnvelope: isEnvelope } = await import("../../src/components/tool-card/renderers/app-create"));
});

beforeEach(() => {
  requestOpenMiniApp.mockClear(); currentFolder = "/projects/original";
  Object.defineProperty(window, "nautiloDesktop", { configurable: true, value: { currentFolder: {
    getPath: async () => currentFolder,
  } } });
});
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = null; container = null; });

const workspace = {
  ok: true, status: "created", opened: false,
  openInApp: { appId: "nautilo-presentation", appName: "Slides", target: {
    surface: "workspace", path: "Launch.presentation.html", artifactInternalId: "artifact-row-1",
    mimeType: "text/html", roomId: "room-1", sizeBytes: 42,
  } },
};

async function render(receipt: unknown, toolName = "app_nautilo_presentation__create_file") {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const props: ToolRendererProps = { toolName, args: {}, result: undefined, state: "success", event: undefined,
    resultText: JSON.stringify(receipt), resultTruncated: false };
  await act(async () => { root!.render(<renderer.ExpandedBody {...props} />); });
}

describe("app create result renderer", () => {
  test("opens the exact Workspace artifact directly in its originating app", async () => {
    await render(workspace);
    await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(requestOpenMiniApp).toHaveBeenCalledWith("nautilo-presentation", {
      kind: "artifact", id: "artifact-row-1", path: "Launch.presentation.html", mimeType: "text/html",
      roomId: "room-1", sizeBytes: 42,
    }, { mode: "edit" });
  });

  test("opens Current Folder only while the original root remains active", async () => {
    const receipt = { ...workspace, openInApp: { appId: "nautilo-presentation", appName: "Slides", target: {
      surface: "currentFolder", relativePath: "Launch.presentation.html", currentFolderRoot: "/projects/original",
    } } };
    await render(receipt);
    await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(requestOpenMiniApp).toHaveBeenCalledWith("nautilo-presentation", {
      kind: "fs", path: "/projects/original/Launch.presentation.html", rootPath: "/projects/original",
    }, { mode: "edit" });
    requestOpenMiniApp.mockClear(); currentFolder = "/projects/other";
    await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(requestOpenMiniApp).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Return to the original Current Folder");
  });

  test("revalidates asynchronously and fails closed when Desktop is missing or disconnected", async () => {
    const receipt = { ...workspace, openInApp: { appId: "nautilo-presentation", appName: "Slides", target: {
      surface: "currentFolder", relativePath: "Launch.presentation.html", currentFolderRoot: "/projects/original",
    } } };
    await render(receipt);
    delete (window as unknown as { nautiloDesktop?: unknown }).nautiloDesktop;
    await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    expect(requestOpenMiniApp).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Connect Nautilo Desktop");

    Object.defineProperty(window, "nautiloDesktop", { configurable: true, value: { currentFolder: {
      getPath: async () => { throw new Error("disconnected"); },
    } } });
    await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    expect(requestOpenMiniApp).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("could not confirm");
  });

  test("joins a matching Windows Current Folder with its native separator", async () => {
    currentFolder = "C:\\Users\\Example\\Decks";
    const receipt = { ...workspace, openInApp: { appId: "nautilo-presentation", appName: "Slides", target: {
      surface: "currentFolder", relativePath: "Launch.presentation.html", currentFolderRoot: currentFolder,
    } } };
    await render(receipt);
    await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    expect(requestOpenMiniApp).toHaveBeenCalledWith("nautilo-presentation", {
      kind: "fs", path: "C:\\Users\\Example\\Decks\\Launch.presentation.html", rootPath: currentFolder,
    }, { mode: "edit" });
  });

  test("rejects mismatched tool origins and unsafe or incomplete receipts", () => {
    expect(isEnvelope("app_other__create_file", JSON.stringify(workspace))).toBe(false);
    expect(isEnvelope("app_nautilo_presentation__create_file", JSON.stringify({ ...workspace, opened: true }))).toBe(false);
    expect(isEnvelope("app_nautilo_presentation__create_file", JSON.stringify({ ...workspace, openInApp: {
      ...workspace.openInApp, target: { ...workspace.openInApp.target, path: "../Launch.presentation.html" },
    } }))).toBe(false);
  });
});
