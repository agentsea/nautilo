import { afterEach, describe, expect, it } from "vitest";

describe("nw-tabs", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("activates a tab and shows matching panel", async () => {
    const el = document.createElement("nw-tabs");
    el.innerHTML = `
      <button slot="tab" type="button" data-tab="a">A</button>
      <button slot="tab" type="button" data-tab="b">B</button>
      <section slot="panel" data-tab="a">Panel A</section>
      <section slot="panel" data-tab="b">Panel B</section>
    `;
    document.body.append(el);
    await el.updateComplete;
    await new Promise<void>((resolve) => {
      queueMicrotask(() => resolve());
    });

    const tabs = [...el.querySelectorAll('[slot="tab"]')];
    const panels = [...el.querySelectorAll('[slot="panel"]')];
    expect(tabs.length).toBe(2);
    expect(panels.length).toBe(2);

    const p = new Promise<CustomEvent<{ tab: string }>>((resolve) => {
      el.addEventListener("nw-tabs-change", (e) => {
        resolve(e as CustomEvent<{ tab: string }>);
      }, { once: true });
    });

    (tabs[1]! as HTMLButtonElement).click();
    const evt = await p;
    expect(evt.detail.tab).toBe("b");
    expect(tabs[1]!.getAttribute("data-active")).toBe("true");
    expect(panels[1]!.getAttribute("data-active")).toBe("true");
  });
});
