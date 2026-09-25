import { useCallback, useEffect, useMemo, useState } from "react";
import type { SecurityAuditEvent } from "@nautilo/api-client/browser";
import { apiClient } from "../../lib/api";
import { useCan } from "../../hooks/use-can";

/** Mirrors `SecurityAuditEventKind` from packages/server security-audit-log.ts */
export const SECURITY_AUDIT_EVENT_KINDS = [
  "moderation_action",
  "moderation_policy_changed",
  "enrollment_review_decided",
  "posture_changed",
  "capability_check_failed",
  "pin_check_failed",
  "pin_enrolled",
  "approval_granted",
  "approval_denied",
  "invite_minted",
  "invite_redeemed",
  "invite_revoked",
  "invite_redeem_failed",
  "invite_redeem_cleanup_failed",
  "invite_complete_profile_failed",
  "invite_bind_logto_user_succeeded",
  "invite_bind_logto_user_failed",
  "logto_token_mint_failed",
  "connection_vault_tool",
  "agent_role_added",
  "agent_role_removed",
  "room_member_added",
  "room_member_removed",
  "room_member_self_joined",
  "room_member_self_left",
  "resume_thread_auth_denied",
  "logto_password_login_succeeded",
  "logto_password_login_failed",
  "user_disabled_session_blocked",
  "user_disabled",
  "user_enabled",
  "admin_password_reset_issued",
] as const;

export type SecurityAuditEventKind = (typeof SECURITY_AUDIT_EVENT_KINDS)[number];

const PAGE_SIZE = 50;
const MAX_ROWS = 500;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type TimeWindowPreset = "1h" | "24h" | "7d" | "30d" | "custom";

function clampWindowStart(startMs: number): number {
  const earliest = Date.now() - MAX_WINDOW_MS;
  return Math.max(startMs, earliest);
}

function windowStartForPreset(
  preset: TimeWindowPreset,
  customStart?: string,
): string {
  const now = Date.now();
  let startMs: number;
  switch (preset) {
    case "1h":
      startMs = now - 60 * 60 * 1000;
      break;
    case "24h":
      startMs = now - 24 * 60 * 60 * 1000;
      break;
    case "7d":
      startMs = now - 7 * 24 * 60 * 60 * 1000;
      break;
    case "30d":
      startMs = now - MAX_WINDOW_MS;
      break;
    case "custom":
      startMs = customStart ? Date.parse(customStart) : now - 24 * 60 * 60 * 1000;
      if (!Number.isFinite(startMs)) startMs = now - 24 * 60 * 60 * 1000;
      break;
  }
  return new Date(clampWindowStart(startMs)).toISOString();
}

function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): string {
  return new Date(value).toISOString();
}

function eventInWindow(
  event: SecurityAuditEvent,
  windowStartMs: number,
  windowEndMs: number | null,
): boolean {
  const ts = Date.parse(event.ts);
  if (!Number.isFinite(ts)) return false;
  if (ts < windowStartMs) return false;
  if (windowEndMs !== null && ts > windowEndMs) return false;
  return true;
}

function eventKey(event: SecurityAuditEvent, idx: number): string {
  return `${event.ts}-${event.kind}-${idx}`;
}

function auditField(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" ? value : fallback;
}

function AuditEventDetail({ event }: { readonly event: SecurityAuditEvent }) {
  switch (event.kind) {
    case "moderation_policy_changed":
      return "Server moderation policy changed";
    case "enrollment_review_decided":
      return "Community joining request reviewed";
    case "moderation_action":
      return (
        <p className="mt-1 text-xs text-foreground">
          Moderation: {auditField(event.action)} · {event.roomId === null ? "Server" : "Room"}
          {" · Requested by "}<span className="font-mono">{auditField(event.requesterUserId, "Unavailable")}</span>
          {" · Operation "}<span className="font-mono">{auditField(event.correlationId)}</span>
        </p>
      );
    case "user_disabled":
      return (
        <p className="mt-1 text-xs text-foreground">
          Disabled user{" "}
          <span className="font-mono">{auditField(event.targetUserId)}</span>
          {typeof event.reason === "string" ? (
            <span className="text-foreground-muted"> — {event.reason}</span>
          ) : null}
        </p>
      );
    case "posture_changed": {
      const prev = event.prev as { securityLevel?: string; deploymentMode?: string } | undefined;
      const next = event.next as { securityLevel?: string; deploymentMode?: string } | undefined;
      return (
        <p className="mt-1 text-xs text-foreground">
          Posture{" "}
          <span className="font-mono">
            {prev?.securityLevel ?? "?"} / {prev?.deploymentMode ?? "?"}
          </span>
          {" → "}
          <span className="font-mono">
            {next?.securityLevel ?? "?"} / {next?.deploymentMode ?? "?"}
          </span>
        </p>
      );
    }
    case "invite_minted":
      return (
        <p className="mt-1 text-xs text-foreground">
          Minted invite{" "}
          <span className="font-mono">{auditField(event.inviteId)}</span>
          {typeof event.inviteKind === "string" ? (
            <span className="text-foreground-muted"> ({event.inviteKind})</span>
          ) : null}
        </p>
      );
    default:
      return (
        <p className="mt-1 text-xs text-foreground-muted">
          actor: {event.actorId ?? "anonymous"}
        </p>
      );
  }
}

export function AuditLogViewer() {
  const can = useCan();
  const canViewAuditLog = can("view_audit_log");

  const [timePreset, setTimePreset] = useState<TimeWindowPreset>("24h");
  const [customStart, setCustomStart] = useState(() =>
    toDatetimeLocalValue(windowStartForPreset("24h")),
  );
  const [customEnd, setCustomEnd] = useState(() => toDatetimeLocalValue(new Date().toISOString()));
  const [selectedKinds, setSelectedKinds] = useState<ReadonlySet<SecurityAuditEventKind>>(
    () => new Set(SECURITY_AUDIT_EVENT_KINDS),
  );
  const [actorIdInput, setActorIdInput] = useState("");
  const [actorIdFilter, setActorIdFilter] = useState("");

  const [events, setEvents] = useState<readonly SecurityAuditEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [fetchLimit, setFetchLimit] = useState(PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const windowSinceIso = useMemo(
    () =>
      timePreset === "custom"
        ? windowStartForPreset("custom", fromDatetimeLocalValue(customStart))
        : windowStartForPreset(timePreset),
    [timePreset, customStart],
  );

  const windowStartMs = useMemo(() => Date.parse(windowSinceIso), [windowSinceIso]);
  const windowEndMs = useMemo(
    () =>
      timePreset === "custom" ? Date.parse(fromDatetimeLocalValue(customEnd)) : null,
    [timePreset, customEnd],
  );

  const kindsQuery = useMemo(() => {
    if (selectedKinds.size === 0 || selectedKinds.size === SECURITY_AUDIT_EVENT_KINDS.length) {
      return undefined;
    }
    return [...selectedKinds];
  }, [selectedKinds]);

  const fetchEvents = useCallback(
    async (opts: { limit: number; loadingMore?: boolean }) => {
      const isLoadMore = opts.loadingMore === true;
      if (isLoadMore) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setError(null);
      }

      const limit = Math.min(Math.max(1, opts.limit), MAX_ROWS);

      try {
        const res = await apiClient.getSecurityAuditLog({
          since: windowSinceIso,
          limit,
          ...(kindsQuery ? { kinds: kindsQuery } : {}),
          ...(actorIdFilter.trim() ? { actorId: actorIdFilter.trim() } : {}),
        });

        const filtered = res.events.filter((event) =>
          eventInWindow(event, windowStartMs, windowEndMs),
        );

        setEvents(filtered);
        setHasMore(res.hasMore && limit < MAX_ROWS);
        setError(null);
      } catch (err) {
        if (!isLoadMore) {
          setEvents([]);
          setHasMore(false);
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isLoadMore) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      }
    },
    [actorIdFilter, kindsQuery, windowEndMs, windowSinceIso, windowStartMs],
  );

  useEffect(() => {
    if (!canViewAuditLog) return;
    setFetchLimit(PAGE_SIZE);
    void fetchEvents({ limit: PAGE_SIZE });
  }, [canViewAuditLog, fetchEvents]);

  const toggleKind = (kind: SecurityAuditEventKind) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
    setFetchLimit(PAGE_SIZE);
  };

  const applyActorFilter = () => {
    setActorIdFilter(actorIdInput.trim());
    setFetchLimit(PAGE_SIZE);
  };

  const handleLoadMore = () => {
    const nextLimit = Math.min(fetchLimit + PAGE_SIZE, MAX_ROWS);
    setFetchLimit(nextLimit);
    void fetchEvents({ limit: nextLimit, loadingMore: true });
  };

  if (!canViewAuditLog) return null;

  return (
    <div className="space-y-4" data-testid="audit-log-viewer">
      <div className="space-y-3 rounded-md border border-border bg-background-element/40 p-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-foreground-muted">Time window</span>
            <select
              data-testid="audit-log-time-preset"
              value={timePreset}
              onChange={(e) => {
                setTimePreset(e.target.value as TimeWindowPreset);
                setFetchLimit(PAGE_SIZE);
              }}
              className="rounded-md border border-border bg-background-panel px-2 py-1.5 text-sm"
            >
              <option value="1h">Last hour</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="custom">Custom</option>
            </select>
          </label>

          {timePreset === "custom" ? (
            <>
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-foreground-muted">From</span>
                <input
                  type="datetime-local"
                  data-testid="audit-log-custom-start"
                  value={customStart}
                  onChange={(e) => {
                    setCustomStart(e.target.value);
                    setFetchLimit(PAGE_SIZE);
                  }}
                  className="rounded-md border border-border bg-background-panel px-2 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-foreground-muted">To</span>
                <input
                  type="datetime-local"
                  data-testid="audit-log-custom-end"
                  value={customEnd}
                  onChange={(e) => {
                    setCustomEnd(e.target.value);
                    setFetchLimit(PAGE_SIZE);
                  }}
                  className="rounded-md border border-border bg-background-panel px-2 py-1.5 text-sm"
                />
              </label>
            </>
          ) : null}

          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs">
            <span className="font-medium text-foreground-muted">Actor ID</span>
            <div className="flex gap-2">
              <input
                type="text"
                data-testid="audit-log-actor-id"
                value={actorIdInput}
                onChange={(e) => setActorIdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyActorFilter();
                }}
                placeholder="Filter by actor ID"
                className="min-w-0 flex-1 rounded-md border border-border bg-background-panel px-2 py-1.5 text-sm"
              />
              <button
                type="button"
                onClick={applyActorFilter}
                className="shrink-0 rounded-md border border-border bg-background-panel px-2 py-1.5 text-sm hover:border-border-strong"
              >
                Apply
              </button>
            </div>
          </label>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-foreground-muted">Event kinds</legend>
          <div className="flex max-h-28 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
            {SECURITY_AUDIT_EVENT_KINDS.map((kind) => (
              <label key={kind} className="inline-flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  data-testid={`audit-log-kind-${kind}`}
                  checked={selectedKinds.has(kind)}
                  onChange={() => toggleKind(kind)}
                />
                <span className="font-mono">{kind}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {loading ? (
        <p className="text-sm text-foreground-muted">Loading audit log...</p>
      ) : error ? (
        <p className="text-sm text-error">{error}</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-foreground-muted">No security audit events in this window.</p>
      ) : (
        <div className="space-y-2">
          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            <ul className="divide-y divide-border">
              {events.map((event, idx) => (
                <li key={eventKey(event, idx)} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs text-foreground-muted">{event.ts}</span>
                    <span className="rounded-full bg-background-element px-2 py-0.5 text-xs">
                      {event.kind}
                    </span>
                  </div>
                  <AuditEventDetail event={event} />
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-foreground-muted" data-testid="audit-log-count">
              Showing {events.length} event{events.length === 1 ? "" : "s"}
              {hasMore ? " — more available" : ""}
            </p>
            {hasMore ? (
              <button
                type="button"
                data-testid="audit-log-load-more"
                disabled={loadingMore || events.length >= MAX_ROWS}
                onClick={handleLoadMore}
                className="rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-border-strong disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
