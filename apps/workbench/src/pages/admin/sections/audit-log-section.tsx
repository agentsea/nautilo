import { AuditLogViewer } from "../../../components/security/audit-log-viewer";

export function AuditLogSection() {
  return (
    <section
      id="audit-log"
      data-testid="admin-audit-log-section"
      className="rounded-lg border border-border bg-background-panel"
      aria-labelledby="audit-log-title"
    >
      <header className="border-b border-border px-5 py-3">
        <h2 id="audit-log-title" className="text-sm font-semibold">
          Audit log
        </h2>
        <p className="mt-1 text-xs text-foreground-muted">
          Server-wide security audit events with kind, actor, and time filters.
        </p>
      </header>
      <div className="px-5 py-4">
        <AuditLogViewer />
      </div>
    </section>
  );
}
