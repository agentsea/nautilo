import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommandApprovalRow } from "@nautilo/api-client";
import { apiClient } from "../../lib/api";
import { Button } from "../../pages/settings/ui";
import { ApprovalsFilters } from "./approvals-filters";
import { ApprovalsList } from "./approvals-list";
import { filterApprovals, type ApprovalFilters } from "./filter-approvals";
import { RevokeAllConfirmModal } from "./revoke-all-confirm-modal";

const DEFAULT_FILTERS: ApprovalFilters = {
  scope: "all",
  search: "",
  family: "all",
};

function ApprovalsSkeleton() {
  return (
    <div
      data-testid="approvals-skeleton"
      className="overflow-hidden rounded-lg border border-border bg-background-panel"
      aria-busy="true"
      aria-label="Loading approvals"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex animate-pulse flex-col gap-2 border-b border-border/40 px-4 py-3 last:border-b-0"
        >
          <div className="h-4 w-2/3 rounded bg-background-element" />
          <div className="h-3 w-1/3 rounded bg-background-element" />
        </div>
      ))}
    </div>
  );
}

export function ApprovalsPane({
  revokeUndoMs,
  initialFilters,
}: {
  revokeUndoMs?: number;
  /** Test seam — seed filter state without simulating text input in happy-dom. */
  initialFilters?: Partial<ApprovalFilters>;
}) {
  const [rows, setRows] = useState<CommandApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [bulkRevoking, setBulkRevoking] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ApprovalFilters>({
    ...DEFAULT_FILTERS,
    ...initialFilters,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.listStandingApprovals();
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredRows = useMemo(
    () => filterApprovals(rows, filters),
    [rows, filters],
  );

  const handleRevokeCommit = useCallback(async (id: string) => {
    await apiClient.revokeStandingApproval(id);
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const handleRevokeAllConfirm = useCallback(async () => {
    setRevokeAllOpen(false);
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return;

    setBulkRevoking(true);
    setBulkError(null);

    const failedIds: string[] = [];
    for (const id of ids) {
      try {
        await apiClient.revokeStandingApproval(id);
      } catch {
        failedIds.push(id);
      }
    }

    if (failedIds.length === 0) {
      setRows([]);
    } else {
      setBulkError(
        failedIds.length === ids.length
          ? "Could not revoke approvals. Try again."
          : `Could not revoke ${failedIds.length} of ${ids.length} approvals.`,
      );
      try {
        const data = await apiClient.listStandingApprovals();
        setRows(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    setBulkRevoking(false);
  }, [rows]);

  const hasAnyRows = !loading && !error && rows.length > 0;
  const showFilteredEmpty = hasAnyRows && filteredRows.length === 0;
  const showList = hasAnyRows && filteredRows.length > 0;

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-3xl flex-col gap-4 px-6 py-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Standing rules that skip the approval prompt for matching tool calls.
          </p>
        </div>
        {hasAnyRows ? (
          <Button
            variant="ghost"
            disabled={bulkRevoking}
            loading={bulkRevoking}
            ariaLabel="Revoke all approvals"
            onClick={() => setRevokeAllOpen(true)}
          >
            Revoke all
          </Button>
        ) : null}
      </header>

      {loading ? <ApprovalsSkeleton /> : null}

      {!loading && error ? (
        <div
          data-testid="approvals-error"
          className="rounded-lg border border-border bg-background-panel px-4 py-6 text-center"
          role="alert"
        >
          <p className="text-sm text-[var(--error)]">{error}</p>
          <div className="mt-3">
            <Button variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </div>
      ) : null}

      {!loading && !error && rows.length === 0 ? (
        <div
          data-testid="approvals-empty"
          className="rounded-lg border border-border bg-background-panel px-4 py-10 text-center"
        >
          <p className="text-sm text-foreground-muted">
            No standing approvals yet. Approve a tool with &ldquo;This room&rdquo; or
            &ldquo;Always&rdquo; from the chat dock to create one.
          </p>
        </div>
      ) : null}

      {hasAnyRows ? (
        <>
          {bulkError ? (
            <div
              data-testid="approvals-bulk-error"
              className="rounded-lg border border-border bg-background-panel px-4 py-3 text-sm text-[var(--error)]"
              role="alert"
            >
              {bulkError}
            </div>
          ) : null}
          <ApprovalsFilters allRows={rows} filters={filters} onChange={setFilters} />
        </>
      ) : null}

      {showFilteredEmpty || showList ? (
        <div data-testid="approvals-scroll" className="min-h-0 flex-1 overflow-y-auto">
          {showFilteredEmpty ? (
            <div
              data-testid="approvals-filter-empty"
              className="rounded-lg border border-border bg-background-panel px-4 py-10 text-center"
            >
              <p className="text-sm text-foreground-muted">No matching approvals</p>
            </div>
          ) : null}

          {showList ? (
            <ApprovalsList
              rows={filteredRows}
              onRevokeCommit={handleRevokeCommit}
              revokeUndoMs={revokeUndoMs}
            />
          ) : null}
        </div>
      ) : null}

      {revokeAllOpen ? (
        <RevokeAllConfirmModal
          count={rows.length}
          onCancel={() => setRevokeAllOpen(false)}
          onConfirm={() => void handleRevokeAllConfirm()}
        />
      ) : null}
    </div>
  );
}
