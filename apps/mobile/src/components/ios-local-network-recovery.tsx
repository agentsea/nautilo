import * as Linking from "expo-linking";
import { useMemo } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import {
  IOS_LOCAL_NETWORK_RECOVERY_MESSAGE,
  IOS_LOCAL_NETWORK_RECOVERY_TITLE,
  shouldOfferIosLocalNetworkRecovery,
} from "@/lib/ios-local-network-recovery";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

interface IosLocalNetworkRecoveryProps {
  error: string | null;
  serverUrl: string;
}

export function IosLocalNetworkRecovery({
  error,
  serverUrl,
}: IosLocalNetworkRecoveryProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const visible = shouldOfferIosLocalNetworkRecovery({
    platform: Platform.OS,
    serverUrl,
    error,
  });

  if (!visible) return null;

  async function openSettings() {
    try {
      await Linking.openSettings();
    } catch {
      Alert.alert(
        "Couldn’t open Settings",
        "Open iOS Settings, find Nautilo, and enable Local Network, then try again.",
      );
    }
  }

  return (
    <View style={styles.container} accessibilityLiveRegion="polite">
      <Text style={styles.title}>{IOS_LOCAL_NETWORK_RECOVERY_TITLE}</Text>
      <Text style={styles.message}>{IOS_LOCAL_NETWORK_RECOVERY_MESSAGE}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => void openSettings()}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Open Settings</Text>
      </Pressable>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: {
      gap: t.spacing.sm,
      padding: t.spacing.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.sm,
      backgroundColor: t.color.surface.subtle,
    },
    title: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    message: { ...t.typography.body, color: t.color.text.muted },
    button: { alignSelf: "flex-start", paddingVertical: t.spacing.xs },
    buttonText: { ...t.typography.label, color: t.color.brand.accent },
  });
}
