import { Stack, router, useLocalSearchParams, type Href } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { IosLocalNetworkRecovery } from "@/components/ios-local-network-recovery";
import { Screen } from "@/components/screen";
import { currentSignInReturnPath, mobileWebRouterDestination } from "@/lib/auth-gate-navigation";
import { signedInLandingDestination } from "@/lib/session-expiry";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

// D369 Phase 2 + Phase 4 — sign-in against the active server's Logto (PKCE).
// Phase 4 only improves the error copy for cancelled / failed / refresh-dead
// outcomes (signIn() returns an error string). No flow change.
//
// Error map: cancelled (user dismissed the browser), refresh-dead (tokens
// invalidated), missing Logto config, network/transport, and a generic
// fallback. We never leak raw stack traces — friendly recoverable copy.
const FRIENDLY_ERRORS: Array<{ test: RegExp; message: string }> = [
  { test: /cancelled/i, message: "Sign-in was cancelled. Try again when you’re ready." },
  { test: /missing logto|not configured for mobile/i, message: "This server isn’t configured for mobile sign-in. Ask your admin to enable mobile auth." },
  { test: /network|fetch failed|failed to fetch|timeout|unreachable/i, message: "Couldn’t reach the sign-in service. Check your connection and try again." },
  { test: /refresh|expired|invalid token/i, message: "Your session expired. Try signing in again." },
];

function friendlyError(raw: string, serverUrl?: string): string {
  if (serverUrl && !/^https?:\/\//i.test(serverUrl)) {
    return "This saved address is incomplete. Remove it and add the server again.";
  }
  for (const { test, message } of FRIENDLY_ERRORS) {
    if (test.test(raw)) return message;
  }
  return "Sign-in failed. Please try again.";
}

export default function SignInScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { status, signIn, signInNotice } = useAuth();
  const { activeServer } = useServers();
  const { returnTo, verification } = useLocalSearchParams<{
    returnTo?: string | string[];
    verification?: string | string[];
  }>();
  const returnPath = currentSignInReturnPath(returnTo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const destination = returnPath
      ? mobileWebRouterDestination(returnPath)
      : signedInLandingDestination(status);
    if (status === "signed-in" && destination) router.replace(destination as Href);
  }, [returnPath, status]);

  async function onSignIn() {
    setBusy(true);
    setError(null);
    const err = await signIn(returnPath);
    setBusy(false);
    if (err) {
      setError(friendlyError(err, activeServer?.serverUrl));
      return;
    }
    router.replace((returnPath ? mobileWebRouterDestination(returnPath) : "/(drawer)/(tabs)") as Href);
  }

  return (
    <Screen scroll={false} contentStyle={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.content}>
        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.sub}>
          {activeServer ? `to ${activeServer.displayName}` : "to your Nautilo server"}
        </Text>

        {signInNotice || verification === "incomplete" ? (
          <Text style={styles.notice} accessibilityLiveRegion="polite">
            {signInNotice ?? "Sign-in did not finish. Nothing changed."}
          </Text>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <IosLocalNetworkRecovery
          error={error}
          serverUrl={activeServer?.serverUrl ?? ""}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          style={[styles.button, busy && styles.buttonDisabled]}
          disabled={busy}
          onPress={() => void onSignIn()}
        >
          {busy ? <ActivityIndicator color={t.color.text.onPrimary} /> : <Text style={styles.buttonText}>Continue</Text>}
        </Pressable>

        <Pressable accessibilityRole="link" onPress={() => router.replace("/(onboarding)/add-server")}>
          <Text style={styles.switchLink}>{error ? "Back to saved servers" : "Use a different server"}</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    screen: { justifyContent: "center" },
    content: { width: "100%", maxWidth: 440, alignSelf: "center", gap: t.spacing.md },
    title: { ...t.typography.title, color: t.color.text.foreground },
    sub: { ...t.typography.body, color: t.color.text.muted, marginBottom: t.spacing.md },
    error: { ...t.typography.label, color: t.color.status.error },
    notice: { ...t.typography.body, color: t.color.text.muted, marginBottom: t.spacing.md },
    button: {
      backgroundColor: t.color.action.primaryBg,
      borderRadius: t.radii.sm,
      padding: t.spacing.lg,
      alignItems: "center",
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { ...t.typography.bodyStrong, color: t.color.text.onPrimary },
    switchLink: { ...t.typography.label, color: t.color.brand.accent, textAlign: "center", marginTop: t.spacing.sm },
  });
}
