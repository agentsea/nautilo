import { describe, expect, test } from "bun:test";
import { MemDocStore } from "@nautilo/office-docs/browser";
import { createBlock, createTableBlock, getBlockText, type Document } from "@nautilo/office-docs/node";
import { NautiloDocStore } from "./nautilo-doc-store";
import { createDefaultManifest, parseWriterHtml, serializeWriterHtml } from "./office-document";

function paragraph(id: string, text: string) {
  return { ...createBlock("paragraph"), id, inlines: [{ text, style: {} }] };
}

async function fixture(document: Document = { blocks: [paragraph("one", "Alpha"), paragraph("two", "Beta")] }) {
  const manifest = { ...createDefaultManifest(), extension: { source: "legacy" } };
  const initial = serializeWriterHtml(manifest, document);
  const writes: string[] = [];
  let changes = 0;
  const store = new NautiloDocStore(initial, {
    createStore: (doc) => new MemDocStore(doc),
    writePatch: ({ container }) => { writes.push(container); return true; },
    onLocalChange: () => { changes++; },
  });
  await store.initBase();
  return { store, initial, writes, changes: () => changes };
}

describe("Writer with the owned Docs store", () => {
  test("nested batches publish one completed draft and one undoable saved change", async () => {
    const { store, writes, changes } = await fixture();
    const before = store.getDocument();
    store.batch(() => {
      store.insertText("one", 5, "!");
      store.batch(() => {
        store.snapshot();
        store.insertText("two", 4, "?");
      });
      expect(changes()).toBe(0);
    });
    const after = store.getDocument();
    expect(changes()).toBe(1);
    expect(await store.flush()).toBe(true);
    expect(writes).toHaveLength(1);
    store.undo();
    expect(store.getDocument()).toEqual(before);
    expect(store.canUndo()).toBe(false);
    store.redo();
    expect(store.getDocument()).toEqual(after);
    await store.flush();
  });

  test("no-op batches retain redo and produce no dirty publication or write", async () => {
    const { store, writes, changes } = await fixture();
    store.batch(() => store.insertText("one", 5, "!"));
    store.undo();
    const priorChanges = changes();
    store.batch(() => store.batch(() => {}));
    store.applyStyles([]);
    store.insertBlocksAfter("one", []);
    expect(changes()).toBe(priorChanges);
    expect(store.canRedo()).toBe(true);
    expect(store.hasUnsavedLocalEdits()).toBe(false);
    await store.flush();
    expect(writes).toHaveLength(0);
  });

  test("a throwing batch exposes its surviving draft, can undo it, and unwinds grouping", async () => {
    const { store, changes } = await fixture();
    const before = store.getDocument();
    expect(() => store.batch(() => {
      store.insertText("one", 5, "!");
      throw new Error("interrupted edit");
    })).toThrow("interrupted edit");
    expect(changes()).toBe(1);
    expect(store.hasUnsavedLocalEdits()).toBe(true);
    store.undo();
    expect(store.getDocument()).toEqual(before);
    store.batch(() => store.insertText("two", 4, "?"));
    expect(getBlockText(store.getDocument().blocks[1]!)).toBe("Beta?");
    expect(changes()).toBe(3);
    await store.flush();
  });

  test("multi-range style changes retain rich runs and undo together", async () => {
    const { store } = await fixture();
    const before = store.getDocument();
    store.applyStyles([
      { blockId: "one", fromOffset: 0, toOffset: 2, style: { bold: true, fontSize: 18 } },
      { blockId: "two", fromOffset: 1, toOffset: 4, style: { italic: true, fontSize: 24 } },
    ]);
    const styled = store.getDocument();
    expect(styled.blocks[0]!.inlines[0]!.style).toMatchObject({ bold: true, fontSize: 18 });
    expect(styled.blocks[1]!.inlines[1]!.style).toMatchObject({ italic: true, fontSize: 24 });
    store.undo();
    expect(store.getDocument()).toEqual(before);
    expect(store.canUndo()).toBe(false);
    store.redo();
    expect(store.getDocument()).toEqual(styled);
    await store.flush();
  });

  test("ordered multi-block insertion works inside a table cell as one undo unit", async () => {
    const table = createTableBlock(1, 1);
    table.tableData!.rows[0]!.cells[0]!.blocks = [paragraph("cell", "Cell")];
    const { store } = await fixture({ blocks: [table] });
    const before = store.getDocument();
    store.insertBlocksAfter("cell", [paragraph("a", "First"), paragraph("b", "Second")]);
    expect(store.getDocument().blocks[0]!.tableData!.rows[0]!.cells[0]!.blocks.map(b => b.id)).toEqual(["cell", "a", "b"]);
    store.undo();
    expect(store.getDocument()).toEqual(before);
    expect(store.canUndo()).toBe(false);
    await store.flush();
  });

  test("preserves safe legacy fields through load, edit, save and reopen without an open-time write", async () => {
    const block = Object.assign(paragraph("one", "Legacy"), { extension: { annotation: "retained" } });
    const document = Object.assign({
      blocks: [block, createTableBlock(1, 2)],
      header: { blocks: [paragraph("header", "Header")] },
      footer: { blocks: [paragraph("footer", "Footer")] },
    }, { extension: { revisionLabel: "original" } });
    const { store, initial, writes } = await fixture(document);
    expect(await store.flush()).toBe(true);
    expect(writes).toHaveLength(0);
    store.batch(() => store.insertText("one", 6, " edited"));
    await store.flush();
    const saved = writes[0]!;
    const parsed = parseWriterHtml(saved);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.document.manifest).toMatchObject({ extension: { source: "legacy" } });
    expect(parsed.document.document).toMatchObject({ extension: { revisionLabel: "original" } });
    expect(parsed.document.document.blocks[0]).toMatchObject({ extension: { annotation: "retained" } });
    const reopened = new NautiloDocStore(saved, {
      createStore: doc => new MemDocStore(doc),
      writePatch: () => { throw new Error("reopen must not write"); },
    });
    expect(reopened.getDocument()).toEqual(store.getDocument());
    expect(await reopened.flush()).toBe(true);
    expect(saved).not.toBe(initial);
  });

  test("refuses malformed existing containers instead of creating a blank writable document", () => {
    expect(() => new NautiloDocStore("broken existing document", {
      createStore: doc => new MemDocStore(doc),
      writePatch: () => { throw new Error("must not write"); },
    })).toThrow();
  });
});
