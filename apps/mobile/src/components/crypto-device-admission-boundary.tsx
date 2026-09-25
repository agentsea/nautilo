import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, TextInput } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";

type Admission = "checking" | "plaintext" | "unsupported" | "unavailable";
type AdmissionDecision = Readonly<{
  key: string;
  outcome: Admission;
}>;

/**
 * Mobile and Mobile Web do not yet own crypto-device custody. Resolve the
 * server policy immediately below AuthProvider, before realtime, artifacts,
 * push registration, or any other protected product provider can mount.
 */
export function CryptoDeviceAdmissionBoundary({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { status, viewer } = useAuth();
  const { activeServer, addServer, servers, switchTo } = useServers();
  const theme = useAppTheme();
  const [choosingServer, setChoosingServer] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [serverBusy, setServerBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const activeServerUrl = activeServer?.serverUrl ?? null;
  const admissionKey = status === "signed-in" && activeServer !== null
    ? `${activeServer.id}\0${activeServer.serverUrl}\0${viewer?.userId ?? "identity-pending"}`
    : null;
  const [decision, setDecision] = useState<AdmissionDecision | null>(null);
  const admission: Admission = admissionKey === null
    ? "plaintext"
    : decision?.key === admissionKey
      ? decision.outcome
      : "checking";

  useEffect(() => {
    let current = true;
    if (admissionKey === null || activeServerUrl === null) {
      return () => { current = false; };
    }
    const key = admissionKey;
    const client = getApiClient(activeServerUrl);
    const inspectPolicy = (): void => {
      void client.admin.encryptionTransition.getPolicy().then((policy) => {
        if (current) {
          setDecision({
            key,
            outcome: policy.requiresCryptoDevice ? "unsupported" : "plaintext",
          });
        }
      })
      .catch(() => {
        if (current) setDecision({ key, outcome: "unavailable" });
      });
    };
    setDecision({ key, outcome: "checking" });
    client.setDeviceAdmissionRequiredHandler(() => {
      if (current) setDecision({ key, outcome: "unsupported" });
    });
    inspectPolicy();
    const timer = setInterval(inspectPolicy, 5_000);
    return () => {
      current = false;
      clearInterval(timer);
      client.setDeviceAdmissionRequiredHandler(null);
    };
  }, [activeServerUrl, admissionKey]);

  if (admission === "plaintext") return <>{children}</>;

  const chooseSavedServer = async (serverId: string): Promise<void> => {
    setServerBusy(true);
    setServerError(null);
    try {
      await switchTo(serverId);
      setChoosingServer(false);
    } catch {
      setServerError("Couldn’t switch servers. Check the connection and try again.");
    } finally {
      setServerBusy(false);
    }
  };

  const connectServer = async (): Promise<void> => {
    setServerBusy(true);
    setServerError(null);
    try {
      const error = await addServer(serverUrl);
      if (error) {
        setServerError(error);
        return;
      }
      setChoosingServer(false);
    } catch {
      setServerError("Couldn’t connect to that server. Check the URL and try again.");
    } finally {
      setServerBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      accessibilityLabel="Encryption device required"
      behavior="padding"
      style={{
        flex: 1,
        alignItems: "stretch",
        justifyContent: "center",
        gap: 12,
        padding: 32,
        backgroundColor: theme.color.surface.background,
      }}
    >
      {choosingServer ? (
        <>
          <Text
            accessibilityRole="header"
            style={{ color: theme.color.text.foreground, fontSize: 20, fontWeight: "600", textAlign: "center" }}
          >
            Use a different server
          </Text>
          {servers.map((server) => (
            <Pressable
              accessibilityRole="button"
              disabled={serverBusy || server.id === activeServer?.id}
              key={server.id}
              onPress={() => void chooseSavedServer(server.id)}
              style={{
                borderColor: theme.color.border.default,
                borderRadius: 8,
                borderWidth: 1,
                opacity: server.id === activeServer?.id ? 0.5 : 1,
                padding: 12,
              }}
            >
              <Text style={{ color: theme.color.text.foreground, fontWeight: "600" }}>
                {server.displayName}
              </Text>
              <Text style={{ color: theme.color.text.muted }} numberOfLines={1}>
                {server.serverUrl}
              </Text>
            </Pressable>
          ))}
          <TextInput
            accessibilityLabel="Server URL"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!serverBusy}
            inputMode="url"
            onChangeText={setServerUrl}
            onSubmitEditing={() => void connectServer()}
            placeholder="https://your-server.example.com"
            placeholderTextColor={theme.color.text.disabled}
            returnKeyType="go"
            style={{
              borderColor: theme.color.border.default,
              borderRadius: 8,
              borderWidth: 1,
              color: theme.color.text.foreground,
              padding: 12,
            }}
            value={serverUrl}
          />
          {serverError ? (
            <Text accessibilityLiveRegion="polite" style={{ color: theme.color.status.error, textAlign: "center" }}>
              {serverError}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={serverBusy || serverUrl.trim().length === 0}
            onPress={() => void connectServer()}
            style={{
              alignItems: "center",
              backgroundColor: theme.color.action.primaryBg,
              borderRadius: 8,
              opacity: serverBusy || serverUrl.trim().length === 0 ? 0.5 : 1,
              padding: 12,
            }}
          >
            {serverBusy
              ? <ActivityIndicator color={theme.color.text.onPrimary} />
              : <Text style={{ color: theme.color.text.onPrimary, fontWeight: "600" }}>Connect</Text>}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={serverBusy}
            onPress={() => setChoosingServer(false)}
            style={{ alignItems: "center", padding: 8 }}
          >
            <Text style={{ color: theme.color.brand.accent }}>Cancel</Text>
          </Pressable>
        </>
      ) : (
        <>
      {admission === "checking" ? (
        <ActivityIndicator size="large" color={theme.color.brand.accent} />
      ) : null}
      <Text
        accessibilityRole="header"
        style={{ color: theme.color.text.foreground, fontSize: 20, fontWeight: "600" }}
      >
        {admission === "unsupported"
          ? "Encryption is not available in this app yet"
          : admission === "unavailable"
            ? "Encryption status is unavailable"
            : "Checking encryption…"}
      </Text>
      {admission !== "checking" ? (
        <Text style={{ color: theme.color.text.muted, textAlign: "center" }}>
          {admission === "unsupported"
            ? `${Platform.OS === "web" ? "Mobile Web" : "Mobile"} cannot connect an encryption device yet. Use Browser or Desktop for this server.`
            : "Nautilo could not safely determine whether this device may enter. Check the connection and try again."}
        </Text>
          ) : null}
          {admission !== "checking" ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setServerError(null);
                setChoosingServer(true);
              }}
              style={{ alignItems: "center", padding: 12 }}
            >
              <Text style={{ color: theme.color.brand.accent, fontWeight: "600" }}>
                Use a different server
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
    </KeyboardAvoidingView>
  );
}
