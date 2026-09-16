import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ConnectionDisclosureControl, connectionDisclosureStorageKey, useConnectionDisclosure } from "./connection-disclosure";

function Probe({ viewerKey, forceOpen = false, routeHash, routeKey }: { viewerKey: string | null; forceOpen?: boolean; routeHash?: string; routeKey?: string }) {
  const disclosure = useConnectionDisclosure({ cardId: "test-card", viewerKey, forceOpen, routeHash, routeKey });
  return <section id="test-card" tabIndex={-1}><ConnectionDisclosureControl expanded={disclosure.expanded} detailsId={disclosure.detailsId} onToggle={disclosure.toggle} /><div id={disclosure.detailsId} hidden={!disclosure.expanded}><input aria-label="Mounted controller" /></div></section>;
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  localStorage.clear();
  window.location.hash = "";
});

describe("connection disclosure", () => {
  test("keeps its body mounted while hidden and scopes the remembered choice to the viewer", () => {
    const view = render(<Probe viewerKey="viewer-a" />);
    fireEvent.click(view.getByRole("button", { name: "Collapse" }));

    const details = view.container.querySelector("input[aria-label='Mounted controller']")?.parentElement!;
    expect(details.hidden).toBe(true);
    expect(localStorage.getItem(connectionDisclosureStorageKey("viewer-a", "test-card"))).toBe("collapsed");

    view.unmount();
    const otherViewer = render(<Probe viewerKey="viewer-b" />);
    expect(otherViewer.getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded")).toBe("true");
  });

  test("force-open reveals recovery without overwriting the ordinary collapsed preference", () => {
    const view = render(<Probe viewerKey="viewer-a" />);
    fireEvent.click(view.getByRole("button", { name: "Collapse" }));

    view.rerender(<Probe viewerKey="viewer-a" forceOpen />);
    expect(view.getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem(connectionDisclosureStorageKey("viewer-a", "test-card"))).toBe("collapsed");

    view.rerender(<Probe viewerKey="viewer-a" />);
    expect(view.getByRole("button", { name: "Expand" }).getAttribute("aria-expanded")).toBe("false");
  });

  test("reveals a raw card hash without changing the stored preference", () => {
    localStorage.setItem(connectionDisclosureStorageKey("viewer-a", "test-card"), "collapsed");
    window.location.hash = "#test-card";
    const view = render(<Probe viewerKey="viewer-a" />);
    expect(view.getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem(connectionDisclosureStorageKey("viewer-a", "test-card"))).toBe("collapsed");

    fireEvent.click(view.getByRole("button", { name: "Collapse" }));
    expect(view.getByRole("button", { name: "Expand" }).getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelector("input[aria-label='Mounted controller']")?.parentElement?.hidden).toBe(true);
  });

  test("force-opens a persisted card after Router navigation", () => {
    localStorage.setItem(connectionDisclosureStorageKey("viewer-a", "test-card"), "collapsed");
    const view = render(<Probe viewerKey="viewer-a" routeHash="" routeKey="initial" />);
    expect(view.getByRole("button", { name: "Expand" })).toBeTruthy();

    view.rerender(<Probe viewerKey="viewer-a" routeHash="#test-card" routeKey="next" />);
    expect(view.getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem(connectionDisclosureStorageKey("viewer-a", "test-card"))).toBe("collapsed");

    fireEvent.click(view.getByRole("button", { name: "Collapse" }));
    expect(view.getByRole("button", { name: "Expand" }).getAttribute("aria-expanded")).toBe("false");
  });
});
