import { afterEach, describe, expect, it } from "vitest";
import type { LitElement } from "lit";

describe("nw-button", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("dispatches nw-action with data-action detail", async () => {
    const el = document.createElement("nw-button") as LitElement;
    el.setAttribute("data-action", "save");
    el.textContent = "Save";
    document.body.append(el);
    await el.updateComplete;

    const evt = new Promise<CustomEvent<{ action: string }>>((resolve) => {
      el.addEventListener("nw-action", (e) => {
        resolve(e as CustomEvent<{ action: string }>);
      }, { once: true });
    });

    el.shadowRoot?.querySelector("button")?.click();
    const fired = await evt;
    expect(fired.detail.action).toBe("save");
    expect(fired.bubbles).toBe(true);
    expect(fired.composed).toBe(true);
  });
});
