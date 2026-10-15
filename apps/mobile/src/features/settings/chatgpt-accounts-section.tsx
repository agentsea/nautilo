import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { SettingsStatus } from "@/components/settings/settings-status";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import { createChatGPTAccountsController, type ChatGPTAccount } from "./chatgpt-accounts-controller";
import { settingsScopeForVerifiedViewer } from "./settings-data-state";

export function ChatGPTAccountsSection() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const theme = useAppTheme();
  const serverRef = useRef(activeServer);
  serverRef.current = activeServer;
  const [controller] = useState(() => createChatGPTAccountsController(scope => {
    const server = serverRef.current;
    if (!server || server.id !== scope.serverId) throw new Error("The active server changed.");
    return getApiClient(server.serverUrl);
  }));
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, { status, viewerState, viewer }), [activeServer, status, viewerState, viewer]);
  const subscribe = useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]);
  const snapshot = useCallback(() => controller.data.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [confirmation, setConfirmation] = useState<ChatGPTAccount | "switch" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const focused = useRef(false);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    setMessage(null);
    setConfirmation(null);
    controller.setScope(scope);
    if (scope) void controller.load();
    return () => { focused.current = false; setConfirmation(null); controller.setScope(null); };
  }, [controller, scope]));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", next => {
      if (next === "active" && focused.current && scope) { setConfirmation(null); void controller.load(); }
    });
    return () => subscription.remove();
  }, [controller, scope]);
  useEffect(() => { setConfirmation(null); }, [state.data, state.loadError]);
  const busy = state.loading || state.mutating || !scope || !!state.loadError;
  const text = { color: theme.color.text.foreground };
  const help = { color: theme.color.text.muted };
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" disabled={busy || disabled} onPress={action} style={[styles.button, { borderColor: theme.color.border.default, opacity: busy || disabled ? 0.5 : 1 }]}><Text style={text}>{label}</Text></Pressable>;
  const disconnect = async (account: ChatGPTAccount) => {
    setMessage(null);
    const result = await controller.disconnect(account);
    if (result.status === "applied") setMessage(result.remoteRevocationConfirmed ? "Disconnected. OpenAI confirmed app access was revoked." : "Local access is disconnected. OpenAI revocation was not confirmed; remove app access in ChatGPT Settings → Usage too.");
    setConfirmation(null);
  };
  const switchFunding = async () => { await controller.select(null); setConfirmation(null); };
  return <View style={styles.section}>
    <Text style={[theme.typography.subheading, text]}>ChatGPT subscription</Text>
    <Text style={help}>Link or reconnect your ChatGPT subscription in Nautilo Desktop connected to this same server. Then choose it here for eligible OpenAI chats and Tasks.</Text>
    <Text style={help}>This server’s operator can read the saved credentials. A subscription limit pauses the work; Nautilo will not automatically charge an API key.</Text>
    {message ? <SettingsStatus tone="warning">{message}</SettingsStatus> : null}
    {state.loading ? <ActivityIndicator accessibilityLabel="Loading ChatGPT accounts" /> : null}
    {state.loadError || state.mutationError ? <SettingsStatus tone="error">Could not update ChatGPT accounts. Check your connection and sign-in, then refresh.</SettingsStatus> : null}
    {scope ? <Pressable accessibilityRole="button" disabled={state.loading || state.mutating} onPress={() => void controller.load()} style={styles.button}><Text style={text}>Refresh accounts</Text></Pressable> : null}
    {state.data?.enabled === false ? <SettingsStatus tone="warning">Subscription funding is unavailable on this server. You can still disconnect saved accounts.</SettingsStatus> : null}
    {state.data?.accounts.length === 0 ? <Text style={help}>No ChatGPT account linked yet.</Text> : null}
    {state.data?.accounts.map(account => <View key={account.id} style={[styles.card, { borderColor: theme.color.border.default }]}>
      <Text style={text}>{account.label} · {account.registrationLabel}</Text>
      <Text style={help}>{account.pendingRegistration ? "Sign-in unfinished — finish in Desktop" : account.requiresReplacement ? "Credentials unavailable — reconnect in Desktop" : account.state === "connected" ? "Connected" : account.state === "disconnected" ? "Disconnected" : "Reconnect in Desktop"}{account.selected ? " · Selected for OpenAI" : ""}</Text>
      {account.state === "connected" && state.data?.enabled ? <Text style={help}>{state.data.models[account.id] === null ? "Models unavailable. Refresh to try again." : state.data.models[account.id]?.length ? `Eligible models: ${state.data.models[account.id]!.map(model => model.name).join(", ")}` : "No eligible models are available."}</Text> : null}
      {button(account.selected ? "Selected for OpenAI" : "Use for OpenAI chats", () => void controller.select(account), !state.data?.enabled || account.selected || account.state !== "connected" || account.requiresReplacement === true)}
      {account.state !== "disconnected" ? button("Disconnect", () => setConfirmation(account)) : null}
      {typeof confirmation === "object" && confirmation?.id === account.id ? <><Text style={help}>Disconnect this account? Work pinned to it will pause. Other accounts and API keys remain available.</Text>{button("Confirm disconnect", () => void disconnect(confirmation))}{button("Cancel", () => setConfirmation(null))}</> : null}
    </View>)}
    {state.data?.accounts.some(account => account.selected) && state.data.enabled ? <>
      {button("Use configured API funding instead", () => setConfirmation("switch"))}
      {confirmation === "switch" ? <><Text style={help}>New OpenAI work may charge your personal API key or the server under its configured policy. Existing work keeps its original funding.</Text>{button("Confirm API funding", () => void switchFunding())}{button("Cancel", () => setConfirmation(null))}</> : null}
    </> : null}
  </View>;
}
const styles = StyleSheet.create({ section: { gap: 12 }, card: { gap: 8, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12 }, button: { minHeight: 44, padding: 12, justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 } });
