import type { ReactElement } from "react";
import type { TaskHarnessActivity } from "@nautilo/types";
import { ToolCard } from "../../../components/tool-card/tool-card";
import {
  projectToolArgsForCardDisplay,
  projectToolResultTextForDisplay,
} from "../../../components/tool-argument-preview";
import { preserveComputerUseResultForCard } from "../../../components/tool-card/renderers/computer-use";
import { preserveConnectedAppResultForCard } from "../../../components/tool-card/renderers/connected-app-receipt";
import type { ToolActivityEvent } from "../../../adapters/runtime-contexts";
import { ReaderMarkdown } from "../../../viewers/markdown/markdown-viewer";

export function HarnessActivityFeed({
  activity,
  defaultExpanded = true,
  terminalState,
  className = "",
}: {
  readonly activity: readonly TaskHarnessActivity[];
  readonly defaultExpanded?: boolean;
  readonly terminalState?: "cancelled";
  readonly className?: string;
}): ReactElement | null {
  if (activity.length === 0) return null;
  return (
    <div
      className={`flex flex-col gap-1.5 ${className}`}
      data-testid="subagent-harness-activity-feed"
      aria-label="Harness execution activity"
    >
      {activity.map((item) => (
        <HarnessActivityCard
          key={item.id}
          activity={item}
          defaultExpanded={defaultExpanded}
          terminalState={terminalState}
        />
      ))}
    </div>
  );
}

function HarnessActivityCard({
  activity,
  defaultExpanded,
  terminalState,
}: {
  readonly activity: TaskHarnessActivity;
  readonly defaultExpanded: boolean;
  readonly terminalState?: "cancelled";
}): ReactElement {
  const safeArgs = projectToolArgsForCardDisplay(activity.args);
  const safeResult = preserveComputerUseResultForCard(activity.name, activity.result)
    ?? preserveConnectedAppResultForCard(activity.name, activity.result)
    ?? projectToolResultTextForDisplay(activity.result);
  const status =
    activity.status === "completed"
      ? "ok"
      : activity.status === "failed"
        ? "error"
        : "running";
  const event: ToolActivityEvent = {
    toolCallId: activity.id,
    toolName: activity.name,
    args: safeArgs,
    status,
    startedAt: activity.startedAt,
    ...(activity.endedAt !== undefined ? { endedAt: activity.endedAt } : {}),
    ...(safeResult !== undefined ? { result: safeResult } : {}),
    ...(activity.status === "failed" && safeResult
      ? { error: safeResult }
      : {}),
  };
  const summary = activity.name === "external_command" && typeof safeArgs["detail"] === "string"
    ? safeArgs["detail"].trim()
    : "";
  const isAssistantResponse = activity.name === "assistant_response";
  return (
    <ToolCard
      toolName={activity.name}
      toolCallId={activity.id}
      args={safeArgs}
      result={safeResult}
      isError={activity.status === "failed"}
      status={{ type: status === "running" ? "running" : "complete" }}
      activityOverride={event}
      {...(isAssistantResponse
        ? {
            displayName: "Assistant response",
            expandedContent: (
              <div
                className="border-t border-border px-3 py-2 text-sm text-foreground"
                data-testid="assistant-streaming-response"
              >
                <ReaderMarkdown content={safeResult ?? ""} />
              </div>
            ),
          }
        : summary
        ? {
            displayName: summary,
            expandedContent: (
              <div className="border-t border-border px-3 py-2 text-xs text-foreground-muted">
                <p className="whitespace-pre-wrap break-words">{summary}</p>
              </div>
            ),
          }
        : {})}
      stateOverride={terminalState}
      defaultExpanded={defaultExpanded}
    />
  );
}
