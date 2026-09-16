/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildAppTheme } from "@/theme/tokens";

describe("Task work overview row component contract", () => {
  test("keeps portrait, one detail seam, text status, long text, and a 44pt target", () => {
    const source = readFileSync(resolve(import.meta.dir, "task-work-overview-row.tsx"), "utf8");
    expect(source).toContain("<TaskAgentAvatar");
    expect(source).toContain("onSelectTask?: (taskId: string) => void");
    expect(source).toContain("accessibilityHint=\"View task details\"");
    expect(source).toContain("accessibilityRole=\"button\"");
    expect(source).toContain("if (!onSelectTask)");
    expect(source).toContain("instead of pretending that a disabled button can disclose details");
    expect(source).toContain("minHeight: 72");
    expect(source).toContain("allowFontScaling");
    expect(source).toContain("useWindowDimensions");
    expect(source).toContain("const largeText = fontScale >= 1.3");
    expect(source).toContain('flexDirection: largeText ? "column" : "row"');
    expect(source).toContain('<Text accessible={false} allowFontScaling={false} style={styles.disclosure}>›</Text>');
    expect(source).toContain("presentation.statusLabel");
    expect(source).toContain("presentation.activity");
    expect(source).toContain("presentation.displayParentTaskId");
    expect(source).toContain("presentation.displayDepth");
    expect(source).not.toContain("accessibilityState={{ disabled: !onSelectTask }}");
    expect(source).toContain('role="listitem"');
    expect(source).toContain("useReducedMotion");
    expect(source).toContain("shouldAnimateTaskWorkOverviewRow");
    expect(source).toContain("Animated.loop");
    expect(source).not.toMatch(/numberOfLines|source count|tool count|summari[sz]/i);
  });

  test("uses semantic theme tokens in both supported theme modes", () => {
    const source = readFileSync(resolve(import.meta.dir, "task-work-overview-row.tsx"), "utf8");
    expect(source).toContain("useAppTheme");
    expect(source).toContain("t.color.surface.background");
    expect(source).toContain("t.color.text.foreground");
    expect(source).toContain("t.color.status.error");
    expect(source).not.toMatch(/#[0-9A-F]{3,8}/i);
    for (const mode of ["light", "dark"] as const) {
      const theme = buildAppTheme(mode);
      expect(theme.color.surface.background).toBeTruthy();
      expect(theme.color.text.foreground).toBeTruthy();
      expect(theme.color.status.error).toBeTruthy();
    }
  });

  test("keeps exact Approval and PIN discoverability informational in the overview", () => {
    const source = readFileSync(resolve(import.meta.dir, "task-work-overview-row.tsx"), "utf8");
    expect(source).toContain("useAttention");
    expect(source).toContain("pendingApprovalForTask(displayRow.row.taskId)");
    expect(source).toContain("activeChallengeForTask(displayRow.row.taskId)");
    expect(source).toContain('"Approval required"');
    expect(source).toContain('"PIN required"');
    expect(source).toContain("accessibilityRole=\"text\"");
    expect(source).not.toMatch(/resolveChallenge|replyToApproval|PinModal/);

    const content = readFileSync(resolve(import.meta.dir, "task-work-overview-content.tsx"), "utf8");
    expect(content).toContain("taskApprovalForOverviewRow({");
    expect(content).toContain("taskId: item.row.taskId");
    expect(content).toContain("pendingApprovals");
    expect(content).toContain("<ApprovalCard approval={taskApproval} />");
  });

  test("keeps Done disclosure shell-local, bounded, explicit, and touch-safe", () => {
    const source = readFileSync(resolve(import.meta.dir, "task-work-overview-content.tsx"), "utf8");
    expect(source).toContain("const [doneExpanded, setDoneExpanded] = useState(false)");
    expect(source).toContain("projectTaskWorkOverview");
    expect(source).toContain("accessibilityState={{ expanded }}");
    expect(source).toContain("minHeight: 44");
    expect(source).toContain("accessibilityRole=\"list\"");
    expect(source).toContain("SectionList");
    expect(source).toContain("accessibilityRole=\"header\"");
    expect(source).not.toMatch(/ScrollView|FlatList|TextInput|Modal|BottomSheet/);
    expect(source).toContain('flexWrap: "wrap"');
    expect(source).toContain("columnGap: t.spacing.sm");
  });
});
