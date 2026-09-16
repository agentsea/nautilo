import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import { canManageMobileCommand, commandSettingsErrorMessage, createCommandDetailController, formatMobileCommandTitle, mobileCommandKind, type CommandDetailController } from "@/features/settings/commands-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function CommandDetailScreen() {
  const { name: rawName } = useLocalSearchParams<{ name: string }>(); const name = typeof rawName === "string" ? rawName : "";
  const { activeServer } = useServers(); const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  const serverRef = useRef(activeServer); serverRef.current = activeServer;
  const controllerRef = useRef<CommandDetailController | null>(null);
  if (!controllerRef.current) controllerRef.current = createCommandDetailController((scope) => { const server = serverRef.current; if (!server || server.id !== scope.serverId) throw new Error("The active server changed."); return getApiClient(server.serverUrl); });
  const controller = controllerRef.current;
  const subscribe = useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]); const snapshot = useCallback(() => controller.data.getState(), [controller]); const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, { status, viewerState, viewer: viewer && viewerState === "verified" ? viewer : null }), [activeServer, status, viewer, viewerState]);
  const [description, setDescription] = useState(""); const [body, setBody] = useState(""); const [enabled, setEnabled] = useState(true);
  useFocusEffect(useCallback(() => { controller.setScope(scope); if (scope && name) void controller.load(name); return () => controller.setScope(null); }, [controller, name, scope]));
  const command = state.data?.name === name ? state.data : null;
  useEffect(() => { if (command) { setDescription(command.description); setBody(command.body); setEnabled(command.enabled); } }, [command]);
  const kind = command ? mobileCommandKind(command) : null; const editable = command ? canManageMobileCommand(command) : false; const busy = state.loading || state.mutating;
  const retryDisabled = !scope || busy;
  const goBack = (): void => { if (router.canGoBack()) router.back(); else router.replace("/settings/commands"); };
  const save = (): void => { if (!command || !editable || !description.trim() || !body.trim()) return; void controller.save({ name: command.name, description: description.trim(), body: body.trim(), enabled }); };
  const customize = (): void => void controller.customize();
  const reset = (): void => Alert.alert("Reset to official Command?", "Your customized prompt and enabled state will be discarded.", [{ text: "Cancel", style: "cancel" }, { text: "Reset", style: "destructive", onPress: () => void controller.reset() }]);
  const remove = (): void => Alert.alert("Delete Command?", `/${command?.name ?? ""} will no longer be available in slash discovery.`, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => void controller.remove().then((result) => { if (result.status === "applied") router.replace("/settings/commands"); }) }]);
  return <View style={styles.container}><Stack.Screen options={{ header: () => <AppBar title={command ? formatMobileCommandTitle(command.name) : "Command"} left={<AppBarBackButton onPress={goBack} />} /> }} /><Screen edgeTop={false} contentStyle={styles.content} keyboardBottomOffset={editable ? 80 : 0}>
    {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before managing this Command.</SettingsStatus> : null}
    {state.loading && !command ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading Command" /> : null}
    {state.loadError ? <SettingsStatus tone="error">{commandSettingsErrorMessage(state.loadError)}</SettingsStatus> : null}
    {state.loadError && !command ? <Pressable style={[styles.secondary, retryDisabled && styles.disabled]} disabled={retryDisabled} onPress={() => void controller.retry(name)} accessibilityRole="button" accessibilityLabel="Try again loading this Command" accessibilityHint="Retries loading this Command from this server." accessibilityState={{ disabled: retryDisabled }}><Text style={styles.secondaryText}>{state.loading ? "Retrying…" : "Try again"}</Text></Pressable> : null}
    {state.mutationError ? <SettingsStatus tone="error">{commandSettingsErrorMessage(state.mutationError)}</SettingsStatus> : null}
    {command ? <>
      <View style={styles.identity}><Text style={styles.slug}>/{command.name}</Text><Text style={styles.meta}>{kind === "official-untouched" ? "Official Command" : kind === "official-customized" ? "Official Command · customized" : "Your Command"} · {command.tokenEstimate} tokens</Text></View>
      {kind === "official-untouched" ? <View style={styles.notice}><Text style={styles.noticeText}>Official Commands are read-only. Customize this Command to create a server-managed copy before changing it.</Text><Pressable style={[styles.primary, busy && styles.disabled]} disabled={!scope || busy} onPress={customize} accessibilityRole="button" accessibilityLabel={`Customize ${command.name}`}><Text style={styles.primaryText}>{state.mutating ? "Customizing…" : "Customize"}</Text></Pressable></View> : <>
        <Field label="Description" value={description} onChangeText={setDescription} editable={!busy} /><Field label="Instructions" value={body} onChangeText={setBody} editable={!busy} multiline />
        <View style={styles.enabledRow}><View><Text style={styles.label}>Enabled</Text><Text style={styles.helper}>Shown in slash discovery when this server permits it.</Text></View><Pressable style={[styles.toggle, enabled && styles.toggleOn, busy && styles.disabled]} disabled={busy} onPress={() => setEnabled((current) => !current)} accessibilityRole="switch" accessibilityLabel="Command enabled" accessibilityState={{ checked: enabled, disabled: busy }}><View style={[styles.knob, enabled && styles.knobOn]} /></Pressable></View>
        {kind === "official-customized" ? <Pressable style={[styles.secondary, busy && styles.disabled]} disabled={busy} onPress={reset} accessibilityRole="button" accessibilityLabel="Reset Command to official"><Text style={styles.secondaryText}>Reset to official</Text></Pressable> : <Pressable style={[styles.delete, busy && styles.disabled]} disabled={busy} onPress={remove} accessibilityRole="button" accessibilityLabel="Delete Command"><Text style={styles.deleteText}>Delete Command</Text></Pressable>}
      </>}
    </> : null}
  </Screen>
  {command && editable ? <KeyboardStickyView style={styles.actionBar}>
    <Pressable style={[styles.primary, (!scope || busy || !description.trim() || !body.trim()) && styles.disabled]} disabled={!scope || busy || !description.trim() || !body.trim()} onPress={save} accessibilityRole="button" accessibilityLabel="Save Command"><Text style={styles.primaryText}>{state.mutating ? "Saving…" : "Save changes"}</Text></Pressable>
  </KeyboardStickyView> : null}
  </View>;
}
function Field({ label, value, onChangeText, editable, multiline = false }: { label: string; value: string; onChangeText: (text: string) => void; editable: boolean; multiline?: boolean }) { const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]); return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} editable={editable} multiline={multiline} scrollEnabled={multiline} textAlignVertical={multiline ? "top" : undefined} style={[styles.input, multiline && styles.body]} accessibilityLabel={`Command ${label}`} /></View>; }
function createStyles(t: AppTheme) { return StyleSheet.create({ container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.lg }, identity: { gap: 3 }, slug: { ...t.typography.subheading, color: t.color.text.foreground }, meta: { ...t.typography.caption, color: t.color.text.muted }, notice: { gap: t.spacing.md, padding: t.spacing.lg, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, noticeText: { ...t.typography.body, color: t.color.text.muted }, field: { gap: t.spacing.sm }, label: { ...t.typography.bodyStrong, color: t.color.text.foreground }, helper: { ...t.typography.caption, color: t.color.text.muted }, input: { minHeight: 44, borderRadius: t.radii.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, ...t.typography.body, color: t.color.text.foreground, backgroundColor: t.color.surface.panel }, body: { height: 250, fontFamily: "monospace", fontSize: 14, lineHeight: 20 }, enabledRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.spacing.md }, toggle: { width: 44, height: 26, padding: 3, borderRadius: t.radii.pill, backgroundColor: t.color.border.strong, justifyContent: "center" }, toggleOn: { backgroundColor: t.color.status.success }, knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: t.color.surface.background }, knobOn: { alignSelf: "flex-end" }, actionBar: { padding: t.spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.color.border.default, backgroundColor: t.color.surface.background }, primary: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, backgroundColor: t.color.brand.accent }, primaryText: { ...t.typography.label, color: t.color.text.onPrimary }, secondary: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.brand.accent }, secondaryText: { ...t.typography.label, color: t.color.brand.accent }, delete: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.status.error }, deleteText: { ...t.typography.label, color: t.color.status.error }, disabled: { opacity: 0.55 } }); }
