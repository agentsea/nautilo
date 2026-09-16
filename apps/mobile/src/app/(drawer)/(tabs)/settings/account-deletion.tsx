import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ApiError, type AccountDeletionEligibility } from "@nautilo/api-client/browser";

import { Screen } from "@/components/screen";
import { SettingsConfirmation } from "@/components/settings/settings-confirmation";
import { SettingsStatus } from "@/components/settings/settings-status";
import { getApiClient } from "@/lib/api";
import {
  beginAccountDeletionAttempt,
  loadAccountDeletionAttempt,
  markAccountDeletionServerConfirmed,
  reconcileAccountDeletionAttempt,
} from "@/lib/account-deletion-recovery";
import { useAuth } from "@/providers/auth";
import { usePlatformCapabilities } from "@/providers/platform-capabilities";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

function blockedMessage(eligibility: AccountDeletionEligibility): string | null {
  if (eligibility.eligible) return null;
  switch (eligibility.code) {
    case "last_owner":
      return "This is the server’s last owner account. Transfer ownership or shut down the server before deleting it.";
    case "owns_shared_rooms":
      return `This account owns ${eligibility.sharedRoomCount} shared ${eligibility.sharedRoomCount === 1 ? "Room" : "Rooms"}. Reassign or delete them first so other people do not lose access.`;
    case "federated_user":
      return "This account is managed by another server. Delete it through that account authority.";
    case "protected_custody":
      return "This account has protected custody. Account termination requires a compatible newer Nautilo release or operator path; do not retry deletion until that flow is available.";
    case "active_media_operation":
      return "This account has active media work with a provider. Wait for it to finish and its cleanup to complete before deleting the account.";
    case "user_not_found":
      return "This account is no longer available on the server.";
  }
}

export default function AccountDeletionScreen() {
  const { activeServer, servers } = useServers();
  const { status, viewerState, reauthenticate, commitAccountDeleted } = useAuth();
  const platform = usePlatformCapabilities().platform;
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [eligibility, setEligibility] = useState<AccountDeletionEligibility | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverDeletionComplete, setServerDeletionComplete] = useState(false);
  const [recoveredServerDeletion, setRecoveredServerDeletion] = useState(false);
  const recoveryRemovalStarted = useRef(false);
  // Native has a durable AsyncStorage receipt. Mobile Web's step-up redirects
  // replace this component, so it deliberately remains outside that replay
  // contract until Web has an equivalent server-scoped continuation.
  const canUseNativeRecovery = platform !== "web";

  const finishLocalRemoval = useCallback(async () => {
    if (!activeServer) return;
    await commitAccountDeleted();
    const hasAnotherServer = servers.some((server) => server.id !== activeServer.id);
    router.replace(hasAnotherServer ? "/(drawer)/(tabs)" : "/(onboarding)/add-server");
  }, [activeServer, commitAccountDeleted, servers]);

  const loadEligibility = useCallback(async () => {
    if (!activeServer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    let attempt = null;
    if (canUseNativeRecovery) {
      try {
        attempt = await loadAccountDeletionAttempt({
          serverId: activeServer.id,
          serverUrl: activeServer.serverUrl,
        });
      } catch {
        // A receipt read failure is ambiguous, never evidence that deletion
        // completed. The pending receipt is retained for a later launch.
      }
    }
    try {
      const next = await getApiClient(activeServer.serverUrl).getAccountDeletionEligibility();
      setEligibility(next);
      if (!attempt) return;
      const reconciliation = reconcileAccountDeletionAttempt(attempt, {
        kind: "eligibility",
        eligibility: next,
      });
      if (reconciliation === "server-deleted") {
        setServerDeletionComplete(true);
        setRecoveredServerDeletion(true);
      } else if (reconciliation === "retry-deletion") {
        setError("A previous deletion request did not reach the server. Review the eligibility above, then delete again.");
      } else {
        setError("Nautilo could not confirm the earlier deletion request. Your account has not been removed from this phone; reconnect and try again.");
      }
    } catch (caught) {
      if (attempt) {
        const reconciliation = reconcileAccountDeletionAttempt(attempt, caught instanceof ApiError
          ? { kind: "http-error", status: caught.status }
          : { kind: "transport-error" });
        if (reconciliation === "server-deleted") {
          setServerDeletionComplete(true);
          setRecoveredServerDeletion(true);
          return;
        }
        setError("Nautilo could not confirm the earlier deletion request. Your account has not been removed from this phone; reconnect and try again.");
      } else {
        setError("Nautilo could not check whether this account can be deleted. Reconnect and try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [activeServer, canUseNativeRecovery]);

  useEffect(() => {
    void loadEligibility();
  }, [loadEligibility]);

  useEffect(() => {
    if (!recoveredServerDeletion || recoveryRemovalStarted.current) return;
    recoveryRemovalStarted.current = true;
    setBusy(true);
    void finishLocalRemoval().catch(() => {
      setError("Your server account was deleted, but this phone could not finish removing its local registration. Tap Finish removal to retry.");
    }).finally(() => {
      setBusy(false);
    });
  }, [finishLocalRemoval, recoveredServerDeletion]);

  const deleteAccount = useCallback(async () => {
    if (!activeServer || !eligibility?.eligible) return;
    let deletedOnServer = serverDeletionComplete;
    setBusy(true);
    setError(null);
    try {
      await reauthenticate();
      if (canUseNativeRecovery) {
        // Persist before the request crosses the network boundary. It contains
        // only the canonical server scope and timestamps, never credentials.
        await beginAccountDeletionAttempt({
          serverId: activeServer.id,
          serverUrl: activeServer.serverUrl,
        });
      }
      await getApiClient(activeServer.serverUrl).deleteAccount();
      deletedOnServer = true;
      if (canUseNativeRecovery) {
        // If this update fails, the earlier pending receipt stays in place and
        // the next mount will conservatively reconcile it through eligibility.
        await markAccountDeletionServerConfirmed({
          serverId: activeServer.id,
          serverUrl: activeServer.serverUrl,
        }).catch(() => {});
      }
      setServerDeletionComplete(true);
      setConfirming(false);
      await finishLocalRemoval();
    } catch (caught) {
      setConfirming(false);
      setError(
        deletedOnServer
          ? "Your server account was deleted, but this phone could not finish removing its local registration. Tap Finish removal to retry."
          : caught instanceof Error
            ? caught.message
            : "Account deletion could not be completed.",
      );
      if (!deletedOnServer) void loadEligibility();
    } finally {
      setBusy(false);
    }
  }, [activeServer, canUseNativeRecovery, eligibility, finishLocalRemoval, loadEligibility, reauthenticate, serverDeletionComplete]);

  const retryLocalRemoval = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await finishLocalRemoval();
    } catch {
      setError("This phone still could not finish removing the deleted server account. Close Nautilo and try again.");
    } finally {
      setBusy(false);
    }
  }, [finishLocalRemoval]);

  const blocked = eligibility ? blockedMessage(eligibility) : null;
  const canDelete =
    eligibility?.eligible === true &&
    status === "signed-in" &&
    viewerState === "verified" &&
    !busy;

  return (
    <Screen>
      <View style={styles.content}>
        <Text style={styles.title}>Delete this server account</Text>
        <Text style={styles.body}>
          This permanently deletes your account and associated data from {activeServer?.displayName ?? "this Nautilo server"}.
          This is different from removing a saved server from your phone.
        </Text>
        <View style={styles.card}>
          <Text style={styles.label}>SERVER</Text>
          <Text style={styles.serverName}>{activeServer?.displayName ?? "No active server"}</Text>
          <Text style={styles.serverUrl}>{activeServer?.serverUrl ?? ""}</Text>
        </View>
        <Text style={styles.body}>Other saved Nautilo servers and their accounts are not affected.</Text>

        {loading ? <ActivityIndicator accessibilityLabel="Checking account deletion eligibility" /> : null}
        {blocked ? <SettingsStatus tone="warning">{blocked}</SettingsStatus> : null}
        {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}

        {serverDeletionComplete ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            style={[styles.secondaryButton, busy && styles.disabled]}
            onPress={() => void retryLocalRemoval()}
          >
            <Text style={styles.secondaryLabel}>{busy ? "Finishing…" : "Finish removal"}</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Requires a fresh sign-in, then permanently deletes this account from the named server."
            accessibilityState={{ disabled: !canDelete }}
            disabled={!canDelete}
            style={[styles.deleteButton, !canDelete && styles.disabled]}
            onPress={() => setConfirming(true)}
          >
            <Text style={styles.deleteLabel}>Delete account</Text>
          </Pressable>
        )}

        {!loading && !eligibility && !serverDeletionComplete ? (
          <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={() => void loadEligibility()}>
            <Text style={styles.secondaryLabel}>Try again</Text>
          </Pressable>
        ) : null}
      </View>

      <SettingsConfirmation
        visible={confirming}
        title="Permanently delete this account?"
        message={`Nautilo will delete this account and its associated data from ${activeServer?.displayName ?? "this server"}. This cannot be undone. Other saved servers will remain.`}
        confirmLabel="Delete account"
        destructive
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void deleteAccount()}
      />
    </Screen>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    content: { gap: t.spacing.lg },
    title: { ...t.typography.heading, color: t.color.text.foreground },
    body: { ...t.typography.body, color: t.color.text.muted },
    card: {
      gap: t.spacing.xs,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.panel,
      padding: t.spacing.lg,
    },
    label: { ...t.typography.label, color: t.color.text.muted },
    serverName: { ...t.typography.subheading, color: t.color.text.foreground },
    serverUrl: { ...t.typography.caption, color: t.color.text.muted },
    deleteButton: {
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: t.radii.sm,
      backgroundColor: t.color.status.error,
      paddingHorizontal: t.spacing.lg,
    },
    deleteLabel: { ...t.typography.label, color: t.color.text.onPrimary },
    secondaryButton: {
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.sm,
      paddingHorizontal: t.spacing.lg,
    },
    secondaryLabel: { ...t.typography.label, color: t.color.text.foreground },
    disabled: { opacity: 0.5 },
  });
}
