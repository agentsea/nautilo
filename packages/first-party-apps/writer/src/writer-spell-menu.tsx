/**
 * Accessible spelling-suggestion popover for Writer canvas context menus.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { EditorAPI, SpellError } from "@nautilo/office-docs/browser";
import type { ThemeMode } from "@nautilo/office-docs/browser";
import type { WriterSpellMenuRequest } from "./writer-spellcheck";

export interface WriterSpellMenuProps {
  editor: EditorAPI | null;
  request: WriterSpellMenuRequest | null;
  theme: ThemeMode;
  onIgnore: (word: string) => void;
  onLearn: (word: string) => void;
  onClose: () => void;
}

export function WriterSpellMenu({ editor, request, theme, onIgnore, onLearn, onClose }: WriterSpellMenuProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!request || !editor) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSuggestions([]);
    setActiveIndex(0);
    void editor.getSpellSuggestions(request.error.word).then((items) => {
      if (cancelled) return;
      setSuggestions(items);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [editor, request]);

  useLayoutEffect(() => {
    if (!request || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const minLeft = viewportLeft + 8;
    const maxLeft = viewportLeft + width - rect.width - 8;
    const minTop = viewportTop + 8;
    const maxTop = viewportTop + height - rect.height - 8;
    const left = Math.max(minLeft, Math.min(request.clientX, maxLeft));
    const below = request.clientY + 4;
    const top = below + rect.height <= viewportTop + height - 8
      ? Math.max(minTop, Math.min(below, maxTop))
      : Math.max(minTop, Math.min(request.clientY - rect.height - 4, maxTop));
    setPosition({ left, top });
    itemRefs.current[0]?.focus();
  }, [request, suggestions, loading]);

  const closeAndReturnFocus = useCallback(() => { onClose(); queueMicrotask(() => editor?.focus()); }, [editor, onClose]);

  useEffect(() => {
    if (!request) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      closeAndReturnFocus();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
    };
  }, [request, closeAndReturnFocus]);

  const applySuggestion = useCallback(
    (replacement: string, error: SpellError) => {
      if (!editor) return;
      editor.applySpellSuggestion(error, replacement);
      closeAndReturnFocus();
    },
    [editor, closeAndReturnFocus],
  );

  if (!request) return null;

  const visualViewport = window.visualViewport;
  const viewportLeft = visualViewport?.offsetLeft ?? 0;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportWidth = visualViewport?.width ?? window.innerWidth;
  const viewportHeight = visualViewport?.height ?? window.innerHeight;
  const fallbackLeft = Math.max(viewportLeft + 8, Math.min(request.clientX, viewportLeft + viewportWidth - 8));
  const fallbackTop = Math.max(viewportTop + 8, Math.min(request.clientY + 4, viewportTop + viewportHeight - 8));

  const style: React.CSSProperties = {
    position: "fixed",
    top: position?.top ?? fallbackTop,
    left: position?.left ?? fallbackLeft,
    zIndex: 60,
    visibility: position ? "visible" : "hidden",
  };
  const actions = [...suggestions.map((word) => ({ label: word, run: () => applySuggestion(word, request.error) })), { label: "Ignore spelling", run: () => { onIgnore(request.error.word); closeAndReturnFocus(); } }, { label: "Learn spelling", run: () => { onLearn(request.error.word); closeAndReturnFocus(); } }];
  const move = (next: number) => { const index = ((next % actions.length) + actions.length) % actions.length; setActiveIndex(index); itemRefs.current[index]?.focus(); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); closeAndReturnFocus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); move(activeIndex + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(activeIndex - 1); }
    else if (event.key === "Home") { event.preventDefault(); move(0); }
    else if (event.key === "End") { event.preventDefault(); move(actions.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); actions[activeIndex]?.run(); }
  };

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={`Spelling suggestions for ${request.error.word}`}
      className="wr-popover wr-spell-menu"
      data-theme={theme}
      style={style}
      onKeyDown={onKeyDown}
    >
      <div className="wr-spell-menu__title" aria-hidden="true">
        {request.error.word}
      </div>
      {loading ? (
        <div className="wr-spell-menu__status" aria-live="polite">
          Loading suggestions…
        </div>
      ) : suggestions.length === 0 ? (
        <div className="wr-spell-menu__status" aria-live="polite">
          No suggestions
        </div>
      ) : null}
      {actions.map((action, index) => (
          <button
            key={`${action.label}-${index}`}
            ref={(node) => { itemRefs.current[index] = node; }}
            type="button"
            role="menuitem"
            tabIndex={index === activeIndex ? 0 : -1}
            className="wr-menu-btn wr-menu-btn--block"
            onFocus={() => setActiveIndex(index)}
            onClick={action.run}
          >
            {action.label}
          </button>
        ))}
    </div>,
    document.body,
  );
}
