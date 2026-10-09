import type {
  PersonalCostsRecoveryAttempt,
  PersonalCostsByTaskRow,
  ServiceCostOperationsSummary,
  ServiceCostRecoveryAttempt,
} from "@nautilo/types";
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
      <p className="mb-3 text-xs text-foreground-muted">
        References identify Tasks without revealing their instructions or results.
        Paid-service attribution is available for newly recorded service activity;
        older service costs may remain only in provider totals.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-foreground-muted">
            <th className="pb-2 font-medium">Task reference</th>
            <th className="pb-2 text-right font-medium">Model attempts</th>
            <th className="pb-2 text-right font-medium">Paid operations</th>
            <th className="pb-2 text-right font-medium">Actual</th>
            <th className="pb-2 text-right font-medium">Current estimate</th>
            <th className="pb-2 text-right font-medium">Known spend</th>
            <th className="pb-2 text-right font-medium">Unresolved</th>
          </tr></thead>
          <tbody>{rows.map((row) => {
            const service = row as PersonalCostsByTaskRow & {
              providerOperations?: number;
              unknownProviderOperations?: number;
            };
            return <tr key={row.taskId} className="border-t border-border">
              <td className="py-2"><code className="text-xs">{row.taskId}</code></td>
              <td className="py-2 text-right tabular-nums">{formatInt(row.calls)}</td>
              <td className="py-2 text-right tabular-nums">{formatInt(service.providerOperations ?? 0)}</td>
              <td className="py-2 text-right tabular-nums">{formatUsd(row.actualCostUsd)}</td>
              <td className="py-2 text-right tabular-nums">{formatUsd(row.estimatedCostUsd)}</td>
              <td className="py-2 text-right tabular-nums">{formatUsd(row.totalCostUsd)}</td>
              <td className="py-2 text-right tabular-nums">{formatInt(row.pendingAttempts + row.unknownAttempts + (service.unknownProviderOperations ?? 0))}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </Panel>
  );
}

export function CostsServiceOperations({ summary }: {
  summary: ServiceCostOperationsSummary | null | undefined;
}) {
  if (!summary || summary.operations === 0) return null;
  return (
    <Panel title="Paid service outcomes">
      <p className="text-sm">
        {formatInt(summary.operations)} operations · {formatInt(summary.succeeded)} succeeded · {formatInt(summary.failed)} failed · {formatInt(summary.cancelled)} cancelled · {formatInt(summary.interrupted)} interrupted · {formatInt(summary.unknown)} unknown
        {summary.legacy > 0 ? ` · ${formatInt(summary.legacy)} older unclassified` : ""}
      </p>
      {summary.legacy > 0 ? (
        <p className="mt-1 text-xs text-foreground-muted">
          Older service activity predates outcome and Task attribution tracking,
          so no outcome is inferred and some spend may appear only in provider totals.
        </p>
      ) : null}
    </Panel>
  );
}

export function CostsServiceRecoveryPanel({ attempts }: {
  attempts: readonly ServiceCostRecoveryAttempt[];
}) {
  if (attempts.length === 0) return null;
  return (
    <Panel title="Recent unresolved paid services">
      <p className="mb-3 text-xs text-foreground-muted">
        Showing up to 100 newest paid service operations whose charge is still unknown.
        Older unresolved operations remain included in the totals.
      </p>
      <ul className="divide-y divide-border">
        {attempts.map((attempt, index) => (
          <li key={`${attempt.provider}:${attempt.operation}:${attempt.occurredAt}:${index}`} className="py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>
                {attempt.provider} · {attempt.operation}
                {attempt.workload ? ` · ${attempt.workload.replaceAll("_", " ")}` : ""}
              </strong>
              <time dateTime={attempt.occurredAt} className="text-foreground-muted">
                {new Date(attempt.occurredAt).toLocaleString()}
              </time>
            </div>
            <p className="mt-1 text-foreground-muted">
              Outcome {attempt.attemptOutcome ?? "older unclassified"}
              {attempt.failureCode ? ` · Failure ${attempt.failureCode.replaceAll("_", " ")}` : ""}
              {attempt.requestReference ? ` · Request ${attempt.requestReference}` : ""}
              {attempt.taskId ? ` · Task ${attempt.taskId}` : ""}
              {attempt.runId ? ` · Run ${attempt.runId}` : ""}
              {attempt.jobId ? ` · Job ${attempt.jobId}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
