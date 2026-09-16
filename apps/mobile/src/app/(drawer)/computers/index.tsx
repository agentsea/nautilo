import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import type { RemoteHost } from "@nautilo/api-client/browser";

import { AppBar, useOpenAppDrawer } from "@/components/app-bar";
import { useRemoteHosts } from "@/features/remote/remote-hosts";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function ComputersScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const openDrawer = useOpenAppDrawer();
  const { server, hosts, phoneLabel, loading, error, activeHostId, setActiveHost, refresh, renamePhone, revoke } =
    useRemoteHosts();
  const [editingPhone, setEditingPhone] = useState(false);
  const [label, setLabel] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [busyHostId, setBusyHostId] = useState<string | null>(null);

  const beginRenamePhone = (): void => {
    setMutationError(null);
    setEditingPhone(true);
    setLabel(phoneLabel);
  };

  const saveRename = async (): Promise<void> => {
    const nextLabel = label.trim();
    if (!editingPhone || !nextLabel || busyHostId) return;
    setBusyHostId("phone");
    const result = await renamePhone(nextLabel);
    setBusyHostId(null);
    if (!result.ok) {
      setMutationError(result.message);
      return;
    }
    setEditingPhone(false);
  };

  const confirmRevoke = (host: RemoteHost): void => {
    Alert.alert(
      "Revoke this computer?",
      `${host.label ?? "This computer"} will disappear from this phone’s Computers list. Pair again to restore access.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke",
          style: "destructive",
          onPress: () => {
            setBusyHostId(host.remoteHostId);
            setMutationError(null);
            void revoke(host.remoteHostId).then((result) => {
              setBusyHostId(null);
              if (!result.ok) setMutationError(result.message);
            });
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <AppBar title="Computers" onMenuPress={openDrawer} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void refresh()}
            tintColor={theme.color.brand.accent}
          />
        }
      >
        <View style={styles.serverSummary}>
          <Ionicons
            name="server-outline"
            size={18}
            color={theme.color.text.muted}
          />
          <View style={styles.grow}>
            <Text style={styles.serverName}>
              {server?.displayName ?? "No server selected"}
            </Text>
            <Text style={styles.serverNotice}>
              Use paired computers from ordinary chats on this server. Nautilo
              never switches servers from a QR or manual code.
            </Text>
          </View>
        </View>

        <View style={styles.pairRow}>
          <Pressable
            style={styles.primaryButton}
            onPress={() => router.push("/(onboarding)/scan-computer-qr")}
            accessibilityRole="button"
            accessibilityLabel="Pair a computer by scanning its QR code"
          >
            <Ionicons
              name="qr-code-outline"
              size={20}
              color={theme.color.text.onPrimary}
            />
            <Text style={styles.primaryText}>Pair a computer</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryButton}
            onPress={() => router.push("/(drawer)/computers/manual")}
            accessibilityRole="button"
            accessibilityLabel="Pair a computer with a manual code"
          >
            <Text style={styles.secondaryText}>Enter code</Text>
          </Pressable>
        </View>

        {error ? (
          <View style={styles.errorCard} accessibilityRole="alert">
            <Text style={styles.errorText}>{error}</Text>
            <Pressable
              onPress={() => void refresh()}
              accessibilityRole="button"
            >
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : null}
        {mutationError ? (
          <Text
            style={styles.errorText}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {mutationError}
          </Text>
        ) : null}

        <View style={styles.phoneCard}>
          <View style={styles.phoneIdentity}>
            <Ionicons
              name="phone-portrait-outline"
              size={22}
              color={theme.color.text.muted}
            />
            <View style={styles.grow}>
              <Text style={styles.phoneEyebrow}>This phone</Text>
              <Text style={styles.phoneLabel}>{phoneLabel}</Text>
            </View>
          </View>
          <Pressable
            style={styles.compactAction}
            disabled={hosts.length === 0 || busyHostId === "phone"}
            onPress={beginRenamePhone}
            accessibilityRole="button"
            accessibilityLabel={`Rename this phone, currently ${phoneLabel}`}
          >
            {busyHostId === "phone" ? (
              <ActivityIndicator size="small" color={theme.color.brand.accent} />
            ) : (
              <Text style={styles.secondaryText}>Rename</Text>
            )}
          </Pressable>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Paired with this phone</Text>
          {loading && hosts.length > 0 ? (
            <ActivityIndicator
              size="small"
              color={theme.color.brand.accent}
            />
          ) : null}
        </View>

        {!loading && hosts.length === 0 && !error ? (
          <View style={styles.emptyCard}>
            <Ionicons
              name="laptop-outline"
              size={28}
              color={theme.color.text.muted}
            />
            <Text style={styles.emptyTitle}>No paired computers</Text>
            <Text style={styles.emptyBody}>
              On your desktop, open Settings → Mobile access, then scan its
              one-time QR code or enter its manual code here.
            </Text>
          </View>
        ) : null}

        {hosts.map((host) => {
          const presentation = readinessPresentation(host);
          const busy = busyHostId === host.remoteHostId;
          return (
            <View
              key={host.remoteHostId}
              style={styles.hostCard}
            >
              <View style={styles.hostTop}>
                <View style={styles.grow}>
                  <Text style={styles.hostLabel}>
                    {host.label ?? "Unnamed host"}
                  </Text>
                  {host.remoteHostId === activeHostId ? (
                    <Text style={styles.activeHostLabel}>Active in Files</Text>
                  ) : null}
                  <View style={styles.statusRow}>
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: presentation.color(theme) },
                      ]}
                    />
                    <Text
                      style={[
                        styles.statusTitle,
                        { color: presentation.color(theme) },
                      ]}
                    >
                      {presentation.title}
                    </Text>
                  </View>
                </View>
                {busy ? (
                  <ActivityIndicator color={theme.color.brand.accent} />
                ) : null}
              </View>
              <Text style={styles.hostDetail}>{presentation.detail}</Text>
              {host.lastSeenAt ? (
                <Text style={styles.lastSeen}>
                  Last seen {formatLastSeen(host.lastSeenAt)}
                </Text>
              ) : null}
              <View style={styles.hostActions}>
                <Pressable
                  style={[styles.actionButton, (busy || host.readiness !== "compatible_online") && styles.disabled]}
                  disabled={busy || host.readiness !== "compatible_online"}
                  onPress={() => void setActiveHost(host.remoteHostId).then(() => router.push({
                    pathname: "/(drawer)/computers/[remoteHostId]",
                    params: { remoteHostId: host.remoteHostId },
                  }))}
                  accessibilityRole="button"
                  accessibilityLabel={`Browse files on ${host.label ?? "this computer"}`}
                  accessibilityHint={host.readiness === "compatible_online" ? "Choose its Workspace or Current Folder" : presentation.detail}
                >
                  <Ionicons
                    name="folder-open-outline"
                    size={17}
                    color={theme.color.brand.accent}
                  />
                  <Text style={styles.secondaryText}>Browse files</Text>
                </Pressable>
                <Pressable
                  style={styles.actionButton}
                  disabled={busy}
                  onPress={() => confirmRevoke(host)}
                  accessibilityRole="button"
                  accessibilityLabel={`Revoke ${host.label ?? "host"}`}
                >
                  <Ionicons
                    name="trash-outline"
                    size={17}
                    color={theme.color.status.error}
                  />
                  <Text style={styles.revokeText}>Revoke</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
      </ScrollView>

      <Modal
        visible={editingPhone}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingPhone(false)}
      >
        <KeyboardAvoidingView behavior="padding" style={styles.modalScrim}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename this phone</Text>
            <TextInput
              style={styles.input}
              value={label}
              onChangeText={setLabel}
              autoFocus
              maxLength={200}
              editable={!busyHostId}
              returnKeyType="done"
              onSubmitEditing={() => void saveRename()}
              accessibilityLabel="Phone name"
            />
            {mutationError ? (
              <Text style={styles.errorText} accessibilityRole="alert">
                {mutationError}
              </Text>
            ) : null}
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalAction}
                onPress={() => setEditingPhone(false)}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.primaryButton,
                  (!label.trim() || !!busyHostId) && styles.disabled,
                ]}
                disabled={!label.trim() || !!busyHostId}
                onPress={() => void saveRename()}
                accessibilityRole="button"
              >
                <Text style={styles.primaryText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function readinessPresentation(host: RemoteHost): {
  title: string;
  detail: string;
  color(theme: AppTheme): string;
} {
  switch (host.readiness) {
    case "compatible_online":
      return {
        title: "Online",
        detail: "This computer can provide its available local tools.",
        color: (theme) => theme.color.status.success,
      };
    case "incompatible_online":
      return {
        title: "Update required",
        detail: "This computer is online but its desktop connection is incompatible.",
        color: (theme) => theme.color.status.warning,
      };
    case "stale":
      return {
        title: "Connection stale",
        detail: "The desktop stopped responding recently.",
        color: (theme) => theme.color.status.warning,
      };
    case "identity_conflict":
      return {
        title: "Pair again",
        detail: "The host identity is ambiguous. Revoke it and pair again.",
        color: (theme) => theme.color.status.error,
      };
    case "unknown":
      return {
        title: "Unavailable",
        detail: "The server cannot verify this host’s current capabilities.",
        color: (theme) => theme.color.status.warning,
      };
    case "offline":
      return {
        title: "Offline",
        detail: "The desktop is not currently connected.",
        color: (theme) => theme.color.text.muted,
      };
  }
}

function formatLastSeen(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "recently" : parsed.toLocaleString();
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface.background },
    content: {
      padding: theme.spacing.xl,
      paddingBottom: theme.spacing.xxl,
      gap: theme.spacing.lg,
    },
    grow: { flex: 1 },
    serverSummary: {
      flexDirection: "row",
      gap: theme.spacing.md,
      alignItems: "flex-start",
    },
    serverName: {
      ...theme.typography.bodyStrong,
      color: theme.color.text.foreground,
    },
    serverNotice: {
      ...theme.typography.caption,
      color: theme.color.text.muted,
      marginTop: theme.spacing.xs,
    },
    pairRow: { flexDirection: "row", gap: theme.spacing.md },
    primaryButton: {
      minHeight: 48,
      flexDirection: "row",
      gap: theme.spacing.sm,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.color.action.primaryBg,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radii.sm,
    },
    primaryText: {
      ...theme.typography.bodyStrong,
      color: theme.color.text.onPrimary,
    },
    secondaryButton: {
      minHeight: 48,
      justifyContent: "center",
      alignItems: "center",
      borderWidth: 1,
      borderColor: theme.color.border.default,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radii.sm,
    },
    secondaryText: {
      ...theme.typography.label,
      color: theme.color.brand.accent,
    },
    disabled: { opacity: 0.5 },
    errorCard: {
      borderWidth: 1,
      borderColor: theme.color.status.error,
      padding: theme.spacing.md,
      borderRadius: theme.radii.sm,
      gap: theme.spacing.sm,
    },
    errorText: { ...theme.typography.label, color: theme.color.status.error },
    retryText: { ...theme.typography.label, color: theme.color.brand.accent },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionTitle: {
      ...theme.typography.subheading,
      color: theme.color.text.foreground,
    },
    phoneCard: {
      minHeight: 72,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing.md,
      padding: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.color.border.default,
      borderRadius: theme.radii.md,
      backgroundColor: theme.color.surface.subtle,
    },
    phoneIdentity: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.md,
    },
    phoneEyebrow: {
      ...theme.typography.caption,
      color: theme.color.text.muted,
    },
    phoneLabel: {
      ...theme.typography.bodyStrong,
      color: theme.color.text.foreground,
      marginTop: theme.spacing.xs,
    },
    compactAction: {
      minWidth: 72,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing.sm,
    },
    emptyCard: {
      alignItems: "center",
      gap: theme.spacing.sm,
      padding: theme.spacing.xl,
      borderWidth: 1,
      borderColor: theme.color.border.default,
      borderRadius: theme.radii.md,
    },
    emptyTitle: {
      ...theme.typography.bodyStrong,
      color: theme.color.text.foreground,
    },
    emptyBody: {
      ...theme.typography.body,
      color: theme.color.text.muted,
      textAlign: "center",
    },
    hostCard: {
      borderWidth: 1,
      borderColor: theme.color.border.default,
      borderRadius: theme.radii.md,
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
      backgroundColor: theme.color.surface.subtle,
    },
    hostTop: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    hostLabel: {
      ...theme.typography.subheading,
      color: theme.color.text.foreground,
    },
    activeHostLabel: {
      ...theme.typography.caption,
      color: theme.color.brand.accent,
      marginTop: theme.spacing.xs,
    },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    statusTitle: { ...theme.typography.label },
    hostDetail: { ...theme.typography.body, color: theme.color.text.muted },
    lastSeen: { ...theme.typography.caption, color: theme.color.text.dim },
    hostActions: {
      flexDirection: "row",
      gap: theme.spacing.md,
      marginTop: theme.spacing.sm,
    },
    actionButton: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      borderColor: theme.color.border.default,
    },
    actionText: {
      ...theme.typography.label,
      color: theme.color.text.foreground,
    },
    revokeText: { ...theme.typography.label, color: theme.color.status.error },
    modalScrim: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "center",
      padding: theme.spacing.xl,
    },
    modalCard: {
      backgroundColor: theme.color.surface.background,
      borderRadius: theme.radii.md,
      padding: theme.spacing.xl,
      gap: theme.spacing.md,
    },
    modalTitle: {
      ...theme.typography.subheading,
      color: theme.color.text.foreground,
    },
    input: {
      ...theme.typography.body,
      color: theme.color.text.foreground,
      borderWidth: 1,
      borderColor: theme.color.border.default,
      borderRadius: theme.radii.sm,
      padding: theme.spacing.md,
    },
    modalActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      alignItems: "center",
      gap: theme.spacing.md,
    },
    modalAction: { minHeight: 44, justifyContent: "center" },
  });
}
