import type { CommandApprovalRow } from "@nautilo/api-client";
import { ApprovalRow } from "./approval-row";
import {
  groupApprovalsByScope,
  roomGroupTestId,
  roomGroupTitle,
  SERVER_GROUP_TITLE,
} from "./group-approvals";

function GroupCountBadge({ count }: { count: number }) {
  return (
    <span
      className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-background-element px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground-muted"
    >
      {count}
    </span>
  );
}

function ApprovalGroup({
  title,
  testId,
  rows,
  onRevokeCommit,
  revokeUndoMs,
}: {
  title: string;
  testId: string;
  rows: readonly CommandApprovalRow[];
  onRevokeCommit: (id: string) => Promise<void>;
  revokeUndoMs?: number;
}) {
  if (rows.length === 0) return null;

  return (
    <section data-testid={testId} className="border-b border-border last:border-b-0">
      <header className="bg-background-element/50 px-4 py-2">
        <h2 className="flex items-center text-[11px] font-semibold tracking-wide text-foreground-muted uppercase">
          <span>{title}</span>
          <GroupCountBadge count={rows.length} />
        </h2>
      </header>
      <ul>
        {rows.map((row) => (
          <ApprovalRow
            key={row.id}
            row={row}
            onRevokeCommit={onRevokeCommit}
            revokeUndoMs={revokeUndoMs}
          />
        ))}
      </ul>
    </section>
  );
}

export function ApprovalsList({
  rows,
  onRevokeCommit,
  revokeUndoMs,
}: {
  rows: readonly CommandApprovalRow[];
  onRevokeCommit: (id: string) => Promise<void>;
  revokeUndoMs?: number;
}) {
  const grouped = groupApprovalsByScope(rows);

  return (
    <div
      data-testid="approvals-list"
      className="overflow-hidden rounded-lg border border-border bg-background-panel"
    >
      <ApprovalGroup
        title={SERVER_GROUP_TITLE}
        testId={`approval-group-${SERVER_GROUP_TITLE}`}
        rows={grouped.server}
        onRevokeCommit={onRevokeCommit}
        revokeUndoMs={revokeUndoMs}
      />
      {grouped.rooms.map((roomGroup) => (
        <ApprovalGroup
          key={roomGroup.roomId}
          title={roomGroupTitle(roomGroup)}
          testId={roomGroupTestId(roomGroup)}
          rows={roomGroup.rows}
          onRevokeCommit={onRevokeCommit}
          revokeUndoMs={revokeUndoMs}
        />
      ))}
    </div>
  );
}
