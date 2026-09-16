import { useState } from "react";
import { useMessage } from "@assistant-ui/react";

/** Only an authoritative sent timestamp is shown; legacy missing dates stay unknown. */
export function validMessageSentAt(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function messageDayKey(value: unknown): string | null {
  const date = validMessageSentAt(value);
  return date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : null;
}

/** Undated system rows do not restart a calendar day. */
export function messageDayStarts(values: readonly unknown[]): ReadonlySet<number> {
  const starts = new Set<number>();
  let previous: string | null = null;
  values.forEach((value, index) => {
    const day = messageDayKey(value);
    if (!day) return;
    if (day !== previous) starts.add(index);
    previous = day;
  });
  return starts;
}

export function MessageTimestamp() {
  const sentAt = useMessage((message) => message.metadata.custom?.sentAt);
  const [expanded, setExpanded] = useState(false);
  const date = validMessageSentAt(sentAt);
  if (!date) return null;
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const exact = `${date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  return <>
    <button type="button" className="rounded px-0.5 text-[11px] font-normal text-foreground-muted hover:bg-background-element hover:text-foreground"
      aria-label={`Sent ${exact}`} aria-expanded={expanded} title={exact} onClick={() => setExpanded((value) => !value)}>
      <time dateTime={date.toISOString()}>{time}</time>
    </button>
    {expanded && <span className="w-full break-words rounded border border-border bg-background-element px-2 py-1 text-[11px] font-normal text-foreground-muted">Sent {exact}</span>}
  </>;
}
