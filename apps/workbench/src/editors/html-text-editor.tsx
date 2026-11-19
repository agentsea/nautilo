import { useCallback, useEffect, useRef, useState } from "react";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  createEditor,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
} from "@mdxeditor/lexical";
import { createEmptyHistoryState, registerHistory } from "@mdxeditor/lexical-history";
import { registerPlainText } from "@mdxeditor/lexical-plain-text";
import {
  applyHtmlRegionTexts,
  buildHtmlTextModel,
  type HtmlTextModel,
  type HtmlTextRegion,
} from "./html-text-model";

export type HtmlTextEditorProps = {
  value: string;
  onChange: (source: string) => void;
  onSave?: () => void;
};

// The edit frame has same-origin DOM access for the trusted parent editor, but
// never script execution. This is deliberately separate from the script-capable
// opaque-origin Reader preview. No authored document code receives save access.
const EDIT_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const EDIT_STYLE = `
html { scroll-behavior: auto !important; }
[data-nautilo-html-region] { cursor: text; }
[data-nautilo-html-region]:empty { min-height: 1em; }
[data-nautilo-html-region]:hover { outline: 1px dashed #64748b; outline-offset: 3px; }
[data-nautilo-html-region]:focus { outline: 2px solid #6366f1; outline-offset: 3px; }
[data-nautilo-html-region][contenteditable=true] > p { margin: 0; display: contents; }
.nautilo-html-bold { font-weight: bold; }
.nautilo-html-italic { font-style: italic; }
.nautilo-html-underline { text-decoration: underline; }
.nautilo-html-strikethrough { text-decoration: line-through; }
.nautilo-html-code { font-family: monospace; }
`;

function createModel(source: string): HtmlTextModel {
  return buildHtmlTextModel(source, { previewCsp: EDIT_CSP, previewStyle: EDIT_STYLE });
}

export function HtmlTextEditor({ value, onChange, onSave }: HtmlTextEditorProps) {
  const [session, setSession] = useState(() => ({ model: createModel(value), generation: 0 }));
  const [error, setError] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const activeEditor = useRef<LexicalEditor | null>(null);
  const disposeFrame = useRef<() => void>(() => {});
  const emittedSource = useRef(value);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };

  useEffect(() => {
    if (value === emittedSource.current) return;
    // Only an external change (source editing, conflict resolution, remote
    // update) replaces the frame. Own autosave echoes keep selection/history.
    emittedSource.current = value;
    disposeFrame.current();
    activeEditor.current = null;
    setActiveLabel(null);
    setCanUndo(false);
    setCanRedo(false);
    setError(null);
    setSession((previous) => ({ model: createModel(value), generation: previous.generation + 1 }));
  }, [value]);

  useEffect(() => () => disposeFrame.current(), []);

  const initializeFrame = useCallback(() => {
    disposeFrame.current();
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    if (!doc || !frame?.contentWindow) return;
    const frameWindow = frame.contentWindow;
    const model = session.model;
    const edits = new Map<string, string>();
    const editors = new Map<HTMLElement, LexicalEditor>();
    const cleanups: Array<() => void> = [];
    const originalMarkup = new Map<HTMLElement, string>();

    function activate(element: HTMLElement, region: HtmlTextRegion) {
      const existing = editors.get(element);
      if (existing) {
        activeEditor.current = existing;
        setActiveLabel(region.label);
        return existing;
      }
      const editor = createEditor({
        namespace: "html-text-region",
        onError: (caught) => setError(caught.message),
        theme: { text: {
          bold: "nautilo-html-bold", italic: "nautilo-html-italic",
          underline: "nautilo-html-underline", strikethrough: "nautilo-html-strikethrough",
          code: "nautilo-html-code",
        } },
      });
      originalMarkup.set(element, element.innerHTML);
      const originalWhiteSpace = frameWindow.getComputedStyle(element).whiteSpace;
      element.contentEditable = "true";
      element.setAttribute("role", "textbox");
      element.setAttribute("aria-label", region.label);
      element.setAttribute("aria-multiline", "false");
      editor.setRootElement(element);
      element.style.whiteSpace = originalWhiteSpace;
      const unregisterPlain = registerPlainText(editor);
      editor.update(() => {
        const paragraph = $createParagraphNode();
        for (const run of region.runs) {
          const text = $createTextNode(run.text);
          for (const mark of run.marks) text.toggleFormat(mark);
          paragraph.append(text);
        }
        $getRoot().clear().append(paragraph);
      }, { discrete: true });
      // A zero delay makes every committed edit individually undoable; there is
      // no timer, retry, document-size, or block-count policy in this editor.
      const history = createEmptyHistoryState();
      history.current = { editor, editorState: editor.getEditorState() };
      const unregisterHistory = registerHistory(editor, history, 0);
      const unregisterUpdate = editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
        if (!dirtyElements.size && !dirtyLeaves.size) return;
        const text = editorState.read(() => $getRoot().getTextContent());
        edits.set(region.id, text);
        const result = applyHtmlRegionTexts(model, model.source,
          [...edits].map(([regionId, nextText]) => ({ regionId, text: nextText })));
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setError(null);
        emittedSource.current = result.source;
        callbacks.current.onChange(result.source);
      });
      const unregisterPaste = editor.registerCommand(PASTE_COMMAND, (event) => {
        if (originalWhiteSpace !== "normal" && originalWhiteSpace !== "nowrap") return false;
        const clipboard = event && "clipboardData" in event ? event.clipboardData : null;
        if (!clipboard) return false;
        const text = clipboard.getData("text/plain");
        if (!/[\r\n]/.test(text)) return false;
        event.preventDefault();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(text.replace(/\r\n?|\n/g, " "));
        return true;
      }, COMMAND_PRIORITY_HIGH);
      const unregisterEnter = editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
        event?.preventDefault();
        element.blur();
        return true;
      }, COMMAND_PRIORITY_HIGH);
      const unregisterUndo = editor.registerCommand(CAN_UNDO_COMMAND, (enabled) => {
        if (activeEditor.current === editor) setCanUndo(enabled);
        return false;
      }, COMMAND_PRIORITY_LOW);
      const unregisterRedo = editor.registerCommand(CAN_REDO_COMMAND, (enabled) => {
        if (activeEditor.current === editor) setCanRedo(enabled);
        return false;
      }, COMMAND_PRIORITY_LOW);
      const focus = () => {
        activeEditor.current = editor;
        setActiveLabel(region.label);
        setCanUndo(history.undoStack.length > 0);
        setCanRedo(history.redoStack.length > 0);
      };
      element.addEventListener("focus", focus);
      cleanups.push(() => {
        unregisterPlain(); unregisterHistory(); unregisterUpdate(); unregisterPaste(); unregisterEnter(); unregisterUndo(); unregisterRedo();
        element.removeEventListener("focus", focus);
        editor.setRootElement(null);
      });
      editors.set(element, editor);
      focus();
      return editor;
    }

    for (const region of model.regions) {
      const element = doc.querySelector<HTMLElement>(`[data-nautilo-html-region="${region.id}"]`);
      if (!element) continue;
      element.tabIndex = 0;
      element.setAttribute("aria-description", `Edit ${region.label}`);
      const focus = () => {
        const isNew = !editors.has(element);
        const editor = activate(element, region);
        if (isNew) editor.focus(undefined, { defaultSelection: "rootStart" });
      };
      element.addEventListener("focus", focus);
      cleanups.push(() => element.removeEventListener("focus", focus));
    }
    const pointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const element = target?.closest<HTMLElement>("[data-nautilo-html-region]");
      const region = model.regions.find((candidate) => candidate.id === element?.dataset.nautiloHtmlRegion);
      if (!element || !region || editors.has(element)) return;
      event.preventDefault();
      const editor = activate(element, region);
      editor.focus(() => {
        const pointDoc = doc as Document & {
          caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
          caretRangeFromPoint?: (x: number, y: number) => Range | null;
        };
        const point = pointDoc.caretPositionFromPoint?.(event.clientX, event.clientY);
        const range = pointDoc.caretRangeFromPoint?.(event.clientX, event.clientY) ?? doc.createRange();
        if (point) { range.setStart(point.offsetNode, point.offset); range.collapse(true); }
        if (element.contains(range.startContainer)) {
          const selection = doc.defaultView?.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }, { defaultSelection: "rootStart" });
    };
    const click = (event: MouseEvent) => {
      // Links are text targets while editing, never navigation. Selection is
      // handled on pointerdown before the first activation replaces DOM nodes.
      event.preventDefault();
    };
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        callbacks.current.onSave?.();
      } else if (event.key === "Escape") {
        (doc.activeElement as HTMLElement | null)?.blur();
        iframeRef.current?.focus();
      }
    };
    doc.addEventListener("pointerdown", pointerDown, true);
    doc.addEventListener("click", click);
    doc.addEventListener("keydown", key, true);
    disposeFrame.current = () => {
      doc.removeEventListener("pointerdown", pointerDown, true);
      doc.removeEventListener("click", click);
      doc.removeEventListener("keydown", key, true);
      for (const cleanup of cleanups) cleanup();
      for (const [element, markup] of originalMarkup) {
        element.innerHTML = markup;
        element.removeAttribute("contenteditable");
      }
      cleanups.length = 0;
    };
  }, [session]);

  const command = (redo: boolean) => {
    const editor = activeEditor.current;
    if (!editor) return;
    editor.dispatchCommand(redo ? REDO_COMMAND : UNDO_COMMAND, undefined);
    editor.getRootElement()?.focus({ preventScroll: true });
  };

  if (session.model.blockedReason) {
    return <div className="p-4 text-sm text-foreground-muted">{session.model.blockedReason} Use its app or Source to edit this document.</div>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="html-text-editor">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-foreground-muted">
        <button type="button" disabled={!canUndo} onMouseDown={(event) => event.preventDefault()} onClick={() => command(false)} className="rounded border border-border px-2 py-1 disabled:opacity-40">Undo</button>
        <button type="button" disabled={!canRedo} onMouseDown={(event) => event.preventDefault()} onClick={() => command(true)} className="rounded border border-border px-2 py-1 disabled:opacity-40">Redo</button>
        <span>{activeLabel ? `Editing ${activeLabel}. Enter or Esc to finish.` : "Click text to edit. Tab moves between text areas."}</span>
        <span className="ml-auto">Page scripts paused while editing.</span>
      </div>
      {error ? <p role="alert" className="p-3 text-sm text-[var(--error)]">{error}</p> : null}
      {session.model.regions.length === 0 ? <p className="p-3 text-sm text-foreground-muted">No editable text was found. Text created by scripts can be changed in Source.</p> : null}
      <iframe key={session.generation} ref={iframeRef} title="Edit HTML text" sandbox="allow-same-origin" srcDoc={session.model.previewHtml} onLoad={initializeFrame} className="min-h-0 w-full flex-1 border-0 bg-white" />
    </div>
  );
}
