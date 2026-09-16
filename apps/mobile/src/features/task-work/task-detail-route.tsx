import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { ApprovalCard } from "@/components/approval-card";
import { viewerCan } from "@/lib/viewer-capabilities";
import { useAuth } from "@/providers/auth";
import { useAttention } from "@/providers/attention";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

import { taskDetailBackTarget } from "./task-detail-navigation";
import { TaskAgentAvatar } from "./task-agent-avatar";
import { TaskDetailTranscript } from "./task-detail-transcript";
import { TaskDetailLifecycleControls } from "./task-detail-lifecycle-controls";
import { useTaskDetail } from "./use-task-detail";
import { useTaskRoomHandoff } from "./use-task-room-handoff";

/** Phase 4.1 shell: identity and exact loading only; transcript/controls follow in 4.2–4.4. */
export default function TaskDetailRoute() {
  const { taskId: rawTaskId, originRoomId: rawOriginRoomId } = useLocalSearchParams<{ taskId?: string | string[]; originRoomId?: string | string[] }>();
  const taskId = typeof rawTaskId === "string" ? rawTaskId : null;
  const originRoomId = typeof rawOriginRoomId === "string" ? rawOriginRoomId : null;
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const detail = useTaskDetail({
    taskId,
    server: activeServer,
    authStatus: status,
    viewerId: viewer?.userId ?? null,
    viewerActorId: viewer?.actorId ?? null,
    viewerState,
    canInvokeAgents: viewerCan(viewer, "invoke_agents"),
    viewerIdentity: viewer,
  });
  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace(taskDetailBackTarget(originRoomId));
  };
  const task = detail.data?.task ?? null;
  const { pendingApprovalForTask, activeChallengeForTask, presentChallenge } = useAttention();
  const latestRunId = detail.data?.runs.at(-1)?.id;
  const taskApproval = task ? pendingApprovalForTask(task.id, latestRunId) : null;
  const taskChallenge = task ? activeChallengeForTask(task.id, latestRunId) : null;
  const roomHandoff = useTaskRoomHandoff({
    detailTarget: detail.target,
    taskStatus: task?.status ?? null,
    targetRoomId: task?.targetRoomId,
    attentionPending: taskApproval !== null || taskChallenge !== null,
    server: activeServer,
  });
  const openTargetRoom = (): void => {
    void roomHandoff.open().then((result) => {
      if (result.status !== "navigate") return;
      try {
        if (!roomHandoff.mayNavigate(result.target)) return;
        router.push({ pathname: "/chat/[roomId]", params: { roomId: result.target.targetRoomId } });
      } catch {
        // Route failure must not discard the exact verified Task detail or the
        // already-authorized retry target.
        roomHandoff.reportNavigationFailure();
      }
    });
  };
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: true, header: () => <AppBar title="Task" left={<AppBarBackButton onPress={goBack} />} showOverflow={false} /> }} />
      {task ? (
        <>
          <TaskDetailTranscript
            detail={detail.data!}
            activity={detail.liveActivity ?? "No current activity."}
            harnessActivity={detail.liveHarnessActivity}
            loading={detail.loading}
            recovery={detail.error ? <Recovery error={detail.error} onRetry={() => void detail.refresh()} retained /> : null}
            header={<View style={styles.identity}>
              <View style={styles.identityRow} accessibilityRole="summary" accessibilityLabel={`${task.agentName?.trim() || "Assigned Genie"}. ${task.prompt || "Task"}. ${task.status}.`}>
                {/* This is intentionally mounted only after the exact authorized response. */}
                <TaskAgentAvatar serverUrl={detail.target!.serverUrl} taskId={task.id} size={44} agentName={task.agentName} />
                <View style={styles.identityCopy}>
                  <Text style={styles.agentName}>{task.agentName?.trim() || "Assigned Genie"}</Text>
                  <Text style={styles.status} accessibilityLiveRegion="polite">{task.status}</Text>
                  <Text style={styles.prompt} selectable>{task.prompt || "Task"}</Text>
                </View>
              </View>
              <TaskDetailLifecycleControls
                targetKey={`${detail.target!.serverId}:${detail.target!.serverUrl}:${detail.target!.userId}:${detail.target!.actorId}:${detail.target!.viewerEpoch}:${task.id}`}
                actions={detail.lifecycle.actions}
                phase={detail.lifecycle.phase}
                action={detail.lifecycle.action}
                error={detail.lifecycle.error}
                notice={detail.lifecycle.notice}
                onAction={(action) => void detail.lifecycle.act(action)}
                onReload={() => void detail.lifecycle.reload()}
              />
              {taskApproval ? <ApprovalCard approval={taskApproval} /> : null}
              {!taskApproval && taskChallenge ? <Pressable style={styles.attention} accessibilityRole="button" accessibilityLabel="Enter PIN to continue task" accessibilityHint="Opens the existing PIN confirmation" onPress={() => presentChallenge(taskChallenge)}><Text style={styles.attentionText}>PIN required to continue this task.</Text></Pressable> : null}
              {roomHandoff.authorized || roomHandoff.opening ? <Pressable style={styles.roomHandoff} disabled={roomHandoff.opening} accessibilityRole="button" accessibilityLabel="Open Room" accessibilityHint="Opens the Task response room." accessibilityState={{ disabled: roomHandoff.opening, busy: roomHandoff.opening }} onPress={openTargetRoom}><Text style={styles.roomHandoffText}>{roomHandoff.opening ? "Checking room…" : "Open Room"}</Text></Pressable> : null}
              {roomHandoff.error ? <View style={styles.roomHandoffError} accessibilityRole="alert"><Text style={styles.roomHandoffErrorText}>{roomHandoff.error}</Text></View> : null}
            </View>}
          />
        </>
      ) : detail.loading ? (
        <View style={styles.center} accessibilityLiveRegion="polite"><ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading task" /></View>
      ) : detail.authRequired ? (
        <Unavailable title="Sign in required" message="Your session ended before this task could be loaded." onRetry={() => void detail.refresh()} styles={styles} />
      ) : detail.unavailable || !detail.validTaskId ? (
        <Unavailable title="Task unavailable" message="This task is no longer available." onRetry={detail.validTaskId ? () => void detail.refresh() : undefined} styles={styles} />
      ) : detail.error ? (
        <Recovery error={detail.error} onRetry={() => void detail.refresh()} />
      ) : (
        <Unavailable title="Task unavailable" message="This task is no longer available." styles={styles} />
      )}
    </View>
  );
}

function Unavailable({ title, message, onRetry, styles }: { title: string; message: string; onRetry?: () => void; styles: ReturnType<typeof createStyles> }) {
  return <View style={styles.center} accessibilityLiveRegion="polite"><Text style={styles.unavailableTitle}>{title}</Text><Text style={styles.unavailableCopy}>{message}</Text>{onRetry ? <Pressable style={styles.retryTarget} onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry task" accessibilityHint="Tries this exact task again"><Text style={styles.retry}>Try again</Text></Pressable> : null}</View>;
}

function Recovery({ error, onRetry, retained = false }: { error: Error; onRetry: () => void; retained?: boolean }) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  return <View style={styles.error} accessibilityRole="alert"><Text style={styles.errorText}>{retained ? "Showing the last verified task while refresh failed." : error.message || "Could not reach this server."}</Text><Pressable style={styles.retryTarget} onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry task" accessibilityHint="Tries this exact task again"><Text style={styles.retry}>Try again</Text></Pressable></View>;
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    identity: { gap: t.spacing.md, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, backgroundColor: t.color.surface.background },
    identityRow: { flexDirection: "row", gap: t.spacing.md },
    identityCopy: { flex: 1, gap: 2 }, agentName: { color: t.color.text.foreground, ...t.typography.body, fontWeight: "700" }, status: { color: t.color.text.muted, ...t.typography.caption }, prompt: { color: t.color.text.foreground, ...t.typography.body },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: t.spacing.xl, gap: t.spacing.sm }, unavailableTitle: { color: t.color.text.foreground, ...t.typography.title }, unavailableCopy: { color: t.color.text.muted, ...t.typography.body, textAlign: "center" }, retryTarget: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.sm }, retry: { color: t.color.border.interactive, ...t.typography.body, fontWeight: "700" }, error: { borderRadius: t.radii.md, backgroundColor: t.color.surface.element, padding: t.spacing.md, gap: t.spacing.sm }, errorText: { color: t.color.text.foreground, ...t.typography.body }, attention: { borderRadius: t.radii.md, backgroundColor: t.color.surface.subtle, padding: t.spacing.md }, attentionText: { color: t.color.text.foreground, ...t.typography.bodyStrong }, roomHandoff: { minHeight: 44, justifyContent: "center", alignItems: "center", borderRadius: t.radii.md, backgroundColor: t.color.surface.subtle, paddingHorizontal: t.spacing.md }, roomHandoffText: { color: t.color.border.interactive, ...t.typography.bodyStrong }, roomHandoffError: { borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.status.error, padding: t.spacing.sm }, roomHandoffErrorText: { color: t.color.status.error, ...t.typography.caption },
  });
}
