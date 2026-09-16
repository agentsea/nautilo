import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Screen } from "@/components/screen";
import { currentServingOrigin, fullWorkbenchUrl, independentMobileWebUrl } from "@/lib/browser-entry.web";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function AddCurrentOriginServerScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { addServer } = useServers();
  const params = useLocalSearchParams<{ external?: string }>();
  const external = params.external === "1";
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"connecting" | "failed">("connecting");
  const [externalUrl, setExternalUrl] = useState("");
  const [externalError, setExternalError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    if (external) return () => { current = false; };
    const origin = currentServingOrigin(typeof location === "undefined" ? null : location);
    if (!origin) {
      setState("failed");
      return () => { current = false; };
    }
    setState("connecting");
    void addServer(origin).then((error) => {
      if (!current) return;
      if (error) {
        setState("failed");
        return;
      }
      router.replace("/");
    });
    return () => { current = false; };
  }, [addServer, attempt, external]);

  const openFullWorkbench = useCallback(() => {
    const origin = currentServingOrigin(typeof location === "undefined" ? null : location);
    if (origin) location.assign(fullWorkbenchUrl(origin));
  }, []);

  const openIndependentServer = useCallback(() => {
    const target = independentMobileWebUrl(externalUrl);
    if (!target) {
      setExternalError("Enter a secure Nautilo server URL.");
      return;
    }
    location.assign(target);
  }, [externalUrl]);

  return (
    <Screen contentStyle={styles.content}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.panel}>
        {external ? (
          <>
            <Text style={styles.title}>Open another Nautilo server</Text>
            <Text style={styles.body}>
              This opens that server’s independent Mobile Web sign-in. Accounts, credentials, and server lists are not shared.
            </Text>
            <TextInput
              accessibilityLabel="Another Nautilo server URL"
              autoCapitalize="none"
              autoCorrect={false}
              inputMode="url"
              keyboardType="url"
              placeholder="https://another-server.example.com"
              placeholderTextColor={t.color.text.disabled}
              style={styles.input}
              value={externalUrl}
              onChangeText={(value) => { setExternalUrl(value); setExternalError(null); }}
              onSubmitEditing={openIndependentServer}
            />
            {externalError ? <Text style={styles.error}>{externalError}</Text> : null}
            <Pressable accessibilityRole="link" style={styles.primary} onPress={openIndependentServer}>
              <Text style={styles.primaryText}>Open Mobile Web</Text>
            </Pressable>
          </>
        ) : state === "connecting" ? (
          <>
            <ActivityIndicator size="large" color={t.color.brand.accent} />
            <Text style={styles.title}>Connecting to this Nautilo server…</Text>
            <Text style={styles.body}>Mobile Web uses the same server that delivered this page.</Text>
          </>
        ) : (
          <>
            <Text style={styles.title}>Mobile Web is not available here yet</Text>
            <Text style={styles.body}>
              This origin did not answer as a Mobile Web-enabled Nautilo server. You can retry or continue in Full Workbench.
            </Text>
            <Pressable accessibilityRole="button" style={styles.primary} onPress={() => setAttempt((value) => value + 1)}>
              <Text style={styles.primaryText}>Retry</Text>
            </Pressable>
            <Pressable
              accessibilityRole="link"
              style={styles.secondary}
              onPress={() => router.replace({ pathname: "/(onboarding)/add-server", params: { external: "1" } })}
            >
              <Text style={styles.secondaryText}>Open another server</Text>
            </Pressable>
          </>
        )}
        <Pressable accessibilityRole="link" style={styles.secondary} onPress={openFullWorkbench}>
          <Text style={styles.secondaryText}>Open Full Workbench</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    content: { flexGrow: 1, justifyContent: "center" },
    panel: {
      width: "100%",
      maxWidth: 520,
      alignSelf: "center",
      gap: t.spacing.lg,
      padding: t.spacing.xl,
      borderRadius: t.radii.lg,
      backgroundColor: t.color.surface.panel,
    },
    title: { ...t.typography.heading, color: t.color.text.foreground, textAlign: "center" },
    body: { ...t.typography.body, color: t.color.text.muted, textAlign: "center" },
    input: { ...t.typography.body, color: t.color.text.foreground, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, borderRadius: t.radii.sm, padding: t.spacing.lg },
    error: { ...t.typography.label, color: t.color.status.error },
    primary: { alignItems: "center", padding: t.spacing.lg, borderRadius: t.radii.sm, backgroundColor: t.color.action.primaryBg },
    primaryText: { ...t.typography.bodyStrong, color: t.color.text.onPrimary },
    secondary: { alignItems: "center", padding: t.spacing.md },
    secondaryText: { ...t.typography.bodyStrong, color: t.color.brand.accent },
  });
}
