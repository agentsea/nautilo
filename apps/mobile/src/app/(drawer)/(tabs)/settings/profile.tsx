import { Image } from "expo-image";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import {
  authenticatedAgentAvatarSource,
  loadAuthenticatedAgentAvatarSource,
} from "@/features/settings/agent-avatar-source";
import { SoulEditorSheet } from "@/features/settings/soul-editor-sheet";
import {
  createAgentProfileController,
  profileDraft,
  type AgentProfileController,
} from "@/features/settings/agent-profile-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { ensureValidToken } from "@/lib/auth";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import { usePlatformCapability } from "@/providers/platform-capabilities";
import type { AppTheme } from "@/theme/tokens";

export default function AgentProfileScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const photoSelection = usePlatformCapability("photoSelection");
  const activeServerRef = useRef(activeServer);
  activeServerRef.current = activeServer;
  const controllerRef = useRef<AgentProfileController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createAgentProfileController((scope) => {
      const server = activeServerRef.current;
      if (!server || server.id !== scope.serverId) throw new Error("The active server changed.");
      return getApiClient(server.serverUrl);
    }, Crypto.randomUUID);
  }
  const controller = controllerRef.current;
  const subscribe = useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.data.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, {
    status,
    viewerState,
    viewer: viewer && viewerState === "verified" ? viewer : null,
  }), [activeServer, status, viewer, viewerState]);
  const [soulSheetVisible, setSoulSheetVisible] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; message: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    controller.setScope(scope);
    if (scope) void controller.load();
  }, [controller, scope]);
  useEffect(() => () => controller.setScope(null), [controller]);
  useEffect(() => {
    let cancelled = false;
    if (!activeServer) {
      setToken(null);
      return;
    }
    const avatar = state.data?.avatar;
    if (!avatar) return;
    void loadAuthenticatedAgentAvatarSource({
      serverId: activeServer.id,
      serverUrl: activeServer.serverUrl,
      avatar,
      getToken: ensureValidToken,
    }).then((source) => {
      if (!cancelled) setToken(source?.headers.Authorization.replace("Bearer ", "") ?? null);
    });
    return () => { cancelled = true; };
  }, [activeServer, state.data?.avatar]);

  const profile = state.data;
  const draft = state.draft ?? (profile ? profileDraft(profile) : null);
  const setDraft = (patch: Partial<NonNullable<typeof draft>>): void => {
    if (!draft) return;
    controller.data.setDraft({ ...draft, ...patch });
  };
  const avatarSource = profile && activeServer
    ? authenticatedAgentAvatarSource({ serverUrl: activeServer.serverUrl, accessToken: token, avatar: profile.avatar })
    : null;
  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/(drawer)/(tabs)/settings");
  };
  const save = async (): Promise<void> => {
    if (!draft) return;
    const outcome = await controller.save(draft);
    if (outcome.status === "applied") setNotice({ tone: "success", message: "Agent profile saved and refreshed from the server." });
    else if (outcome.status === "partial") setNotice({ tone: "warning", message: outcome.message });
    else if (outcome.status === "failed") setNotice({ tone: "error", message: outcome.message });
  };
  const generateSoul = async (): Promise<void> => {
    const outcome = await controller.generateSoul();
    if (outcome.status === "applied") setNotice({ tone: "success", message: "Soul instructions generated and refreshed from the server." });
    else if (outcome.status === "failed") setNotice({ tone: "error", message: outcome.message });
  };

  return (
    <View style={styles.container}>
      <AppBar title="Your Agent" left={<AppBarBackButton onPress={goBack} />} />
      <Screen edgeTop={false} contentStyle={styles.content}>
        {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before editing your Agent profile.</SettingsStatus> : null}
        {state.loading ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading Agent profile" /> : null}
        {state.loadError ? <SettingsStatus tone="error">{state.loadError.message}</SettingsStatus> : null}
        {notice ? <SettingsStatus tone={notice.tone}>{notice.message}</SettingsStatus> : null}
        {profile && draft ? <>
          <View style={styles.avatarBlock}>
            {avatarSource ? <Image source={avatarSource} style={styles.avatar} contentFit="cover" accessibilityLabel="Your authenticated Agent avatar" /> : <View style={styles.avatarFallback}><Text style={styles.avatarFallbackText}>{profile.name.slice(0, 1).toUpperCase()}</Text></View>}
            {photoSelection.status === "supported" ? <Pressable style={styles.secondaryButton} onPress={() => router.push("/(drawer)/(tabs)/settings/agent-photos")} accessibilityRole="button" accessibilityLabel="Manage Agent photos" accessibilityHint="Opens your Agent photo library.">
              <Text style={styles.secondaryButtonText}>Change photo</Text>
            </Pressable> : null}
          </View>
          <Text style={styles.label}>Name</Text>
          <TextInput value={draft.name} onChangeText={(name) => setDraft({ name })} style={styles.input} editable={!state.mutating} accessibilityLabel="Agent name" autoCapitalize="words" />
          <Text style={styles.label}>Handle</Text>
          <TextInput value={draft.handle} onChangeText={(handle) => setDraft({ handle: handle.replace(/^@/, "") })} style={styles.input} editable={!state.mutating} accessibilityLabel="Agent handle" accessibilityHint="A unique handle without @." autoCapitalize="none" autoCorrect={false} />
          <View style={styles.soulHeading}><Text style={styles.label}>Soul instructions</Text><Pressable onPress={() => void generateSoul()} disabled={state.mutating} accessibilityRole="button" accessibilityLabel="Generate Soul instructions" accessibilityHint="Generates and saves instructions for your own Agent."><Text style={styles.generateText}>Generate</Text></Pressable></View>
          <Pressable onPress={() => setSoulSheetVisible(true)} style={styles.soulCard} accessibilityRole="button" accessibilityLabel="Edit Soul instructions" accessibilityHint="Opens a focused editor for your Agent's Soul instructions.">
            <Text style={styles.soulPreview} numberOfLines={4}>{draft.soulFile || "No Soul instructions yet."}</Text>
            <Text style={styles.editSoulText}>Edit instructions</Text>
          </Pressable>
          <Pressable style={({ pressed }) => [styles.saveButton, (pressed || state.mutating) && styles.pressed]} onPress={() => void save()} disabled={state.mutating} accessibilityRole="button" accessibilityLabel="Save Agent profile" accessibilityState={{ disabled: state.mutating }}>
            <Text style={styles.saveButtonText}>{state.mutating ? "Saving…" : "Save changes"}</Text>
          </Pressable>
        </> : null}
      </Screen>
      {draft ? <SoulEditorSheet visible={soulSheetVisible} value={draft.soulFile} onApply={(soulFile) => setDraft({ soulFile })} onClose={() => setSoulSheetVisible(false)} /> : null}
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.md },
    avatarBlock: { alignItems: "center", gap: t.spacing.sm, paddingVertical: t.spacing.sm }, avatar: { width: 112, height: 112, borderRadius: t.radii.pill }, avatarFallback: { width: 112, height: 112, borderRadius: t.radii.pill, justifyContent: "center", alignItems: "center", backgroundColor: t.color.brand.accent }, avatarFallbackText: { ...t.typography.heading, color: t.color.text.onPrimary },
    label: { ...t.typography.bodyStrong, color: t.color.text.foreground }, input: { minHeight: 48, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, color: t.color.text.foreground, backgroundColor: t.color.surface.panel, ...t.typography.body }, soulCard: { gap: t.spacing.sm, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, padding: t.spacing.md, backgroundColor: t.color.surface.panel }, soulPreview: { ...t.typography.body, color: t.color.text.muted }, editSoulText: { ...t.typography.bodyStrong, color: t.color.brand.accent },
    secondaryButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.md, borderRadius: t.radii.sm, borderWidth: 1, borderColor: t.color.border.default }, secondaryButtonText: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    presets: { flexDirection: "row", gap: t.spacing.sm, flexWrap: "wrap" }, preset: { width: 56, height: 56, padding: 2, alignItems: "center", justifyContent: "center", borderRadius: t.radii.sm, borderWidth: 2, borderColor: t.color.border.default, backgroundColor: t.color.surface.panel, overflow: "hidden" }, presetSelected: { borderColor: t.color.brand.accent, backgroundColor: t.color.surface.subtle }, presetImage: { width: "100%", height: "100%", borderRadius: t.radii.sm }, soulHeading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, generateText: { ...t.typography.bodyStrong, color: t.color.brand.accent }, saveButton: { minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: t.radii.sm, backgroundColor: t.color.action.primaryBg }, saveButtonText: { ...t.typography.bodyStrong, color: t.color.text.onPrimary }, pressed: { opacity: 0.7 },
  });
}
