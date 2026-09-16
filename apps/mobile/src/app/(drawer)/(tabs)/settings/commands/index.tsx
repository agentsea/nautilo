import { router, type Href, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { CommandListItem } from "@nautilo/api-client/browser";

import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import {
  canManageMobileCommand,
  commandSettingsErrorMessage,
  createCommandsListController,
  formatMobileCommandTitle,
  mobileCommandKind,
  type CommandsListController,
} from "@/features/settings/commands-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

/** Server-owned Commands catalogue with no local execution or offline writes. */
export default function CommandsScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [query, setQuery] = useState("");
  const serverRef = useRef(activeServer);
  serverRef.current = activeServer;
  const controllerRef = useRef<CommandsListController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createCommandsListController((scope) => {
      const server = serverRef.current;
      if (!server || server.id !== scope.serverId) throw new Error("The active server changed.");
      return getApiClient(server.serverUrl);
    });
  }
  const controller = controllerRef.current;
  const subscribe = useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]);
  const snapshot = useCallback(() => controller.data.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, {
    status, viewerState, viewer: viewer && viewerState === "verified" ? viewer : null,
  }), [activeServer, status, viewer, viewerState]);

  useFocusEffect(useCallback(() => {
    controller.setScope(scope);
    if (scope) void controller.load();
    return () => controller.setScope(null);
  }, [controller, scope]));

  const commands = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = state.data?.commands ?? [];
    return q ? all.filter((command) => command.name.toLowerCase().includes(q) || command.description.toLowerCase().includes(q)) : all;
  }, [query, state.data?.commands]);
  const retryDisabled = !scope || state.loading || state.mutating;
  const goToCommand = (name: string): void => router.push(`/settings/commands/${encodeURIComponent(name)}` as Href);

  return <View style={styles.container}><Screen edgeTop={false} contentStyle={styles.content}>
    <Text style={styles.intro}>Commands are reusable slash prompts. The server controls who can view and change them; chat expands a selected command only when you send it.</Text>
    {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before managing Commands.</SettingsStatus> : null}
    {state.loadError ? <SettingsStatus tone="error">{commandSettingsErrorMessage(state.loadError)}</SettingsStatus> : null}
    {state.loadError && !state.data ? <Pressable style={[styles.retryButton, retryDisabled && styles.disabled]} disabled={retryDisabled} onPress={() => void controller.retry()} accessibilityRole="button" accessibilityLabel="Try again loading Commands" accessibilityHint="Retries loading the Commands catalogue from this server." accessibilityState={{ disabled: retryDisabled }}><Text style={styles.retryButtonText}>{state.loading ? "Retrying…" : "Try again"}</Text></Pressable> : null}
    {state.mutationError ? <SettingsStatus tone="error">{commandSettingsErrorMessage(state.mutationError)}</SettingsStatus> : null}
    {state.loading && !state.data ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading Commands" /> : null}
    {state.data ? <>
      <View style={styles.toolbar}>
        <TextInput value={query} onChangeText={setQuery} style={styles.search} placeholder="Search Commands" placeholderTextColor={t.color.text.dim} accessibilityLabel="Search Commands" />
        <Pressable style={[styles.create, (!scope || state.loading || state.mutating) && styles.disabled]} disabled={!scope || state.loading || state.mutating} onPress={() => router.push("/settings/commands/new" as Href)} accessibilityRole="button" accessibilityLabel="Create Command"><Text style={styles.createText}>New</Text></Pressable>
      </View>
      <View style={styles.summary}><Text style={styles.summaryText}>{state.data.summary.enabled} enabled · {state.data.summary.disabled} disabled</Text><Pressable onPress={() => void controller.retry()} disabled={state.loading || state.mutating} accessibilityRole="button" accessibilityLabel="Refresh Commands"><Text style={styles.refresh}>{state.loading ? "Refreshing…" : "Refresh"}</Text></Pressable></View>
      {commands.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>No Commands found</Text><Text style={styles.emptyCopy}>{query ? "Try a different search." : "Create a Command to offer a reusable slash prompt."}</Text></View> : <View style={styles.list}>{commands.map((command) => <CommandRow key={command.name} command={command} busy={state.loading || state.mutating} onOpen={() => goToCommand(command.name)} onToggle={() => void controller.setEnabled(command.name, !command.enabled)} />)}</View>}
    </> : null}
  </Screen></View>;
}

function CommandRow({ command, busy, onOpen, onToggle }: { command: CommandListItem; busy: boolean; onOpen: () => void; onToggle: () => void }) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  const kind = mobileCommandKind(command); const mutable = canManageMobileCommand(command);
  const badge = kind === "official-untouched" ? "Official" : kind === "official-customized" ? "Official · customized" : "Your Command";
  return <View style={styles.row}><Pressable style={styles.rowCopy} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Command ${command.name}, ${badge}`} accessibilityHint="Opens Command details and configuration."><View style={styles.titleLine}><Text style={styles.name}>/{formatMobileCommandTitle(command.name)}</Text><Text style={styles.badge}>{badge}</Text></View><Text style={styles.slug}>{command.name}</Text><Text style={styles.description} numberOfLines={2}>{command.description}</Text></Pressable><Pressable style={[styles.toggle, command.enabled && styles.toggleOn, (!mutable || busy) && styles.disabled]} onPress={onToggle} disabled={!mutable || busy} accessibilityRole="switch" accessibilityLabel={`${command.enabled ? "Disable" : "Enable"} ${command.name}`} accessibilityHint={mutable ? "Updates this Command on the server." : "Customize this official Command before changing it."} accessibilityState={{ checked: command.enabled, disabled: !mutable || busy }}><View style={[styles.knob, command.enabled && styles.knobOn]} /></Pressable></View>;
}

function createStyles(t: AppTheme) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.md }, intro: { ...t.typography.body, color: t.color.text.muted }, toolbar: { flexDirection: "row", gap: t.spacing.sm }, search: { flex: 1, minHeight: 44, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, paddingHorizontal: t.spacing.md, ...t.typography.body, color: t.color.text.foreground, backgroundColor: t.color.surface.panel }, create: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent }, createText: { ...t.typography.label, color: t.color.text.onPrimary }, summary: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, summaryText: { ...t.typography.caption, color: t.color.text.muted }, refresh: { ...t.typography.label, color: t.color.brand.accent }, retryButton: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.brand.accent }, retryButtonText: { ...t.typography.label, color: t.color.brand.accent }, list: { overflow: "hidden", borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, backgroundColor: t.color.surface.panel }, row: { minHeight: 88, flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default }, rowCopy: { flex: 1, gap: 3 }, titleLine: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm, alignItems: "center" }, name: { ...t.typography.bodyStrong, color: t.color.text.foreground }, badge: { ...t.typography.caption, color: t.color.brand.accent }, slug: { ...t.typography.caption, color: t.color.text.dim }, description: { ...t.typography.caption, color: t.color.text.muted }, toggle: { width: 44, height: 26, padding: 3, borderRadius: t.radii.pill, backgroundColor: t.color.border.strong, justifyContent: "center" }, toggleOn: { backgroundColor: t.color.status.success }, knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: t.color.surface.background }, knobOn: { alignSelf: "flex-end" }, empty: { gap: t.spacing.sm, padding: t.spacing.lg, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, backgroundColor: t.color.surface.panel }, emptyTitle: { ...t.typography.subheading, color: t.color.text.foreground }, emptyCopy: { ...t.typography.body, color: t.color.text.muted }, disabled: { opacity: 0.55 },
}); }
