import type { ReactElement } from "react";
import type { HumanPresenceStatus } from "@nautilo/types";

/** Human availability in the roster; an absent snapshot is always unavailable. */
export function HumanPresence({
  status,
  compact = false,
  name,
}: {
  readonly status: HumanPresenceStatus | undefined;
  readonly compact?: boolean;
  readonly name?: string;
}): ReactElement {
  if (compact) {
    const label = status == null ? "Status unavailable" : presenceLabel(status);
    return (
      <span
        className={status == null
          ? "absolute bottom-0 right-0 text-[8px] font-semibold leading-none text-foreground-muted"
          : `absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-background-panel ${statusColor(status)}`}
        role="img"
        aria-label={name ? `${name}: ${label}` : label}
        title={name ? `${name}: ${label}` : label}
        data-testid="human-presence"
        data-status={status ?? "unavailable"}
      >
        {status == null ? "—" : null}
      </span>
    );
  }

  return status == null ? (
    <span className="shrink-0 text-[10px] text-foreground-muted" aria-label="Status unavailable" data-testid="human-presence" data-status="unavailable">—</span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-foreground-muted" data-testid="human-presence" data-status={status}>
      <span className={`h-1.5 w-1.5 rounded-full ${statusColor(status)}`} aria-hidden />
      <span>{presenceLabel(status)}</span>
    </span>
  );
}

function presenceLabel(status: HumanPresenceStatus): string {
  return status === "online" ? "Online" : status === "idle" ? "Idle" : "Offline";
}

function statusColor(status: HumanPresenceStatus | undefined): string {
  return status === "online"
    ? "bg-[var(--success)]"
    : status === "idle"
      ? "bg-[var(--warning)]"
      : status === "offline"
        ? "bg-foreground-muted"
        : "bg-border";
}
