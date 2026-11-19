import { useEffect, useId, useRef, type KeyboardEvent } from "react";

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

const buttonClass = "rounded border border-border px-2.5 py-1 text-foreground hover:bg-background-element disabled:opacity-40 aria-pressed:bg-primary-muted aria-pressed:border-primary aria-[pressed=mixed]:border-primary";
const marks: { mark: HtmlFormattingMark; label: string; key: string; style: string }[] = [
  { mark: "bold", label: "Bold", key: "B", style: "font-bold" },
  { mark: "italic", label: "Italic", key: "I", style: "italic" },
  { mark: "underline", label: "Underline", key: "U", style: "underline" },
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
      {marks.map(({ mark, label, key, style }) => <button
        key={mark} type="button" aria-label={label}
        aria-pressed={selection.marks[mark] === "mixed" ? "mixed" : selection.marks[mark] === "on"}
        aria-keyshortcuts={`Control+${key.toLowerCase()} Meta+${key.toLowerCase()}`}
        title={`${label} (⌘/Ctrl+${key})`} disabled={!selection.available || open}
        className={`${buttonClass} ${style}`}
        onMouseDown={event => event.preventDefault()} onClick={() => props.onToggle(mark)}
      >{label}</button>)}
      <button type="button" aria-label="Link" aria-haspopup="dialog" aria-expanded={open}
        aria-keyshortcuts="Control+k Meta+k" title="Insert or edit link (⌘/Ctrl+K)"
        disabled={!selection.available || open} className={buttonClass}
        onMouseDown={event => event.preventDefault()} onClick={props.onOpenLink}>Link</button>
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
