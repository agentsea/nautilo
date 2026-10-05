import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { CredentialMetadata } from "@nautilo/api-client/browser";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import { createPersonalCredentialsController, personalAccountErrorMessage, type PersonalCredentialsController } from "@/features/settings/personal-account-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function PersonalProviderKeysScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const serverRef = useRef(activeServer);
  serverRef.current = activeServer;
  const controllerRef = useRef<PersonalCredentialsController | null>(null);
  if (!controllerRef.current) controllerRef.current = createPersonalCredentialsController((scope) => {
    const server = serverRef.current;
    if (!server || server.id !== scope.serverId) throw new Error("The active server changed.");
    return getApiClient(server.serverUrl);
  });
  const controller = controllerRef.current;
  const subscribe = useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]);
  const snapshot = useCallback(() => controller.data.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, { status, viewerState, viewer }), [activeServer, status, viewer, viewerState]);
  const [editing, setEditing] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => { setEditing(null); setSecret(""); setSuccess(null); }, [scope?.serverId, scope?.userId]);
  useFocusEffect(useCallback(() => {
    controller.setScope(scope);
    if (scope) void controller.load();
    return () => controller.setScope(null);
  }, [controller, scope]));

  const byProvider = useMemo(() => new Map(state.data?.credentials.map((item) => [item.provider, item]) ?? []), [state.data]);
  const providers = useMemo(() => {
    const credentialIds = new Set(state.data?.credentials.map((credential) => credential.provider) ?? []);
    const catalog = [...(state.data?.providers ?? [])]
      .filter((provider) => provider.id !== "nautilo-gateway" || credentialIds.has(provider.id));
    const known = new Set(catalog.map((provider) => provider.id));
    for (const credential of state.data?.credentials ?? []) if (!known.has(credential.provider)) catalog.push({ id: credential.provider, name: credential.provider, purpose: "Saved provider outside the current catalogue", personalCapabilities: [], destination: credential.destination });
    return catalog;
  }, [state.data]);

  const save = async (provider: string, current?: CredentialMetadata): Promise<void> => {
    setSuccess(null);
    try {
      const result = await controller.save(provider, secret, current);
      if (result.status === "applied") { setEditing(null); setSecret(""); setSuccess(provider); }
    } catch {
      // Empty input remains local and never reaches the client.
    }
  };
  const remove = (provider: string, current: CredentialMetadata): void => Alert.alert("Delete personal key?", "Eligible work will stop using this provider key. Your historical costs remain available.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: () => { setSuccess(null); void controller.remove(provider, current); } },
  ]);
  const goBack = (): void => router.canGoBack() ? router.back() : router.replace("/(drawer)/(tabs)/settings");

  return <View style={styles.container}>
    <Stack.Screen options={{ header: () => <AppBar title="Personal API keys" left={<AppBarBackButton onPress={goBack} />} /> }} />
    <Screen edgeTop={false} contentStyle={styles.content}>
      <Text style={styles.intro}>Add your own key for eligible personal chat and native text Tasks. Save checks the key without making a paid request. Embeddings stay server-managed.</Text>
      {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before managing personal keys.</SettingsStatus> : null}
      {state.loading ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading personal API keys" /> : null}
      {state.loadError ? <><SettingsStatus tone="error">{personalAccountErrorMessage(state.loadError)}</SettingsStatus><ActionButton label="Retry" onPress={() => void controller.retry()} /></> : null}
      {state.mutationError ? <SettingsStatus tone="error">{personalAccountErrorMessage(state.mutationError)}</SettingsStatus> : null}
      {state.data && providers.length === 0 ? <SettingsStatus tone="warning">Provider choices are temporarily unavailable.</SettingsStatus> : null}
      {providers.map((provider) => {
        const current = byProvider.get(provider.id);
        const isEditing = editing === provider.id;
        return <View key={provider.id} style={styles.card}>
          <View style={styles.cardHeader}><View style={styles.cardCopy}><Text style={styles.provider}>{provider.name}</Text><Text style={styles.help}>{provider.purpose}</Text></View><Text style={[styles.badge, current && !current.requiresReplacement && current.validationStatus !== "rejected" ? styles.good : styles.muted]}>{current ? current.validationStatus : "Not added"}</Text></View>
          <Text style={styles.help}>{provider.personalCapabilities.includes("chat") ? "Enables personal text models. Eligible charges are paid by you." : "Saved for a later supported capability; this key does not enable text work yet."}</Text>
          {provider.destination ? <Text style={styles.destination} selectable>Fixed destination: {provider.destination}</Text> : provider.id === "gateway" ? <SettingsStatus tone="warning">The server has not published a Gateway destination. You cannot enroll this key yet.</SettingsStatus> : null}
          {current?.masked ? <Text style={styles.masked}>{current.masked}</Text> : null}
          {current?.requiresReplacement ? <SettingsStatus tone="error">Replace this key before it can be used.</SettingsStatus> : null}
          {current?.receiptReadStatus === "unavailable" ? <SettingsStatus tone="warning">This key can run requests, but cannot read cost receipts. Grant receipt-read permission to this key, then use Check again. Receipts from a removed or replaced key may remain unresolved.</SettingsStatus> : null}
          {success === provider.id ? <SettingsStatus tone="success">Key saved and checked. Choose a model for your Agent, then review charges in Your costs.</SettingsStatus> : null}
          {isEditing ? <>
            <TextInput value={secret} onChangeText={setSecret} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" textContentType="newPassword" editable={!state.mutating} style={styles.input} placeholder={provider.formatHint ?? "Provider API key"} placeholderTextColor={t.color.text.muted} accessibilityLabel={`${current ? "Replacement" : "New"} ${provider.name} API key`} />
            <View style={styles.actions}><ActionButton label={state.mutating ? "Saving…" : current ? "Replace key" : "Save key"} disabled={state.mutating || !secret.trim() || (provider.id === "gateway" && !provider.destination)} onPress={() => void save(provider.id, current)} primary /><ActionButton label="Cancel" disabled={state.mutating} onPress={() => { setEditing(null); setSecret(""); }} /></View>
          </> : <View style={styles.actions}>
            <ActionButton label={current ? "Replace" : "Add key"} disabled={state.mutating || (provider.id === "gateway" && !provider.destination)} onPress={() => { setEditing(provider.id); setSecret(""); setSuccess(null); }} primary={!current} />
            {current && (current.validationStatus === "unavailable" || current.validationStatus === "unverified" || current.receiptReadStatus === "unavailable") ? <ActionButton label="Check again" disabled={state.mutating} onPress={() => void controller.validate(provider.id, current)} /> : null}
            {current ? <ActionButton label="Delete" disabled={state.mutating} onPress={() => remove(provider.id, current)} /> : null}
          </View>}
        </View>;
      })}
    </Screen>
  </View>;
}

function ActionButton({ label, onPress, disabled = false, primary = false }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  return <Pressable style={({ pressed }) => [styles.button, primary && styles.primaryButton, (disabled || pressed) && styles.dimmed]} disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled }}><Text style={[styles.buttonText, primary && styles.primaryButtonText]}>{label}</Text></Pressable>;
}

function createStyles(t: AppTheme) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.lg }, intro: { ...t.typography.body, color: t.color.text.muted },
  card: { gap: t.spacing.md, padding: t.spacing.lg, borderRadius: t.radii.lg, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: t.spacing.md }, cardCopy: { flex: 1, gap: 2 }, provider: { ...t.typography.subheading, color: t.color.text.foreground }, help: { ...t.typography.caption, color: t.color.text.muted },
  badge: { ...t.typography.caption, paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.xs, borderRadius: t.radii.pill, overflow: "hidden" }, good: { color: t.color.status.success, backgroundColor: t.color.surface.subtle }, muted: { color: t.color.text.muted, backgroundColor: t.color.surface.subtle },
  destination: { ...t.typography.caption, color: t.color.text.muted }, masked: { ...t.typography.label, color: t.color.text.foreground }, input: { minHeight: 48, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md, color: t.color.text.foreground, ...t.typography.body },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm }, button: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.color.border.default }, primaryButton: { backgroundColor: t.color.brand.accent, borderColor: t.color.brand.accent }, buttonText: { ...t.typography.label, color: t.color.text.foreground }, primaryButtonText: { color: t.color.surface.background }, dimmed: { opacity: 0.55 },
}); }
