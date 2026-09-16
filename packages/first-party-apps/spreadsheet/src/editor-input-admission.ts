import type { Range, Ref } from "../engine/browser.js";

export type PendingInputEditor = {
  getSelectionRangeOrActiveCell(): Range | undefined;
  focusCell(ref: Ref): Promise<void>;
};

export type EditorInputAdmission = {
  readonly pending: boolean;
  commit(editor: PendingInputEditor): Promise<void>;
  noteStoreChange(): void;
  restoreAfterRender(): void;
  discard(): void;
  dispose(): void;
};

function editableIn(host: HTMLElement, target: EventTarget | null): HTMLElement | undefined {
  const ElementConstructor = host.ownerDocument.defaultView?.HTMLElement;
  if (!ElementConstructor || !(target instanceof ElementConstructor)) return undefined;
  const element = target;
  return host.contains(element) && element.getAttribute("contenteditable") === "true" ? element : undefined;
}

/** Tracks text that Wafflebase still owns only in its contenteditable DOM.
 * The editor's public focusCell API is the supported way to commit that text. */
export function createEditorInputAdmission(
  host: HTMLElement,
  onPendingChange: (pending: boolean) => void,
  selectedCell?: () => Ref | undefined,
): EditorInputAdmission {
  let pendingElement: HTMLElement | undefined;
  let baselineElement: HTMLElement | undefined;
  let baselineText: string | undefined;
  let draftText: string | undefined;
  let composing = false;
  let storeChanged = false;
  let keyboardFinish: "unchanged" | "cancel" | undefined;
  let disposed = false;
  let draftCell: Ref | undefined;
  let caret: { anchor: number; focus: number } | undefined;

  const sameCell = (): boolean => {
    if (!selectedCell) return true;
    const current = selectedCell();
    return Boolean(current && draftCell && current.r === draftCell.r && current.c === draftCell.c);
  };
  const captureCaret = (element: HTMLElement): void => {
    const selection = element.ownerDocument.getSelection();
    if (!selection?.anchorNode || !selection.focusNode
      || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return;
    const offset = (node: Node, end: number): number => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      range.setEnd(node, end);
      return range.toString().length;
    };
    caret = { anchor: offset(selection.anchorNode, selection.anchorOffset), focus: offset(selection.focusNode, selection.focusOffset) };
  };

  const update = (next: HTMLElement | undefined): void => {
    const wasPending = Boolean(pendingElement);
    pendingElement = next;
    if (!next) {
      composing = false;
      baselineElement = undefined;
      baselineText = undefined;
      draftText = undefined;
      storeChanged = false;
      keyboardFinish = undefined;
      draftCell = undefined;
      caret = undefined;
    }
    if (wasPending !== Boolean(next)) onPendingChange(Boolean(next));
  };
  const onInput = (event: Event): void => {
    const editable = editableIn(host, event.target);
    if (!editable) return;
    if (!pendingElement) {
      const ref = selectedCell?.();
      draftCell = ref ? { ...ref } : undefined;
    }
    // A later input supersedes any completion evidence for the earlier draft.
    storeChanged = false;
    keyboardFinish = undefined;
    draftText = editable.innerText;
    captureCaret(editable);
    update(editable);
  };
  const onCompositionStart = (event: Event): void => {
    const editable = editableIn(host, event.target);
    if (!editable) return;
    if (!pendingElement) {
      const ref = selectedCell?.();
      draftCell = ref ? { ...ref } : undefined;
    }
    composing = true;
    update(editable);
  };
  const onCompositionEnd = (): void => { composing = false; };
  const onFocusIn = (event: FocusEvent): void => {
    const editable = editableIn(host, event.target);
    if (!editable || pendingElement) return;
    baselineElement = editable;
    baselineText = editable.innerText;
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!pendingElement || event.target !== pendingElement || event.isComposing) return;
    if (event.key === "Escape") keyboardFinish = "cancel";
    else if (
      (event.key === "Enter" || event.key === "Tab")
      && baselineElement === pendingElement
      && baselineText === pendingElement.innerText
    ) keyboardFinish = "unchanged";
  };
  const onSelectionChange = (): void => {
    if (pendingElement && pendingElement.ownerDocument.activeElement === pendingElement
      && pendingElement.innerText === draftText) captureCaret(pendingElement);
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (
      (keyboardFinish === "cancel" && event.key === "Escape")
      || (keyboardFinish === "unchanged" && (event.key === "Enter" || event.key === "Tab"))
    ) keyboardFinish = undefined;
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (event.target !== pendingElement) return;
    const nextEditable = editableIn(host, event.relatedTarget);
    if (nextEditable) {
      update(nextEditable);
      return;
    }
    // A successful store callback proves a changed draft was committed. Escape
    // explicitly cancels it. Enter/Tab is safe only when the current editor
    // text exactly matches the value captured before editing; a rejected changed
    // value therefore remains guarded even when the engine discards and blurs it.
    if (storeChanged || keyboardFinish) update(undefined);
  };

  host.addEventListener("input", onInput, true);
  host.addEventListener("compositionstart", onCompositionStart, true);
  host.addEventListener("compositionend", onCompositionEnd, true);
  host.addEventListener("focusin", onFocusIn, true);
  host.addEventListener("keydown", onKeyDown, true);
  host.addEventListener("keyup", onKeyUp, true);
  host.addEventListener("focusout", onFocusOut, true);
  host.ownerDocument.addEventListener("selectionchange", onSelectionChange);

  return {
    get pending() { return Boolean(pendingElement); },
    async commit(editor) {
      if (!pendingElement) return;
      if (composing) throw new Error("Finish composing the cell before continuing.");
      if (!sameCell()) throw new Error("Return to the cell with the unfinished edit before saving, or press Escape to discard it.");
      const range = editor.getSelectionRangeOrActiveCell();
      if (!range) throw new Error("Select a cell before committing the edit.");
      const editable = pendingElement;
      const rawText = draftText ?? editable.innerText;
      const unchanged = baselineElement === editable && baselineText === rawText;
      editable.innerText = rawText;
      editable.focus();
      try {
        await editor.focusCell(range[0]);
      } catch (error) {
        editable.innerText = rawText;
        draftText = rawText;
        throw error;
      }
      if (!pendingElement || storeChanged || unchanged) {
        update(undefined);
        return;
      }
      editable.innerText = rawText;
      draftText = rawText;
      throw new Error("The editor did not confirm the pending cell edit. Correct the value or press Escape to discard it.");
    },
    noteStoreChange() {
      if (!pendingElement) return;
      storeChanged = true;
      if (pendingElement.ownerDocument.activeElement !== pendingElement) update(undefined);
    },
    restoreAfterRender() {
      // A host banner or viewport resize repaints the formula bar from the
      // saved cell. Keep the admitted raw draft visible until commit/cancel.
      if (!pendingElement?.isConnected || draftText === undefined || composing || storeChanged || keyboardFinish || !sameCell()) return;
      if (pendingElement.innerText === draftText) return;
      const focused = pendingElement.ownerDocument.activeElement === pendingElement;
      pendingElement.innerText = draftText;
      const text = pendingElement.firstChild;
      if (focused && caret && text?.nodeType === 3) {
        pendingElement.ownerDocument.getSelection()?.setBaseAndExtent(
          text, Math.min(caret.anchor, text.textContent?.length ?? 0),
          text, Math.min(caret.focus, text.textContent?.length ?? 0),
        );
      }
    },
    discard() { update(undefined); },
    dispose() {
      if (disposed) return;
      disposed = true;
      host.removeEventListener("input", onInput, true);
      host.removeEventListener("compositionstart", onCompositionStart, true);
      host.removeEventListener("compositionend", onCompositionEnd, true);
      host.removeEventListener("focusin", onFocusIn, true);
      host.removeEventListener("keydown", onKeyDown, true);
      host.removeEventListener("keyup", onKeyUp, true);
      host.removeEventListener("focusout", onFocusOut, true);
      host.ownerDocument.removeEventListener("selectionchange", onSelectionChange);
      update(undefined);
    },
  };
}
