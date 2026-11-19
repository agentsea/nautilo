import { useCallback, useEffect, useRef, useState } from "react";
import {
  $createParagraphNode, ParagraphNode, TextNode, $getRoot, $getSelection, $isRangeSelection, $setSelection,
  COMMAND_PRIORITY_HIGH, createEditor, KEY_ENTER_COMMAND, PASTE_COMMAND,
  REDO_COMMAND, UNDO_COMMAND, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG, type EditorState, type LexicalEditor,
} from "@mdxeditor/lexical";
import { registerPlainText } from "@mdxeditor/lexical-plain-text";
import { applyHtmlRegionTexts, buildHtmlTextModel, type HtmlTextModel, type HtmlTextRegion } from "./html-text-model";
import { HtmlTextDocumentHistory, type HtmlTextHistoryView } from "./html-text-history";
import { HtmlSourceInlineNode, inlineAppearance, $appendHtmlRegionRuns, $reconcileHtmlRegion } from "./html-text-inline-node";
import { $htmlTextSelectionOffsets, $htmlTextSelectionAtOffsets, captureHtmlDomSelection, type HtmlTextSelectionOffsets } from "./html-text-selection";

export type HtmlTextEditorProps = {
  value: string;
  onChange: (source: string) => void;
  onSave?: () => void;
  history?: HtmlTextDocumentHistory;
  /** A hidden Text surface retains its live session while Source is visible. */
  active?: boolean;
};

// Parent-owned editing code can access this frame; authored scripts never can.
const EDIT_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const EDIT_STYLE = `
html { scroll-behavior: auto !important; }
[data-nautilo-html-region] { cursor: text; }
[data-nautilo-html-region]:empty { min-height: 1em; }
[data-nautilo-html-region]:hover { outline: 1px dashed #64748b; outline-offset: 3px; }
[data-nautilo-html-region]:focus { outline: 2px solid #6366f1; outline-offset: 3px; }
[data-nautilo-html-region][contenteditable=true] > p { all: unset; display: contents; }
`;
const RESTORE_TAG = SKIP_SCROLL_INTO_VIEW_TAG;
type TextView = Extract<HtmlTextHistoryView, { kind: "text" }>;
function createModel(source: string): HtmlTextModel { return buildHtmlTextModel(source, { previewCsp: EDIT_CSP, previewStyle: EDIT_STYLE }); }

export function HtmlTextEditor({ value, onChange, onSave, history: sharedHistory, active = true }: HtmlTextEditorProps) {
  const ownedHistory = useRef<HtmlTextDocumentHistory | null>(null);
  ownedHistory.current ??= new HtmlTextDocumentHistory(value);
  const history = sharedHistory ?? ownedHistory.current;
  const [session, setSession] = useState(() => ({ model: createModel(value), identity: {}, generation: 0 }));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [historyStatus, setHistoryStatus] = useState(() => history.getSnapshot());
  const historyStatusRef = useRef(historyStatus);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const activeEditor = useRef<LexicalEditor | null>(null);
  const disposeFrame = useRef<() => void>(() => {});
  const restoreInFrame = useRef<(view: TextView, focus: boolean) => boolean>(() => false);
  const pendingRestore = useRef<TextView | null>(null);
  const emittedSource = useRef(value);
  const renderedSource = useRef(value);
  const isActive = useRef(active);
  isActive.current = active;
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };

  const rebuild = useCallback((source: string) => {
    disposeFrame.current();
    restoreInFrame.current = () => false;
    activeEditor.current = null;
    renderedSource.current = source;
    setActiveLabel(null); setError(null);
    setSession(previous => ({ model: createModel(source), identity: {}, generation: previous.generation + 1 }));
  }, []);

  useEffect(() => history.subscribe(event => {
    const previousStatus = historyStatusRef.current;
    historyStatusRef.current = history.getSnapshot();
    setHistoryStatus(historyStatusRef.current);
    if (event.kind === "record") { setNotice(null); return; }
    if (event.kind === "reset" && (previousStatus.canUndo || previousStatus.canRedo)) setNotice("Document updated elsewhere; undo history restarted.");
    emittedSource.current = event.source;
    const view = event.view?.kind === "text" ? event.view : null;
    pendingRestore.current = view;
    if (event.kind === "restore" && view && restoreInFrame.current(view, isActive.current)) {
      renderedSource.current = event.source;
      if (isActive.current) pendingRestore.current = null;
    } else if (isActive.current) rebuild(event.source);
    if (!sharedHistory) callbacks.current.onChange(event.source);
  }), [history, rebuild, sharedHistory]);

  useEffect(() => {
    if (value === emittedSource.current) return;
    emittedSource.current = value;
    if (history.getSnapshot().source !== value) history.reset(value);
    else if (active && renderedSource.current !== value) rebuild(value);
  }, [value, active, history, rebuild]);

  useEffect(() => {
    if (!active) return;
    const source = history.getSnapshot().source;
    if (renderedSource.current !== source) { rebuild(source); return; }
    const view = pendingRestore.current;
    if (view && restoreInFrame.current(view, true)) pendingRestore.current = null;
  }, [active, history, rebuild]);
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
    let beforeInput: { regionId: string; text: string; offsets: HtmlTextSelectionOffsets; scroll: { x: number; y: number } } | null = null;

    const viewFor = (editorState: EditorState, region: HtmlTextRegion, scroll = { x: frameWindow.scrollX, y: frameWindow.scrollY }): TextView => ({
      kind: "text", session: session.identity, regionId: region.id, regionIndex: model.regions.indexOf(region), regionCount: model.regions.length, regionTagName: region.tagName, state: editorState,
      ...editorState.read($htmlTextSelectionOffsets), scrollX: scroll.x, scrollY: scroll.y,
    });

    function activate(element: HTMLElement, region: HtmlTextRegion): LexicalEditor {
      const existing = editors.get(element);
      if (existing) { activeEditor.current = existing; setActiveLabel(region.label); return existing; }
      const appearances = new Map<string, string>();
      for (const run of region.runs) for (const inline of run.inlinePath ?? []) {
        const original = element.querySelector<HTMLElement>(`[data-nautilo-html-inline="${inline.id}"]`);
        if (original && !appearances.has(inline.id)) appearances.set(inline.id, inlineAppearance(frameWindow.getComputedStyle(original)));
      }
      const editor = createEditor({ namespace: "html-text-region", nodes: [HtmlSourceInlineNode], onError: caught => setError(caught.message) });
      originalMarkup.set(element, element.innerHTML);
      const originalWhiteSpace = frameWindow.getComputedStyle(element).whiteSpace;
      element.contentEditable = "true";
      element.setAttribute("role", "textbox"); element.setAttribute("aria-label", region.label); element.setAttribute("aria-multiline", "false");
      editor.setRootElement(element);
      element.style.whiteSpace = originalWhiteSpace;
      const unregisterPlain = registerPlainText(editor);
      editor.update(() => {
        const paragraph = $createParagraphNode();
        $appendHtmlRegionRuns(paragraph, region.runs, appearances);
        $getRoot().clear().append(paragraph);
      }, { discrete: true });
      const unregisterUpdate = editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves, tags }) => {
        if (!dirtyElements.size && !dirtyLeaves.size) return;
        const text = editorState.read(() => $getRoot().getTextContent());
        const previousText = prevEditorState.read(() => $getRoot().getTextContent());
        if (text === previousText) return;
        edits.set(region.id, text);
        const result = applyHtmlRegionTexts(model, model.source, [...edits].map(([regionId, nextText]) => ({ regionId, text: nextText })));
        if (!result.ok) { setError(result.reason); return; }
        setError(null); emittedSource.current = result.source; renderedSource.current = result.source;
        if (tags.has(RESTORE_TAG) || tags.has(SKIP_DOM_SELECTION_TAG)) return;
        const captured = beforeInput?.regionId === region.id && beforeInput.text === previousText ? beforeInput : null;
        const beforeView = viewFor(prevEditorState, region, captured?.scroll);
        if (captured) Object.assign(beforeView, captured.offsets);
        beforeInput = null;
        history.record(result.source, { before: beforeView, after: viewFor(editorState, region) });
        callbacks.current.onChange(result.source);
      });
      const reconcile = () => {
        const selection = $htmlTextSelectionOffsets();
        if ($reconcileHtmlRegion(region, appearances)) $setSelection($htmlTextSelectionAtOffsets(selection.anchor, selection.focus));
      };
      const unregisterTextTransform = editor.registerNodeTransform(TextNode, reconcile);
      const unregisterParagraphTransform = editor.registerNodeTransform(ParagraphNode, reconcile);
      const unregisterUndo = editor.registerCommand(UNDO_COMMAND, () => history.undo(), COMMAND_PRIORITY_HIGH);
      const unregisterRedo = editor.registerCommand(REDO_COMMAND, () => history.redo(), COMMAND_PRIORITY_HIGH);
      const unregisterPaste = editor.registerCommand(PASTE_COMMAND, event => {
        if (originalWhiteSpace !== "normal" && originalWhiteSpace !== "nowrap") return false;
        const clipboard = event && "clipboardData" in event ? event.clipboardData : null;
        if (!clipboard) return false;
        const text = clipboard.getData("text/plain");
        if (!/[\r\n]/.test(text)) return false;
        event.preventDefault(); const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(text.replace(/\r\n?|\n/g, " "));
        return true;
      }, COMMAND_PRIORITY_HIGH);
      const unregisterEnter = editor.registerCommand(KEY_ENTER_COMMAND, event => { event?.preventDefault(); element.blur(); return true; }, COMMAND_PRIORITY_HIGH);
      const focus = () => { activeEditor.current = editor; setActiveLabel(region.label); };
      element.addEventListener("focus", focus);
      cleanups.push(() => {
        unregisterPlain(); unregisterUpdate(); unregisterPaste(); unregisterEnter(); unregisterUndo(); unregisterRedo();
        unregisterTextTransform(); unregisterParagraphTransform();
        element.removeEventListener("focus", focus); editor.setRootElement(null);
      });
      editors.set(element, editor); focus();
      return editor;
    }

    restoreInFrame.current = (view, focus) => {
      if (view.session !== session.identity) return false;
      const region = model.regions.find(r => r.id === view.regionId);
      const element = doc.querySelector<HTMLElement>(`[data-nautilo-html-region="${view.regionId}"]`);
      if (!region || !element) return false;
      const editor = activate(element, region);
      // The DOM caret captured before input can be newer than this state's
      // selection (e.g. End navigation immediately followed by typing).
      const selection = view.state.read(() => $htmlTextSelectionAtOffsets(view.anchor, view.focus));
      editor.setEditorState(view.state.clone(selection), { tag: focus ? RESTORE_TAG : SKIP_DOM_SELECTION_TAG });
      if (focus) {
        element.focus({ preventScroll: true });
        frameWindow.scrollTo(view.scrollX, view.scrollY);
      }
      return true;
    };
    for (const region of model.regions) {
      const element = doc.querySelector<HTMLElement>(`[data-nautilo-html-region="${region.id}"]`);
      if (!element) continue;
      if (!region.text.trim()) element.style.minHeight = "1em";
      element.tabIndex = 0; element.setAttribute("aria-description", `Edit ${region.label}`);
      const focus = () => { const isNew = !editors.has(element); const editor = activate(element, region); if (isNew) editor.focus(undefined, { defaultSelection: "rootStart" }); };
      element.addEventListener("focus", focus); cleanups.push(() => element.removeEventListener("focus", focus));
    }
    const pointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const element = target?.closest<HTMLElement>("[data-nautilo-html-region]");
      const region = model.regions.find(candidate => candidate.id === element?.dataset.nautiloHtmlRegion);
      if (!element || !region || editors.has(element)) return;
      event.preventDefault(); const editor = activate(element, region);
      editor.focus(() => {
        const pointDoc = doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
        const point = pointDoc.caretPositionFromPoint?.(event.clientX, event.clientY);
        const range = pointDoc.caretRangeFromPoint?.(event.clientX, event.clientY) ?? doc.createRange();
        if (point) { range.setStart(point.offsetNode, point.offset); range.collapse(true); }
        if (element.contains(range.startContainer)) { const selection = frameWindow.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
      }, { defaultSelection: "rootStart" });
    };
    const click = (event: MouseEvent) => event.preventDefault();
    const captureBeforeInput = () => {
      const selection = frameWindow.getSelection();
      const anchor = selection?.anchorNode;
      const element = (anchor?.nodeType === 1 ? anchor as Element : anchor?.parentElement)?.closest<HTMLElement>("[data-nautilo-html-region]");
      const editor = element && editors.get(element);
      const regionId = element?.dataset.nautiloHtmlRegion;
      if (!element || !editor || !regionId) return null;
      const offsets = captureHtmlDomSelection(element, editor);
      if (!offsets) return null;
      beforeInput = { regionId, offsets, text: editor.getEditorState().read(() => $getRoot().getTextContent()), scroll: { x: frameWindow.scrollX, y: frameWindow.scrollY } };
      return { editor, element, offsets };
    };
    const input = (event: InputEvent) => {
      const captured = captureBeforeInput();
      if (!captured || event.isComposing || event.inputType !== "insertText" || event.data === null) return;
      // Native contenteditable under authored normal white-space can discard a
      // leading/trailing typed space. Controlled insertion keeps exact text and
      // uses the real DOM caret, while composition remains with Lexical/browser.
      event.preventDefault(); event.stopPropagation();
      const data = event.data;
      captured.editor.update(() => {
        const selection = $htmlTextSelectionAtOffsets(captured.offsets.anchor, captured.offsets.focus);
        selection.style = "all:unset;display:contents";
        $setSelection(selection); selection.insertText(data);
      }, { discrete: true });
    };
    const key = (event: KeyboardEvent) => {
      captureBeforeInput();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); callbacks.current.onSave?.(); }
      else if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
        event.preventDefault(); event.stopPropagation();
        if (event.shiftKey || event.key.toLowerCase() === "y") history.redo(); else history.undo();
      } else if (event.key === "Escape") { (doc.activeElement as HTMLElement | null)?.blur(); iframeRef.current?.focus(); }
    };
    doc.addEventListener("pointerdown", pointerDown, true); doc.addEventListener("click", click);
    doc.addEventListener("keydown", key, true); doc.addEventListener("beforeinput", input, true); doc.addEventListener("paste", captureBeforeInput, true); doc.addEventListener("cut", captureBeforeInput, true);
    disposeFrame.current = () => {
      doc.removeEventListener("pointerdown", pointerDown, true); doc.removeEventListener("click", click);
      doc.removeEventListener("keydown", key, true); doc.removeEventListener("beforeinput", input, true); doc.removeEventListener("paste", captureBeforeInput, true); doc.removeEventListener("cut", captureBeforeInput, true);
      for (const cleanup of cleanups) cleanup();
      for (const [element, markup] of originalMarkup) { element.innerHTML = markup; element.removeAttribute("contenteditable"); }
      cleanups.length = 0;
    };
    const pending = pendingRestore.current;
    if (pending && isActive.current) {
      const candidate = model.regions[pending.regionIndex];
      const expectedText = pending.state.read(() => $getRoot().getTextContent());
      const region = model.regions.length === pending.regionCount && candidate?.tagName === pending.regionTagName && candidate.text === expectedText ? candidate : undefined;
      const element = region && doc.querySelector<HTMLElement>(`[data-nautilo-html-region="${region.id}"]`);
      if (element && region) {
        const editor = activate(element, region);
        editor.update(() => {
          $setSelection($htmlTextSelectionAtOffsets(pending.anchor, pending.focus));
        }, { discrete: true, tag: RESTORE_TAG });
        element.focus({ preventScroll: true }); frameWindow.scrollTo(pending.scrollX, pending.scrollY);
      }
      pendingRestore.current = null;
    }
  }, [session, history]);

  if (session.model.blockedReason) return <div className="p-4 text-sm text-foreground-muted">{session.model.blockedReason} Use its app or Source to edit this document.</div>;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="html-text-editor">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-foreground-muted">
        <button type="button" disabled={!historyStatus.canUndo} onMouseDown={event => event.preventDefault()} onClick={() => history.undo()} className="rounded border border-border px-2 py-1 disabled:opacity-40">Undo</button>
        <button type="button" disabled={!historyStatus.canRedo} onMouseDown={event => event.preventDefault()} onClick={() => history.redo()} className="rounded border border-border px-2 py-1 disabled:opacity-40">Redo</button>
        <span>{activeLabel ? `Editing ${activeLabel}. Enter or Esc to finish.` : "Click text to edit. Tab moves between text areas."}</span>
        <span className="ml-auto">Page scripts paused while editing.</span>
      </div>
      {notice ? <p role="status" className="px-3 py-2 text-xs text-foreground-muted">{notice}</p> : null}
      {error ? <p role="alert" className="p-3 text-sm text-[var(--error)]">{error}</p> : null}
      {session.model.regions.length === 0 ? <p className="p-3 text-sm text-foreground-muted">No editable text was found. Text created by scripts can be changed in Source.</p> : null}
      <iframe key={session.generation} ref={iframeRef} title="Edit HTML text" sandbox="allow-same-origin" srcDoc={session.model.previewHtml} onLoad={initializeFrame} className="min-h-0 w-full flex-1 border-0 bg-white" />
    </div>
  );
}
