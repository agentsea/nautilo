import { useCallback, useState } from "react";
import type { CommandApprovalRow } from "@nautilo/api-client";
import { Button, StatusPill } from "../../pages/settings/ui";
import { formatRelativeTime } from "./format-relative-time";
import { REVOKE_UNDO_MS } from "./revoke-constants";
import {
  classifyToolFamily,
  getApprovalHeadline,
  getApprovalSubline,
  toolFamilyIcon,
} from "./tool-display";
import { useRevokeCountdown } from "./use-revoke-countdown";

function ScopeBadge({ row }: { row: CommandApprovalRow }) {
  if (row.scope === "server") {
    return <StatusPill tone="info">Always · server-wide</StatusPill>;
  }
  return (
    <StatusPill tone="muted">Room: {row.roomLabel ?? "(unknown)"}</StatusPill>
  );
}

export function ApprovalRow({
  row,
  onRevokeCommit,
  revokeUndoMs = REVOKE_UNDO_MS,
}: {
  row: CommandApprovalRow;
  onRevokeCommit: (id: string) => Promise<void>;
  /** Test hook — shorter undo window. */
  revokeUndoMs?: number;
}) {
  const [phase, setPhase] = useState<"idle" | "countdown" | "committing" | "exit">("idle");

  const handleExpire = useCallback(() => {
    void (async () => {
      setPhase("committing");
      try {
        await onRevokeCommit(row.id);
        setPhase("exit");
      } catch {
        setPhase("idle");
      }
    })();
  }, [onRevokeCommit, row.id]);

  const countdown = useRevokeCountdown({
    durationMs: revokeUndoMs,
    onExpire: handleExpire,
  });

  const startRevoke = () => {
    setPhase("countdown");
    countdown.start();
  };

  const restore = () => {
    countdown.cancel();
    setPhase("idle");
  };

  if (phase === "exit") {
    return (
      <li
        data-testid={`approval-row-${row.id}`}
        data-phase="exit"
        className="overflow-hidden transition-all duration-300 ease-out max-h-0 opacity-0 py-0 border-b-0"
        aria-hidden="true"
      />
    );
  }

  const revokedUi = phase === "countdown" || phase === "committing";
  const family = classifyToolFamily(row);
  const FamilyIcon = toolFamilyIcon(family);
  const headline = getApprovalHeadline(row);
  const subline = getApprovalSubline(row);

  return (
    <li
      data-testid={`approval-row-${row.id}`}
      data-phase={phase}
      className={[
        "flex flex-wrap items-start justify-between gap-3 border-b border-border/40 px-4 py-3 last:border-b-0 transition-opacity duration-200",
        revokedUi ? "opacity-70" : "",
      ].join(" ")}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start gap-2">
          <FamilyIcon
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-foreground-muted"
            data-testid={`approval-row-icon-${row.id}`}
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p
              className={[
                "text-sm font-medium text-foreground break-words",
                revokedUi ? "line-through text-foreground-muted" : "",
              ].join(" ")}
              data-testid={`approval-row-headline-${row.id}`}
            >
              {headline}
            </p>
            {subline ? (
              <p
                className={[
                  "text-xs text-foreground-muted break-words",
                  revokedUi ? "line-through" : "",
                ].join(" ")}
                data-testid={`approval-row-subline-${row.id}`}
              >
                {subline}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <ScopeBadge row={row} />
          <span className="text-xs text-foreground-muted">
            {formatRelativeTime(row.createdAt)}
          </span>
        </div>
        {phase === "countdown" ? (
          <p
            className="text-xs text-[var(--warning)] pl-6"
            data-testid={`revoke-countdown-${row.id}`}
          >
            Revoked · undoing in {countdown.secondsLeft}s
          </p>
        ) : null}
        {phase === "committing" ? (
          <p className="text-xs text-foreground-muted pl-6">Revoking…</p>
        ) : null}
      </div>

      <div className="shrink-0 flex items-center gap-2">
        {phase === "idle" ? (
          <Button variant="ghost" onClick={startRevoke} ariaLabel={`Revoke ${row.label}`}>
            Revoke
          </Button>
        ) : null}
        {phase === "countdown" ? (
          <Button variant="secondary" onClick={restore} ariaLabel={`Restore ${row.label}`}>
            Restore
          </Button>
        ) : null}
      </div>
    </li>
  );
}
