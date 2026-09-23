import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  MOBILE_PROTECTED_TASK_DETAIL,
  mobileTaskDefinitionContent,
  mobileTaskRunContent,
  mobileTaskSummaryContent,
  type MobileTaskDetail as TaskDetail,
  type MobileTaskRun as TaskRunSummary,
  type MobileTaskSummary as TaskSummary,
} from "@/features/task-work/task-content-mobile";

import { AppBar, useOpenAppDrawer } from "@/components/app-bar";
import { BottomSheet } from "@/components/bottom-sheet";
import { Screen } from "@/components/screen";
import {
  canResumeScheduledWork,
  scheduleCadence,
  scheduleNextFire,
  scheduleStatus,
  scheduledWorkFailure,
  type ScheduledWorkFailure,
} from "@/features/scheduled-work/scheduled-work-state";
import { useScheduledWork } from "@/features/scheduled-work/use-scheduled-work";
import { useAuth } from "@/providers/auth";
import {
  recoverMobileCapabilityDenial,
  type MobileCapabilityScope,
} from "@/lib/mobile-capability-denial";
import { viewerCan } from "@/lib/viewer-capabilities";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function ScheduledWorkScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState, signOut, refreshViewer } = useAuth();
  const canInvokeAgents = viewerCan(viewer, "invoke_agents");
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const openDrawer = useOpenAppDrawer();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmStopId, setConfirmStopId] = useState<string | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const activeScopeRef = useRef<MobileCapabilityScope | null>(null);
  activeScopeRef.current = activeServer && viewer
    ? { serverId: activeServer.id, userId: viewer.userId }
    : null;
  const currentCapabilityScope = useCallback(() => activeScopeRef.current, []);
  useEffect(() => setCapabilityError(null), [activeServer?.id, viewer?.userId]);
  const scheduled = useScheduledWork({
    server: activeServer,
    authStatus: status,
    viewerId: viewer?.userId ?? null,
    viewerActorId: viewer?.actorId ?? null,
    viewerState,
    canInvokeAgents,
    viewerIdentity: viewer,
  });
  const selectedRow = scheduled.rows.find((row) => row.id === selectedId) ?? null;
  // Do not show the previous schedule's run history while a new detail request
  // is in flight. A stale completion is also fenced by the controller.
  const detail = scheduled.detail?.task.id === selectedId ? scheduled.detail : null;
  const failure = scheduled.failure ?? (scheduled.mutationError ? scheduledWorkFailure(scheduled.mutationError) : null);
  const busy = scheduled.mutating;

  const openDetail = (id: string): void => {
    setConfirmStopId(null);
    setSelectedId(id);
    void scheduled.openDetail(id);
  };
  const closeDetail = (): void => {
    if (busy) return;
    setConfirmStopId(null);
    setSelectedId(null);
    scheduled.closeDetail();
  };
  const signIn = (): void => {
    void signOut().finally(() => router.replace("/(onboarding)/sign-in"));
  };
  const doLifecycle = (id: string, operation: "pause" | "resume" | "stop"): void => {
    if (operation === "resume" && !canInvokeAgents) return;
    const actionScope = currentCapabilityScope();
    setCapabilityError(null);
    const task = operation === "pause" ? scheduled.pause(id)
      : operation === "resume" ? scheduled.resume(id)
        : scheduled.stop(id);
    void task.then(async (result) => {
      // The canonical list GET is the success condition. Close the detail so
      // the next visit cannot present a stale run history or action state.
      if (result.status === "applied") closeDetail();
      if (result.status === "failed") {
        const denial = await recoverMobileCapabilityDenial({
          error: result.error,
          actionScope,
          getCurrentScope: currentCapabilityScope,
          refreshViewer,
        });
        if (denial) setCapabilityError(denial.message);
      }
    });
  };
  const confirmStop = (): void => {
    if (!confirmStopId || busy) return;
    if (failure?.kind === "signed-out") {
      setConfirmStopId(null);
      signIn();
      return;
    }
    if (scheduled.canonicalRefreshPending || failure?.kind === "unavailable") {
      void scheduled.retry();
      return;
    }
    doLifecycle(confirmStopId, "stop");
  };

  return (
    <View style={styles.container}>
      <AppBar title="Scheduled work" onMenuPress={openDrawer} />
      {!scheduled.scope && status === "signed-out" ? (
        <StateCard title="Sign in required" detail="Sign in to view the schedules owned by this account." action="Sign in" onPress={signIn} />
      ) : scheduled.loading && scheduled.rows.length === 0 ? (
        <View style={styles.center} accessibilityLiveRegion="polite">
          <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading scheduled work" />
        </View>
      ) : failure && scheduled.rows.length === 0 ? (
        <FailureCard failure={failure} onRetry={() => void scheduled.retry()} onSignIn={signIn} />
      ) : (
        <Screen edgeTop={false} contentStyle={styles.content}>
          <Text style={styles.intro}>
            View and control work scheduled by your agents. Your server keeps the schedule running; this phone does not.
          </Text>
          {failure ? <InlineFailure failure={failure} /> : null}
          {capabilityError ? (
            <View style={styles.errorCard} accessibilityRole="alert">
              <Text style={styles.errorText}>{capabilityError}</Text>
            </View>
          ) : null}
          {scheduled.canonicalRefreshPending ? (
            <View style={styles.notice} accessibilityRole="alert">
              <Text style={styles.noticeText}>The server accepted your change, but this phone needs to reload the canonical schedule list.</Text>
              <Pressable onPress={() => void scheduled.retry()} accessibilityRole="button" accessibilityLabel="Reload scheduled work">
                <Text style={styles.noticeAction}>Reload</Text>
              </Pressable>
            </View>
          ) : null}
          {scheduled.rows.length === 0 ? (
            <View style={styles.empty} accessibilityLiveRegion="polite">
              <Text style={styles.emptyTitle}>No active schedules</Text>
              <Text style={styles.emptyCopy}>Ask an agent on desktop or in chat to schedule work. You can monitor and control it here.</Text>
            </View>
          ) : (
            <View style={styles.list} accessibilityRole="summary" accessibilityLabel="Scheduled work">
              {scheduled.rows.map((row) => <ScheduleRow key={row.id} row={row} onPress={() => openDetail(row.id)} />)}
            </View>
          )}
        </Screen>
      )}
      <ScheduledWorkDetail
        visible={selectedId !== null}
        row={selectedRow}
        detail={detail}
        loading={scheduled.detailLoading}
        loadError={scheduled.detailError}
        busy={busy}
        canResume={canInvokeAgents}
        onClose={closeDetail}
        onRetry={() => selectedId ? void scheduled.openDetail(selectedId) : undefined}
        onPause={() => selectedId && doLifecycle(selectedId, "pause")}
        onResume={() => selectedId && doLifecycle(selectedId, "resume")}
        onStop={() => selectedId && setConfirmStopId(selectedId)}
        onOpenRoom={(roomId) => {
          closeDetail();
          router.push({ pathname: "/chat/[roomId]", params: { roomId } });
        }}
      />
      <StopConfirmation
        visible={confirmStopId !== null}
        busy={busy}
        failure={failure}
        refreshPending={scheduled.canonicalRefreshPending}
        onCancel={() => !busy && setConfirmStopId(null)}
        onConfirm={confirmStop}
      />
    </View>
  );
}

function ScheduleRow({ row, onPress }: { row: TaskSummary; onPress: () => void }) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const content = mobileTaskSummaryContent(row);
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${content.prompt || "Scheduled work"}, ${scheduleStatus(row.status)}, ${scheduleCadence(row)}, ${scheduleNextFire(row.nextFireAt)}`}
      accessibilityHint="Opens schedule details and recent runs."
    >
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle} numberOfLines={2}>{content.prompt || "Scheduled work"}</Text>
        <Text style={styles.rowMeta}>{scheduleStatus(row.status)} · {scheduleCadence(row)}</Text>
        <Text style={styles.rowMeta}>{scheduleNextFire(row.nextFireAt)}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function ScheduledWorkDetail({
  visible, row, detail, loading, loadError, busy, canResume, onClose, onRetry, onPause, onResume, onStop, onOpenRoom,
}: {
  visible: boolean; row: TaskSummary | null; detail: TaskDetail | null; loading: boolean; loadError: Error | null; busy: boolean;
  canResume: boolean;
  onClose: () => void; onRetry: () => void; onPause: () => void; onResume: () => void; onStop: () => void; onOpenRoom: (id: string) => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const task = detail?.task ?? row;
  const content = detail ? mobileTaskDefinitionContent(detail) : row ? mobileTaskSummaryContent(row) : null;
  const roomId = detail?.task.targetRoomId ?? row?.targetRoomId ?? detail?.task.callingRoomId ?? row?.callingRoomId ?? null;
  return (
    <BottomSheet visible={visible} snapPoints={["82%"]} onClose={onClose}>
      <View style={styles.sheet} accessibilityViewIsModal>
        <View style={styles.sheetHeading}>
          <View style={styles.sheetCopy}>
            <Text style={styles.sheetTitle}>Scheduled work</Text>
            <Text style={styles.sheetSubtitle} numberOfLines={2}>{content?.prompt || "Loading schedule…"}</Text>
          </View>
          <Pressable onPress={onClose} disabled={busy} accessibilityRole="button" accessibilityLabel="Close scheduled work details" accessibilityState={{ disabled: busy }} style={styles.done}>
            <Text style={styles.doneLabel}>Done</Text>
          </Pressable>
        </View>
        {loading && !detail ? <View style={styles.detailCenter}><ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading schedule details" /></View> : null}
        {loadError && !detail ? <DetailLoadFailure error={loadError} onRetry={onRetry} /> : null}
        {task && (!loading || detail) ? (
          <ScrollView contentContainerStyle={styles.sheetScroll} showsVerticalScrollIndicator>
            {content?.status === "unsupported_client" ? <Text style={styles.noticeText} accessibilityRole="alert">{MOBILE_PROTECTED_TASK_DETAIL}</Text> : null}
            <DetailField label="Status" value={scheduleStatus(task.status)} />
            <DetailField label="Cadence" value={scheduleCadence(task)} mono={task.scheduleKind === "cron"} />
            <DetailField label="Next run" value={scheduleNextFire(task.nextFireAt)} detail={task.nextFireAt ?? undefined} />
            {roomId ? <Pressable onPress={() => onOpenRoom(roomId)} style={styles.roomButton} accessibilityRole="button" accessibilityLabel="Open owning room" accessibilityHint="Opens the conversation this scheduled work belongs to."><Text style={styles.roomLabel}>Open owning room</Text></Pressable> : null}
            <View style={styles.actions}>
              {task.status === "paused"
                ? canResumeScheduledWork(task.status, canResume) ? <ActionButton label="Resume schedule" onPress={onResume} disabled={busy} /> : null
                : <ActionButton label="Pause schedule" onPress={onPause} disabled={busy} />}
              <ActionButton label="Stop schedule" onPress={onStop} disabled={busy} destructive />
            </View>
            <View style={styles.runsHeading}><Text style={styles.sectionTitle}>Recent runs</Text><Text style={styles.sectionHint}>Server history</Text></View>
            {detail?.runs.length ? detail.runs.slice(0, 8).map((run) => <RunRow key={run.id} run={run} />) : <Text style={styles.noRuns}>No runs have been recorded yet.</Text>}
          </ScrollView>
        ) : null}
      </View>
    </BottomSheet>
  );
}

function DetailField({ label, value, detail, mono = false }: { label: string; value: string; detail?: string; mono?: boolean }) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><Text selectable style={[styles.fieldValue, mono && styles.mono]}>{value}</Text>{detail ? <Text selectable style={styles.fieldDetail}>{formatDate(detail)}</Text> : null}</View>;
}

function ActionButton({ label, onPress, disabled, destructive = false }: { label: string; onPress: () => void; disabled: boolean; destructive?: boolean }) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  return <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.action, destructive ? styles.stopAction : styles.pauseAction, (pressed || disabled) && styles.pressed]} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}><Text style={[styles.actionLabel, destructive && styles.stopActionLabel]}>{label}</Text></Pressable>;
}

function RunRow({ run }: { run: TaskRunSummary }) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  const content = mobileTaskRunContent(run);
  const detail = content.status === "unsupported_client"
    ? MOBILE_PROTECTED_TASK_DETAIL
    : content.lastError || content.resultText || "No result text.";
  return <View style={styles.run}><Text style={styles.runTitle}>{scheduleStatus(run.status)}</Text><Text style={styles.runTime}>{formatDate(run.completedAt ?? run.startedAt)}</Text><Text selectable style={styles.runResult} numberOfLines={5}>{detail}</Text></View>;
}

function DetailLoadFailure({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  const failure = scheduledWorkFailure(error);
  const message = failure.kind === "signed-out" ? "Your session ended. Close this sheet and sign in again." : failure.message;
  return <View style={styles.detailCenter}><Text style={styles.errorText}>{message}</Text><Pressable onPress={onRetry} accessibilityRole="button"><Text style={styles.noticeAction}>Try again</Text></Pressable></View>;
}

function StopConfirmation({ visible, busy, failure, refreshPending, onCancel, onConfirm }: { visible: boolean; busy: boolean; failure: ScheduledWorkFailure | null; refreshPending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  const label = failure?.kind === "signed-out" ? "Sign in" : refreshPending || failure?.kind === "unavailable" ? "Reload" : "Stop schedule";
  const message = failure?.kind === "signed-out" ? "Your session ended. Sign in before changing this schedule." : refreshPending || failure?.kind === "unavailable" ? "This schedule may have changed elsewhere. Reload the server list before trying again." : "This stops future scheduled runs. It cannot be resumed from this phone.";
  return <BottomSheet visible={visible} snapPoints={["38%"]} onClose={onCancel}><View style={styles.confirm} accessibilityViewIsModal><Text style={styles.confirmTitle}>Stop this schedule?</Text><Text style={styles.confirmCopy}>{message}</Text><View style={styles.confirmActions}><Pressable onPress={onCancel} disabled={busy} style={styles.cancelButton} accessibilityRole="button"><Text style={styles.cancelLabel}>Cancel</Text></Pressable><Pressable onPress={onConfirm} disabled={busy} style={styles.confirmButton} accessibilityRole="button"><Text style={styles.confirmLabel}>{label}</Text></Pressable></View></View></BottomSheet>;
}

function FailureCard({ failure, onRetry, onSignIn }: { failure: ScheduledWorkFailure; onRetry: () => void; onSignIn: () => void }) {
  const title = failure.kind === "signed-out" ? "Sign in required" : failure.kind === "unavailable" ? "Schedules unavailable" : "Could not load schedules";
  return <StateCard title={title} detail={failure.kind === "signed-out" ? "Your session ended. Sign in to view scheduled work." : failure.message} action={failure.kind === "signed-out" ? "Sign in" : "Try again"} onPress={failure.kind === "signed-out" ? onSignIn : onRetry} />;
}
function InlineFailure({ failure }: { failure: ScheduledWorkFailure }) { const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]); return <View style={styles.errorCard} accessibilityRole="alert"><Text style={styles.errorText}>{failure.kind === "signed-out" ? "Your session ended. Sign in again to make changes." : failure.message}</Text></View>; }
function StateCard({ title, detail, action, onPress }: { title: string; detail: string; action: string; onPress: () => void }) { const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]); return <View style={styles.center}><Text style={styles.stateTitle}>{title}</Text><Text style={styles.stateCopy}>{detail}</Text><Pressable onPress={onPress} style={styles.primaryButton} accessibilityRole="button"><Text style={styles.primaryLabel}>{action}</Text></Pressable></View>; }
function formatDate(value: string | null | undefined): string { if (!value) return "Not recorded"; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : value; }

function createStyles(t: AppTheme) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.lg }, intro: { ...t.typography.body, color: t.color.text.muted },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: t.spacing.md, padding: t.spacing.xl }, stateTitle: { ...t.typography.heading, color: t.color.text.foreground, textAlign: "center" }, stateCopy: { ...t.typography.body, color: t.color.text.muted, textAlign: "center" }, primaryButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent }, primaryLabel: { ...t.typography.label, color: t.color.text.onPrimary },
  list: { overflow: "hidden", borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, row: { minHeight: 78, flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default }, rowCopy: { flex: 1, gap: 2 }, rowTitle: { ...t.typography.bodyStrong, color: t.color.text.foreground }, rowMeta: { ...t.typography.caption, color: t.color.text.muted }, chevron: { fontSize: 28, color: t.color.text.muted }, pressed: { opacity: 0.65 },
  empty: { gap: t.spacing.sm, padding: t.spacing.lg, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, emptyTitle: { ...t.typography.subheading, color: t.color.text.foreground }, emptyCopy: { ...t.typography.body, color: t.color.text.muted }, errorCard: { padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.status.error }, errorText: { ...t.typography.body, color: t.color.status.error }, notice: { gap: t.spacing.sm, padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.surface.subtle }, noticeText: { ...t.typography.body, color: t.color.text.foreground }, noticeAction: { ...t.typography.label, color: t.color.brand.accent },
  sheet: { flex: 1, gap: t.spacing.md }, sheetHeading: { flexDirection: "row", alignItems: "flex-start", gap: t.spacing.md }, sheetCopy: { flex: 1, gap: 2 }, sheetTitle: { ...t.typography.subheading, color: t.color.text.foreground }, sheetSubtitle: { ...t.typography.caption, color: t.color.text.muted }, done: { minHeight: 44, justifyContent: "center", paddingLeft: t.spacing.sm }, doneLabel: { ...t.typography.label, color: t.color.brand.accent }, detailCenter: { flex: 1, alignItems: "center", justifyContent: "center", gap: t.spacing.md }, sheetScroll: { gap: t.spacing.md, paddingBottom: t.spacing.xl }, field: { gap: 2, padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.surface.background, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, fieldLabel: { ...t.typography.caption, color: t.color.text.muted, fontWeight: "700", textTransform: "uppercase" }, fieldValue: { ...t.typography.body, color: t.color.text.foreground }, fieldDetail: { ...t.typography.caption, color: t.color.text.muted }, mono: { fontFamily: "monospace" }, roomButton: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.brand.accent }, roomLabel: { ...t.typography.label, color: t.color.brand.accent }, actions: { flexDirection: "row", gap: t.spacing.sm }, action: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, paddingHorizontal: t.spacing.sm }, pauseAction: { backgroundColor: t.color.surface.subtle }, stopAction: { backgroundColor: t.color.status.error }, actionLabel: { ...t.typography.label, color: t.color.text.foreground }, stopActionLabel: { color: t.color.text.onPrimary }, runsHeading: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginTop: t.spacing.sm }, sectionTitle: { ...t.typography.subheading, color: t.color.text.foreground }, sectionHint: { ...t.typography.caption, color: t.color.text.muted }, noRuns: { ...t.typography.body, color: t.color.text.muted, paddingVertical: t.spacing.md }, run: { gap: 3, padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.surface.background, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, runTitle: { ...t.typography.bodyStrong, color: t.color.text.foreground }, runTime: { ...t.typography.caption, color: t.color.text.muted }, runResult: { ...t.typography.body, color: t.color.text.foreground },
  confirm: { flex: 1, gap: t.spacing.md }, confirmTitle: { ...t.typography.heading, color: t.color.text.foreground }, confirmCopy: { ...t.typography.body, color: t.color.text.muted }, confirmActions: { flexDirection: "row", gap: t.spacing.sm, marginTop: "auto" }, cancelButton: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, backgroundColor: t.color.surface.subtle }, cancelLabel: { ...t.typography.label, color: t.color.text.foreground }, confirmButton: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, backgroundColor: t.color.status.error }, confirmLabel: { ...t.typography.label, color: t.color.text.onPrimary },
}); }
