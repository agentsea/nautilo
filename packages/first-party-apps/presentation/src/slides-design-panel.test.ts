import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mountSlidesDesignPanel } from "./slides-design-panel";
import { createSlideDocument, serializeSlideHtml } from "./slide-document";

test("candidate and current Design panels retain separate accessible tab relationships", () => {
  const window = new Window();
  const first = window.document.createElement("aside");
  const candidate = window.document.createElement("aside");
  window.document.body.append(first, candidate);
  const callbacks = { theme() {}, layout() {}, close() {} };
  const current = mountSlidesDesignPanel(first as unknown as HTMLElement, callbacks);
  const replacement = mountSlidesDesignPanel(candidate as unknown as HTMLElement, callbacks);
  try {
    const ids = [...window.document.querySelectorAll("[id]")].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const host of [first, candidate]) {
      for (const tab of host.querySelectorAll('[role="tab"]')) {
        const target = window.document.getElementById(tab.getAttribute("aria-controls")!);
        expect(target?.parentElement).toBe(tab.parentElement?.parentElement);
        expect(target?.getAttribute("aria-labelledby")).toBe(tab.id);
      }
    }
    current.dispose();
    for (const tab of candidate.querySelectorAll('[role="tab"]')) {
      expect(window.document.getElementById(tab.getAttribute("aria-controls")!)).not.toBeNull();
    }
  } finally {
    current.dispose();
    replacement.dispose();
    window.close();
  }
});

test("My Templates ignores a late list after disposal", async () => {
  const window = new Window();
  const host = window.document.createElement("aside");
  window.document.body.append(host);
  let resolveList!: (value: Array<{ id: string; name: string }>) => void;
  const list = new Promise<Array<{ id: string; name: string }>>((resolve) => { resolveList = resolve; });
  const handle = mountSlidesDesignPanel(host as unknown as HTMLElement, {
    theme() {}, layout() {}, template() {}, close() {},
  }, {
    list: () => list,
    read: async () => ({ content: serializeSlideHtml(createSlideDocument()) }),
    save: async (input) => ({ id: "saved", name: input.name }),
    remove: async () => {},
  });
  handle.refresh(createSlideDocument(), [], createSlideDocument().slides[0]?.id);
  (host.querySelectorAll('[role="tab"]')[2] as unknown as HTMLButtonElement).click();
  expect(host.textContent).toContain("Loading templates…");
  handle.dispose();
  resolveList([{ id: "late", name: "Late template" }]);
  await Promise.resolve();
  await Promise.resolve();
  expect(host.textContent).not.toContain("Late template");
  window.close();
});

test("My Templates exposes a retry after a library failure", async () => {
  const window = new Window();
  const host = window.document.createElement("aside");
  window.document.body.append(host);
  let attempts = 0;
  const handle = mountSlidesDesignPanel(host as unknown as HTMLElement, {
    theme() {}, layout() {}, close() {},
  }, {
    list: async () => { attempts += 1; if (attempts === 1) throw new Error("permission denied"); return []; },
    read: async () => { throw new Error("not called"); },
    save: async (input) => ({ id: "saved", name: input.name }),
    remove: async () => {},
  });
  handle.refresh(createSlideDocument(), [], undefined);
  (host.querySelectorAll('[role="tab"]')[2] as unknown as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
  expect(host.textContent).toContain("Couldn’t load templates: permission denied");
  handle.refresh(createSlideDocument(), [], undefined);
  handle.refresh(createSlideDocument(), [], undefined);
  expect(attempts).toBe(1);
  (host.querySelector(".ps-design-panel__retry") as unknown as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
  expect(host.textContent).toContain("No saved templates yet.");
  handle.dispose();
  window.close();
});

test("My Templates reveals cards before sequential preview reads finish", async () => {
  const window = new Window();
  const host = window.document.createElement("aside");
  window.document.body.append(host);
  let finishFirst!: (value: { content: string }) => void;
  const first = new Promise<{ content: string }>((resolve) => { finishFirst = resolve; });
  const reads: string[] = [];
  const handle = mountSlidesDesignPanel(host as unknown as HTMLElement, {
    theme() {}, layout() {}, close() {},
  }, {
    list: async () => [{ id: "one", name: "One" }, { id: "two", name: "Two" }],
    read: (id) => { reads.push(id); return id === "one" ? first : Promise.resolve({ content: serializeSlideHtml(createSlideDocument()) }); },
    save: async (input) => ({ id: "saved", name: input.name }), remove: async () => {},
  });
  handle.refresh(createSlideDocument(), [], undefined);
  (host.querySelectorAll('[role="tab"]')[2] as unknown as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
  expect(host.querySelectorAll(".ps-template-card")).toHaveLength(2);
  expect(reads).toEqual(["one"]);
  finishFirst({ content: serializeSlideHtml(createSlideDocument()) });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(reads).toEqual(["one", "two"]);
  handle.dispose(); window.close();
});

test("My Templates confirms deletion inside the sandboxed panel", async () => {
  const window = new Window();
  const host = window.document.createElement("aside");
  window.document.body.append(host);
  const removed: string[] = [];
  let summaries = [{ id: "launch", name: "Launch hero" }];
  const handle = mountSlidesDesignPanel(host as unknown as HTMLElement, {
    theme() {}, layout() {}, close() {},
  }, {
    list: async () => summaries,
    read: async () => ({ content: serializeSlideHtml(createSlideDocument()) }),
    save: async (input) => ({ id: "saved", name: input.name }),
    remove: async (id) => { removed.push(id); summaries = []; },
  });
  handle.refresh(createSlideDocument(), [], undefined);
  (host.querySelectorAll('[role="tab"]')[2] as unknown as HTMLButtonElement).click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const remove = host.querySelector('[aria-label="Delete Launch hero template"]') as unknown as HTMLButtonElement;
  remove.click();
  const confirmation = host.querySelector('[role="alertdialog"]');
  expect(confirmation?.textContent).toContain("Inserted slides will not be affected.");
  (confirmation?.querySelector(".ps-template-card__cancel-delete") as unknown as HTMLButtonElement).click();
  expect(removed).toEqual([]);
  remove.click();
  (host.querySelector(".ps-template-card__confirm-delete") as unknown as HTMLButtonElement).click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(removed).toEqual(["launch"]);
  expect(host.textContent).toContain("No saved templates yet.");
  handle.dispose(); window.close();
});
