import { useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";

import { useAppTheme } from "@/providers/theme";
import { useAttention } from "@/providers/attention";
import { ApprovalCard } from "@/components/approval-card";
import type { AppTheme } from "@/theme/tokens";

import { projectTaskWorkOverview, type TaskWorkOverviewDisplayRow, type TaskWorkOverviewSection } from "./task-work-overview-presentation";
import { taskApprovalForOverviewRow } from "./task-attention-placement";
import { TaskWorkOverviewRow } from "./task-work-overview-row";
import type { TaskWorkViewState } from "./task-work-state";

type TaskWorkOverviewContentProps = {
  readonly view: TaskWorkViewState;
  readonly serverUrl: string;
  readonly onSelectTask?: (taskId: string) => void;
  /** Injectable for deterministic row timing tests; the shell need not own a timer. */
  readonly nowMs?: number;
};

type TaskWorkOverviewListSection = TaskWorkOverviewSection & {
  readonly data: readonly TaskWorkOverviewDisplayRow[];
};

/** Bounded, scroll-contained section renderer; controller state stays outside. */
export function TaskWorkOverviewContent({ view, serverUrl, onSelectTask, nowMs = Date.now() }: TaskWorkOverviewContentProps) {
  const t = useAppTheme();
  const { pendingApprovals } = useAttention();
  const [doneExpanded, setDoneExpanded] = useState(false);
  const projection = useMemo(() => projectTaskWorkOverview({
    overviewRows: view.selectors.overviewRows,
    newlyCompleted: view.selectors.newlyCompleted,
    doneExpanded,
  }), [doneExpanded, view.selectors.newlyCompleted, view.selectors.overviewRows]);
  const sections = useMemo<readonly TaskWorkOverviewListSection[]>(
    () => projection.sections
      .filter((section) => section.count > 0)
      .map((section) => ({ ...section, data: section.rows })),
    [projection.sections],
  );
  const styles = useMemo(() => createStyles(t), [t]);

  if (projection.empty) {
    return <View style={styles.empty}><Text allowFontScaling style={styles.emptyText}>No delegated work to display.</Text></View>;
  }

  return <SectionList<TaskWorkOverviewDisplayRow, TaskWorkOverviewListSection>
    style={styles.list}
    contentContainerStyle={styles.listContent}
    accessibilityRole="list"
    sections={sections}
    keyExtractor={(displayRow) => displayRow.row.taskId}
    renderItem={({ item, section }) => {
      const taskApproval = taskApprovalForOverviewRow({
        sectionId: section.id,
        taskId: item.row.taskId,
        pendingApprovals,
      });
      return <View>
        <TaskWorkOverviewRow
          displayRow={item}
          serverUrl={serverUrl}
          nowMs={nowMs}
          needsAttention={section.id === "needs-you"}
          onSelectTask={onSelectTask}
        />
        {taskApproval ? <ApprovalCard approval={taskApproval} /> : null}
      </View>;
    }}
    renderSectionHeader={({ section }) => <TaskWorkOverviewSectionHeader
      section={section}
      onToggleDone={section.id === "done" ? () => setDoneExpanded((expanded) => !expanded) : undefined}
    />}
  />;
}

function TaskWorkOverviewSectionHeader({
  section,
  onToggleDone,
}: {
  readonly section: TaskWorkOverviewSection;
  readonly onToggleDone?: () => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const isDone = section.id === "done";
  const expanded = isDone ? !section.collapsed : true;
  const heading = `${section.title} (${section.count})`;
  const headingContent = <Text allowFontScaling style={styles.sectionTitle}>{heading}</Text>;

  return <View style={styles.section}>
    {isDone ? (
      <Pressable
        onPress={onToggleDone}
        style={styles.doneToggle}
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Hide" : "Show"} ${section.count} completed ${section.count === 1 ? "task" : "tasks"}`}
        accessibilityState={{ expanded }}>
        {headingContent}
        <Text allowFontScaling style={styles.doneDisclosure} accessible={false}>{expanded ? "Hide" : "Show"}</Text>
      </Pressable>
    ) : <View style={styles.sectionHeading} accessible accessibilityRole="header" accessibilityLabel={heading}>{headingContent}</View>}
  </View>;
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    list: { flex: 1 },
    listContent: { paddingBottom: t.spacing.lg },
    section: { marginTop: t.spacing.sm },
    sectionHeading: { minHeight: 36, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.xs, justifyContent: "center" },
    sectionTitle: { flexShrink: 1, color: t.color.text.foreground, ...t.typography.label },
    doneToggle: { minHeight: 44, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.xs, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: t.spacing.sm, rowGap: t.spacing.xs },
    doneDisclosure: { flexShrink: 0, color: t.color.border.interactive, ...t.typography.label },
    empty: { flex: 1, justifyContent: "center", padding: t.spacing.lg },
    emptyText: { color: t.color.text.muted, ...t.typography.body },
  });
}
