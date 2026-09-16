// D369 Phase 7 — blocking PIN / prove-it modal. Shown whenever
// `useAttention().activeChallenge` is set; works wherever the user is
// (mounted globally in _layout so it overlays the navigator). Secure
// numeric PIN entry → `resolveChallenge` (prove_it → `proveItAndResume`;
// identity → `identityVerifyResume`). On `{ ok: false }` or throw →
// "Incorrect PIN, try again" (recoverable; modal stays). On success the
// provider clears the challenge → modal unmounts.
//
// A "Deny" action is offered for `prove_it` (→ `denyProveIt`); for
// `identity` we offer "Cancel" (dismiss only — the server times the
// challenge out on its own; there is no identity-deny endpoint).
//
// An `identity.challenge` with `mode: "enrollPin"` uses the canonical
// enrollment endpoint through AttentionProvider. The ordinary "I don't have
// a PIN" escape remains recoverable for other challenge kinds.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useReducedMotion } from "react-native-reanimated";

import { useAttention } from "@/providers/attention";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { ShareMemoryApprovalPreview } from "@nautilo/types";

function ProjectionMemoryChallengeDetail({ preview }: { preview: ShareMemoryApprovalPreview }) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const projection = preview.projection;
  if (!projection) return null;

  return (
    <View style={styles.projection} accessibilityLabel="New Memory copy approval details">
      <Text style={styles.projectionTitle}>A NEW Memory copy will be created</Text>
      <Text style={styles.projectionDestination}>
        Destination Room: {projection.roomLabel} · {projection.roomKind.replaceAll("_", " ")} · {projection.memberCount} visible {projection.memberCount === 1 ? "member" : "members"}
      </Text>
      <Text style={styles.projectionContentLabel}>Exact projected Memory content</Text>
      <ScrollView
        style={styles.projectionContentScroll}
        contentContainerStyle={styles.projectionContentContainer}
        nestedScrollEnabled
        accessibilityLabel="Exact projected Memory content"
      >
        <Text selectable style={styles.projectionContent}>{projection.content}</Text>
      </ScrollView>
      {projection.audienceWarning ? (
        <Text style={styles.projectionWarning} accessibilityLabel="Destination audience warning">
          {projection.audienceWarning}
        </Text>
      ) : null}
    </View>
  );
}

function RunShellTimeoutChallengeDetail({
  timeoutSeconds,
  reason,
}: {
  timeoutSeconds: number;
  reason: string;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return (
    <View style={styles.runShellTimeout} accessibilityLabel="Long shell command approval details">
      <Text style={styles.runShellTimeoutTitle}>Long command budget: {timeoutSeconds} seconds</Text>
      <Text style={styles.runShellTimeoutLabel}>Execution intent</Text>
      <Text selectable style={styles.runShellTimeoutReason}>{reason}</Text>
    </View>
  );
}

export function PinModal() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const reducedMotion = useReducedMotion();
  const {
    activeChallenge,
    resolveChallenge,
    denyChallenge,
    dismissChallenge,
  } = useAttention();

  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNoPin, setShowNoPin] = useState(false);
  const activeChallengeRef = useRef(activeChallenge);
  activeChallengeRef.current = activeChallenge;

  // Reset transient state whenever a fresh challenge mounts so a stale
  // PIN / error from a prior challenge doesn't bleed in.
  useEffect(() => {
    if (activeChallenge) {
      setPin("");
      setError(null);
      setSubmitting(false);
      setShowNoPin(false);
    }
  }, [activeChallenge]);

  const visible = activeChallenge !== null;
  const isProveIt = activeChallenge?.kind === "prove_it";
  const isIdentity = activeChallenge?.kind === "identity";
  const isEnrollPin = activeChallenge?.kind === "identity" && activeChallenge.event.mode === "enrollPin";

  const handleSubmit = async (): Promise<void> => {
    if (!activeChallenge || submitting) return;
    if (!/^\d{6,8}$/.test(pin)) {
      setError("Enter a 6–8 digit PIN.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const expected = activeChallenge;
    const res = await resolveChallenge(expected, pin);
    if (activeChallengeRef.current !== expected) return;
    if (!res.ok) {
      setError("Incorrect PIN. Try again.");
      setPin("");
      // modal stays mounted; user retries
    }
    // success → provider clears challenge → modal unmounts
    setSubmitting(false);
  };

  const handleDeny = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    const expected = activeChallenge;
    if (expected) await denyChallenge(expected);
    if (activeChallengeRef.current !== expected) return;
    setSubmitting(false);
  };

  const title = isProveIt
    ? "Prove it's you"
    : isEnrollPin
      ? "Set up PIN"
      : isIdentity
      ? "Verify your identity"
      : "Enter PIN";

  const subtitle = isProveIt
    ? "Enter your PIN to approve this action."
    : isEnrollPin
      ? "Choose a 6–8 digit PIN to continue."
      : isIdentity
      ? "Enter your PIN to continue."
      : "Enter your PIN.";
  const projectionPreviews = activeChallenge?.kind === "prove_it"
    ? activeChallenge.event.tools.flatMap((tool) =>
        tool.name === "share_memory" && tool.shareMemoryPreview?.projection
          ? [tool.shareMemoryPreview]
          : [],
      )
    : [];
  const runShellTimeouts = activeChallenge?.kind === "prove_it"
    ? activeChallenge.event.tools.flatMap((tool) =>
        tool.name === "run_shell" && tool.runShellTimeout
          ? [tool.runShellTimeout]
          : [],
      )
    : [];

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reducedMotion ? "none" : "fade"}
      onRequestClose={() => {
        // Hardware back (Android) / escape: deny for prove_it, dismiss
        // for identity. Disabled while submitting to avoid a double-fire.
        if (submitting) return;
        if (isProveIt) void handleDeny();
        else if (activeChallenge) dismissChallenge(activeChallenge);
      }}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior="padding"
        accessibilityViewIsModal
        {...(Platform.OS === "web" ? { role: "dialog", "aria-modal": true } as unknown as Record<string, unknown> : {})}
      >
        <ScrollView
          style={styles.sheet}
          contentContainerStyle={styles.sheetContent}
          keyboardShouldPersistTaps="handled"
          bounces={false}
        >
          <Text style={styles.title} accessibilityRole="header">{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>

          {projectionPreviews.map((preview, index) => (
            <ProjectionMemoryChallengeDetail
              key={`${preview.projection?.roomLabel ?? "room"}-${index}`}
              preview={preview}
            />
          ))}

          {runShellTimeouts.map((timeout, index) => (
            <RunShellTimeoutChallengeDetail
              key={`${timeout.timeoutSeconds}-${index}`}
              timeoutSeconds={timeout.timeoutSeconds}
              reason={timeout.reason}
            />
          ))}

          <TextInput
            style={styles.input}
            value={pin}
            onChangeText={setPin}
            placeholder="PIN"
            placeholderTextColor={t.color.text.disabled}
            secureTextEntry
            keyboardType="number-pad"
            textContentType="password"
            autoFocus
            editable={!submitting}
            maxLength={8}
            onSubmitEditing={() => void handleSubmit()}
            accessibilityLabel="PIN"
            accessibilityHint="Enter a 6 to 8 digit PIN."
            accessibilityState={{ disabled: submitting }}
          />

          {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}

          <View style={styles.actions}>
            {isProveIt ? (
              <Pressable
                style={[styles.button, styles.secondaryButton]}
                disabled={submitting}
                onPress={() => void handleDeny()}
                accessibilityRole="button"
                accessibilityLabel="Deny"
                accessibilityState={{ disabled: submitting, busy: submitting }}
              >
                <Text style={styles.secondaryText}>Deny</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.button, styles.secondaryButton]}
                disabled={submitting}
                onPress={() => { if (activeChallenge) dismissChallenge(activeChallenge); }}
                accessibilityRole="button"
                accessibilityLabel="Cancel PIN entry"
                accessibilityState={{ disabled: submitting, busy: submitting }}
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.button, styles.primaryButton]}
              disabled={submitting || !/^\d{6,8}$/.test(pin)}
              onPress={() => void handleSubmit()}
              accessibilityRole="button"
              accessibilityLabel={isEnrollPin ? "Set up PIN" : "Submit PIN"}
              accessibilityState={{ disabled: submitting || !/^\d{6,8}$/.test(pin), busy: submitting }}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={t.color.text.onPrimary} />
              ) : (
                <Text style={styles.primaryText}>{isEnrollPin ? "Set up PIN" : "Submit"}</Text>
              )}
            </Pressable>
          </View>

          {!isEnrollPin ? <>
            <Pressable
              style={styles.noPinLink}
              disabled={submitting}
              onPress={() => setShowNoPin(true)}
              accessibilityRole="button"
              accessibilityLabel="I don't have a PIN"
              accessibilityState={{ disabled: submitting }}
            >
              <Text style={styles.noPinLinkText}>I don&apos;t have a PIN</Text>
            </Pressable>
            {showNoPin ? (
              <View style={styles.noPinBox}>
                <Text style={styles.noPinText}>
                  Set up a PIN on a desktop Nautilo client to approve
                  sensitive actions. You can dismiss this for now — the
                  request will time out on the server.
                </Text>
                <Pressable
                  style={[styles.button, styles.secondaryButton, { marginTop: t.spacing.sm }]}
                  disabled={submitting}
                  onPress={() => {
                    setShowNoPin(false);
                    if (isProveIt) void handleDeny();
                    else if (activeChallenge) dismissChallenge(activeChallenge);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss PIN help"
                  accessibilityState={{ disabled: submitting }}
                >
                  <Text style={styles.secondaryText}>Dismiss</Text>
                </Pressable>
              </View>
            ) : null}
          </> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: t.spacing.xl,
    },
    sheet: {
      width: "100%",
      maxWidth: 360,
      maxHeight: "100%",
      backgroundColor: t.color.surface.panel,
      borderRadius: t.radii.lg,
    },
    sheetContent: {
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.xl,
    },
    title: { ...t.typography.subheading, color: t.color.text.foreground },
    subtitle: { marginTop: t.spacing.xs, ...t.typography.body, color: t.color.text.muted },
    projection: {
      marginTop: t.spacing.md,
      paddingLeft: t.spacing.sm,
      borderLeftWidth: 2,
      borderLeftColor: t.color.status.warning,
      gap: t.spacing.xs,
    },
    projectionTitle: { ...t.typography.label, color: t.color.text.foreground },
    projectionDestination: { ...t.typography.caption, color: t.color.text.muted, lineHeight: 18 },
    projectionContentLabel: { ...t.typography.caption, color: t.color.text.foreground, fontWeight: "700" },
    projectionContentScroll: {
      maxHeight: 180,
      borderRadius: t.radii.sm,
      backgroundColor: t.color.surface.subtle,
    },
    projectionContentContainer: { paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.sm },
    projectionContent: { ...t.typography.caption, color: t.color.text.foreground, lineHeight: 18 },
    projectionWarning: { ...t.typography.caption, color: t.color.text.foreground, lineHeight: 18 },
    runShellTimeout: {
      marginTop: t.spacing.md,
      paddingLeft: t.spacing.sm,
      borderLeftWidth: 2,
      borderLeftColor: t.color.status.warning,
      gap: t.spacing.xs,
    },
    runShellTimeoutTitle: { ...t.typography.label, color: t.color.text.foreground },
    runShellTimeoutLabel: { ...t.typography.caption, color: t.color.text.foreground, fontWeight: "700" },
    runShellTimeoutReason: { ...t.typography.caption, color: t.color.text.foreground, lineHeight: 18 },
    input: {
      marginTop: t.spacing.md,
      minHeight: 48,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.sm,
      paddingHorizontal: t.spacing.md,
      ...t.typography.body,
      color: t.color.text.foreground,
      backgroundColor: t.color.surface.element,
      letterSpacing: 4,
    },
    error: { marginTop: t.spacing.sm, ...t.typography.caption, color: t.color.status.error },
    actions: { marginTop: t.spacing.md, flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
    button: {
      flex: 1,
      minWidth: 120,
      minHeight: 44,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radii.sm,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryButton: { backgroundColor: t.color.action.primaryBg },
    secondaryButton: {
      backgroundColor: t.color.surface.element,
      borderWidth: 1,
      borderColor: t.color.border.default,
    },
    primaryText: { ...t.typography.label, color: t.color.text.onPrimary },
    secondaryText: { ...t.typography.label, color: t.color.text.foreground },
    noPinLink: { marginTop: t.spacing.md, minHeight: 44, alignSelf: "center", justifyContent: "center", paddingHorizontal: t.spacing.sm },
    noPinLinkText: { ...t.typography.caption, color: t.color.text.muted },
    noPinBox: { marginTop: t.spacing.sm },
    noPinText: { ...t.typography.caption, color: t.color.text.muted, lineHeight: 17 },
  });
}
