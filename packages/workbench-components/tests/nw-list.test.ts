import { afterEach, describe, expect, it } from "vitest";

describe("nw-list", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("toggles li data-checked and emits nw-list-change", async () => {
    const el = document.createElement("nw-list");
    el.innerHTML = `<ul><li id="x">One</li></ul>`;
    document.body.append(el);

    const li = el.querySelector("li#x");
    expect(li).toBeTruthy();

    const p = new Promise<CustomEvent<{ checked: boolean; id: string }>>(
      (resolve) => {
        el.addEventListener("nw-list-change", (e) => {
          resolve(e as CustomEvent<{ checked: boolean; id: string }>);
        }, { once: true });
      },
    );

    li!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true }),
    );

    const evt = await p;
    expect(evt.detail.checked).toBe(true);
    expect(evt.detail.id).toBe("x");
    expect(li!.getAttribute("data-checked")).toBe("true");
  });
});
