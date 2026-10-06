import type { PersonalCostsRecoveryAttempt, PersonalCostsByTaskRow } from "@nautilo/types";
import { formatInt, formatUsd } from "./costs-view-model";
import { Panel } from "./costs-dashboard";

function recoveryActionLabel(action: PersonalCostsRecoveryAttempt["repairAction"]): string {
  switch (action) {
    case "wait_for_receipt": return "Waiting for the provider receipt.";
    case "retry_receipt_read": return "Receipt lookup will retry automatically; no new inference is sent.";
    case "check_receipt_access": return "Check receipt-read access for the key that created this request.";
    case "contact_operator": return "Contact the server operator to repair credential custody.";
    case "review_cost": return "No automatic settlement is available. Review this request with the provider.";
  }
}

export function CostsRecoveryPanel({ attempts, keysPath }: {
  attempts: readonly PersonalCostsRecoveryAttempt[];
  keysPath: string;
}) {
  if (attempts.length === 0) return null;
  return (
    <Panel title="Recent unresolved attempts">
      <p className="mb-3 text-xs text-foreground-muted">
        Recent attempts with delayed or unknown costs. References contain no prompts, outputs or keys.
        {" "}<a className="text-primary hover:underline" href={keysPath}>Manage provider keys</a>
      </p>
      <ul className="divide-y divide-border">
        {attempts.map((attempt) => (
          <li key={attempt.attemptId} className="py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>{attempt.providerRoute} · {attempt.status}</strong>
              <time dateTime={attempt.lastObservedAt} className="text-foreground-muted">
                {new Date(attempt.lastObservedAt).toLocaleString()}
              </time>
            </div>
            <p className="mt-1">{recoveryActionLabel(attempt.repairAction)}</p>
            <p className="mt-1 break-all text-foreground-muted">
              Attempt {attempt.attemptId}
              {attempt.requestReference ? ` · Request reference ${attempt.requestReference}` : " · No provider request reference"}
              {attempt.taskId ? ` · Task ${attempt.taskId}` : ""}
              {" · "}Reason: {attempt.reason.replaceAll("_", " ")}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function CostsTaskAttribution({ rows }: { rows: readonly PersonalCostsByTaskRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Panel title="By Task">
      <p className="mb-3 text-xs text-foreground-muted">References identify Tasks without revealing their instructions or results.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-foreground-muted">
            <th className="pb-2 font-medium">Task reference</th>
            <th className="pb-2 text-right font-medium">Attempts</th>
            <th className="pb-2 text-right font-medium">Known spend</th>
            <th className="pb-2 text-right font-medium">Unresolved</th>
          </tr></thead>
          <tbody>{rows.map((row) => <tr key={row.taskId} className="border-t border-border">
            <td className="py-2"><code className="text-xs">{row.taskId}</code></td>
            <td className="py-2 text-right tabular-nums">{formatInt(row.calls)}</td>
            <td className="py-2 text-right tabular-nums">{formatUsd(row.totalCostUsd)}</td>
            <td className="py-2 text-right tabular-nums">{formatInt(row.pendingAttempts + row.unknownAttempts)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </Panel>
  );
}
