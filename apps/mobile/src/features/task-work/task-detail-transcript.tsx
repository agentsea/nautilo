import { useMemo, type ReactElement } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import {
  isTaskTranscriptToolRow,
  type TaskTranscriptMessageVM,
} from "@nautilo/types";

import { MessageBubble } from "@/components/message-bubble";
import { ToolCard } from "@/components/tool-card";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { TaskDetailHarnessActivity } from "./task-detail-live-activity";
import {
  MOBILE_PROTECTED_TASK_DETAIL,
  mobileTaskDefinitionContent,
  mobileTaskRunContent,
  mobileTaskTranscript,
  type MobileTaskDetail,
} from "./task-content-mobile";

/**
 * A read-only, non-inverted Task run transcript. It intentionally owns no
 * Room chat panes, route-owned chat state, action rails, assistant-ui runtime, or stores.
 */
export function TaskDetailTranscript({
  detail,
  activity,
  loading,
  header,
  recovery,
  harnessActivity,
}: {
  readonly detail: MobileTaskDetail;
  readonly activity: string;
  readonly loading: boolean;
  readonly header: ReactElement;
  readonly recovery?: ReactElement | null;
  readonly harnessActivity: TaskDetailHarnessActivity | null;
}): ReactElement {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const rows = useMemo(() => mobileTaskTranscript(detail), [detail]);
  const definition = mobileTaskDefinitionContent(detail);
  const latestRun = detail.runs.at(-1);
  const latestRunUnsupported = latestRun !== undefined
    && mobileTaskRunContent(latestRun).status === "unsupported_client";

  return (
    <FlatList
      data={rows}
      keyExtractor={(item) => item.key}
      renderItem={({ item }) => <TaskTranscriptRow item={item} />}
      contentContainerStyle={styles.content}
      ListHeaderComponent={
        <>
          {header}
          <View style={styles.activity} accessibilityLabel={`Task activity: ${activity}`}>
            <Text style={styles.activityLabel}>Activity</Text>
            <Text selectable style={styles.activityText}>{activity}</Text>
          </View>
          {definition.status === "unsupported_client" ? <Text style={styles.meta} accessibilityRole="alert">{MOBILE_PROTECTED_TASK_DETAIL}</Text> : null}
          {definition.expectedOutput ? <Text selectable style={styles.meta}>Expected output: {definition.expectedOutput}</Text> : null}
          {latestRun?.startedAt ? <Text selectable style={styles.meta}>Started: {latestRun.startedAt}</Text> : null}
          {latestRun?.completedAt ? <Text selectable style={styles.meta}>Completed: {latestRun.completedAt}</Text> : null}
          {harnessActivity ? <ToolCard name={harnessActivity.name} status={harnessActivity.status === "running" ? "start" : "end"} taskActivityStatus={harnessActivity.status} args={harnessActivity.args} result={harnessActivity.result} taskTranscript /> : null}
          {loading ? <Text style={styles.refreshing}>Refreshing task…</Text> : null}
          {recovery ?? null}
        </>
      }
      ListEmptyComponent={
        <Text style={styles.empty} accessibilityLiveRegion="polite">
          {definition.status === "unsupported_client" || latestRunUnsupported ? MOBILE_PROTECTED_TASK_DETAIL
            : loading ? "Loading transcript…" : latestRun ? "No transcript is available for this run." : "No runs yet."}
        </Text>
      }
      accessibilityLabel="Task transcript"
    />
  );
}

function TaskTranscriptRow({ item }: { readonly item: TaskTranscriptMessageVM }): ReactElement | null {
  if (item.role === "assistant") {
    return (
      <MessageBubble
        role="assistant"
        outgoing={false}
        content={item.content}
        selectableContent
      />
    );
  }
  if (isTaskTranscriptToolRow(item)) {
    return <ToolCard name={item.toolName ?? "tool"} status="end" args={item.args} result={item.resultText} taskTranscript />;
  }
  // Retain this strict renderer gate so a future mapper cannot turn a Task
  // transcript into a Room-like surface.
  return null;
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    content: { flexGrow: 1, padding: t.spacing.lg, gap: t.spacing.sm },
    activity: { gap: 2, borderRadius: t.radii.md, backgroundColor: t.color.surface.element, padding: t.spacing.md, marginBottom: t.spacing.xs },
    activityLabel: { color: t.color.text.muted, ...t.typography.caption, fontWeight: "700" },
    activityText: { color: t.color.text.foreground, ...t.typography.body },
    refreshing: { color: t.color.text.muted, ...t.typography.caption, marginBottom: t.spacing.xs },
    meta: { color: t.color.text.muted, ...t.typography.caption },
    empty: { color: t.color.text.muted, ...t.typography.body, paddingVertical: t.spacing.md },
  });
}
