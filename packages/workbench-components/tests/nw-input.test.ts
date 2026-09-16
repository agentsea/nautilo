import { afterEach, describe, expect, it } from "vitest";

describe("nw-input", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("emits nw-input-change when the field changes", async () => {
    const el = document.createElement("nw-input");
    document.body.append(el);
    el.value = "a";
    await el.updateComplete;

    const p = new Promise<CustomEvent<{ value: string }>>((resolve) => {
      el.addEventListener("nw-input-change", (e) => {
        resolve(e as CustomEvent<{ value: string }>);
      }, { once: true });
    });

    const input = el.shadowRoot?.querySelector("input");
    expect(input).toBeTruthy();
    input!.value = "ab";
    input!.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

    const evt = await p;
    expect(evt.detail.value).toBe("ab");
    expect(evt.bubbles).toBe(true);
    expect(evt.composed).toBe(true);
  });
});
