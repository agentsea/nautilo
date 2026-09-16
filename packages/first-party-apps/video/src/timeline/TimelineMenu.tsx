import { useLayoutEffect, useRef, type ReactElement } from "react";
import { createPortal } from "react-dom";

export type TimelineMenuItem = { label: string; disabled?: boolean | undefined; run: () => void };

/** Shared mouse/keyboard menu. Never steals a timeline drag or edits on open. */
export function TimelineMenu({ x, y, items, onClose }: {
  x: number; y: number; items: TimelineMenuItem[]; onClose: () => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const previous = document.activeElement as HTMLElement | null;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: Event) => { if (!menu.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", dismiss);
    return () => { document.removeEventListener("pointerdown", dismiss); previous?.focus(); };
  }, [x, y, onClose]);
  return createPortal(<div ref={ref} role="menu" aria-label="Timeline actions" className="video-timeline-menu" style={{ left: x, top: y }} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }}>{items.map((item) => <button key={item.label} role="menuitem" type="button" disabled={item.disabled} onClick={() => { onClose(); item.run(); }}>{item.label}</button>)}</div>, document.body);
}

export function TrackIcon({ kind }: { kind: "eye" | "eye-off" | "mute" | "lock" | "more" }): ReactElement {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "eye" ? <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></> : null}
    {kind === "eye-off" ? <><path d="m3 3 18 18M10.6 5.1A12 12 0 0 1 12 5c6 0 10 7 10 7a21 21 0 0 1-3.1 3.8M6.1 6.1A23 23 0 0 0 2 12s4 7 10 7a12 12 0 0 0 5-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2" /></> : null}
    {kind === "mute" ? <><path d="M4 9h4l5-4v14l-5-4H4Z" /><path d="M17 8c3 2 3 6 0 8M20 5c5 4 5 10 0 14" /></> : null}
    {kind === "lock" ? <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></> : null}
    {kind === "more" ? <><circle cx="4" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="20" cy="12" r="1" /></> : null}
  </svg>;
}
