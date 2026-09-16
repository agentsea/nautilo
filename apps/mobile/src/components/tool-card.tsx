import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  publicBrowserReadActiveSchema,
  connectedWebOperationTerminalReadResultSchema,
  parseGenieRecoveryResultV1,
  parseGuideUserResultV1,
} from '@nautilo/types';

import { useAppTheme } from '@/providers/theme';
import type { AppTheme } from '@/theme/tokens';
import type { TaskHarnessActivity } from '@nautilo/types';

const INCOMING_AVATAR_COLUMN = 28 + 8;
const UNSUPPORTED_GUIDANCE_COPY = 'Use the visible Nautilo menus to continue.';
const RECOVERY_TOOL_NAMES = new Set([
  'google_workspace',
  'launch_customization',
  'task',
  'in_background',
]);
const SSH_RECOVERY_TOOL_NAMES = new Set([
  'structured_ssh_auth',
  'structured_ssh_exec',
  'structured_ssh_copy_upload',
  'structured_ssh_copy_download',
]);

function looksLikeLegacyActionTokenOrRoute(value: string): boolean {
  // Old servers may leave an opaque all-caps action token in a transcript.
  // Keep it inert without coupling Mobile to a retired action family.
  return /(?:^|\s)[A-Z][A-Z0-9_]*_ACTION:[A-Za-z0-9_.-]+/u.test(value)
    || /\]\(\/|\/(?:settings|connections|admin)(?:#|\b)/iu.test(value);
}

function discoverToolsRecoveryText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const recovered: { name: string; recovery: unknown }[] = [];
  for (const candidate of value as unknown[]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    if (typeof row.name !== 'string' || !('recovery' in row)) continue;
    recovered.push({ name: row.name, recovery: row.recovery });
  }
  if (recovered.length === 0) return null;

  const texts = new Set<string>();
  const names = new Set<string>();
  for (const row of recovered) {
    if (!SSH_RECOVERY_TOOL_NAMES.has(row.name)) return null;
    const parsed = parseGenieRecoveryResultV1(row.recovery);
    if (
      parsed.recovery.target !== 'connections.ssh'
      || parsed.recovery.requirement !== 'pin'
      || parsed.recovery.domainTool !== row.name
    ) return null;
    names.add(row.name);
    texts.add(parsed.text);
  }
  return names.size > 0 && texts.size === 1 ? (texts.values().next().value ?? null) : null;
}

/**
 * Mobile intentionally has no Workbench target adapter or ui.action
 * presentation. Semantic guidance remains readable and inert here; it never
 * renders a route, action token, or unvalidated guidance JSON.
 */
export function mobileToolCardResultText(name: string, result: string): string {
  if (name === 'browse_web') {
    try {
      const value: unknown = JSON.parse(result);
      const active = publicBrowserReadActiveSchema.safeParse(value);
      if (active.success) return `Browser research started on ${active.data.target.origin}. ${active.data.operation.activity.summary} Your Genie will report the result when the browser work finishes.`;
      const completed = connectedWebOperationTerminalReadResultSchema.safeParse(value);
      if (completed.success && completed.data.account === null) return completed.data.read?.answer ?? 'The browser run finished without a readable answer.';
      return 'Browser research could not return a usable result. Your Genie can explain the next step.';
    } catch { return 'The browser result could not be displayed safely.'; }
  }
  if (name === 'guide_user') {
    try {
      const decoded: unknown = JSON.parse(result);
      const parsed = parseGuideUserResultV1(decoded);
      return parsed.kind === 'guidance' ? parsed.fallbackText : UNSUPPORTED_GUIDANCE_COPY;
    } catch {
      return UNSUPPORTED_GUIDANCE_COPY;
    }
  }

  if (name === 'discover_tools') {
    try {
      const decoded: unknown = JSON.parse(result);
      return discoverToolsRecoveryText(decoded) ?? UNSUPPORTED_GUIDANCE_COPY;
    } catch {
      return UNSUPPORTED_GUIDANCE_COPY;
    }
  }

  if (!RECOVERY_TOOL_NAMES.has(name)) return result;
  try {
    const decoded: unknown = JSON.parse(result);
    return parseGenieRecoveryResultV1(decoded).text;
  } catch {
    return looksLikeLegacyActionTokenOrRoute(result) || /^[{[]/u.test(result.trimStart())
      ? UNSUPPORTED_GUIDANCE_COPY
      : result;
  }
}

type ToolCardProps = {
  name: string;
  status: 'start' | 'end';
  result?: string;
  /** Preserve a truthful terminal state when ordinary result text is collapsed. */
  failed?: boolean;
  /** Ordinary Room cards disclose their already-projected result outside the row. */
  onResultLongPress?: (result: string) => void;
  /** Already-projected durable inputs; rendered only on inert Task rows. */
  args?: Record<string, unknown>;
  /** Durable Task rows are receipts, not success/failure outcomes. */
  taskTranscript?: boolean;
  /** Exact provider-neutral live state; absent for durable transcript receipts. */
  taskActivityStatus?: TaskHarnessActivity['status'];
  /** Align with grouped incoming message text, without fabricating an avatar. */
  groupedIncoming?: boolean;
};

export function taskTranscriptToolState(
  status: TaskHarnessActivity['status'] | undefined,
  result: string | undefined,
): { label: 'Working' | 'Completed' | 'Failed' | 'Waiting' | 'Recorded' | 'Result unavailable'; tone: 'muted' | 'error' | 'warning' } {
  if (status === 'running') return { label: 'Working', tone: 'muted' };
  if (status === 'completed') return { label: 'Completed', tone: 'muted' };
  if (status === 'failed') return { label: 'Failed', tone: 'error' };
  if (status === 'waiting') return { label: 'Waiting', tone: 'warning' };
  return result === undefined ? { label: 'Result unavailable', tone: 'muted' } : { label: 'Recorded', tone: 'muted' };
}

/** Details are deliberately hidden until the user invokes the 44pt disclosure. */
export function taskTranscriptDetailsVisible(open: boolean, taskTranscript: boolean): boolean {
  return taskTranscript && open;
}

export function ToolCard({ name, status, result, failed = false, onResultLongPress, args, taskTranscript = false, taskActivityStatus, groupedIncoming = false }: ToolCardProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isRunning = status === 'start';
  const visibleResult = result ? mobileToolCardResultText(name, result) : undefined;
  const visibleArgs = taskTranscript && args && Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : null;
  const taskState = taskTranscriptToolState(taskActivityStatus, result);
  const taskStateStyle = taskState.tone === 'error' ? styles.failedState
    : taskState.tone === 'warning' ? styles.waitingState : styles.recorded;
  const ordinaryStateLabel = isRunning ? 'Working' : failed ? 'Failed' : 'Completed';

  const content = (
    <>
      <View style={styles.header}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {taskTranscript ? (
          <Text style={taskStateStyle}>{taskState.label}</Text>
        ) : isRunning ? (
          <ActivityIndicator size="small" color={t.color.text.muted} style={styles.spinner} />
        ) : (
          <View style={failed ? styles.failedDot : styles.doneDot} />
        )}
      </View>
      {taskTranscript && (visibleArgs || visibleResult) ? <Pressable style={styles.detailsTarget} onPress={() => setDetailsOpen((open) => !open)} accessibilityRole="button" accessibilityState={{ expanded: detailsOpen }} accessibilityLabel={detailsOpen ? `Hide details for ${name}` : `Show details for ${name}`}><Text style={styles.detailsToggle}>{detailsOpen ? "Hide details" : "Show details"}</Text></Pressable> : null}
      {taskTranscriptDetailsVisible(detailsOpen, taskTranscript) && visibleArgs ? <Text selectable style={styles.args}>{visibleArgs}</Text> : null}
      {taskTranscriptDetailsVisible(detailsOpen, taskTranscript) && visibleResult ? (
        <Text selectable style={styles.result}>
          {visibleResult}
        </Text>
      ) : null}
    </>
  );

  if (!taskTranscript && visibleResult !== undefined && onResultLongPress !== undefined) {
    return (
      <Pressable
        style={[styles.card, groupedIncoming ? styles.cardGroupedIncoming : null]}
        onLongPress={() => onResultLongPress(visibleResult)}
        delayLongPress={500}
        accessibilityRole="button"
        accessibilityLabel={`${name}. ${ordinaryStateLabel}`}
        accessibilityHint="Long press to show the available result"
        accessibilityActions={[{ name: 'activate', label: 'Show available result' }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'activate') onResultLongPress(visibleResult);
        }}>
        {content}
      </Pressable>
    );
  }

  return (
    <View
      style={[styles.card, groupedIncoming ? styles.cardGroupedIncoming : null]}
      accessibilityLabel={taskTranscript ? `${name}. ${taskState.label}` : `${name}. ${ordinaryStateLabel}`}>
      {content}
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    card: {
      alignSelf: 'flex-start',
      maxWidth: '90%',
      marginVertical: t.spacing.xs,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
    },
    cardGroupedIncoming: {
      marginLeft: INCOMING_AVATAR_COLUMN,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
    },
    name: {
      flexShrink: 1,
      ...t.typography.label,
      color: t.color.text.foreground,
    },
    spinner: {
      transform: [{ scale: 0.85 }],
    },
    doneDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: t.color.status.success,
    },
    failedDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: t.color.status.error,
    },
    recorded: { ...t.typography.caption, color: t.color.text.muted },
    failedState: { ...t.typography.caption, color: t.color.status.error },
    waitingState: { ...t.typography.caption, color: t.color.text.foreground },
    args: { marginTop: t.spacing.xs, ...t.typography.caption, color: t.color.text.muted, fontFamily: "monospace" },
    detailsToggle: { marginTop: t.spacing.xs, ...t.typography.caption, color: t.color.border.interactive },
    detailsTarget: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start", paddingRight: t.spacing.md },
    result: {
      marginTop: t.spacing.xs,
      ...t.typography.caption,
      color: t.color.text.muted,
    },
  });
}
