import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { CalendarClock, BellOff } from "lucide-react";
import type { EventFeedPreference } from "@nautilo/types";
import { createWorkbenchPortal } from "../components/workbench-portals";
import { useEventFeed } from "./event-feed-context";
import { eventFeedCustomSnooze, eventFeedLocalDateInput, eventFeedSnoozePreset } from "./event-feed-snooze";

export function EventFeedQuietControl() {
  const feed = useEventFeed();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customTime, setCustomTime] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [position, setPosition] = useState({ top: 0, right: 0, maxHeight: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const preferenceLoaded = feed.quietPreference !== null;
  const disabled = !feed.connected || feed.savingPreference || feed.quietPreference === null;

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = (): void => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const top = rect.bottom + 4;
      setPosition({ top, right: Math.max(8, window.innerWidth - rect.right), maxHeight: Math.max(0, window.innerHeight - top - 8) });
    };
    const outside = (event: Event): void => {
      const target = event.target;
      if (target instanceof window.Node && !panel.current?.contains(target) && !anchor.current?.contains(target)) setOpen(false);
    };
    reposition();
    panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", reposition);
    };
  }, [open, preferenceLoaded]);

  useEffect(() => {
    if (custom) panel.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [custom]);

  const close = (): void => { setOpen(false); anchor.current?.focus(); };
  const save = async (preference: EventFeedPreference): Promise<void> => {
    if (await feed.setQuietPreference(preference)) close();
  };
  const optionClass = "flex w-full items-center justify-between gap-2 rounded px-3 py-2.5 text-left text-xs hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-40";

  return <>
    <button ref={anchor} type="button" aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
      disabled={!feed.connected}
      onClick={() => { setCustom(false); setValidationError(null); setOpen(!open); }}
      className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground disabled:opacity-40">
      <BellOff className="h-3.5 w-3.5" aria-hidden="true" />
      {feed.quiet ? "Quiet" : "Quiet events"}
    </button>
    {open ? createWorkbenchPortal(
      <div ref={panel} id={id} role="dialog" aria-label="Quiet events" style={position}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        }}
        className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-border bg-background p-2 text-foreground shadow-xl">
        <div className="border-b border-border px-3 pb-3 pt-2">
          <p className="flex items-center gap-2 text-sm font-medium"><BellOff className="h-4 w-4" aria-hidden="true" />Quiet events</p>
          <p className="mt-1 text-xs text-foreground-muted">Only for you · All your devices on this server</p>
        </div>
        {custom ? (
          <form className="p-3" onSubmit={(event) => {
            event.preventDefault();
            const preference = eventFeedCustomSnooze(customTime);
            if (!preference) { setValidationError("Choose a valid time in the future."); return; }
            setValidationError(null);
            void save(preference);
          }}>
            <label htmlFor={`${id}-until`} className="mb-2 block text-xs font-medium">Resume Events</label>
            <input id={`${id}-until`} type="datetime-local" required value={customTime} disabled={disabled}
              onChange={(event) => setCustomTime(event.currentTarget.value)}
              className="w-full min-w-0 rounded border border-border bg-background-element p-2 text-sm text-foreground" />
            {validationError ? <p role="alert" className="mt-2 text-xs text-error">{validationError}</p> : null}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" disabled={feed.savingPreference} onClick={() => setCustom(false)} className="rounded px-2 py-1 text-xs hover:bg-background-element">Back</button>
              <button type="submit" disabled={disabled} className="rounded bg-[var(--primary-muted)] px-2 py-1 text-xs font-medium disabled:opacity-40">{feed.savingPreference ? "Saving…" : "Quiet events"}</button>
            </div>
          </form>
        ) : (
          <div className="py-1">
            <button type="button" className={optionClass} disabled={disabled} onClick={() => void save(eventFeedSnoozePreset("hour"))}>For 1 hour</button>
            <button type="button" className={optionClass} disabled={disabled} onClick={() => void save(eventFeedSnoozePreset("tomorrow"))}><span>Until tomorrow</span><span className="text-foreground-muted">9:00 AM</span></button>
            <button type="button" className={optionClass} disabled={disabled} onClick={() => {
              setCustomTime(eventFeedLocalDateInput(new Date(Date.now() + 60 * 60 * 1000)));
              setCustom(true);
            }}><span>Choose a time…</span><CalendarClock className="h-4 w-4" aria-hidden="true" /></button>
            <div className="mt-1 border-t border-border pt-1">
              <button type="button" className={optionClass} disabled={disabled} onClick={() => void save({ mode: "quiet" })}>Until I turn it back on</button>
            </div>
          </div>
        )}
        {!feed.connected ? <p role="status" className="px-3 py-2 text-xs text-foreground-muted">Reconnect to change your preference.</p>
          : feed.quietPreference === null && !feed.preferenceError ? <p role="status" className="px-3 py-2 text-xs text-foreground-muted">Loading your preference…</p> : null}
        {feed.preferenceError ? <div role="alert" className="px-3 py-2 text-xs text-error">
          <p>{feed.preferenceError}</p>
          <button type="button" disabled={!feed.connected || feed.savingPreference} onClick={() => void feed.refresh()} className="mt-2 underline">Retry</button>
        </div> : null}
        {feed.savingPreference ? <p role="status" className="px-3 py-2 text-xs text-foreground-muted">Saving preference…</p> : null}
        <p className="rounded-md bg-background-element px-3 py-2 text-xs text-foreground-muted">Events still collect here. Other people’s preferences stay unchanged.</p>
      </div>, document.body,
    ) : null}
  </>;
}
