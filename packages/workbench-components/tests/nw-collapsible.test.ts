import { afterEach, describe, expect, it } from "vitest";
import type { LitElement } from "lit";
import type { NwCollapsible } from "../src/components/nw-collapsible.js";

describe("nw-collapsible", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("toggles open and dispatches nw-collapsible-toggle", async () => {
    const el = document.createElement("nw-collapsible") as NwCollapsible & LitElement;
    el.innerHTML = `<span slot="summary">More</span><p>Body</p>`;
    document.body.append(el);
    await el.updateComplete;

    const p = new Promise<CustomEvent<{ open: boolean }>>((resolve) => {
      el.addEventListener("nw-collapsible-toggle", (e) => {
        resolve(e as CustomEvent<{ open: boolean }>);
      }, { once: true });
    });

    el.shadowRoot?.querySelector("button")?.click();
    const evt = await p;
    expect(evt.detail.open).toBe(true);
    expect(el.open).toBe(true);
    expect(el.shadowRoot?.querySelector(".content")?.hasAttribute("hidden")).toBe(
      false,
    );
  });
});
