import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import {
  createModelDefaultController,
  currentModelDefault,
  modelDefaultErrorMessage,
  type ModelDefaultController,
} from "@/features/settings/model-default-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

/** Canonical Agent model-ID default. D462 axes stay absent until their own API exists. */
export default function ModelsAndDefaultsScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const serverRef = useRef(activeServer);
  serverRef.current = activeServer;
  const controllerRef = useRef<ModelDefaultController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createModelDefaultController((scope) => {
      const server = serverRef.current;
      if (!server || server.id !== scope.serverId) throw new Error("The active server changed.");
      return getApiClient(server.serverUrl);
    });
  }
  const controller = controllerRef.current;
  const subscribe = useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]);
  const snapshot = useCallback(() => controller.data.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const scope = useMemo(
    () => settingsScopeForVerifiedViewer(activeServer, {
      status,
      viewerState,
      viewer: viewer && viewerState === "verified" ? viewer : null,
    }),
    [activeServer, status, viewer, viewerState],
  );

  useFocusEffect(useCallback(() => {
    controller.setScope(scope);
    if (scope) void controller.load();
    // The picker owns a separate route-local controller. Reload canonical
    // profile state whenever this retained summary route regains focus.
    return () => controller.setScope(null);
  }, [controller, scope]));

  const current = currentModelDefault(state.data);
  const reset = async (): Promise<void> => {
    const result = await controller.reset();
    if (result.status === "failed") return;
  };
  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/(drawer)/(tabs)/settings");
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ header: () => <AppBar title="Models & defaults" left={<AppBarBackButton onPress={goBack} />} /> }} />
      <Screen edgeTop={false} contentStyle={styles.content}>
        {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before changing your Agent default.</SettingsStatus> : null}
        {state.loading ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading Agent model defaults" /> : null}
        {state.loadError ? <SettingsStatus tone="error">{modelDefaultErrorMessage(state.loadError)}</SettingsStatus> : null}
        {state.mutationError ? <SettingsStatus tone="error">{modelDefaultErrorMessage(state.mutationError)}</SettingsStatus> : null}
        {current ? (
          <>
            <Text style={styles.sectionLabel}>DEFAULT FOR YOUR AGENT</Text>
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              onPress={() => router.push("/settings/model-picker")}
              disabled={!scope || state.mutating}
              accessibilityRole="button"
              accessibilityLabel={`Model, ${current.label}`}
              accessibilityHint="Opens the searchable model catalogue."
              accessibilityState={{ disabled: !scope || state.mutating }}
            >
              <View style={styles.rowCopy}>
                <Text style={styles.rowLabel}>Model</Text>
                <Text style={[styles.rowDetail, !current.selectable && styles.unavailable]}>{current.label}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
            <Text style={[styles.helper, !current.selectable && styles.unavailable]}>{current.detail}</Text>
            <Text style={styles.helper}>Used when a Room has no override.</Text>
            {/* Reasoning and Serving are intentionally absent: current bytes only expose Room-scoped D462 controls. */}
            <Pressable
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              onPress={() => void reset()}
              disabled={!scope || state.mutating || current.id === null}
              accessibilityRole="button"
              accessibilityLabel="Reset to server default model"
              accessibilityHint="Removes this Agent's explicit model ID and refreshes the server value."
              accessibilityState={{ disabled: !scope || state.mutating || current.id === null }}
            >
              <Text style={styles.secondaryButtonText}>{state.mutating ? "Saving…" : "Reset to server default"}</Text>
            </Pressable>
          </>
        ) : null}
      </Screen>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    content: { gap: t.spacing.md },
    sectionLabel: { ...t.typography.caption, color: t.color.text.muted, fontWeight: "700", letterSpacing: 0.7 },
    row: { minHeight: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: t.spacing.lg, gap: t.spacing.md, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, backgroundColor: t.color.surface.panel },
    rowCopy: { flex: 1, gap: 3 },
    rowLabel: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    rowDetail: { ...t.typography.caption, color: t.color.text.muted },
    chevron: { fontSize: 28, color: t.color.text.muted },
    helper: { ...t.typography.caption, color: t.color.text.muted },
    unavailable: { color: t.color.status.warning },
    secondaryButton: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.color.border.default },
    secondaryButtonText: { ...t.typography.label, color: t.color.text.foreground },
    pressed: { opacity: 0.7 },
  });
}
