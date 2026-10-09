import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { CredentialMetadata } from "@nautilo/api-client/browser";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import { createPersonalCredentialsController, personalAccountErrorMessage, personalCredentialLoadKind, type PersonalCredentialsController } from "@/features/settings/personal-account-controller";
import { personalProviderKeyRows } from "@/features/settings/personal-provider-key-presentation";
import { personalProviderCapabilitySummary } from "@nautilo/types";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

function readableTime(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toLocaleString();
}

interface CredentialDeleteConfirmation {
  readonly provider: string;
  readonly credential: CredentialMetadata;
  readonly policyEnabled: boolean;
}

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
  const [confirmDelete, setConfirmDelete] = useState<CredentialDeleteConfirmation | null>(null);
  const focusedRef = useRef(false);

  useEffect(() => { setEditing(null); setSecret(""); setSuccess(null); setConfirmDelete(null); }, [scope?.actorId, scope?.serverId, scope?.userId]);
  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    setConfirmDelete(null);
    controller.setScope(scope);
    if (scope) void controller.load();
    return () => { focusedRef.current = false; setConfirmDelete(null); controller.setScope(null); };
  }, [controller, scope]));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && focusedRef.current && scope) {
        setConfirmDelete(null);
        controller.setScope(scope);
        void controller.load();
      }
    });
    return () => subscription.remove();
  }, [controller, scope]);

  const loadKind = state.loadError ? personalCredentialLoadKind(state.loadError) : null;
  const policyDisabled = loadKind === "disabled" || state.data?.allowPersonalProviderKeys === false;
  const byProvider = useMemo(() => new Map(state.data?.credentials.map((item) => [item.provider, item]) ?? []), [state.data]);
  const providers = useMemo(() => loadKind === "disabled" ? [] : personalProviderKeyRows(state.data), [loadKind, state.data]);
  const loadAllowsActions = Boolean(scope && state.data && !state.loading && !state.loadError);
  useEffect(() => {
    if (!confirmDelete) return;
    const current = state.data?.credentials.find((credential) => credential.provider === confirmDelete.provider);
    if (
      state.loadError
      || !current
      || current.id !== confirmDelete.credential.id
      || current.revision !== confirmDelete.credential.revision
      || (state.data?.allowPersonalProviderKeys !== false) !== confirmDelete.policyEnabled
    ) {
      setConfirmDelete(null);
    }
  }, [confirmDelete, state.data, state.loadError]);
  useEffect(() => {
    if (policyDisabled || loadKind === "forbidden" || loadKind === "signedOut") {
      setEditing(null);
      setSecret("");
      setSuccess(null);
    }
  }, [loadKind, policyDisabled]);

  const save = async (provider: string, current?: CredentialMetadata): Promise<void> => {
    setSuccess(null);
    try {
      const result = await controller.save(provider, secret, current);
      if (result.status === "applied") { setEditing(null); setSecret(""); setSuccess(provider); }
    } catch {
      // Empty input remains local and never reaches the client.
    }
  };
  const remove = async (confirmation: CredentialDeleteConfirmation): Promise<void> => {
    setSuccess(null);
    await controller.remove(confirmation.provider, confirmation.credential);
    setConfirmDelete((current) => current
      && current.provider === confirmation.provider
      && current.credential.id === confirmation.credential.id
      && current.credential.revision === confirmation.credential.revision
      ? null
      : current);
  };
  const goBack = (): void => router.canGoBack() ? router.back() : router.replace("/(drawer)/(tabs)/settings");

  return <View style={styles.container}>
    <Stack.Screen options={{ header: () => <AppBar title="Personal API keys" left={<AppBarBackButton onPress={goBack} />} /> }} />
    <Screen edgeTop={false} contentStyle={styles.content}>
      {!policyDisabled ? <Text style={styles.intro}>Add your own key for eligible personal chat, native text Tasks, Research and Decisions. Save checks the key without making a paid request. Embeddings stay server-managed.</Text> : null}
      {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before managing personal keys.</SettingsStatus> : null}
      {state.loading ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading personal API keys" /> : null}
      {state.loadError ? <><SettingsStatus tone={loadKind === "error" ? "error" : "warning"}>{personalAccountErrorMessage(state.loadError)}</SettingsStatus>{loadKind === "error" ? <ActionButton label="Retry" onPress={() => void controller.retry()} /> : null}</> : null}
      {!state.loadError && state.data?.allowPersonalProviderKeys === false ? <SettingsStatus tone="warning">{`Personal API keys are disabled on this server.${state.data.credentials.length > 0 ? " Your saved keys won’t be used. You can delete them below." : ""}`}</SettingsStatus> : null}
      {state.mutationError ? <SettingsStatus tone="error">{personalAccountErrorMessage(state.mutationError)}</SettingsStatus> : null}
      {providers.map((provider) => {
        const current = byProvider.get(provider.id);
        const isEditing = editing === provider.id;
        const actionsEnabled = loadAllowsActions && !provider.deleteOnly && provider.available;
        const deleteEnabled = loadAllowsActions && Boolean(current);
        const savedAt = current ? readableTime(current.updatedAt) : null;
        const confirmingDelete = Boolean(
          current
          && confirmDelete?.provider === provider.id
          && confirmDelete.credential.id === current.id
          && confirmDelete.credential.revision === current.revision
          && confirmDelete.policyEnabled === (state.data?.allowPersonalProviderKeys !== false),
        );
        return <View key={provider.id} style={styles.card}>
          <View style={styles.cardHeader}><View style={styles.cardCopy}><Text style={styles.provider}>{provider.name}</Text>{provider.deleteOnly ? <Text style={styles.help}>{savedAt ? `Saved ${savedAt}` : "Saved"}</Text> : <Text style={styles.help}>{provider.purpose}</Text>}</View>{!provider.deleteOnly ? <Text style={[styles.badge, current && !current.requiresReplacement && current.validationStatus !== "rejected" ? styles.good : styles.muted]}>{state.data ? current ? current.validationStatus : "Not added" : "Checking status…"}</Text> : null}</View>
          {!provider.deleteOnly && provider.catalogued ? <Text style={styles.help}>{personalProviderCapabilitySummary(provider)}</Text> : null}
          {!provider.deleteOnly && current?.masked ? <Text style={styles.masked}>{current.masked}</Text> : null}
          {!provider.deleteOnly && current?.requiresReplacement ? <SettingsStatus tone="error">Replace this key before it can be used.</SettingsStatus> : null}
          {!provider.deleteOnly && current?.receiptReadStatus === "unavailable" ? <Text style={styles.help}>This key can run eligible requests. Some costs may appear later because it cannot currently read cost receipts.</Text> : null}
          {!provider.deleteOnly && success === provider.id ? <SettingsStatus tone="success">{`Key saved and checked. ${provider.catalogued ? personalProviderCapabilitySummary(provider) : ""} Configure eligible models under Capability models, then review charges in Your costs.`}</SettingsStatus> : null}
          {confirmingDelete && confirmDelete ? <>
            <Text style={styles.help}>Delete personal key? Eligible work will stop using this provider key. Your historical costs remain available.</Text>
            <View style={styles.actions}><ActionButton label="Delete key" accessibilityLabel={`Delete ${provider.name} key now`} disabled={!deleteEnabled || state.mutating} onPress={() => void remove(confirmDelete)} /><ActionButton label="Cancel" accessibilityLabel={`Cancel deleting ${provider.name} key`} disabled={!deleteEnabled || state.mutating} onPress={() => setConfirmDelete(null)} /></View>
          </> : isEditing && provider.catalogued && !provider.deleteOnly ? <>
            <TextInput value={secret} onChangeText={setSecret} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" textContentType="newPassword" editable={actionsEnabled && !state.mutating} style={styles.input} placeholder={provider.formatHint ?? "Provider API key"} placeholderTextColor={t.color.text.muted} accessibilityLabel={`${current ? "Replacement" : "New"} ${provider.name} API key`} />
            <View style={styles.actions}><ActionButton label={state.mutating ? "Saving…" : current ? "Replace key" : "Save key"} disabled={!actionsEnabled || state.mutating || !secret.trim()} onPress={() => void save(provider.id, current)} primary /><ActionButton label="Cancel" disabled={state.mutating} onPress={() => { setEditing(null); setSecret(""); }} /></View>
          </> : <View style={styles.actions}>
            {!provider.deleteOnly && provider.catalogued && (!state.data || provider.available) ? <ActionButton label={current ? "Replace" : "Add key"} disabled={!actionsEnabled || state.mutating} onPress={() => { setEditing(provider.id); setSecret(""); setSuccess(null); }} primary={!current} /> : null}
            {!provider.deleteOnly && current && provider.catalogued && (current.validationStatus === "unavailable" || current.validationStatus === "unverified" || current.receiptReadStatus === "unavailable") ? <ActionButton label="Check again" disabled={!actionsEnabled || state.mutating} onPress={() => void controller.validate(provider.id, current)} /> : null}
            {current ? <ActionButton label="Delete" accessibilityLabel={`Delete ${provider.name} key`} disabled={!deleteEnabled || state.mutating} onPress={() => setConfirmDelete({ provider: provider.id, credential: current, policyEnabled: state.data?.allowPersonalProviderKeys !== false })} /> : null}
          </View>}
        </View>;
      })}
    </Screen>
  </View>;
}

function ActionButton({ label, onPress, accessibilityLabel, disabled = false, primary = false }: { label: string; onPress: () => void; accessibilityLabel?: string; disabled?: boolean; primary?: boolean }) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  return <Pressable style={({ pressed }) => [styles.button, primary && styles.primaryButton, (disabled || pressed) && styles.dimmed]} disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }}><Text style={[styles.buttonText, primary && styles.primaryButtonText]}>{label}</Text></Pressable>;
}

function createStyles(t: AppTheme) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.lg }, intro: { ...t.typography.body, color: t.color.text.muted },
  card: { gap: t.spacing.md, padding: t.spacing.lg, borderRadius: t.radii.lg, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: t.spacing.md }, cardCopy: { flex: 1, gap: 2 }, provider: { ...t.typography.subheading, color: t.color.text.foreground }, help: { ...t.typography.caption, color: t.color.text.muted },
  badge: { ...t.typography.caption, paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.xs, borderRadius: t.radii.pill, overflow: "hidden" }, good: { color: t.color.status.success, backgroundColor: t.color.surface.subtle }, muted: { color: t.color.text.muted, backgroundColor: t.color.surface.subtle },
  destination: { ...t.typography.caption, color: t.color.text.muted }, masked: { ...t.typography.label, color: t.color.text.foreground }, input: { minHeight: 48, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md, color: t.color.text.foreground, ...t.typography.body },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm }, button: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.color.border.default }, primaryButton: { backgroundColor: t.color.brand.accent, borderColor: t.color.brand.accent }, buttonText: { ...t.typography.label, color: t.color.text.foreground }, primaryButtonText: { color: t.color.surface.background }, dimmed: { opacity: 0.55 },
}); }
