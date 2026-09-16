import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { EffectiveAccessDetail } from "@/features/settings/effective-access-detail";
import {
  accessOverview,
  capabilityStatusLabel,
  roleLabel,
  viewerFreshnessNotice,
  type AccessCapability,
  type EffectiveAccess,
} from "@/features/settings/access-presentation";
import { useEffectiveAccess } from "@/features/settings/use-effective-access";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export default function YourAccessScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState, signOut } = useAuth();
  const { state, retry } = useEffectiveAccess({
    server: activeServer,
    authStatus: status,
    viewerId: viewer?.userId ?? null,
    viewerActorId: viewer?.actorId ?? null,
    viewerState,
  });
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [detail, setDetail] = useState<AccessCapability | null>(null);
  const freshness = viewerFreshnessNotice(viewerState);

  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/(drawer)/(tabs)/settings");
  };

  const signIn = (): void => {
    void signOut().finally(() => router.replace("/(onboarding)/sign-in"));
  };

  return (
    <View style={styles.container}>
      <AppBar title="Your Access" left={<AppBarBackButton onPress={goBack} />} />
      {state.kind === "ready" ? (
        <Screen edgeTop={false} contentStyle={styles.content}>
          {freshness ? <Text style={styles.warning} accessibilityLiveRegion="polite">{freshness}</Text> : null}
          <AccessReadout access={state.access} onSelect={setDetail} />
        </Screen>
      ) : (
        <AccessState
          state={state.kind}
          onRetry={() => void retry()}
          onSignIn={signIn}
        />
      )}
      <EffectiveAccessDetail capability={detail} visible={detail !== null} onClose={() => setDetail(null)} />
    </View>
  );
}

function AccessReadout({
  access,
  onSelect,
}: {
  access: EffectiveAccess;
  onSelect: (capability: AccessCapability) => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const overview = accessOverview(access);
  return (
    <>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>SERVER-CALCULATED ROLE</Text>
        <Text style={styles.role}>{roleLabel(overview.highestRole)}</Text>
        <Text style={styles.helper}>This read-only view does not change access or expose administration.</Text>
      </View>
      {!overview.hasAnyGrant ? (
        <View style={styles.emptyCard}>
          <Text style={styles.sectionTitle}>No access grants</Text>
          <Text style={styles.helper}>This server has not granted any capabilities to this account.</Text>
        </View>
      ) : null}
      <CapabilitySection title={`Granted (${overview.granted.length})`} capabilities={overview.granted} onSelect={onSelect} />
      <CapabilitySection title={`Not granted (${overview.denied.length})`} capabilities={overview.denied} onSelect={onSelect} />
    </>
  );
}

function CapabilitySection({
  title,
  capabilities,
  onSelect,
}: {
  title: string;
  capabilities: readonly AccessCapability[];
  onSelect: (capability: AccessCapability) => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {capabilities.length ? capabilities.map((capability) => {
        const canShowSource = capability.provenance.length > 0;
        return (
          <Pressable
            key={capability.slug}
            disabled={!canShowSource}
            onPress={() => onSelect(capability)}
            style={[styles.capability, !canShowSource && styles.capabilityStatic]}
            accessibilityRole={canShowSource ? "button" : "text"}
            accessibilityLabel={`${capability.slug}. ${capabilityStatusLabel(capability)}. ${capability.description}${canShowSource ? ". View access source" : ""}`}
          >
            <View style={styles.capabilityCopy}>
              <Text style={styles.capabilityName}>{capability.slug}</Text>
              <Text style={styles.capabilityDescription}>{capability.description}</Text>
            </View>
            <Text style={[styles.capabilityStatus, capability.granted ? styles.granted : styles.denied]}>
              {capabilityStatusLabel(capability)}
            </Text>
          </Pressable>
        );
      }) : <Text style={styles.helper}>None reported by this server.</Text>}
    </View>
  );
}

function AccessState({
  state,
  onRetry,
  onSignIn,
}: {
  state: Exclude<ReturnType<typeof useEffectiveAccess>["state"]["kind"], "ready">;
  onRetry: () => void;
  onSignIn: () => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  if (state === "loading") {
    return <View style={styles.status}><ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading your access" /></View>;
  }
  const isSignedOut = state === "signed-out";
  const isIdentityStale = state === "identity-stale";
  const isForbidden = state === "forbidden";
  const title = isSignedOut || isIdentityStale
    ? isIdentityStale ? "Identity check needed" : "Sign in required"
    : isForbidden ? "Access unavailable" : "Could not load your access";
  const detail = isIdentityStale
    ? "Reconnect or sign in again before Nautilo reads your access from this server."
    : isSignedOut
    ? "Your session has expired or you are signed out."
    : isForbidden
      ? "This server did not allow this access view."
      : "Check your connection and try again.";
  return (
    <View style={styles.status} accessibilityLiveRegion="polite">
      <Text style={styles.statusTitle}>{title}</Text>
      <Text style={styles.helper}>{detail}</Text>
      <Pressable style={styles.button} onPress={isSignedOut || isIdentityStale ? onSignIn : onRetry} accessibilityRole="button">
        <Text style={styles.buttonLabel}>{isSignedOut || isIdentityStale ? "Sign in" : "Try again"}</Text>
      </Pressable>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    content: { gap: t.spacing.lg },
    card: { gap: t.spacing.sm, padding: t.spacing.lg, borderRadius: t.radii.lg, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default },
    eyebrow: { ...t.typography.caption, color: t.color.text.muted },
    role: { ...t.typography.heading, color: t.color.text.foreground },
    helper: { ...t.typography.body, color: t.color.text.muted },
    warning: { ...t.typography.body, color: t.color.status.warning, padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel },
    emptyCard: { gap: t.spacing.sm, padding: t.spacing.lg, borderRadius: t.radii.lg, backgroundColor: t.color.surface.panel },
    section: { gap: t.spacing.sm },
    sectionTitle: { ...t.typography.subheading, color: t.color.text.foreground },
    capability: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default },
    capabilityStatic: { opacity: 0.82 },
    capabilityCopy: { flex: 1, gap: 2 },
    capabilityName: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    capabilityDescription: { ...t.typography.caption, color: t.color.text.muted },
    capabilityStatus: { ...t.typography.label },
    granted: { color: t.color.status.success },
    denied: { color: t.color.text.dim },
    status: { flex: 1, alignItems: "center", justifyContent: "center", gap: t.spacing.md, padding: t.spacing.xl },
    statusTitle: { ...t.typography.heading, color: t.color.text.foreground, textAlign: "center" },
    button: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent },
    buttonLabel: { ...t.typography.bodyStrong, color: t.color.surface.background },
  });
}
