import { afterEach, describe, expect, it } from "vitest";
import type { LitElement } from "lit";

describe("nw-doc", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders article wrapper with slotted heading", async () => {
    const el = document.createElement("nw-doc") as LitElement;
    el.innerHTML = "<h2>Title</h2>";
    document.body.append(el);
    await el.updateComplete;
    const article = el.shadowRoot?.querySelector("article");
    expect(article).toBeTruthy();
    expect(article?.querySelector("slot")).toBeTruthy();
  });
});
