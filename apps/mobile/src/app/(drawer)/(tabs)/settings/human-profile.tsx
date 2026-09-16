import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import { prepareAgentAvatarUpload, type PickedAgentImage } from "@/features/settings/agent-avatar-source";
import { ChangeAgentPhotoSheet } from "@/features/settings/change-agent-photo-sheet";
import { sameSettingsDataScope, settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { ensureValidToken } from "@/lib/auth";
import { createAvatarUploadFile } from "@/lib/avatar-upload-file";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import { usePlatformCapability } from "@/providers/platform-capabilities";
import type { AppTheme } from "@/theme/tokens";

/** Mobile counterpart of desktop Settings → Your identity. */
export default function HumanProfileScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState, refreshViewer } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const photoSelection = usePlatformCapability("photoSelection");
  const [token, setToken] = useState<string | null>(null);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, {
    status, viewerState, viewer: viewer && viewerState === "verified" ? viewer : null,
  }), [activeServer, status, viewer, viewerState]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    setSaving(false);
    setNotice(null);
    setPickerOpen(false);
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    if (!activeServer || status !== "signed-in") { setToken(null); return; }
    void ensureValidToken(activeServer.id, activeServer.serverUrl).then((value) => { if (!cancelled) setToken(value); });
    return () => { cancelled = true; };
  }, [activeServer, status]);

  const goBack = (): void => { if (router.canGoBack()) router.back(); else router.replace("/(drawer)/(tabs)/settings"); };
  const upload = async (asset: PickedAgentImage): Promise<void> => {
    const operationScope = scope;
    const operationServer = activeServer;
    if (!operationScope || !operationServer || !viewer) return;
    const file = createAvatarUploadFile(asset.uri);
    if (!file) return;
    const prepared = prepareAgentAvatarUpload(asset, file);
    if (!prepared.ok) { setNotice({ tone: "error", message: prepared.message }); return; }
    setSaving(true);
    setNotice(null);
    try {
      await getApiClient(operationServer.serverUrl).uploadHumanAvatar(prepared.file);
      if (!sameSettingsDataScope(scopeRef.current, operationScope)) return;
      await refreshViewer();
      if (!sameSettingsDataScope(scopeRef.current, operationScope)) return;
      setAvatarVersion(Date.now());
      setNotice({ tone: "success", message: "Your portrait was updated on this server." });
    } catch (error) {
      if (sameSettingsDataScope(scopeRef.current, operationScope)) setNotice({ tone: "error", message: error instanceof Error && error.message ? error.message : "Could not update your portrait." });
    } finally {
      if (sameSettingsDataScope(scopeRef.current, operationScope)) setSaving(false);
    }
  };
  const avatarSource = activeServer && viewer && token ? {
    uri: `${activeServer.serverUrl.replace(/\/+$/, "")}/api/users/${encodeURIComponent(viewer.userId)}/avatar?v=${avatarVersion}`,
    headers: { Authorization: `Bearer ${token}` },
  } : null;

  return <View style={styles.container}>
    <AppBar title="Your profile" left={<AppBarBackButton onPress={goBack} />} />
    <Screen edgeTop={false} contentStyle={styles.content}>
      {viewerState !== "verified" ? <SettingsStatus tone="warning">Reconnect before changing your Human portrait.</SettingsStatus> : null}
      {notice ? <SettingsStatus tone={notice.tone}>{notice.message}</SettingsStatus> : null}
      {viewer ? <>
        <View style={styles.avatarBlock}>
          {avatarSource ? <Image source={avatarSource} style={styles.avatar} contentFit="cover" accessibilityLabel="Your Human portrait" /> : <View style={styles.avatarFallback}><Text style={styles.avatarFallbackText}>{(viewer.displayName ?? viewer.handle ?? "Y").slice(0, 1).toUpperCase()}</Text></View>}
          {photoSelection.status === "supported" ? <Pressable onPress={() => setPickerOpen(true)} disabled={saving || !scope} style={styles.changeButton} accessibilityRole="button" accessibilityLabel="Change your Human portrait"><Text style={styles.changeButtonText}>{saving ? "Uploading…" : "Change portrait"}</Text></Pressable> : null}
          {saving ? <ActivityIndicator color={t.color.brand.accent} /> : null}
        </View>
        <Text style={styles.label}>Display name</Text>
        <TextInput value={viewer.displayName ?? ""} editable={false} style={[styles.input, styles.readOnly]} accessibilityLabel="Human display name" />
        <Text style={styles.help}>Your Human name on this server. Read-only here.</Text>
        <Text style={styles.label}>Handle</Text>
        <TextInput value={viewer.handle ? `@${viewer.handle}` : ""} editable={false} style={[styles.input, styles.readOnly]} accessibilityLabel="Human handle" autoCapitalize="none" />
        <Text style={styles.help}>Your Human handle on this server. Read-only here.</Text>
        <Text style={styles.explainer}>This portrait appears next to your messages in shared conversations. It does not change your Agent's photo.</Text>
      </> : null}
    </Screen>
    {photoSelection.status === "supported" ? <ChangeAgentPhotoSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} onPick={(asset) => void upload(asset)} subject="Human" /> : null}
  </View>;
}

function createStyles(t: AppTheme) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.sm },
  avatarBlock: { alignItems: "center", gap: t.spacing.sm, paddingVertical: t.spacing.md }, avatar: { width: 112, height: 112, borderRadius: t.radii.pill }, avatarFallback: { width: 112, height: 112, borderRadius: t.radii.pill, alignItems: "center", justifyContent: "center", backgroundColor: t.color.surface.subtle }, avatarFallbackText: { ...t.typography.heading, color: t.color.text.foreground },
  changeButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.md, borderRadius: t.radii.sm, borderWidth: 1, borderColor: t.color.border.default }, changeButtonText: { ...t.typography.bodyStrong, color: t.color.text.foreground },
  label: { ...t.typography.bodyStrong, color: t.color.text.foreground, marginTop: t.spacing.sm }, input: { minHeight: 48, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md, color: t.color.text.foreground, ...t.typography.body }, readOnly: { backgroundColor: t.color.surface.subtle, color: t.color.text.muted }, help: { ...t.typography.caption, color: t.color.text.muted }, explainer: { ...t.typography.caption, color: t.color.text.muted, marginTop: t.spacing.md },
}); }
