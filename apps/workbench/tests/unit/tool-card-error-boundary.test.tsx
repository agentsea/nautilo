import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ToolCardBodyErrorBoundary } from "../../src/components/tool-card/tool-card";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};

function BrokenPreview(): React.ReactElement {
  throw new Error("malformed tool payload");
}

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

afterAll(() => {
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

describe("ToolCardBodyErrorBoundary", () => {
  test("contains renderer failures inside the expanded tool card", () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);

    act(() => {
      root.render(
        <div data-testid="conversation-still-mounted">
          <ToolCardBodyErrorBoundary toolName="file">
            <BrokenPreview />
          </ToolCardBodyErrorBoundary>
        </div>,
      );
    });

    expect(host.querySelector('[data-testid="conversation-still-mounted"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="tool-card-render-fallback"]')).not.toBeNull();
    expect(host.textContent).toContain("This tool result could not be previewed.");
    expect(consoleError).toHaveBeenCalled();

    act(() => root.unmount());
    host.remove();
    consoleError.mockRestore();
  });
});
