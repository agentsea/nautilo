import { afterEach, describe, expect, it } from "vitest";
import type { LitElement } from "lit";

describe("nw-card", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders slotted content in shadow section", async () => {
    const el = document.createElement("nw-card") as LitElement;
    el.innerHTML = "<p>Inside</p>";
    document.body.append(el);
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("section")).toBeTruthy();
    expect(el.textContent?.trim()).toBe("Inside");
  });
});
