/**
 * D323 — ModelFallbackStatusNotice dismiss affordance.
 *
 * Guards the two user-facing guarantees of the fallback pill:
 *   - it is NOT pointer-events-none (the pill is interactive);
 *   - clicking it invokes onDismiss (manual dismiss, no waiting for a
 *     turn-terminal event).
 *
 * The turn-scoped auto-expiry timer lives in NautiloRuntimeProvider and is
 * not exercised here (it would require the full provider graph); this covers
 * the presentational dismiss path that the extraction made testable.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelFallbackStatusNotice } from "../../src/adapters/model-fallback-notice";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};
let container: HTMLElement;
let root: Root;

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const k of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

afterEach(() => {
  if (root) act(() => root.unmount());
});

afterAll(() => {
  Object.assign(globalThis, priorGlobals);
});

function renderNotice(onDismiss: () => void): HTMLElement {
  container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  act(() => {
    root.render(
      <ModelFallbackStatusNotice
        line="anthropic:claude-sonnet-4-6 timed out — trying anthropic:claude-opus-4-7"
        onDismiss={onDismiss}
      />,
    );
  });
  return container;
}

describe("ModelFallbackStatusNotice (D323)", () => {
  test("renders the status line and is interactive (not pointer-events-none)", () => {
    renderNotice(() => {});
    const wrapper = container.querySelector('[data-testid="model-fallback-status"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).not.toContain("pointer-events-none");
    expect(container.textContent).toContain("timed out — trying");
    // The dismiss affordance is a real button.
    expect(container.querySelector("button[aria-label='Dismiss']")).not.toBeNull();
  });

  test("clicking the pill invokes onDismiss", () => {
    const onDismiss = mock(() => {});
    renderNotice(onDismiss);
    const button = container.querySelector(
      "button[aria-label='Dismiss']",
    ) as unknown as HTMLElement;
    expect(button).not.toBeNull();
    act(() => {
      button.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
