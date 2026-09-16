/** D299 — map focus_events.source / live WS reason to short tooltip copy. */
export type FocusSource = "mention" | "reply" | "ui" | "inferred" | null;

export function formatFocusReason(args: {
  source: FocusSource;
  reason: string | null;
}): string | null {
  const trimmed = args.reason?.trim();
  if (trimmed) return trimmed;
  switch (args.source) {
    case "mention":
      return "@-mentioned";
    case "reply":
      return "replied to";
    case "ui":
      return "you focused";
    case "inferred":
      return "auto-routed";
    default:
      return null;
  }
}

export function focusTooltipLabel(displayName: string, reason: string | null): string {
  return reason ? `${displayName} — ${reason}` : displayName;
}
