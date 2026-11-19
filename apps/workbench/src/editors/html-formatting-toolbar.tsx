import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { Bold, Italic, Link as LinkIcon, Redo2, Underline, Undo2, type LucideIcon } from "lucide-react";

export type HtmlFormattingMark = "bold" | "italic" | "underline";
export type HtmlFormattingSelection = {
  available: boolean;
  collapsed: boolean;
  marks: Record<HtmlFormattingMark, "on" | "off" | "mixed">;
  link: { href: string } | null;
};
export type HtmlLinkDialogState = {
  url: string;
  text: string;
  editingExisting: boolean;
  canRemove: boolean;
};
type HtmlFormattingToolbarProps = {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  selection: HtmlFormattingSelection;
  onToggle: (mark: HtmlFormattingMark) => void;
  onOpenLink: () => void;
  linkDialog: HtmlLinkDialogState | null;
  onLinkUrlChange: (url: string) => void;
  onLinkTextChange: (text: string) => void;
  onLinkApply: () => void;
  onLinkRemove: () => void;
  onLinkCancel: () => void;
  error: string | null;
};

const buttonBaseClass = "rounded border border-border text-foreground hover:bg-background-element disabled:opacity-40 aria-pressed:bg-primary-muted aria-pressed:border-primary aria-[pressed=mixed]:border-primary";
const buttonClass = `${buttonBaseClass} px-2.5 py-1`;
const iconButtonClass = `${buttonBaseClass} inline-flex h-8 w-8 shrink-0 items-center justify-center p-0`;
const marks: { mark: HtmlFormattingMark; label: string; key: string; Icon: LucideIcon }[] = [
  { mark: "bold", label: "Bold", key: "B", Icon: Bold },
  { mark: "italic", label: "Italic", key: "I", Icon: Italic },
  { mark: "underline", label: "Underline", key: "U", Icon: Underline },
];

export function HtmlFormattingToolbar(props: HtmlFormattingToolbarProps) {
  const { selection, linkDialog } = props;
  const urlInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const open = linkDialog !== null;
  useEffect(() => {
    if (open) { urlInput.current?.focus(); urlInput.current?.select(); }
  }, [open]);

  const navigateToolbar = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return <div className="border-b border-border text-xs">
    <div role="toolbar" aria-label="Text formatting" className="flex flex-wrap items-center gap-2 px-3 py-2" onKeyDown={navigateToolbar}>
      <button type="button" aria-label="Undo" title="Undo (⌘/Ctrl+Z)"
        aria-keyshortcuts="Control+z Meta+z" disabled={!props.canUndo || open} className={iconButtonClass}
        onMouseDown={event => event.preventDefault()} onClick={props.onUndo}><Undo2 aria-hidden="true" size={15} /></button>
      <button type="button" aria-label="Redo" title="Redo (⌘/Ctrl+Shift+Z or Ctrl+Y)"
        aria-keyshortcuts="Control+Shift+z Meta+Shift+z Control+y" disabled={!props.canRedo || open} className={iconButtonClass}
        onMouseDown={event => event.preventDefault()} onClick={props.onRedo}><Redo2 aria-hidden="true" size={15} /></button>
      <span aria-hidden="true" className="mx-1 h-5 border-l border-border" />
      {marks.map(({ mark, label, key, Icon }) => <button
        key={mark} type="button" aria-label={label}
        aria-pressed={selection.marks[mark] === "mixed" ? "mixed" : selection.marks[mark] === "on"}
        aria-keyshortcuts={`Control+${key.toLowerCase()} Meta+${key.toLowerCase()}`}
        title={`${label} (⌘/Ctrl+${key})`} disabled={!selection.available || open}
        className={iconButtonClass}
        onMouseDown={event => event.preventDefault()} onClick={() => props.onToggle(mark)}
      ><Icon aria-hidden="true" size={15} /></button>)}
      <button type="button" aria-label="Link" aria-haspopup="dialog" aria-expanded={open}
        aria-keyshortcuts="Control+k Meta+k" title="Insert or edit link (⌘/Ctrl+K)"
        disabled={!selection.available || open} className={iconButtonClass}
        onMouseDown={event => event.preventDefault()} onClick={props.onOpenLink}><LinkIcon aria-hidden="true" size={15} /></button>
    </div>
    {linkDialog ? <form role="dialog" aria-label={linkDialog.editingExisting ? "Edit link" : "Insert link"}
      className="flex flex-wrap items-end gap-2 border-t border-border px-3 py-3"
      onSubmit={event => { event.preventDefault(); props.onLinkApply(); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onLinkCancel(); }
      }}>
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span>Link URL</span>
        <input ref={urlInput} type="text" value={linkDialog.url} placeholder="https://example.com"
          autoComplete="off" spellCheck={false} aria-invalid={!!props.error} aria-describedby={props.error ? errorId : undefined}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          onChange={event => props.onLinkUrlChange(event.target.value)} />
      </label>
      {selection.collapsed && !linkDialog.editingExisting ? <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span>Link text</span>
        <input type="text" value={linkDialog.text} placeholder="Text to display"
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          onChange={event => props.onLinkTextChange(event.target.value)} />
      </label> : null}
      <button type="submit" className={buttonClass}>Apply link</button>
      {linkDialog.canRemove ? <button type="button" className={buttonClass} onClick={props.onLinkRemove}>Remove link</button> : null}
      <button type="button" className={buttonClass} onClick={props.onLinkCancel}>Cancel</button>
      {props.error ? <p id={errorId} role="alert" className="w-full text-[var(--error)]">{props.error}</p> : null}
    </form> : null}
  </div>;
}
