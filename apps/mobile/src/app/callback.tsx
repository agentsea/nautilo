// OAuth owns the code exchange. This route owns only safe native-ceremony
// recovery after a hosted invite signup returns through `nautilo://callback`.
import { router, Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { inviteCallbackFallback, inviteCallbackRecovery } from "@/features/invite-redemption/invite-callback-recovery";
import { loadInviteCallbackLocator, peekInviteHandoffStage } from "@/features/invite-redemption/invite-handoff";
import { getInviteIntake } from "@/features/invite-redemption/invite-intake";
import { useAuth } from "@/providers/auth";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

const CALLBACK_POLL_MS = 125;
const CALLBACK_WAIT_LIMIT = 80;

export default function CallbackRoute() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { status } = useAuth();
  const [callbackKind, setCallbackKind] = useState<"resolving" | "ordinary" | "invite">("resolving");
  const [inviteUnavailable, setInviteUnavailable] = useState(false);

  const continueInvite = () => {
    void (async () => {
      const activeRoute = getInviteIntake().activeRoute();
      const locator = activeRoute ? null : await loadInviteCallbackLocator().catch(() => null);
      const route = activeRoute ?? (locator ? {
        pathname: "/(onboarding)/invite" as const,
        params: locator,
      } : null);
      const fallback = inviteCallbackFallback(route);
      router.replace(fallback.kind === "resume" ? fallback.route : "/(onboarding)/add-server");
    })();
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const recover = async () => {
      const activeRoute = getInviteIntake().activeRoute();
      const locator = activeRoute ? null : await loadInviteCallbackLocator().catch(() => null);
      const route = activeRoute ?? (locator ? {
        pathname: "/(onboarding)/invite" as const,
        params: locator,
      } : null);
      if (!route) {
        setCallbackKind("ordinary");
        // Ordinary native sign-in uses this same transport route. It is not an
        // invite ceremony and must never fall through to invite recovery UI.
        // Give expo-auth-session time to exchange the callback; AuthProvider
        // will then move the signed-in session to the app. If the exchange
        // never settles, return to a truthful retry surface instead of
        // presenting a bogus "Continue sign-up" action.
        attempts += 1;
        if (attempts >= CALLBACK_WAIT_LIMIT) {
          router.replace({
            pathname: "/(onboarding)/sign-in",
            params: { verification: "incomplete" },
          });
          return;
        }
        timer = setTimeout(() => { void recover(); }, CALLBACK_POLL_MS);
        return;
      }
      setCallbackKind("invite");
      const stage = await peekInviteHandoffStage({
        serverId: route.params.serverId,
        serverUrl: route.params.serverUrl,
      }).catch(() => null);
      if (cancelled) return;
      const decision = inviteCallbackRecovery(route, stage);
      if (decision.kind === "restore") {
        router.replace(decision.route);
        return;
      }
      attempts += 1;
      if (decision.kind === "unavailable" || attempts >= CALLBACK_WAIT_LIMIT) {
        setInviteUnavailable(true);
        return;
      }
      timer = setTimeout(() => { void recover(); }, CALLBACK_POLL_MS);
    };
    void recover();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (status === "signed-in" && callbackKind === "ordinary") {
      router.replace("/(drawer)/(tabs)");
    }
  }, [callbackKind, status]);

  return (
    <View
      style={styles.root}
      accessibilityLabel={callbackKind === "invite" ? "Completing secure sign-up" : "Completing sign-in"}
    >
      <Stack.Screen options={{ headerShown: false, animation: "none" }} />
      {inviteUnavailable ? (
        <>
          <Text style={styles.message}>Sign-up is taking longer than expected.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Continue invite sign-up" onPress={continueInvite} style={styles.button}>
            <Text style={styles.buttonText}>Continue sign-up</Text>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator size="large" />
          <Text style={styles.message}>
            {callbackKind === "invite" ? "Completing secure sign-up…" : "Completing sign-in…"}
          </Text>
        </>
      )}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24, backgroundColor: theme.color.surface.background },
    message: { maxWidth: 300, textAlign: "center", fontSize: 17, color: theme.color.text.foreground },
    button: { borderWidth: 1, borderColor: theme.color.brand.accent, borderRadius: 8, paddingHorizontal: 18, paddingVertical: 12 },
    buttonText: { fontSize: 16, fontWeight: "600", color: theme.color.brand.accent },
  });
}
