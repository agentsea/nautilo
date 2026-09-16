import { PUBLIC_PRODUCT_LINKS } from "@nautilo/types";
import Constants from "expo-constants";
import { useMemo } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { Screen } from "@/components/screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

async function openPublicDestination(
  url: string,
  unavailableTitle: string,
  unavailableMessage: string,
): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert(unavailableTitle, unavailableMessage);
  }
}

export default function AboutSettingsScreen() {
  const { activeServer } = useServers();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const version = Constants.expoConfig?.version ?? "0.1.1";
  const build = Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode;

  return (
    <Screen edgeTop={false}>
      <View style={styles.brand}>
        <Text style={styles.name}>Nautilo</Text>
        <Text style={styles.version}>{build ? `Version ${version} (build ${build})` : `Version ${version}`}</Text>
      </View>
      <SettingsSection title="Connection">
        <View style={styles.detail}>
          <Text style={styles.detailLabel}>Connected server</Text>
          <Text style={styles.detailValue} selectable>
            {activeServer?.displayName ?? "Not connected"}
          </Text>
          {activeServer ? <Text style={styles.url} selectable>{activeServer.serverUrl}</Text> : null}
        </View>
      </SettingsSection>
      <SettingsSection title="Privacy and support">
        <Pressable
          accessibilityRole="link"
          accessibilityHint="Opens the Nautilo Privacy Policy in your browser."
          onPress={() =>
            void openPublicDestination(
              PUBLIC_PRODUCT_LINKS.privacyPolicyUrl,
              "Browser unavailable",
              "Open https://nautilo.ai/privacy in your browser.",
            )
          }
          style={styles.linkRow}
        >
          <Text style={styles.detailLabel}>Privacy Policy</Text>
          <Text style={styles.linkValue}>Open in browser</Text>
        </Pressable>
        <Pressable
          accessibilityRole="link"
          accessibilityHint="Opens your email app to contact Nautilo support."
          onPress={() =>
            void openPublicDestination(
              PUBLIC_PRODUCT_LINKS.supportContactUrl,
              "Email app unavailable",
              "Contact Nautilo support at support@kentauros.ai.",
            )
          }
          style={[styles.linkRow, styles.linkRowLast]}
        >
          <Text style={styles.detailLabel}>Contact Support</Text>
          <Text style={styles.linkValue}>support@kentauros.ai</Text>
        </Pressable>
      </SettingsSection>
    </Screen>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    brand: { gap: t.spacing.xs, paddingVertical: t.spacing.md },
    name: { ...t.typography.heading, color: t.color.text.foreground },
    version: { ...t.typography.caption, color: t.color.text.muted },
    detail: {
      gap: 2,
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.md,
      backgroundColor: t.color.surface.panel,
    },
    detailLabel: { ...t.typography.label, color: t.color.text.foreground },
    detailValue: { ...t.typography.body, color: t.color.text.foreground },
    url: { ...t.typography.caption, color: t.color.text.muted },
    linkRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: t.spacing.md,
      minHeight: 48,
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    linkRowLast: { borderBottomWidth: 0 },
    linkValue: {
      ...t.typography.caption,
      color: t.color.brand.accent,
      flexShrink: 1,
      textAlign: "right",
    },
  });
}
