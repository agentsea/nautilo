import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { rootTitle } from "@/features/remote/computer-files";
import { useRemoteHosts } from "@/features/remote/remote-hosts";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { RemoteHostFileRootKind } from "@nautilo/api-client/browser";

export default function ComputerDetailScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const params = useLocalSearchParams<{ remoteHostId?: string | string[] }>();
  const remoteHostId = firstParam(params.remoteHostId);
  const { hosts, loading } = useRemoteHosts();
  const host = hosts.find((candidate) => candidate.remoteHostId === remoteHostId);

  const openRoot = (rootKind: RemoteHostFileRootKind): void => {
    if (!remoteHostId || !host || host.readiness !== "compatible_online") return;
    router.push({
      pathname: "/files/computer/[remoteHostId]/[rootKind]",
      params: { remoteHostId, rootKind },
    });
  };

  const chooseCurrentFolder = (): void => {
    if (!remoteHostId || !host || host.readiness !== "compatible_online") return;
    router.push({
      pathname: "/files/computer/[remoteHostId]/[rootKind]",
      params: { remoteHostId, rootKind: "paired_filesystem", mode: "choose" },
    });
  };

  return (
    <View style={styles.container}>
      <AppBar
        title={host?.label ?? "Computer"}
        left={<AppBarBackButton onPress={() => router.back()} />}
      />
      {loading && !host ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator color={theme.color.brand.accent} accessibilityLabel="Loading paired computer" />
          <Text style={styles.stateDetail}>Checking this phone’s paired computers…</Text>
        </View>
      ) : !host ? (
        <View style={styles.stateWrap} accessibilityRole="alert">
          <Ionicons name="laptop-outline" size={34} color={theme.color.text.muted} />
          <Text style={styles.stateTitle}>Computer is no longer paired</Text>
          <Text style={styles.stateDetail}>Return to Computers and pair it again if you need access.</Text>
          <Pressable style={styles.actionButton} onPress={() => router.replace("/(drawer)/computers")}
            accessibilityRole="button" accessibilityLabel="Return to Computers">
            <Text style={styles.actionText}>Back to Computers</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.intro}>
            <Ionicons name="laptop-outline" size={24} color={theme.color.brand.accent} />
            <View style={styles.introCopy}>
              <Text style={styles.introTitle}>{host.label ?? "Paired computer"}</Text>
              <Text style={styles.introDetail}>
                Choose which files to browse on this Mac. Paths stay relative to the chosen source.
              </Text>
            </View>
          </View>
          {host.readiness !== "compatible_online" ? (
            <View style={styles.warningCard} accessibilityRole="alert">
              <Text style={styles.warningTitle}>Computer is not available</Text>
              <Text style={styles.warningDetail}>Reconnect the Nautilo desktop before browsing its files.</Text>
            </View>
          ) : null}
          <Text style={styles.sectionTitle}>Computer files</Text>
          <RootCard
            icon="sparkles-outline"
            title={rootTitle("workspace")}
            detail="Nautilo’s always-available workspace on this Mac."
            enabled={host.readiness === "compatible_online"}
            onPress={() => openRoot("workspace")}
            theme={theme}
            styles={styles}
          />
          <RootCard
            icon="folder-outline"
            title={rootTitle("current_folder")}
            detail="The folder the person selected on this Mac. It may not be set yet."
            enabled={host.readiness === "compatible_online"}
            onPress={() => openRoot("current_folder")}
            theme={theme}
            styles={styles}
          />
          <Pressable
            style={[styles.changeFolderButton, host.readiness !== "compatible_online" && styles.disabled]}
            disabled={host.readiness !== "compatible_online"}
            onPress={chooseCurrentFolder}
            accessibilityRole="button"
            accessibilityLabel={`Change Current Folder on ${host.label ?? "this computer"}`}
          >
            <Ionicons name="folder-open-outline" size={20} color={theme.color.brand.accent} />
            <View style={styles.rootCopy}>
              <Text style={styles.rootTitle}>Change Current Folder</Text>
              <Text style={styles.rootDetail}>Browse this Mac and choose the folder to use.</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={theme.color.text.muted} />
          </Pressable>
          <Text style={styles.note}>
            Browsing does not change anything. A folder changes only after you confirm it for this computer.
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

function RootCard({
  icon,
  title,
  detail,
  enabled,
  onPress,
  theme,
  styles,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail: string;
  enabled: boolean;
  onPress: () => void;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable
      style={[styles.rootCard, !enabled && styles.disabled]}
      disabled={!enabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Browse ${title}`}
      accessibilityHint={detail}
      accessibilityState={{ disabled: !enabled }}
    >
      <View style={styles.rootIcon}><Ionicons name={icon} size={22} color={theme.color.brand.accent} /></View>
      <View style={styles.rootCopy}>
        <Text style={styles.rootTitle}>{title}</Text>
        <Text style={styles.rootDetail}>{detail}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={theme.color.text.muted} />
    </Pressable>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface.background },
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxl, gap: theme.spacing.md },
    intro: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing.md, paddingBottom: theme.spacing.sm },
    introCopy: { flex: 1, gap: theme.spacing.xs },
    introTitle: { color: theme.color.text.foreground, ...theme.typography.subheading },
    introDetail: { color: theme.color.text.muted, ...theme.typography.body },
    sectionTitle: { color: theme.color.text.foreground, ...theme.typography.subheading, marginTop: theme.spacing.sm },
    rootCard: { minHeight: 88, flexDirection: "row", alignItems: "center", gap: theme.spacing.md, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.color.border.default, borderRadius: theme.radii.md, backgroundColor: theme.color.surface.element },
    changeFolderButton: { minHeight: 88, flexDirection: "row", alignItems: "center", gap: theme.spacing.md, padding: theme.spacing.md, borderWidth: 1, borderColor: theme.color.brand.accent, borderRadius: theme.radii.md, backgroundColor: theme.color.surface.element },
    rootIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: theme.color.surface.subtle },
    rootCopy: { flex: 1, gap: theme.spacing.xs },
    rootTitle: { color: theme.color.text.foreground, ...theme.typography.bodyStrong },
    rootDetail: { color: theme.color.text.muted, ...theme.typography.caption },
    warningCard: { borderWidth: 1, borderColor: theme.color.status.warning, borderRadius: theme.radii.sm, padding: theme.spacing.md, gap: theme.spacing.xs },
    warningTitle: { color: theme.color.status.warning, ...theme.typography.label },
    warningDetail: { color: theme.color.text.muted, ...theme.typography.caption },
    note: { color: theme.color.text.dim, ...theme.typography.caption, marginTop: theme.spacing.sm },
    disabled: { opacity: 0.5 },
    stateWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing.sm, padding: theme.spacing.xl },
    stateTitle: { color: theme.color.text.foreground, ...theme.typography.subheading, textAlign: "center" },
    stateDetail: { color: theme.color.text.muted, ...theme.typography.body, textAlign: "center" },
    actionButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: theme.spacing.lg, borderRadius: theme.radii.sm, borderWidth: 1, borderColor: theme.color.border.default },
    actionText: { color: theme.color.brand.accent, ...theme.typography.label },
  });
}
