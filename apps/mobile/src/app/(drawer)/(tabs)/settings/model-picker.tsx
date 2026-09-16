import { Stack, router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { SettingsPickerScreen } from "@/components/settings/settings-picker-screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import {
  createModelDefaultController,
  modelDefaultErrorMessage,
  type ModelDefaultController,
} from "@/features/settings/model-default-controller";
import { modelPickerGroups } from "@/features/settings/model-default-presentation";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function ModelPickerScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
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

  useEffect(() => {
    controller.setScope(scope);
    if (scope) void controller.load();
  }, [controller, scope]);
  useEffect(() => () => controller.setScope(null), [controller]);

  const selectedId = state.data?.defaultModel ?? undefined;
  const pendingId = state.mutating ? state.draft?.modelId ?? undefined : undefined;
  const groups = modelPickerGroups(state.data?.models ?? [], query, selectedId ?? null);
  // SettingsPickerScreen provides the shared keyboard-aware native search and
  // radio semantics. Prefixes retain visibly grouped provider runs without a
  // duplicate list implementation.
  const options = groups.flatMap((group) => group.rows.map((row) => ({
    id: row.id,
    label: `${group.label} · ${row.label}`,
    description: row.selectable ? row.description : `Unavailable — ${row.description}`,
    disabled: !row.selectable,
  })));
  const apply = async (id: string): Promise<void> => {
    setNotice(null);
    try {
      const result = await controller.apply(id);
      if (result.status === "applied") {
        // `applied` means the write and the picker's canonical profile reload
        // both completed. Return explicitly to the canonical summary rather
        // than trusting a native/deep-link history entry to be its parent.
        router.replace("/(drawer)/(tabs)/settings/models");
      } else if (result.status === "failed") {
        setNotice({ tone: "error", message: modelDefaultErrorMessage(result.error) });
      }
    } catch (error) {
      setNotice({ tone: "error", message: modelDefaultErrorMessage(error) });
    }
  };
  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/(drawer)/(tabs)/settings/models");
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ header: () => <AppBar title="Choose default model" left={<AppBarBackButton onPress={goBack} />} /> }} />
      {!scope ? <View style={styles.state}><SettingsStatus tone="warning">Sign in and reconnect before choosing an Agent default.</SettingsStatus></View> : null}
      {scope && state.loading && !state.data ? <View style={styles.state}><ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading model catalogue" /></View> : null}
      {scope && state.loadError ? <View style={styles.state}><SettingsStatus tone="error">{modelDefaultErrorMessage(state.loadError)}</SettingsStatus><Pressable style={styles.button} onPress={() => void controller.retry()} accessibilityRole="button"><Text style={styles.buttonLabel}>Try again</Text></Pressable></View> : null}
      {notice ? <View style={styles.notice}><SettingsStatus tone={notice.tone}>{notice.message}</SettingsStatus></View> : null}
      {scope && state.data ? (
        <SettingsPickerScreen
          searchLabel="Search models"
          searchValue={query}
          onSearchChange={setQuery}
          options={options}
          selectedId={selectedId ?? undefined}
          pendingId={pendingId}
          interactionDisabled={state.mutating}
          onSelect={(id) => void apply(id)}
          footer={!groups.length ? <Text style={styles.empty}>No models match your search.</Text> : undefined}
        />
      ) : null}
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    state: { flex: 1, alignItems: "center", justifyContent: "center", gap: t.spacing.md, padding: t.spacing.xl },
    notice: { paddingHorizontal: t.spacing.xl, paddingTop: t.spacing.sm },
    empty: { ...t.typography.caption, color: t.color.text.muted },
    button: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent },
    buttonLabel: { ...t.typography.label, color: t.color.surface.background },
  });
}
