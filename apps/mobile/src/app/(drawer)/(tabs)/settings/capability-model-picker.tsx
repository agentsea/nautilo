import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { isPersonalCapabilityRole } from "@nautilo/types";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { SettingsPickerScreen } from "@/components/settings/settings-picker-screen";
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

const INHERIT = "__inherit__";

export default function CapabilityModelPickerScreen() {
  const params = useLocalSearchParams<{ role?: string }>();
  const role = isPersonalCapabilityRole(params.role) ? params.role : null;
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [query, setQuery] = useState("");
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

  useEffect(() => {
    controller.setScope(scope);
    if (scope) void controller.load();
    return () => controller.setScope(null);
  }, [controller, scope]);

  const capability = role ? state.data?.capabilities.find((entry) => entry.role === role) : undefined;
  const needle = query.trim().toLocaleLowerCase();
  const options = capability ? [
    {
      id: INHERIT,
      label: `Inherit · ${capability.selection.source === "inherited" ? capability.selection.displayName : "workflow default"}`,
      description: "Follow the current workflow default.",
    },
    ...capability.options.filter((option) => !needle || [option.modelId, option.displayName, option.provider]
      .some((value) => value.toLocaleLowerCase().includes(needle)))
      .map((option) => ({
        id: option.modelId,
        label: option.displayName,
        description: `${option.modelId} · ${option.provider} · ${option.readiness.status === "ready"
          ? option.readiness.fundingSource === "personal"
            ? `Your ${option.readiness.providerRoute} credential`
            : `Server ${option.readiness.providerRoute} credential`
          : option.readiness.reason ?? "Unavailable now"}`,
      })),
  ] : [];
  const selectedId = role && state.data?.overrides[role] ? state.data.overrides[role] : INHERIT;
  const pendingId = state.mutating
    ? state.draft?.modelId ?? INHERIT
    : undefined;

  const apply = async (id: string) => {
    if (!role) return;
    try {
      const result = await controller.apply(role, id === INHERIT ? null : id);
      if (result.status === "applied") router.replace("/(drawer)/(tabs)/settings/capability-models");
    } catch {
      // The controller retains the canonical state and exposes the error below.
    }
  };
  const goBack = () => router.canGoBack() ? router.back() : router.replace("/(drawer)/(tabs)/settings/capability-models");
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ header: () => <AppBar title={capability?.label ?? "Choose capability model"} left={<AppBarBackButton onPress={goBack} />} /> }} />
      {!role ? <View style={styles.state}><SettingsStatus tone="error">This capability is not supported.</SettingsStatus></View> : null}
      {role && state.loading && !state.data ? <View style={styles.state}><ActivityIndicator color={t.color.brand.accent} /></View> : null}
      {state.loadError ? <View style={styles.state}><SettingsStatus tone="error">{personalCapabilityPreferenceErrorMessage(state.loadError)}</SettingsStatus><Pressable onPress={() => void controller.retry()}><Text style={styles.retry}>Try again</Text></Pressable></View> : null}
      {state.mutationError ? <View style={styles.notice}><SettingsStatus tone="error">{personalCapabilityPreferenceErrorMessage(state.mutationError)}</SettingsStatus></View> : null}
      {scope && capability ? (
        <SettingsPickerScreen
          searchLabel="Search compatible models"
          searchValue={query}
          onSearchChange={setQuery}
          options={options}
          selectedId={selectedId}
          pendingId={pendingId}
          interactionDisabled={state.mutating}
          onSelect={(id) => void apply(id)}
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
    retry: { ...t.typography.label, color: t.color.brand.accent },
  });
}
