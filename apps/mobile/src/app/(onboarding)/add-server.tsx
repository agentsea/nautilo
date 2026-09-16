import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { IosLocalNetworkRecovery } from "@/components/ios-local-network-recovery";
import { Screen } from "@/components/screen";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

// D369 Phase 1 + Phase 4 — add-server (screen #1, the front door).
// Phase 4 adds: optional `url` route param (from deep link / QR) to prefill,
// a "Scan QR code" entry point, and friendlier recoverable error copy that
// maps probeServer/addServer failure modes without leaking raw errors.
//
// Friendly error map covers: bad URL, unreachable host, not-a-Nautilo-server,
// and a generic fallback. Strings are matched loosely so transport-level
// wording changes don't break UX.
const FRIENDLY_ERRORS: Array<{ test: RegExp; message: string }> = [
  { test: /valid http\(s\)? url/i, message: "That doesn’t look like a server URL. Try something like https://your-server.example.com." },
  { test: /not a nautilo server/i, message: "We reached the address, but it isn’t a Nautilo server. Double-check the URL with your admin." },
  { test: /unreachable|network|fetch failed|failed to fetch|timeout/i, message: "Couldn’t reach that server. Check your connection and the URL, then try again." },
];

function friendlyError(raw: string): string {
  for (const { test, message } of FRIENDLY_ERRORS) {
    if (test.test(raw)) return message;
  }
  return "Couldn’t connect to that server. Check the URL and try again.";
}

export default function AddServerScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { addServer, servers, activeServer, switchTo, remove } = useServers();
  const params = useLocalSearchParams<{ url?: string }>();
  const [url, setUrl] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill from a deep link or QR scan. normalizeServerUrl (called inside
  // addServer) cleans trailing slashes / adds https:// — we only set state.
  useEffect(() => {
    if (typeof params.url === "string" && params.url) {
      setUrl(params.url);
    }
  }, [params.url]);

  async function onConnect() {
    setBusy(true);
    setError(null);
    const err = await addServer(url);
    setBusy(false);
    if (err) {
      setError(friendlyError(err));
      return;
    }
    router.replace("/"); // active server set by addServer → gate passes (tabs home)
  }

  async function useSavedServer(id: string) {
    await switchTo(id);
    router.replace("/(onboarding)/sign-in");
  }

  function confirmRemove(id: string, displayName: string) {
    Alert.alert(
      `Remove ${displayName}?`,
      "This removes the saved server and its sign-in from this phone. The server and its data are not deleted.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => { void remove(id); } },
      ],
    );
  }

  return (
    <Screen>
      {/* The screen has its own title below; suppress the redundant native header. */}
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={styles.title}>Connect to a Nautilo server</Text>
      <Text style={styles.sub}>
        Enter your server URL — Nautilo Cloud or your own self-hosted server.
      </Text>

      {servers.length > 0 ? (
        <View style={styles.savedSection}>
          <Text style={styles.savedTitle}>Saved servers</Text>
          {servers.map((server) => (
            <View key={server.id} style={styles.savedRow}>
              <Pressable
                style={styles.savedServer}
                onPress={() => void useSavedServer(server.id)}
                accessibilityRole="button"
                accessibilityLabel={`Use saved server ${server.displayName}`}
              >
                <View style={styles.savedCopy}>
                  <Text style={styles.savedName}>{server.displayName}</Text>
                  <Text style={styles.savedUrl} numberOfLines={1}>{server.serverUrl}</Text>
                </View>
                {server.id === activeServer?.id ? <Text style={styles.activeLabel}>Current</Text> : null}
              </Pressable>
              <Pressable
                style={styles.removeButton}
                onPress={() => confirmRemove(server.id, server.displayName)}
                accessibilityRole="button"
                accessibilityLabel={`Remove saved server ${server.displayName}`}
              >
                <Text style={styles.removeText}>Remove</Text>
              </Pressable>
            </View>
          ))}
          <Text style={styles.orLabel}>Or add another server</Text>
        </View>
      ) : null}

      <TextInput
        style={[styles.input, focused && styles.inputFocused]}
        placeholder="https://your-server.example.com"
        placeholderTextColor={t.color.text.disabled}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        inputMode="url"
        value={url}
        onChangeText={setUrl}
        editable={!busy}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={() => void onConnect()}
        returnKeyType="go"
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <IosLocalNetworkRecovery error={error} serverUrl={url} />

      <Pressable
        style={[styles.button, (busy || !url.trim()) && styles.buttonDisabled]}
        disabled={busy || !url.trim()}
        onPress={() => void onConnect()}
      >
        {busy ? <ActivityIndicator color={t.color.text.onPrimary} /> : <Text style={styles.buttonText}>Connect</Text>}
      </Pressable>

      <Pressable
        style={styles.qrButton}
        disabled={busy}
        onPress={() => router.push("/(onboarding)/scan-qr")}
      >
        <Text style={styles.qrText}>Scan QR code</Text>
      </Pressable>
    </Screen>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    title: { ...t.typography.heading, color: t.color.text.foreground },
    sub: { ...t.typography.body, color: t.color.text.muted, marginBottom: t.spacing.sm },
    savedSection: { gap: t.spacing.sm, marginBottom: t.spacing.md },
    savedTitle: { ...t.typography.subheading, color: t.color.text.foreground },
    savedRow: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, overflow: "hidden" },
    savedServer: { flex: 1, minHeight: 64, flexDirection: "row", alignItems: "center", gap: t.spacing.sm, paddingHorizontal: t.spacing.md },
    savedCopy: { flex: 1, gap: 2 },
    savedName: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    savedUrl: { ...t.typography.caption, color: t.color.text.muted },
    activeLabel: { ...t.typography.caption, color: t.color.brand.accent },
    removeButton: { minHeight: 64, justifyContent: "center", paddingHorizontal: t.spacing.md, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: t.color.border.default },
    removeText: { ...t.typography.label, color: t.color.status.error },
    orLabel: { ...t.typography.caption, color: t.color.text.dim, textTransform: "uppercase", marginTop: t.spacing.sm },
    input: {
      ...t.typography.body,
      color: t.color.text.foreground,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.sm,
      padding: t.spacing.lg,
    },
    inputFocused: { borderColor: t.color.border.interactive },
    error: { ...t.typography.label, color: t.color.status.error },
    button: {
      backgroundColor: t.color.action.primaryBg,
      borderRadius: t.radii.sm,
      padding: t.spacing.lg,
      alignItems: "center",
      marginTop: t.spacing.xs,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { ...t.typography.bodyStrong, color: t.color.text.onPrimary },
    qrButton: { padding: t.spacing.md, alignItems: "center", marginTop: t.spacing.xs },
    qrText: { ...t.typography.label, color: t.color.brand.accent },
  });
}
