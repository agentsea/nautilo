import {
  MOBILE_EXTERNAL_PROCESSING_PARAGRAPHS,
  MOBILE_EXTERNAL_RECIPIENTS,
  MOBILE_USER_AGREEMENT_EFFECTIVE_DATE,
  MOBILE_USER_AGREEMENT_VERSION,
  MOBILE_USER_POLICY_SECTIONS,
  PUBLIC_PRODUCT_LINKS,
} from "@nautilo/types";
import { router } from "expo-router";
import { useMemo } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { Screen } from "@/components/screen";
import { useAuth } from "@/providers/auth";
import { useUserAgreement } from "@/providers/user-agreement";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

async function openDestination(url: string, fallbackTitle: string, fallbackMessage: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert(fallbackTitle, fallbackMessage);
  }
}

function AgreementText() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const groupedRecipients = MOBILE_EXTERNAL_RECIPIENTS.reduce((groups, recipient) => {
    const group = groups.get(recipient.category) ?? [];
    group.push(recipient);
    groups.set(recipient.category, group);
    return groups;
  }, new Map<string, Array<(typeof MOBILE_EXTERNAL_RECIPIENTS)[number]>>());

  return (
    <>
      <View style={styles.intro}>
        <Text style={styles.title}>Before you continue</Text>
        <Text style={styles.meta}>Agreement {MOBILE_USER_AGREEMENT_VERSION} · Effective {MOBILE_USER_AGREEMENT_EFFECTIVE_DATE}</Text>
        <Text style={styles.body}>
          To use Nautilo Mobile, agree to the Community Rules and allow the connected Server to use the external processing described below.
        </Text>
      </View>

      {MOBILE_USER_POLICY_SECTIONS.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={styles.heading}>{section.title}</Text>
          {section.paragraphs.map((paragraph) => <Text key={paragraph} style={styles.body}>{paragraph}</Text>)}
          {section.bullets?.map((bullet) => <Text key={bullet} style={styles.bullet}>• {bullet}</Text>)}
        </View>
      ))}

      <View style={styles.section}>
        <Text style={styles.heading}>External processing</Text>
        {MOBILE_EXTERNAL_PROCESSING_PARAGRAPHS.map((paragraph) => <Text key={paragraph} style={styles.body}>{paragraph}</Text>)}
        {[...groupedRecipients.entries()].map(([category, recipients]) => (
          <View key={category} style={styles.recipientGroup}>
            <Text style={styles.label}>{category}</Text>
            <Text style={styles.body}>{recipients.map((recipient) => recipient.name).join(", ")}</Text>
            {recipients.map((recipient) => recipient.detail ? (
              <Text key={recipient.name} style={styles.detail}>{recipient.detail}</Text>
            ) : null)}
          </View>
        ))}
      </View>

      <View style={styles.links}>
        <Pressable
          accessibilityRole="link"
          onPress={() => void openDestination(
            PUBLIC_PRODUCT_LINKS.privacyPolicyUrl,
            "Browser unavailable",
            "Open https://nautilo.ai/privacy in your browser.",
          )}
        >
          <Text style={styles.link}>Privacy Policy</Text>
        </Pressable>
        <Pressable
          accessibilityRole="link"
          onPress={() => void openDestination(
            PUBLIC_PRODUCT_LINKS.supportContactUrl,
            "Email app unavailable",
            "Contact Nautilo support at support@kentauros.ai.",
          )}
        >
          <Text style={styles.link}>Contact Support</Text>
        </Pressable>
      </View>
    </>
  );
}

export function UserAgreementGateScreen() {
  const { signOut } = useAuth();
  const agreement = useUserAgreement();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  const leave = async (destination: "/(onboarding)/sign-in" | "/(onboarding)/add-server") => {
    await signOut();
    router.replace(destination);
  };

  const failure = agreement.status === "unsupported"
    ? "This Server does not support the current Mobile agreement. Update the Server and try again."
    : agreement.status === "unavailable"
      ? "Nautilo could not verify your agreement with this Server. Reconnect and try again."
      : null;

  return (
    <Screen contentStyle={styles.screen}>
      <AgreementText />
      {failure ? <Text accessibilityRole="alert" style={styles.error}>{failure}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Accepts the Community Rules and external processing agreement and opens Nautilo."
        disabled={agreement.busy || agreement.status === "unsupported"}
        onPress={() => void agreement.accept()}
        style={({ pressed }) => [styles.primaryButton, (pressed || agreement.busy) && styles.pressed]}
      >
        <Text style={styles.primaryButtonText}>{agreement.busy ? "Saving…" : "Agree and allow processing"}</Text>
      </Pressable>
      {agreement.status === "unavailable" ? (
        <Pressable accessibilityRole="button" onPress={() => void agreement.refresh()} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Try again</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => void leave("/(onboarding)/sign-in")} style={styles.secondaryButton}>
        <Text style={styles.secondaryButtonText}>Not now</Text>
      </Pressable>
      <View style={styles.recoveryLinks}>
        <Pressable accessibilityRole="button" onPress={() => void leave("/(onboarding)/add-server")}>
          <Text style={styles.link}>Use another Server</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => router.push("/settings/account-deletion")}>
          <Text style={styles.link}>Delete account</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

export function UserAgreementSettingsScreen() {
  const agreement = useUserAgreement();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const acceptedAt = agreement.acceptance?.acceptedAt
    ? new Date(agreement.acceptance.acceptedAt).toLocaleString()
    : null;

  const confirmWithdrawal = () => {
    Alert.alert(
      "Withdraw acceptance?",
      "Nautilo Mobile will return to the agreement screen. This does not retract content already processed.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Withdraw", style: "destructive", onPress: () => void agreement.withdraw() },
      ],
    );
  };

  return (
    <Screen edgeTop={false} contentStyle={styles.screen}>
      {acceptedAt ? <Text style={styles.accepted}>Accepted {acceptedAt}</Text> : null}
      <AgreementText />
      <Pressable
        accessibilityRole="button"
        disabled={agreement.busy}
        onPress={confirmWithdrawal}
        style={({ pressed }) => [styles.withdrawButton, (pressed || agreement.busy) && styles.pressed]}
      >
        <Text style={styles.withdrawButtonText}>{agreement.busy ? "Saving…" : "Withdraw acceptance"}</Text>
      </Pressable>
    </Screen>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    screen: { paddingBottom: t.spacing.xxl, gap: t.spacing.lg },
    intro: { gap: t.spacing.sm },
    title: { ...t.typography.title, color: t.color.text.foreground },
    meta: { ...t.typography.caption, color: t.color.text.muted },
    section: {
      gap: t.spacing.sm,
      padding: t.spacing.lg,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.panel,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
    },
    heading: { ...t.typography.subheading, color: t.color.text.foreground },
    label: { ...t.typography.label, color: t.color.text.foreground },
    body: { ...t.typography.body, color: t.color.text.foreground },
    bullet: { ...t.typography.body, color: t.color.text.foreground, paddingLeft: t.spacing.sm },
    detail: { ...t.typography.caption, color: t.color.text.muted },
    recipientGroup: { gap: t.spacing.xs },
    links: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.lg },
    recoveryLinks: { flexDirection: "row", justifyContent: "space-between", gap: t.spacing.lg },
    link: { ...t.typography.label, color: t.color.brand.accent },
    error: { ...t.typography.body, color: t.color.status.error },
    accepted: { ...t.typography.label, color: t.color.status.success },
    primaryButton: {
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radii.md,
      backgroundColor: t.color.brand.accent,
    },
    primaryButtonText: { ...t.typography.bodyStrong, color: t.color.text.onPrimary },
    secondaryButton: {
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    secondaryButtonText: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    withdrawButton: {
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.status.error,
    },
    withdrawButtonText: { ...t.typography.bodyStrong, color: t.color.status.error },
    pressed: { opacity: 0.65 },
  });
}
