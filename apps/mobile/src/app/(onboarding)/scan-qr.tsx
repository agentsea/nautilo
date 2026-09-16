// QR scanner for server links and server-qualified invite locators. Reuses
// parseDeepLink, then hands valid invites to the same custody-before-routing
// seam as cold/warm links and manual paste.
//
// Camera permission is requested via useCameraPermissions(); if denied, we
// show a recoverable "permission needed" state and a button to retry. We
// debounce safe server-link scans; invite dedupe happens in InviteIntake
// without retaining a QR's bearer-bearing payload in component state.
import { CameraView, useCameraPermissions } from "expo-camera";
import { router, Stack } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { parseDeepLink } from "@/lib/deep-link";
import { getInviteIntake } from "@/features/invite-redemption/invite-intake";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function ScanQrScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [permission, requestPermission] = useCameraPermissions();
  const [notice, setNotice] = useState<string | null>(null);
  // The only locally retained scan value is a normalized server origin, which
  // contains no invite bearer. Invite duplication is owned by InviteIntake.
  const [lastServerScan, setLastServerScan] = useState<string | null>(null);

  async function onBarcodeScanned(event: { data: string }) {
    const data = event?.data ?? "";
    if (!data) return;

    const parsed = parseDeepLink(data);
    if (parsed.kind === "add-server") {
      if (lastServerScan === parsed.url) return;
      setLastServerScan(parsed.url);
      router.replace({
        pathname: "/(onboarding)/add-server",
        params: { url: parsed.url },
      });
      return;
    }
    if (parsed.kind === "invite") {
      const result = await getInviteIntake().acceptParsed(parsed, "qr", (route) => router.replace(route));
      if (result.kind === "persistence-failed") setNotice(result.message);
      return;
    }
    setNotice(
      parsed.kind === "invalid-invite"
        ? "That invite link is incomplete. Enter the full invite link instead."
        : "That QR isn’t a Nautilo server or invite link.",
    );
  }

  // Permission states: null = still loading, granted = show camera,
  // denied = friendly recoverable prompt.
  if (!permission) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Scan QR" }} />
        <ActivityIndicator color={t.color.text.muted} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Scan QR" }} />
        <Text style={styles.title}>Camera permission needed</Text>
        <Text style={styles.sub}>
          We need camera access to scan your server’s QR code. You can grant it now or
          cancel and enter the server URL by hand.
        </Text>
        <Pressable style={styles.button} onPress={() => void requestPermission()}>
          <Text style={styles.buttonText}>Grant camera access</Text>
        </Pressable>
        <Pressable
          onPress={() => router.replace("/(onboarding)/invite")}
          style={styles.secondary}
        >
          <Text style={styles.switchLink}>Enter invite URL manually</Text>
        </Pressable>
        <Pressable
          onPress={() => router.replace("/(onboarding)/add-server")}
          style={styles.secondary}
        >
          <Text style={styles.switchLink}>Enter server URL manually</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Scan QR" }} />
      <CameraView
        style={styles.camera}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={(event) => { void onBarcodeScanned(event); }}
      />
      <View style={styles.overlay}>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <Pressable onPress={() => router.replace("/(onboarding)/invite")}>
          <Text style={styles.overlayLink}>Enter invite URL manually</Text>
        </Pressable>
        <Pressable onPress={() => router.replace("/(onboarding)/add-server")}>
          <Text style={styles.overlayLink}>Enter server URL manually</Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    // Camera viewport — #000 is structural (the live camera fills this
    // surface); per spec the camera-overlay case keeps its own colors.
    container: { flex: 1, backgroundColor: "#000" },
    camera: { flex: 1 },
    center: {
      flex: 1,
      backgroundColor: t.color.surface.background,
      padding: t.spacing.xl,
      gap: t.spacing.md,
      justifyContent: "center",
      alignItems: "center",
    },
    title: { ...t.typography.heading, color: t.color.text.foreground, textAlign: "center" },
    sub: { ...t.typography.body, color: t.color.text.muted, textAlign: "center" },
    button: {
      backgroundColor: t.color.action.primaryBg,
      borderRadius: t.radii.sm,
      padding: t.spacing.lg,
      alignItems: "center",
      marginTop: t.spacing.sm,
      alignSelf: "stretch",
    },
    buttonText: { ...t.typography.bodyStrong, color: t.color.text.onPrimary },
    secondary: { marginTop: t.spacing.sm },
    overlay: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: t.spacing.xl,
      paddingHorizontal: t.spacing.xl,
      gap: t.spacing.md,
      alignItems: "center",
    },
    // Camera-overlay text — stays white per the spec's camera-overlay exemption.
    notice: {
      color: "#fff",
      backgroundColor: "rgba(0,0,0,0.6)",
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radii.sm,
      ...t.typography.label,
    },
    overlayLink: { color: "#fff", ...t.typography.label, fontWeight: "500" },
    switchLink: { ...t.typography.label, color: t.color.brand.accent },
  });
}
