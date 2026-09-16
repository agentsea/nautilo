import { useCallback, useEffect, useState } from "react";
import { CONTENT_REPORT_REASON_LABELS, type ContentReportDto } from "@nautilo/types";

import { apiClient } from "../../../lib/api";

const PAGE_SIZE = 25;

function humanLabel(human: ContentReportDto["reporter"]): string {
  return human.handle ? `${human.displayName} (@${human.handle})` : human.displayName;
}

function targetLabel(report: ContentReportDto): string {
  if (report.target.type === "person") {
    const handle = report.preview.handle ? ` (@${report.preview.handle})` : "";
    return `${report.preview.displayName ?? "Person"}${handle}`;
  }
  return report.preview.text?.trim() || "Message with no text";
}

export function ReportsSection() {
  const [status, setStatus] = useState<"open" | "closed">("open");
  const [reports, setReports] = useState<ContentReportDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const page = await apiClient.listContentReports({
        status,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      setReports((current) => cursor ? [...current, ...page.reports] : page.reports);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load reports.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async (
    report: ContentReportDto,
    action: "close" | "delete_message_and_close",
  ) => {
    const confirmed = window.confirm(
      action === "delete_message_and_close"
        ? "Permanently delete this message for everyone and close the report?"
        : "Close this report without deleting content?",
    );
    if (!confirmed) return;
    setActingId(report.id);
    setError(null);
    try {
      await apiClient.actOnContentReport(report.id, action);
      setReports((current) => current.filter((item) => item.id !== report.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the report.");
    } finally {
      setActingId(null);
    }
  }, []);

  return (
    <section id="reports" data-testid="admin-reports-section" aria-labelledby="reports-title">
      <div className="rounded-lg border border-border bg-background-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="reports-title" className="text-base font-semibold">Reports</h2>
            <p className="mt-1 text-sm text-foreground-muted">
              Review reports submitted to this Server.
            </p>
          </div>
          <div className="inline-flex rounded-md border border-border p-0.5" aria-label="Report status">
            {(["open", "closed"] as const).map((value) => (
              <button key={value} type="button" onClick={() => setStatus(value)}
                aria-pressed={status === value}
                className={`rounded px-3 py-1.5 text-xs font-medium capitalize ${status === value ? "bg-background-element text-foreground" : "text-foreground-muted"}`}>
                {value}
              </button>
            ))}
          </div>
        </div>

        {error ? <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500" role="alert">{error}</div> : null}
        {loading ? (
          <p className="mt-5 text-sm text-foreground-muted">Loading reports…</p>
        ) : reports.length === 0 ? (
          <p className="mt-5 text-sm text-foreground-muted">No {status} reports.</p>
        ) : (
          <div className="mt-5 flex flex-col gap-3">
            {reports.map((report) => (
              <article key={report.id} className="rounded-md border border-border bg-background p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">{CONTENT_REPORT_REASON_LABELS[report.reason]}</div>
                    <div className="mt-0.5 text-xs text-foreground-muted">
                      Reported by {humanLabel(report.reporter)} · {new Date(report.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${report.sourceAvailable ? "bg-green-500/10 text-green-600" : "bg-background-element text-foreground-muted"}`}>
                    {report.sourceAvailable ? "Source available" : "Source unavailable"}
                  </span>
                </div>
                <div className="mt-3 whitespace-pre-wrap break-words rounded-md bg-background-element p-3 text-sm">{targetLabel(report)}</div>
                {report.preview.attachments.length > 0 ? (
                  <ul className="mt-2 text-xs text-foreground-muted">
                    {report.preview.attachments.map((attachment, index) => (
                      <li key={`${attachment.filename}:${index}`}>{attachment.filename} · {attachment.mimeType} · {attachment.sizeBytes.toLocaleString()} bytes</li>
                    ))}
                  </ul>
                ) : null}
                {report.comment ? <div className="mt-3 text-sm"><span className="font-medium">Reporter comment:</span> {report.comment}</div> : null}
                {report.status === "closed" ? (
                  <div className="mt-3 text-xs text-foreground-muted">
                    Closed {report.closedAt ? new Date(report.closedAt).toLocaleString() : ""}{report.closedBy ? ` by ${humanLabel(report.closedBy)}` : ""}
                  </div>
                ) : (
                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    {report.target.type === "message" && report.sourceAvailable ? (
                      <button type="button" disabled={actingId === report.id}
                        onClick={() => void act(report, "delete_message_and_close")}
                        className="rounded-md border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-500 disabled:opacity-50">
                        Delete message and close
                      </button>
                    ) : null}
                    <button type="button" disabled={actingId === report.id}
                      onClick={() => void act(report, "close")}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] disabled:opacity-50">
                      {actingId === report.id ? "Working…" : "Close report"}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        {nextCursor ? (
          <button type="button" disabled={loadingMore} onClick={() => void load(nextCursor)}
            className="mt-4 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50">
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
