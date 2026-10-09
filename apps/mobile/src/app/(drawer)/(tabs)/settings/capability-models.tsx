import { Stack, router, type Href, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import {
  createPersonalCapabilityPreferencesController,
  personalCapabilityPreferenceErrorMessage,
  type PersonalCapabilityPreferencesController,
} from "@/features/settings/personal-capability-preferences-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function CapabilityModelsScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const serverRef = useRef(activeServer);
  serverRef.current = activeServer;
  const controllerRef = useRef<PersonalCapabilityPreferencesController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createPersonalCapabilityPreferencesController((scope) => {
      const server = serverRef.current;
      if (!server || server.id !== scope.serverId) throw new Error("The active server changed.");
      return getApiClient(server.serverUrl);
    });
  }
  const controller = controllerRef.current;
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]),
    useCallback(() => controller.data.getState(), [controller]),
    useCallback(() => controller.data.getState(), [controller]),
  );
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, {
    status,
    viewerState,
    viewer: viewer && viewerState === "verified" ? viewer : null,
  }), [activeServer, status, viewer, viewerState]);

  useFocusEffect(useCallback(() => {
    controller.setScope(scope);
    if (scope) void controller.load();
    return () => controller.setScope(null);
  }, [controller, scope]));

  const goBack = () => router.canGoBack() ? router.back() : router.replace("/(drawer)/(tabs)/settings");
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ header: () => <AppBar title="Research & decision models" left={<AppBarBackButton onPress={goBack} />} /> }} />
      <Screen edgeTop={false} contentStyle={styles.content}>
        <Text style={styles.helper}>These account-wide choices apply to your own research and decision work. Genie and Room model settings stay separate.</Text>
        {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before changing capability models.</SettingsStatus> : null}
        {state.loading && !state.data ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading capability models" /> : null}
        {state.loadError ? <SettingsStatus tone="error">{personalCapabilityPreferenceErrorMessage(state.loadError)}</SettingsStatus> : null}
        {state.data ? <SettingsStatus tone="info">{`Admin funding priority: ${state.data.fundingPreference === "server_first" ? "Server credentials first" : "Personal keys first"}. A sole permitted source remains usable.`}</SettingsStatus> : null}
        {state.data?.capabilities.map((capability) => (
          <Pressable
            key={capability.role}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            onPress={() => router.push({ pathname: "/settings/capability-model-picker", params: { role: capability.role } } as Href)}
            accessibilityRole="button"
            accessibilityLabel={`${capability.label}, ${capability.selection.displayName}`}
            accessibilityHint="Opens this capability's model choices."
          >
            <View style={styles.rowCopy}>
              <Text style={styles.rowLabel}>{capability.label}</Text>
              <Text style={styles.rowDetail}>{capability.selection.displayName} · {capability.selection.source === "personal" ? "Your choice" : "Inherited"}</Text>
              <Text style={[styles.readiness, capability.readiness.status !== "ready" && styles.warning]}>
                {capability.readiness.status === "ready"
                  ? capability.readiness.fundingSource === "personal"
                    ? `Ready · Your ${capability.readiness.providerRoute} credential`
                    : `Ready · Server ${capability.readiness.providerRoute} credential`
                  : capability.readiness.reason ?? "Unavailable"}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
        {state.data ? <View style={styles.actions}>
          <Pressable style={({ pressed }) => [styles.action, pressed && styles.pressed]} onPress={() => router.push("/(drawer)/(tabs)/settings/provider-keys")} accessibilityRole="button"><Text style={styles.actionText}>Personal API keys</Text></Pressable>
          <Pressable style={({ pressed }) => [styles.action, pressed && styles.pressed]} onPress={() => router.push("/(drawer)/(tabs)/settings/personal-costs")} accessibilityRole="button"><Text style={styles.actionText}>Your costs</Text></Pressable>
        </View> : null}
        <Text style={styles.helper}>You can save a compatible model before adding its key. Readiness and funding are checked again when fresh work starts.</Text>
      </Screen>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    content: { gap: t.spacing.md },
    helper: { ...t.typography.caption, color: t.color.text.muted },
    row: { minHeight: 72, flexDirection: "row", alignItems: "center", paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md, gap: t.spacing.md, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, backgroundColor: t.color.surface.panel },
    rowCopy: { flex: 1, gap: 3 },
    rowLabel: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    rowDetail: { ...t.typography.caption, color: t.color.text.muted },
    readiness: { ...t.typography.caption, color: t.color.status.success },
    warning: { color: t.color.status.warning },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
    action: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.color.border.default },
    actionText: { ...t.typography.label, color: t.color.brand.accent },
    chevron: { fontSize: 28, color: t.color.text.muted },
    pressed: { opacity: 0.7 },
  });
}
