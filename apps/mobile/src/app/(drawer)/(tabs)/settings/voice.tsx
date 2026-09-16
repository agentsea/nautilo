import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Ionicons } from "@expo/vector-icons";
import { router, type Href, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import { createVoiceSettingsController, type VoiceSettingsController } from "@/features/settings/voice-settings-controller";
import { VoicePreviewSession } from "@/features/settings/voice-preview-session";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import { useVoice } from "@/providers/voice";
import type { AppTheme } from "@/theme/tokens";

let previewFileSequence = 0;

/** Native detail for reply playback and this Agent's server-backed voice assignments. */
export default function VoiceSettingsScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const { enabled, toggle } = useVoice();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const activeServerRef = useRef(activeServer);
  activeServerRef.current = activeServer;
  const controllerRef = useRef<VoiceSettingsController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createVoiceSettingsController((scope) => {
      const server = activeServerRef.current;
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
  const previewRef = useRef<VoicePreviewSession | null>(null);
  if (!previewRef.current) previewRef.current = new VoicePreviewSession(nativePreviewPlatform());
  const preview = previewRef.current;
  const previewState = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot);
  const [notice, setNotice] = useState<string | null>(null);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, {
    status, viewerState, viewer: viewer && viewerState === "verified" ? viewer : null,
  }), [activeServer, status, viewer, viewerState]);

  useFocusEffect(useCallback(() => {
    controller.setScope(scope);
    preview.stop();
    if (scope) void controller.load();
    // Voice assignments can change in the picker while this route remains in
    // the stack. Clear the scope on blur so focus always reloads canonical data.
    return () => { preview.stop(); controller.setScope(null); };
  }, [controller, preview, scope]));
  useEffect(() => () => preview.dispose(), [preview]);

  const playAssigned = (voiceId: string, language: string): void => {
    void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldRouteThroughEarpiece: false });
    void preview.play(voiceId, () => controller.preview(voiceId, language));
  };
  const makePrimary = async (language: string): Promise<void> => {
    const outcome = await controller.makePrimary(language);
    if (outcome.status === "failed") setNotice(outcome.message);
  };
  const removeLanguage = async (language: string): Promise<void> => {
    const outcome = await controller.removeLanguage(language);
    if (outcome.status === "failed") setNotice(outcome.message);
  };
  const goBack = (): void => { if (router.canGoBack()) router.back(); else router.replace("/(drawer)/(tabs)/settings"); };
  const openPicker = (role: string): void => router.push({ pathname: "/(drawer)/(tabs)/settings/voice-picker", params: { role } } as Href);
  const profile = state.data;
  const languageVoices = profile ? Object.entries(profile.voices).filter(([key]) => key !== "default").sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <View style={styles.container}>
      <AppBar title="Voice & playback" left={<AppBarBackButton onPress={goBack} />} />
      <Screen edgeTop={false} contentStyle={styles.content}>
        <View style={styles.card}>
          <View style={styles.rowCopy}><Text style={styles.title}>Speak responses</Text><Text style={styles.hint}>Read eligible replies aloud on this device during this session.</Text></View>
          <Pressable onPress={toggle} style={({ pressed }) => [styles.toggle, enabled && styles.toggleOn, pressed && styles.pressed]} accessibilityRole="switch" accessibilityLabel="Speak responses" accessibilityState={{ checked: enabled }}>
            <Text style={styles.toggleText}>{enabled ? "On" : "Off"}</Text>
          </Pressable>
        </View>
        <Text style={styles.localCopy}>This setting is device- and session-local. It does not change your Agent or any server preference.</Text>
        {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before changing your Agent voice.</SettingsStatus> : null}
        {state.loading ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading voice settings" /> : null}
        {state.loadError ? <SettingsStatus tone="error">{state.loadError.message}</SettingsStatus> : null}
        {notice ? <SettingsStatus tone="error">{notice}</SettingsStatus> : null}
        {previewState.error ? <SettingsStatus tone="warning">{previewState.error}</SettingsStatus> : null}
        {profile ? <>
          <Text style={styles.sectionTitle}>Primary voice</Text>
          <View style={styles.card}>
            <View style={styles.rowCopy}><Text style={styles.title}>{profile.voices.default?.voiceName ?? "No primary voice selected"}</Text><Text style={styles.hint}>{profile.language} · used when no language-specific voice is assigned</Text></View>
            <View style={styles.primaryActions}>
              {profile.voices.default ? <Pressable onPress={() => playAssigned(profile.voices.default.voiceId, profile.language)} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Preview primary voice"><Ionicons name={previewState.voiceId === profile.voices.default.voiceId ? "stop" : "play"} size={18} color={t.color.brand.accent} /></Pressable> : null}
              <Pressable onPress={() => openPicker("default")} style={styles.changeButton} accessibilityRole="button" accessibilityLabel="Choose primary voice"><Text style={styles.changeButtonText}>Change</Text></Pressable>
            </View>
          </View>
          <Text style={styles.sectionTitle}>Language voices</Text>
          {languageVoices.length === 0 ? <Text style={styles.localCopy}>No language-specific voices assigned.</Text> : null}
          {languageVoices.map(([language, ref]) => <View key={language} style={styles.languageCard}>
            <View style={styles.languageTopRow}>
              <View style={styles.rowCopy}><Text style={styles.title}>{ref.voiceName}</Text><Text style={styles.hint}>{language}</Text></View>
              <View style={styles.primaryActions}>
                <Pressable onPress={() => playAssigned(ref.voiceId, language)} style={styles.iconButton} accessibilityRole="button" accessibilityLabel={`Preview ${language} voice`}><Ionicons name={previewState.voiceId === ref.voiceId ? "stop" : "play"} size={18} color={t.color.brand.accent} /></Pressable>
                <Pressable onPress={() => openPicker(language)} style={styles.changeButton} accessibilityRole="button" accessibilityLabel={`Change ${language} voice`}><Text style={styles.changeButtonText}>Change</Text></Pressable>
              </View>
            </View>
            <View style={styles.secondaryActions}>
              <Pressable onPress={() => void makePrimary(language)} disabled={state.mutating} style={styles.textButton} accessibilityRole="button" accessibilityLabel={`Make ${language} voice primary`}><Text style={styles.textButtonText}>Make primary</Text></Pressable>
              <Pressable onPress={() => void removeLanguage(language)} disabled={state.mutating} style={styles.textButton} accessibilityRole="button" accessibilityLabel={`Remove ${language} voice`}><Text style={styles.dangerText}>Remove</Text></Pressable>
            </View>
          </View>)}
          <Pressable onPress={() => openPicker(profile.language)} style={styles.addButton} accessibilityRole="button" accessibilityLabel="Add a language voice"><Text style={styles.addButtonText}>Add language voice</Text></Pressable>
        </> : null}
      </Screen>
    </View>
  );
}

function nativePreviewPlatform() {
  return {
    createFile: () => {
      const file = new File(Paths.cache, `voice-preview-${Date.now()}-${previewFileSequence++}.mp3`);
      file.create();
      return file;
    },
    createPlayer: (uri: string) => createAudioPlayer({ uri }),
  };
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.md },
    card: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.color.border.default, backgroundColor: t.color.surface.panel, padding: t.spacing.md },
    languageCard: { gap: t.spacing.xs, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.color.border.default, backgroundColor: t.color.surface.panel, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm },
    languageTopRow: { flexDirection: "row", alignItems: "center", gap: t.spacing.sm },
    rowCopy: { flex: 1, minWidth: 0, gap: 3 }, title: { ...t.typography.bodyStrong, color: t.color.text.foreground }, hint: { ...t.typography.caption, color: t.color.text.muted }, localCopy: { ...t.typography.caption, color: t.color.text.muted }, sectionTitle: { ...t.typography.subheading, color: t.color.text.foreground, marginTop: t.spacing.sm },
    toggle: { minWidth: 54, minHeight: 36, justifyContent: "center", alignItems: "center", borderRadius: t.radii.pill, borderWidth: 1, borderColor: t.color.border.default }, toggleOn: { borderColor: t.color.brand.accent, backgroundColor: t.color.action.primaryBg }, toggleText: { ...t.typography.caption, color: t.color.text.foreground, fontWeight: "700" },
    primaryActions: { flexDirection: "row", alignItems: "center", gap: t.spacing.xs },
    secondaryActions: { flexDirection: "row", justifyContent: "flex-end", gap: t.spacing.md },
    iconButton: { width: 40, height: 40, borderRadius: t.radii.pill, borderWidth: 1, borderColor: t.color.border.default, alignItems: "center", justifyContent: "center" },
    changeButton: { minHeight: 40, justifyContent: "center", paddingHorizontal: t.spacing.sm, borderRadius: t.radii.sm, borderWidth: 1, borderColor: t.color.border.default }, changeButtonText: { ...t.typography.caption, color: t.color.text.foreground, fontWeight: "700" },
    textButton: { minHeight: 36, justifyContent: "center", paddingHorizontal: t.spacing.xs }, textButtonText: { ...t.typography.caption, color: t.color.brand.accent, fontWeight: "700" }, dangerText: { ...t.typography.caption, color: t.color.status.error, fontWeight: "700" }, addButton: { minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: t.radii.sm, borderWidth: 1, borderColor: t.color.brand.accent }, addButtonText: { ...t.typography.bodyStrong, color: t.color.brand.accent }, pressed: { opacity: 0.7 },
  });
}
