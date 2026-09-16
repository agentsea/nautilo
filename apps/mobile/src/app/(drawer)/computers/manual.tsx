import { router, Stack } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";

import { Screen } from "@/components/screen";
import { useRemoteHosts } from "@/features/remote/remote-hosts";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function ManualComputerPairingScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { server, pairManual } = useRemoteHosts();
  const [manualCode, setManualCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const cancel = (): void => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/(drawer)/computers");
  };

  const submit = async (): Promise<void> => {
    const code = manualCode.trim();
    if (!server || !code || busy) return;
    setBusy(true);
    setError(null);
    const result = await pairManual(code);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setManualCode("");
    setComplete(true);
  };

  return (
    <Screen contentStyle={styles.content}>
      <Stack.Screen
        options={{
          title: "Pair a computer",
          headerLeft: () => (
            <Pressable
              onPress={cancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel pairing"
              hitSlop={12}
            >
              <Text style={styles.headerAction}>Cancel</Text>
            </Pressable>
          ),
        }}
      />
      <Text style={styles.title}>
        {complete ? "This phone is paired" : "Enter the pairing code"}
      </Text>
      {complete ? (
        <>
          <Text style={styles.body}>
            The computer will appear in Computers when its current
            presence is available.
          </Text>
          <Pressable
            style={styles.primaryButton}
            onPress={() => router.replace("/(drawer)/computers")}
            accessibilityRole="button"
          >
            <Text style={styles.primaryText}>Open Computers</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.body}>
            On your desktop, open Settings → Mobile access and use the
            one-time code shown there. It will be checked only against{" "}
            {server?.displayName ?? "the selected server"}.
          </Text>
          <TextInput
            value={manualCode}
            onChangeText={setManualCode}
            style={styles.input}
            placeholder="Pairing code"
            placeholderTextColor={theme.color.text.disabled}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
            accessibilityLabel="Manual code for pairing a computer"
          />
          {error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <Pressable
            style={[
              styles.primaryButton,
              (!server || !manualCode.trim() || busy) && styles.disabled,
            ]}
            disabled={!server || !manualCode.trim() || busy}
            onPress={() => void submit()}
            accessibilityRole="button"
            accessibilityState={{
              disabled: !server || !manualCode.trim() || busy,
            }}
          >
            {busy ? (
              <ActivityIndicator color={theme.color.text.onPrimary} />
            ) : (
              <Text style={styles.primaryText}>Pair this phone</Text>
            )}
          </Pressable>
          <Pressable
            style={styles.secondaryButton}
            onPress={() => router.replace("/(onboarding)/scan-computer-qr")}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>Scan a QR instead</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryButton}
            onPress={cancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel pairing"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </>
      )}
    </Screen>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    content: { justifyContent: "center" },
    title: { ...theme.typography.heading, color: theme.color.text.foreground },
    body: { ...theme.typography.body, color: theme.color.text.muted },
    input: {
      ...theme.typography.body,
      color: theme.color.text.foreground,
      borderWidth: 1,
      borderColor: theme.color.border.default,
      borderRadius: theme.radii.sm,
      padding: theme.spacing.lg,
      letterSpacing: 1.5,
    },
    error: { ...theme.typography.label, color: theme.color.status.error },
    primaryButton: {
      backgroundColor: theme.color.action.primaryBg,
      borderRadius: theme.radii.sm,
      padding: theme.spacing.lg,
      alignItems: "center",
    },
    primaryText: {
      ...theme.typography.bodyStrong,
      color: theme.color.text.onPrimary,
    },
    disabled: { opacity: 0.5 },
    secondaryButton: { padding: theme.spacing.md, alignItems: "center" },
    secondaryText: {
      ...theme.typography.label,
      color: theme.color.brand.accent,
    },
    headerAction: {
      ...theme.typography.label,
      color: theme.color.brand.accent,
    },
    cancelText: {
      ...theme.typography.label,
      color: theme.color.text.muted,
    },
  });
}
