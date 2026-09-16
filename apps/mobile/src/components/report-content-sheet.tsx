import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import * as Crypto from "expo-crypto";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import { getApiClient } from "@/lib/api";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import {
  CONTENT_REPORT_REASON_LABELS,
  CONTENT_REPORT_REASONS,
  type ContentReportReason,
  type ContentReportTarget,
} from "@nautilo/types";

export type MobileReportTarget = ContentReportTarget & { label: string };

type Props = {
  serverUrl: string | undefined;
  target: MobileReportTarget | null;
  onClose: () => void;
};

export function ReportContentSheet({ serverUrl, target, onClose }: Props) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const [reason, setReason] = useState<ContentReportReason | null>(null);
  const [comment, setComment] = useState("");
  const [submissionId, setSubmissionId] = useState(() => Crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setReason(null);
    setComment("");
    setSubmissionId(Crypto.randomUUID());
    setSubmitting(false);
    setError(null);
  }, [target]);

  const close = (): void => {
    if (!submitting) onClose();
  };

  const submit = (): void => {
    if (!serverUrl || !target || !reason || submitting) return;
    Alert.alert(
      "Send this report?",
      "The report will go to administrators of your connected Nautilo Server.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Send report",
          onPress: () => {
            void (async () => {
              setSubmitting(true);
              setError(null);
              try {
                const { label: _label, ...reportTarget } = target;
                await getApiClient(serverUrl).createContentReport({
                  id: submissionId,
                  target: reportTarget,
                  reason,
                  ...(comment.trim() ? { comment: comment.trim() } : {}),
                });
                setSubmitting(false);
                onClose();
                Alert.alert(
                  "Report sent",
                  "Administrators of your connected Server can now review it.",
                );
              } catch (cause) {
                setSubmitting(false);
                setError(cause instanceof Error ? cause.message : "Please try again.");
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <BottomSheet
      visible={target !== null}
      onClose={close}
      snapPoints={["72%"]}
      scrollable
      backdrop>
      <View style={styles.content} accessibilityViewIsModal>
        <Text style={styles.title}>Report {target?.label ?? "content"}</Text>
        <Text style={styles.explainer}>
          This goes to administrators of your connected self-hosted Server—not Apple,
          Google, or a central Nautilo moderation service.
        </Text>

        <View style={styles.reasons} accessibilityRole="radiogroup">
          {CONTENT_REPORT_REASONS.map((value) => {
            const selected = reason === value;
            return (
              <Pressable
                key={value}
                style={[styles.reason, selected ? styles.reasonSelected : null]}
                onPress={() => setReason(value)}
                disabled={submitting}
                accessibilityRole="radio"
                accessibilityState={{ selected }}>
                <View style={[styles.radio, selected ? styles.radioSelected : null]} />
                <Text style={styles.reasonText}>{CONTENT_REPORT_REASON_LABELS[value]}</Text>
              </Pressable>
            );
          })}
        </View>

        <BottomSheetTextInput
          style={styles.input}
          value={comment}
          onChangeText={setComment}
          editable={!submitting}
          maxLength={500}
          multiline
          placeholder="Optional details"
          placeholderTextColor={t.color.text.dim}
          accessibilityLabel="Optional report details"
        />
        <Text style={styles.count}>{comment.length}/500</Text>
        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}

        <View style={styles.actions}>
          <Pressable style={styles.cancel} onPress={close} disabled={submitting}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.submit, !reason || submitting ? styles.disabled : null]}
            onPress={submit}
            disabled={!reason || submitting}
            accessibilityRole="button"
            accessibilityLabel="Continue to confirm report">
            {submitting ? (
              <ActivityIndicator color={t.color.text.onPrimary} />
            ) : (
              <Text style={styles.submitText}>Continue</Text>
            )}
          </Pressable>
        </View>
      </View>
    </BottomSheet>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    content: { gap: t.spacing.md },
    title: { ...t.typography.subheading, color: t.color.text.foreground },
    explainer: { ...t.typography.body, color: t.color.text.muted },
    reasons: { gap: t.spacing.xs },
    reason: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.sm,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.sm,
    },
    reasonSelected: { backgroundColor: t.color.surface.element },
    radio: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 2,
      borderColor: t.color.border.strong,
    },
    radioSelected: {
      borderWidth: 5,
      borderColor: t.color.brand.accent,
    },
    reasonText: { ...t.typography.body, color: t.color.text.foreground },
    input: {
      minHeight: 84,
      maxHeight: 120,
      padding: t.spacing.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
      color: t.color.text.foreground,
      backgroundColor: t.color.surface.element,
      textAlignVertical: "top",
      ...t.typography.body,
    },
    count: { ...t.typography.caption, color: t.color.text.dim, textAlign: "right" },
    error: { ...t.typography.caption, color: t.color.status.error },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: t.spacing.sm },
    cancel: { minHeight: 44, justifyContent: "center", paddingHorizontal: t.spacing.md },
    cancelText: { ...t.typography.label, color: t.color.text.foreground },
    submit: {
      minWidth: 112,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: t.spacing.lg,
      borderRadius: t.radii.md,
      backgroundColor: t.color.brand.accent,
    },
    submitText: { ...t.typography.label, color: t.color.text.onPrimary },
    disabled: { opacity: 0.55 },
  });
}
