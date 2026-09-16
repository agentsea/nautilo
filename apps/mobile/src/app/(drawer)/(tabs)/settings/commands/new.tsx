import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";

import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import { commandSettingsErrorMessage, createCommandsListController, type CommandsListController } from "@/features/settings/commands-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function NewCommandScreen() {
  const { activeServer } = useServers(); const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [body, setBody] = useState(""); const [enabled, setEnabled] = useState(true);
  const serverRef = useRef(activeServer); serverRef.current = activeServer;
  const controllerRef = useRef<CommandsListController | null>(null);
  if (!controllerRef.current) controllerRef.current = createCommandsListController((scope) => { const server = serverRef.current; if (!server || server.id !== scope.serverId) throw new Error("The active server changed."); return getApiClient(server.serverUrl); });
  const controller = controllerRef.current;
  const subscribe = useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]); const snapshot = useCallback(() => controller.data.getState(), [controller]); const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, { status, viewerState, viewer: viewer && viewerState === "verified" ? viewer : null }), [activeServer, status, viewer, viewerState]);
  useFocusEffect(useCallback(() => { controller.setScope(scope); return () => controller.setScope(null); }, [controller, scope]));
  const save = (): void => { if (!scope || !name.trim() || !description.trim() || !body.trim()) return; void controller.create({ name: name.trim(), description: description.trim(), body: body.trim(), enabled }).then((result) => { if (result.status === "applied") router.replace("/settings/commands"); }); };
  const canSave = Boolean(scope && name.trim() && description.trim() && body.trim() && !state.mutating);
  return <View style={styles.container}><Screen edgeTop={false} contentStyle={styles.content} keyboardBottomOffset={80}>
    <Text style={styles.intro}>Create a reusable prompt. The server validates its name and owns its availability.</Text>
    {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before creating a Command.</SettingsStatus> : null}
    {state.mutationError ? <SettingsStatus tone="error">{commandSettingsErrorMessage(state.mutationError)}</SettingsStatus> : null}
    <Field label="Name" value={name} onChangeText={setName} editable={!state.mutating} placeholder="review-change" hint="Lowercase slash-command name; do not include /." />
    <Field label="Description" value={description} onChangeText={setDescription} editable={!state.mutating} placeholder="Review a change for correctness." />
    <Field label="Instructions" value={body} onChangeText={setBody} editable={!state.mutating} multiline placeholder="Prompt sent when this Command is used." />
    <View style={styles.enabledRow}><View><Text style={styles.label}>Enabled</Text><Text style={styles.hint}>Show this Command in slash discovery.</Text></View><Pressable style={[styles.toggle, enabled && styles.toggleOn, state.mutating && styles.disabled]} disabled={state.mutating} onPress={() => setEnabled((current) => !current)} accessibilityRole="switch" accessibilityLabel="Command enabled" accessibilityState={{ checked: enabled, disabled: state.mutating }}><View style={[styles.knob, enabled && styles.knobOn]} /></Pressable></View>
  </Screen>
  {canSave || state.mutating ? <KeyboardStickyView style={styles.actionBar}>
    <Pressable style={[styles.save, !canSave && styles.disabled]} disabled={!canSave} onPress={save} accessibilityRole="button" accessibilityLabel="Create Command"><Text style={styles.saveText}>{state.mutating ? "Creating…" : "Create Command"}</Text></Pressable>
    {state.mutating ? <ActivityIndicator color={t.color.brand.accent} /> : null}
  </KeyboardStickyView> : null}
  </View>;
}

function Field({ label, value, onChangeText, editable, placeholder, hint, multiline = false }: { label: string; value: string; onChangeText: (text: string) => void; editable: boolean; placeholder: string; hint?: string; multiline?: boolean }) { const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]); return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} editable={editable} multiline={multiline} scrollEnabled={multiline} textAlignVertical={multiline ? "top" : undefined} style={[styles.input, multiline && styles.body]} placeholder={placeholder} placeholderTextColor={t.color.text.dim} accessibilityLabel={`Command ${label}`} />{hint ? <Text style={styles.hint}>{hint}</Text> : null}</View>; }
function createStyles(t: AppTheme) { return StyleSheet.create({ container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.lg }, intro: { ...t.typography.body, color: t.color.text.muted }, field: { gap: t.spacing.sm }, label: { ...t.typography.bodyStrong, color: t.color.text.foreground }, hint: { ...t.typography.caption, color: t.color.text.muted }, input: { minHeight: 44, borderRadius: t.radii.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, ...t.typography.body, color: t.color.text.foreground, backgroundColor: t.color.surface.panel }, body: { height: 220, fontFamily: "monospace", fontSize: 14, lineHeight: 20 }, enabledRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, toggle: { width: 44, height: 26, padding: 3, borderRadius: t.radii.pill, backgroundColor: t.color.border.strong, justifyContent: "center" }, toggleOn: { backgroundColor: t.color.status.success }, knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: t.color.surface.background }, knobOn: { alignSelf: "flex-end" }, actionBar: { gap: t.spacing.sm, padding: t.spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.color.border.default, backgroundColor: t.color.surface.background }, save: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, backgroundColor: t.color.brand.accent }, saveText: { ...t.typography.label, color: t.color.text.onPrimary }, disabled: { opacity: 0.55 } }); }
