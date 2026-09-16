import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";

import { Screen } from "@/components/screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { SettingsStatus } from "@/components/settings/settings-status";
import {
  createNotificationSettingsController,
  type NotificationSettingsController,
} from "@/features/settings/notification-settings-controller";
import {
  deriveNotificationJourney,
  NOTIFICATION_SCOPE_OPTIONS,
} from "@/features/settings/notification-settings-presentation";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { loadPushBinding } from "@/lib/push-binding-store";
import type { PushReconcileSummary } from "@/lib/push-reconciler";
import { useAuth } from "@/providers/auth";
import { usePushLifecycle } from "@/providers/push-lifecycle";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { NotificationLevel } from "@nautilo/types";

const PROGRESS_DISCLOSURE_DELAY_MS = 300;

function useDelayedProgress(active: boolean): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), PROGRESS_DISCLOSURE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active]);

  return visible;
}

/** Device-local native controls plus one verified Human's M233 default policy. */
export default function NotificationSettingsScreen() {
  const { activeServer, servers } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const pushLifecycle = usePushLifecycle();
  const reconcile = useCallback(
    () => pushLifecycle.reconcile(),
    [pushLifecycle.reconcile],
  );
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const activeServerRef = useRef(activeServer);
  activeServerRef.current = activeServer;
  const controllerRef = useRef<NotificationSettingsController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createNotificationSettingsController(
      (dataScope) => {
        const server = activeServerRef.current;
        if (!server || server.id !== dataScope.serverId) throw new Error("The active server changed.");
        return getApiClient(server.serverUrl);
      },
      async (serverId) => (await loadPushBinding(serverId))?.bindingId ?? null,
    );
  }
  const controller = controllerRef.current;
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]),
    useCallback(() => controller.data.getState(), [controller]),
    useCallback(() => controller.data.getState(), [controller]),
  );
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; message: string } | null>(null);
  const [reconcileSummary, setReconcileSummary] = useState<PushReconcileSummary | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const deliveryRunRef = useRef(0);
  const screenFocusedRef = useRef(false);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, {
    status,
    viewerState,
    viewer: viewer && viewerState === "verified" ? viewer : null,
  }), [activeServer, status, viewer, viewerState]);

  const reconcileDelivery = useCallback(async () => {
    if (!scope) return;
    const run = ++deliveryRunRef.current;
    setNotice(null);
    setSetupError(null);
    setReconciling(true);
    try {
      // Read canonical policy first, then reconcile the independent native /
      // server binding authority and re-read the binding after it settles.
      await controller.load();
      const summary = await reconcile();
      if (deliveryRunRef.current !== run) return;
      setReconcileSummary(summary);
      // Android may create its canonical notification channel during the
      // reconciliation pass. Re-observe native authority before presenting a
      // final state so a newly available or Human-disabled channel is never
      // inferred from the stale pre-run snapshot.
      await pushLifecycle.refreshDevice();
      if (deliveryRunRef.current !== run) return;
      const refresh = await controller.retry();
      if (deliveryRunRef.current !== run) return;
      if (refresh.status === "failed") {
        setSetupError("Nautilo could not confirm notification delivery for this phone.");
      }
    } catch {
      if (deliveryRunRef.current === run) {
        setSetupError("Nautilo could not connect this phone for notifications. Try again.");
      }
    } finally {
      if (deliveryRunRef.current === run) setReconciling(false);
    }
  }, [controller, pushLifecycle.refreshDevice, reconcile, scope]);

  useFocusEffect(useCallback(() => {
    screenFocusedRef.current = true;
    controller.setScope(scope);
    if (scope) void reconcileDelivery();
    return () => {
      screenFocusedRef.current = false;
      deliveryRunRef.current += 1;
      controller.setScope(null);
    };
  }, [controller, reconcileDelivery, scope]));

  useEffect(() => {
    if (
      !screenFocusedRef.current
      || !scope
      || pushLifecycle.activationRevision === 0
      || !pushLifecycle.activationSummary
    ) return;
    const run = ++deliveryRunRef.current;
    setReconcileSummary(pushLifecycle.activationSummary);
    setSetupError(null);
    setReconciling(true);
    void controller.retry().then((result) => {
      if (deliveryRunRef.current !== run) return;
      if (result.status === "failed") {
        setSetupError("Nautilo could not confirm notification delivery for this phone.");
      }
    }).finally(() => {
      if (deliveryRunRef.current === run) setReconciling(false);
    });
  }, [controller, pushLifecycle.activationRevision, pushLifecycle.activationSummary, scope]);

  const changePermission = (): void => {
    setNotice(null);
    if (pushLifecycle.device?.permission === "denied") {
      void pushLifecycle.openSystemSettings().catch(() => setNotice({ tone: "error", message: "Nautilo could not open this device's system settings." }));
      return;
    }
    void pushLifecycle.requestPermission()
      .then(async (next) => {
        if (next.permission === "allowed" || next.permission === "provisional") {
          await reconcileDelivery();
        }
      })
      .catch(() => setNotice({ tone: "error", message: "Notification permission changed, but Nautilo could not refresh delivery status." }));
  };

  const changeBadge = (enabled: boolean): void => {
    setNotice(null);
    void pushLifecycle.setBadgeEnabled(enabled)
      .catch((error) => setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Nautilo could not update this device's app badge.",
      }));
  };

  const setDefaultLevel = (level: NotificationLevel): void => {
    setNotice(null);
    void controller.setDefaultLevel(level).then((outcome) => {
      if (outcome.status === "failed") setNotice({ tone: "error", message: outcome.message });
    });
  };

  const data = state.data;
  const selectedLevel = state.draft?.defaultLevel ?? data?.preferences.defaultLevel;
  const binding = data?.binding;
  const activeReconciliation = reconcileSummary?.native === "unavailable"
    ? "native_unavailable"
    : activeServer
      ? reconcileSummary?.servers.get(activeServer.id)
      : undefined;
  const journey = deriveNotificationJourney({
    permission: pushLifecycle.device?.permission,
    alertCapability: pushLifecycle.device?.alertCapability,
    selectedLevel,
    binding,
    reconciliation: activeReconciliation,
    hasVerifiedServerScope: Boolean(scope),
    setupInFlight: reconciling,
    deviceError: pushLifecycle.deviceError,
    setupError,
  });
  const showJourneyProgress = useDelayedProgress(
    pushLifecycle.refreshingDevice || journey.kind === "connecting",
  );
  const multiServer = servers.length > 1;
  const runJourneyAction = (): void => {
    if (journey.action?.kind === "request_permission" || journey.action?.kind === "open_system_settings") {
      changePermission();
      return;
    }
    if (journey.action?.kind === "retry_setup") void reconcileDelivery();
  };

  return (
    <Screen edgeTop={false} contentStyle={styles.content}>
      <View
        style={[styles.journeyCard, journey.kind === "needs_attention" && styles.journeyAttention]}
        accessibilityRole="summary"
        accessibilityLabel={`${journey.title}. ${journey.detail}`}
      >
        <View style={styles.journeyHeader}>
          <View style={styles.journeyCopy}>
            <Text style={styles.journeyTitle}>{journey.title}</Text>
            <Text style={styles.summary}>{journey.detail}</Text>
          </View>
          <View style={styles.progressSlot} accessible={false}>
            {showJourneyProgress ? (
              <ActivityIndicator accessibilityLabel={journey.title} color={t.color.brand.accent} />
            ) : null}
          </View>
        </View>
        {journey.action ? (
          <Pressable
            onPress={runJourneyAction}
            style={styles.primaryButton}
            accessibilityRole="button"
            accessibilityLabel={journey.action.label}
            accessibilityHint={journey.action.kind === "open_system_settings"
              ? "Opens this phone's operating system notification settings."
              : journey.action.kind === "request_permission"
                ? "Asks this phone for notification permission."
                : "Retries securely connecting this phone to this server."}
          >
            <Text style={styles.primaryButtonText}>{journey.action.label}</Text>
          </Pressable>
        ) : null}
      </View>

      {state.loadError ? <SettingsStatus tone="error">{state.loadError.message}</SettingsStatus> : null}
      {state.mutationError ? <SettingsStatus tone="error">{state.mutationError.message}</SettingsStatus> : null}

      {scope && data ? (
        <>
          <SettingsSection title="Notify me about">
            <View style={styles.scopeOptions} accessibilityRole="radiogroup" accessibilityLabel="Notification alert scope">
              {NOTIFICATION_SCOPE_OPTIONS.map((option) => {
                const selected = selectedLevel === option.value;
                return (
                  <Pressable
                    key={option.value}
                    disabled={state.mutating}
                    onPress={() => setDefaultLevel(option.value)}
                    style={[styles.scopeOption, selected && styles.scopeOptionSelected]}
                    accessibilityRole="radio"
                    accessibilityLabel={`${option.label}: ${option.description}`}
                    accessibilityState={{ selected, disabled: state.mutating }}
                  >
                    <View style={styles.copy}>
                      <Text style={styles.label}>{option.label}</Text>
                      <Text style={styles.summary}>{option.description}</Text>
                    </View>
                    <View style={[styles.radio, selected && styles.radioSelected]} accessible={false} />
                  </Pressable>
                );
              })}
            </View>
          </SettingsSection>

          {multiServer ? (
            <Text style={styles.scopeCopy}>These choices apply to: {activeServer?.displayName ?? "Nautilo"}.</Text>
          ) : null}

          <View style={styles.privacy} accessibilityRole="summary" accessibilityLabel="Notification privacy">
            <Text style={styles.summary}>Message text never appears on your lock screen. Important-message alerts show the sender and conversation, matching Desktop.</Text>
          </View>

          <SettingsSection title="More options">
            <View style={styles.row}>
              <View style={styles.copy}>
                <Text style={styles.label}>App badge</Text>
                <Text style={styles.summary}>
                  {pushLifecycle.device?.badge === "enabled" ? "Show a count where this phone supports it" : pushLifecycle.device?.badge === "disabled" ? "Don't show a count on this phone" : "Available after this phone allows notifications"}
                </Text>
              </View>
              <Switch
                value={pushLifecycle.device?.badge === "enabled"}
                disabled={pushLifecycle.refreshingDevice || pushLifecycle.device?.badge === "unavailable"}
                onValueChange={changeBadge}
                accessibilityLabel="App badge on this phone"
                accessibilityHint="Turns the numeric app badge on or off for this phone only."
                accessibilityState={{ checked: pushLifecycle.device?.badge === "enabled", disabled: pushLifecycle.refreshingDevice || pushLifecycle.device?.badge === "unavailable" }}
              />
            </View>
          </SettingsSection>
        </>
      ) : null}
      {notice ? <SettingsStatus tone={notice.tone}>{notice.message}</SettingsStatus> : null}
    </Screen>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    content: { gap: t.spacing.md },
    journeyCard: { gap: t.spacing.md, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, padding: t.spacing.lg },
    journeyAttention: { borderLeftWidth: 3, borderLeftColor: t.color.status.warning },
    journeyHeader: { flexDirection: "row", alignItems: "center", gap: t.spacing.md },
    journeyCopy: { flex: 1, minWidth: 0, gap: t.spacing.xs },
    progressSlot: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
    journeyTitle: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    primaryButton: { minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: t.radii.sm, backgroundColor: t.color.action.primaryBg, paddingHorizontal: t.spacing.lg },
    primaryButtonText: { ...t.typography.bodyStrong, color: t.color.text.onPrimary },
    row: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default },
    copy: { flex: 1, minWidth: 0, gap: 3 },
    label: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    summary: { ...t.typography.caption, color: t.color.text.muted, lineHeight: 19 },
    scopeOptions: { gap: t.spacing.xs, padding: t.spacing.sm },
    scopeOption: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: t.spacing.md, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm },
    scopeOptionSelected: { backgroundColor: t.color.surface.background, borderWidth: 1, borderColor: t.color.brand.accent },
    radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: t.color.brand.accent },
    radioSelected: { borderWidth: 6 },
    scopeCopy: { ...t.typography.caption, color: t.color.text.muted, paddingHorizontal: t.spacing.xs },
    privacy: { paddingHorizontal: t.spacing.xs },
  });
}
