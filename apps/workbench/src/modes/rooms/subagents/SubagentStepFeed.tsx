import type { ReactElement } from "react";
import { stepLineFor, type TranscriptMessageVM } from "./transcript-vm";

/**
 * D314 Phase A (Stack 92) — L1 condensed "step feed".
 *
 * Rendered inside an expanded `SubagentCard` (L1). A scrollable, dense list of
 * `› step` rows that mirror the dock's existing `line3` look. Presentational
 * only: it renders whatever `TranscriptMessageVM[]` it is handed (a hardcoded
 * fixture in Phase A).
 */
export function SubagentStepFeed({
  messages,
}: {
  readonly messages: readonly TranscriptMessageVM[];
}): ReactElement {
  return (
    <div
      className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto pl-[22px]"
      data-testid="subagent-step-feed"
    >
      {messages.length === 0 ? (
        <p className="text-[10px] italic leading-tight text-foreground-muted">(no steps yet)</p>
      ) : (
        messages.map((message, i) => {
          const line = stepLineFor(message);
          return (
            <p
              key={`${message.createdAt}-${i}`}
              className="truncate text-[10px] leading-tight text-foreground-muted"
              title={line}
            >
              › {line}
            </p>
          );
        })
      )}
    </div>
  );
}
