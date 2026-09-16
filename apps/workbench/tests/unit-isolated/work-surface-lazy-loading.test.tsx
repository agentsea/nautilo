import "../bun-dom-preload";
import { act, Suspense } from "react";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createRoot, type Root } from "react-dom/client";

let readerModuleLoads = 0;
let terminalModuleLoads = 0;
let root: Root | null = null;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mock.module("../../src/components/work-surface/reader-surface", () => {
    readerModuleLoads += 1;
    return {
      ReaderSurface: ({ file }: { file: { path: string } }) => (
        <div data-testid="lazy-reader">{file.path}</div>
      ),
    };
  });
  mock.module("../../src/apps/terminal-surface", () => {
    terminalModuleLoads += 1;
    return {
      TerminalSurface: () => <div data-testid="lazy-terminal">Terminal</div>,
    };
  });
});

afterAll(() => {
  act(() => root?.unmount());
  root = null;
  mock.restore();
});

describe("Workbench work-surface import boundaries", () => {
  test("loads only the selected Reader feature module", async () => {
    const {
      ReaderSurface,
      TerminalSurface: _TerminalSurface,
    } = await import("../../src/layouts/lazy-work-surfaces");

    expect(readerModuleLoads).toBe(0);
    expect(terminalModuleLoads).toBe(0);

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <Suspense fallback={<div data-testid="surface-loading">Loading…</div>}>
          <ReaderSurface
            file={{ kind: "fs", path: "/workspace/report.pdf", rootPath: "/workspace" }}
            onClose={() => {}}
          />
        </Suspense>,
      );
    });

    expect(readerModuleLoads).toBe(1);
    expect(terminalModuleLoads).toBe(0);
    expect(document.querySelector('[data-testid="lazy-reader"]')?.textContent).toBe(
      "/workspace/report.pdf",
    );
  });
});
