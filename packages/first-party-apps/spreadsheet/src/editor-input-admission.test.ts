import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { PendingInputEditor } from "./editor-input-admission";
import { createEditorInputAdmission } from "./editor-input-admission";

describe("editor input admission", () => {
  let window: Window;
  let host: HTMLElement;
  let input: HTMLElement;

  beforeEach(() => {
    window = new Window();
    const domHost = window.document.createElement("div");
    const domInput = window.document.createElement("div");
    host = domHost as unknown as HTMLElement;
    input = domInput as unknown as HTMLElement;
    input.setAttribute("contenteditable", "true");
    host.append(input);
    window.document.body.append(domHost);
  });

  afterEach(() => { window.close(); });

  test("guards raw text and commits it through the editor public API", async () => {
    const states: boolean[] = [];
    const focused: Array<{ r: number; c: number }> = [];
    const admission = createEditorInputAdmission(host, (pending) => states.push(pending));
    const editor: PendingInputEditor = {
      getSelectionRangeOrActiveCell: () => [{ r: 4, c: 2 }, { r: 4, c: 2 }],
      focusCell: async (ref) => {
        focused.push(ref);
        admission.noteStoreChange();
      },
    };

    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(admission.pending).toBe(true);
    expect(states).toEqual([true]);

    await admission.commit(editor);
    expect(focused).toEqual([{ r: 4, c: 2 }]);
    expect(admission.pending).toBe(false);
    expect(states).toEqual([true, false]);
  });

  test("keeps input guarded after a failed commit and later shell focusout", async () => {
    const admission = createEditorInputAdmission(host, () => {});
    const shellButton = window.document.createElement("button");
    window.document.body.append(shellButton);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);

    expect(admission.commit({
      getSelectionRangeOrActiveCell: () => undefined,
      focusCell: async () => {},
    })).rejects.toThrow("Select a cell");
    expect(admission.pending).toBe(true);

    expect(admission.commit({
      getSelectionRangeOrActiveCell: () => [{ r: 1, c: 1 }, { r: 1, c: 1 }],
      focusCell: async () => { throw new Error("validation failed"); },
    })).rejects.toThrow("validation failed");
    expect(admission.pending).toBe(true);

    input.dispatchEvent(new window.FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: shellButton,
    }) as unknown as Event);
    expect(admission.pending).toBe(true);
  });

  test("preserves a rejected draft when focusCell resolves without a successful store change", async () => {
    const admission = createEditorInputAdmission(host, () => {});
    input.innerText = "before";
    input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    input.innerText = "rejected";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);

    expect(admission.commit({
      getSelectionRangeOrActiveCell: () => [{ r: 1, c: 1 }, { r: 1, c: 1 }],
      focusCell: async () => { input.innerText = ""; },
    })).rejects.toThrow("did not confirm");
    expect(admission.pending).toBe(true);
    expect(input.innerText).toBe("rejected");
  });

  test("allows an explicit commit of text proven unchanged from the pre-edit value", async () => {
    const admission = createEditorInputAdmission(host, () => {});
    input.innerText = "same";
    input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);

    await admission.commit({
      getSelectionRangeOrActiveCell: () => [{ r: 1, c: 1 }, { r: 1, c: 1 }],
      focusCell: async () => {},
    });
    expect(admission.pending).toBe(false);
  });

  test("blocks shell commits during composition and releases only after a successful store change", async () => {
    const states: boolean[] = [];
    const admission = createEditorInputAdmission(host, (pending) => states.push(pending));
    input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(admission.commit({
      getSelectionRangeOrActiveCell: () => [{ r: 1, c: 1 }, { r: 1, c: 1 }],
      focusCell: async () => {},
    })).rejects.toThrow("Finish composing");
    expect(admission.pending).toBe(true);

    input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event);
    admission.noteStoreChange();
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    expect(admission.pending).toBe(false);

    expect(states).toEqual([true, false]);
  });

  test("releases when a successful store change arrives after editor focusout", () => {
    const states: boolean[] = [];
    const admission = createEditorInputAdmission(host, (pending) => states.push(pending));
    const shellButton = window.document.createElement("button");
    window.document.body.append(shellButton);
    input.focus();
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);

    shellButton.focus();
    expect(admission.pending).toBe(true);
    expect(states).toEqual([true]);

    admission.noteStoreChange();
    expect(admission.pending).toBe(false);
    expect(states).toEqual([true, false]);
  });

  test("keeps a successful store change admitted until a focused editor leaves", () => {
    const admission = createEditorInputAdmission(host, () => {});
    input.focus();
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);

    admission.noteStoreChange();
    expect(admission.pending).toBe(true);

    input.blur();
    expect(admission.pending).toBe(false);
  });

  test("recognizes explicit cancel and a completed unchanged keyboard commit", () => {
    const states: boolean[] = [];
    const admission = createEditorInputAdmission(host, (pending) => states.push(pending));

    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    expect(admission.pending).toBe(false);

    input.innerText = "same";
    input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    expect(admission.pending).toBe(false);
    expect(states).toEqual([true, false, true, false]);
  });

  test("does not discard a changed edit when native Enter is rejected and blurs", () => {
    const admission = createEditorInputAdmission(host, () => {});
    const shellButton = window.document.createElement("button");
    window.document.body.append(shellButton);
    input.innerText = "before";
    input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    input.innerText = "rejected";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: shellButton,
    }) as unknown as Event);
    expect(admission.pending).toBe(true);

    input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Enter", bubbles: true }) as unknown as Event);
  });

  test("does not mistake focus leaving the grid for a committed edit", () => {
    const admission = createEditorInputAdmission(host, () => {});
    const shellButton = window.document.createElement("button");
    window.document.body.append(shellButton);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: shellButton }) as unknown as Event);
    expect(admission.pending).toBe(true);

    admission.dispose();
    expect(admission.pending).toBe(false);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(admission.pending).toBe(false);
  });

  test("keeps a raw formula visible through host resize and releases it after cancel or commit", () => {
    const admission = createEditorInputAdmission(host, () => {});
    input.innerText = "21";
    input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    input.innerText = "999";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    // The warning banner resized the engine, which repainted its saved value.
    input.innerText = "21";
    admission.restoreAfterRender();
    expect(input.innerText).toBe("999");
    expect(admission.pending).toBe(true);

    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    input.innerText = "21";
    admission.restoreAfterRender();
    expect(input.innerText).toBe("21");
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    expect(admission.pending).toBe(false);

    input.innerText = "777";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    admission.noteStoreChange();
    input.innerText = "next cell";
    admission.restoreAfterRender();
    expect(input.innerText).toBe("next cell");
    admission.dispose();
  });

  test("does not restore or commit an unfinished draft into a different cell", async () => {
    let selected = { r: 1, c: 1 };
    const admission = createEditorInputAdmission(host, () => {}, () => selected);
    input.innerText = "A1 saved";
    input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
    input.innerText = "A1 unfinished";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);

    selected = { r: 1, c: 2 };
    input.innerText = "B1 saved";
    admission.restoreAfterRender();
    expect(input.innerText).toBe("B1 saved");

    const focusCell = async () => {};
    expect(admission.commit({
      getSelectionRangeOrActiveCell: () => [selected, selected],
      focusCell,
    })).rejects.toThrow("Return to the cell with the unfinished edit");
    expect(admission.pending).toBe(true);
    admission.dispose();
  });

  test("restores the focused caret in the middle of a repainted draft", () => {
    const admission = createEditorInputAdmission(host, () => {});
    input.innerText = "abcdef";
    input.focus();
    const text = input.firstChild!;
    const selection = window.document.getSelection() as unknown as {
      setBaseAndExtent(anchor: unknown, anchorOffset: number, focus: unknown, focusOffset: number): void;
    };
    selection.setBaseAndExtent(text, 3, text, 3);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);

    input.innerText = "saved";
    admission.restoreAfterRender();

    expect(input.innerText).toBe("abcdef");
    const restored = window.document.getSelection() as unknown as {
      anchorNode: unknown;
      anchorOffset: number;
      focusOffset: number;
    };
    expect(restored.anchorNode).toBe(input.firstChild);
    expect(restored.anchorOffset).toBe(3);
    expect(restored.focusOffset).toBe(3);
    admission.dispose();
  });
});
