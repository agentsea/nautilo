import { Stack, router } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsConfirmation } from "@/components/settings/settings-confirmation";
import { SettingsStatus } from "@/components/settings/settings-status";
import { StandingApprovalDetail } from "@/features/settings/standing-approval-detail";
import { useStandingApprovals } from "@/features/settings/standing-approvals-controller";
import {
  standingApprovalPresentation,
  type StandingApproval,
  type StandingApprovalsFailure,
} from "@/features/settings/standing-approvals-state";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function StandingApprovalsScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState, signOut } = useAuth();
  const { state, retry, revoke } = useStandingApprovals({
    server: activeServer,
    authStatus: status,
    viewerId: viewer?.userId ?? null,
    viewerActorId: viewer?.actorId ?? null,
    viewerState,
  });
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const approvals = state.kind === "ready" ? state.approvals : [];
  const selected = approvals.find((approval) => approval.id === selectedId) ?? null;
  const confirming = approvals.find((approval) => approval.id === confirmId) ?? null;
  const busy = state.kind === "ready" && state.mutating;
  const mutationFailure = state.kind === "ready" ? state.mutationFailure : null;
  const canonicalRefreshPending = state.kind === "ready" && state.canonicalRefreshPending;
  const confirmationLabel = mutationFailure?.kind === "signed-out"
    ? "Sign in"
    : mutationFailure?.kind === "forbidden"
      ? "Close"
      : canonicalRefreshPending ? "Refresh list" : mutationFailure ? "Try again" : "Revoke approval";

  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/(drawer)/(tabs)/settings");
  };
  const signIn = (): void => {
    void signOut().finally(() => router.replace("/(onboarding)/sign-in"));
  };
  const closeDetail = (): void => {
    if (!busy) setSelectedId(null);
  };
  const askToRevoke = (): void => {
    if (selected?.active && !busy) setConfirmId(selected.id);
  };
  const confirmRevoke = (): void => {
    if (!confirming || busy) return;
    if (mutationFailure?.kind === "signed-out") {
      setConfirmId(null);
      signIn();
      return;
    }
    if (mutationFailure?.kind === "forbidden") {
      setConfirmId(null);
      return;
    }
    void revoke(confirming.id).then((result) => {
      // Only the canonical reload decides whether the row left the list.
      if (result.status === "applied") {
        setConfirmId(null);
        setSelectedId(null);
      }
    });
  };
  const cancelConfirm = (): void => {
    if (!busy) setConfirmId(null);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ header: () => <AppBar title="Standing approvals" left={<AppBarBackButton onPress={goBack} />} /> }} />
      {state.kind === "ready" ? (
        <Screen edgeTop={false} contentStyle={styles.content}>
          <Text style={styles.intro}>Review the standing rules that bypass a future approval prompt.</Text>
          {busy ? <SettingsStatus tone="info">Revoking approval and refreshing the server list…</SettingsStatus> : null}
          {mutationFailure ? <MutationStatus failure={mutationFailure} /> : null}
          {approvals.length === 0 ? (
            <View style={styles.empty} accessibilityLiveRegion="polite">
              <Text style={styles.emptyTitle}>No standing approvals</Text>
              <Text style={styles.helper}>Choose “This room” or “Always” when approving a tool in chat to create one.</Text>
            </View>
          ) : (
            <View style={styles.list} accessibilityRole="summary" accessibilityLabel="Standing approvals">
              {approvals.map((approval) => (
                <ApprovalRow key={approval.id} approval={approval} onPress={() => setSelectedId(approval.id)} />
              ))}
            </View>
          )}
        </Screen>
      ) : state.kind === "loading" ? (
        <View style={styles.state} accessibilityLiveRegion="polite">
          <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading standing approvals" />
        </View>
      ) : (
        <FailureState failure={state} onRetry={() => void retry()} onSignIn={signIn} />
      )}
      <StandingApprovalDetail
        approval={selected}
        visible={selected !== null}
        busy={busy}
        onClose={closeDetail}
        onRevoke={askToRevoke}
      />
      <SettingsConfirmation
        visible={confirming !== null}
        title="Revoke standing approval?"
        message={mutationFailure
          ? mutationFailure.kind === "signed-out"
            ? "Your session has expired. Sign in again before retrying."
            : mutationFailure.kind === "forbidden"
              ? "This server no longer allows this approval to be revoked."
              : canonicalRefreshPending
                ? "The approval may already be revoked. Refresh the server list before trying again."
                : mutationFailure.message
          : "This rule will no longer bypass future approval prompts."}
        confirmLabel={confirmationLabel}
        destructive
        busy={busy}
        onCancel={cancelConfirm}
        onConfirm={confirmRevoke}
      />
    </View>
  );
}

function ApprovalRow({ approval, onPress }: { approval: StandingApproval; onPress: () => void }) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const detail = standingApprovalPresentation(approval);
  const summary = detail.room ? `${detail.scope} · ${detail.room}` : detail.scope;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${detail.title}, ${detail.tool}, ${summary}`}
      accessibilityHint="Shows standing approval details and revocation."
    >
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle} numberOfLines={2}>{detail.title}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>{detail.tool}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>{summary}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function MutationStatus({ failure }: { failure: StandingApprovalsFailure }) {
  const message = failure.kind === "signed-out"
    ? "Your session has expired. Sign in again before revoking an approval."
    : failure.kind === "forbidden"
      ? "This server no longer allows this approval to be revoked."
      : failure.message;
  return <SettingsStatus tone="error">{message}</SettingsStatus>;
}

function FailureState({
  failure,
  onRetry,
  onSignIn,
}: {
  failure: StandingApprovalsFailure;
  onRetry: () => void;
  onSignIn: () => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const requiresSignIn = failure.kind === "signed-out";
  const title = requiresSignIn ? "Sign in required" : failure.kind === "forbidden" ? "Approvals unavailable" : "Could not load approvals";
  const detail = requiresSignIn
    ? "Your session has expired or you are signed out."
    : failure.kind === "forbidden"
      ? "This server did not allow this approvals view."
      : failure.message;
  return (
    <View style={styles.state} accessibilityLiveRegion="polite">
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.helper}>{detail}</Text>
      <Pressable style={styles.primaryButton} onPress={requiresSignIn ? onSignIn : onRetry} accessibilityRole="button">
        <Text style={styles.primaryButtonLabel}>{requiresSignIn ? "Sign in" : "Try again"}</Text>
      </Pressable>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    content: { gap: t.spacing.lg },
    intro: { ...t.typography.body, color: t.color.text.muted },
    list: { overflow: "hidden", borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default },
    row: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: t.spacing.md, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default },
    rowCopy: { flex: 1, gap: 2 },
    rowTitle: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    rowMeta: { ...t.typography.caption, color: t.color.text.muted },
    chevron: { fontSize: 28, color: t.color.text.muted },
    empty: { gap: t.spacing.sm, padding: t.spacing.lg, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default },
    emptyTitle: { ...t.typography.subheading, color: t.color.text.foreground },
    helper: { ...t.typography.body, color: t.color.text.muted, textAlign: "center" },
    state: { flex: 1, alignItems: "center", justifyContent: "center", gap: t.spacing.md, padding: t.spacing.xl },
    stateTitle: { ...t.typography.heading, color: t.color.text.foreground, textAlign: "center" },
    primaryButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent },
    primaryButtonLabel: { ...t.typography.label, color: t.color.surface.background },
    pressed: { opacity: 0.7 },
  });
}
