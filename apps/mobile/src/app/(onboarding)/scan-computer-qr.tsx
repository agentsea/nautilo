import { CameraView, useCameraPermissions } from "expo-camera";
import { router, Stack } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Screen } from "@/components/screen";
import {
  subscribeRemotePairingHandoff,
  takeRemotePairingHandoff,
  type RemotePairingInput,
} from "@/features/remote/computer-pairing-handoff";
import { useRemoteHosts } from "@/features/remote/remote-hosts";
import { parseDeepLink } from "@/lib/deep-link";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function ScanComputerQrScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [permission, requestPermission] = useCameraPermissions();
  const pairingRef = useRef<RemotePairingInput | null>(
    takeRemotePairingHandoff(),
  );
  const [pairingReady, setPairingReady] = useState(
    pairingRef.current !== null,
  );
  const [lastChallengeId, setLastChallengeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const { server, pairQr } = useRemoteHosts();

  const replacePairing = (next: RemotePairingInput | null): void => {
    pairingRef.current = next;
    setPairingReady(next !== null);
  };
  const cancel = (): void => {
    replacePairing(null);
    setLastChallengeId(null);
    setError(null);
    router.replace("/(drawer)/computers");
  };
  const pairingScreenOptions = {
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
  };

  useEffect(() => {
    const unsubscribe = subscribeRemotePairingHandoff(() => {
      const next = takeRemotePairingHandoff();
      if (next) replacePairing(next);
    });
    return () => {
      unsubscribe();
      pairingRef.current = null;
    };
  }, []);

  const scan = (data: string): void => {
    if (!data) return;
    const parsed = parseDeepLink(data);
    if (parsed.kind !== "remote-pair") {
      setError("That QR isn’t a Nautilo computer pairing code.");
      return;
    }
    if (parsed.challengeId === lastChallengeId) return;
    setLastChallengeId(parsed.challengeId);
    setError(null);
    replacePairing({
      challengeId: parsed.challengeId,
      secret: parsed.secret,
      ceremonyContext: parsed.ceremonyContext,
    });
  };

  const consume = async (): Promise<void> => {
    const pairing = pairingRef.current;
    if (!pairing || !server || busy) return;
    setBusy(true);
    setError(null);
    const result = await pairQr(pairing);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // Drop the one-time secret from component state immediately after use.
    replacePairing(null);
    setLastChallengeId(null);
    setComplete(true);
  };

  if (complete) {
    return (
      <Screen contentStyle={styles.center}>
        <Stack.Screen options={{ title: "Computer paired" }} />
        <Text style={styles.title}>This phone is paired</Text>
        <Text style={styles.body}>
          The paired computer will appear in Computers as soon as its
          current presence is available.
        </Text>
        <Pressable
          style={styles.primaryButton}
          onPress={() => router.replace("/(drawer)/computers")}
          accessibilityRole="button"
          accessibilityLabel="Open Computers"
        >
          <Text style={styles.primaryText}>Open Computers</Text>
        </Pressable>
      </Screen>
    );
  }

  if (pairingReady) {
    return (
      <Screen contentStyle={styles.center}>
        <Stack.Screen options={pairingScreenOptions} />
        <Text style={styles.title}>Pair this computer?</Text>
        <Text style={styles.body}>
          This one-time code will be sent only to {server?.displayName ?? "the selected server"}.
          Nautilo never switches servers from a pairing link.
        </Text>
        {!server ? (
          <Text style={styles.error}>
            Select and sign in to the server that displayed this code first.
          </Text>
        ) : null}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <Pressable
          style={[styles.primaryButton, (!server || busy) && styles.disabled]}
          disabled={!server || busy}
          onPress={() => void consume()}
          accessibilityRole="button"
          accessibilityLabel={`Pair this phone with ${server?.displayName ?? "selected server"}`}
          accessibilityState={{ disabled: !server || busy }}
        >
          {busy ? (
            <ActivityIndicator color={theme.color.text.onPrimary} />
          ) : (
            <Text style={styles.primaryText}>Pair this phone</Text>
          )}
        </Pressable>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            replacePairing(null);
            setLastChallengeId(null);
            setError(null);
          }}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Scan a different code</Text>
        </Pressable>
        <Pressable
          style={styles.secondaryButton}
          onPress={cancel}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </Screen>
    );
  }

  if (!permission) {
    return (
      <View style={styles.cameraCenter}>
        <Stack.Screen options={pairingScreenOptions} />
        <ActivityIndicator color={theme.color.text.muted} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <Screen contentStyle={styles.center}>
        <Stack.Screen options={pairingScreenOptions} />
        <Text style={styles.title}>Camera permission needed</Text>
        <Text style={styles.body}>
          Camera access is used only to read the one-time QR shown in Desktop
          → Settings → Mobile access.
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          style={styles.primaryButton}
          onPress={() => void requestPermission()}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>Grant camera access</Text>
        </Pressable>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => router.replace("/(drawer)/computers/manual")}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Enter a manual code</Text>
        </Pressable>
      </Screen>
    );
  }

  return (
    <View style={styles.cameraContainer}>
      <Stack.Screen options={pairingScreenOptions} />
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => scan(data)}
        accessibilityLabel="Computer pairing QR scanner"
      />
      <View style={styles.cameraOverlay}>
        <Text style={styles.cameraInstruction}>
          Scan the one-time QR shown in Desktop → Settings → Mobile access
        </Text>
        {error ? (
          <Text style={styles.cameraError} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <Pressable
          style={styles.cameraLink}
          onPress={() => router.replace("/(drawer)/computers/manual")}
          accessibilityRole="button"
        >
          <Text style={styles.cameraLinkText}>Enter a manual code</Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    center: { justifyContent: "center" },
    title: { ...theme.typography.heading, color: theme.color.text.foreground },
    body: { ...theme.typography.body, color: theme.color.text.muted },
    error: { ...theme.typography.label, color: theme.color.status.error },
    primaryButton: {
      backgroundColor: theme.color.action.primaryBg,
      borderRadius: theme.radii.sm,
      padding: theme.spacing.lg,
      alignItems: "center",
    },
    disabled: { opacity: 0.5 },
    primaryText: {
      ...theme.typography.bodyStrong,
      color: theme.color.text.onPrimary,
    },
    secondaryButton: { padding: theme.spacing.md, alignItems: "center" },
    secondaryText: {
      ...theme.typography.label,
      color: theme.color.brand.accent,
    },
    headerAction: {
      ...theme.typography.label,
      color: theme.color.brand.accent,
    },
    cameraContainer: { flex: 1, backgroundColor: "#000" },
    cameraCenter: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.color.surface.background,
    },
    cameraOverlay: {
      position: "absolute",
      left: theme.spacing.xl,
      right: theme.spacing.xl,
      bottom: theme.spacing.xl,
      gap: theme.spacing.md,
      alignItems: "center",
    },
    cameraInstruction: {
      ...theme.typography.bodyStrong,
      color: "#fff",
      backgroundColor: "rgba(0,0,0,0.65)",
      padding: theme.spacing.md,
      borderRadius: theme.radii.sm,
      textAlign: "center",
    },
    cameraError: {
      ...theme.typography.label,
      color: "#fff",
      backgroundColor: "rgba(160,0,0,0.8)",
      padding: theme.spacing.sm,
      borderRadius: theme.radii.sm,
    },
    cameraLink: {
      padding: theme.spacing.md,
      backgroundColor: "rgba(0,0,0,0.65)",
      borderRadius: theme.radii.sm,
    },
    cameraLinkText: { ...theme.typography.label, color: "#fff" },
  });
}
