import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import {
  standingApprovalPresentation,
  type StandingApproval,
} from "@/features/settings/standing-approvals-state";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export function StandingApprovalDetail({
  approval,
  visible,
  busy,
  onClose,
  onRevoke,
}: {
  approval: StandingApproval | null;
  visible: boolean;
  busy: boolean;
  onClose: () => void;
  onRevoke: () => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const detail = approval ? standingApprovalPresentation(approval) : null;

  return (
    <BottomSheet visible={visible} snapPoints={["60%"]} onClose={onClose}>
      <View style={styles.sheet} accessibilityViewIsModal>
        <View style={styles.heading}>
          <View style={styles.headingCopy}>
            <Text style={styles.title}>Standing approval</Text>
            <Text style={styles.subtitle}>{detail?.title ?? "Approval"}</Text>
          </View>
          <Pressable
            onPress={onClose}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Close approval details"
            accessibilityState={{ disabled: busy }}
            style={styles.done}
          >
            <Text style={styles.doneLabel}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <DetailField label="Scope" value={detail?.scope ?? ""} />
          <DetailField label="Tool" value={detail?.tool ?? ""} />
          {detail?.room ? <DetailField label="Room" value={detail.room} /> : null}
          <Pressable
            onPress={onRevoke}
            disabled={busy || !approval?.active}
            style={({ pressed }) => [styles.revoke, (pressed || busy || !approval?.active) && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Revoke standing approval"
            accessibilityHint="Asks for confirmation before this approval is revoked."
            accessibilityState={{ disabled: busy || !approval?.active }}
          >
            <Text style={styles.revokeLabel}>Revoke approval</Text>
          </Pressable>
        </ScrollView>
      </View>
    </BottomSheet>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    sheet: { flex: 1, gap: t.spacing.lg },
    heading: { flexDirection: "row", alignItems: "flex-start", gap: t.spacing.md },
    headingCopy: { flex: 1, gap: 2 },
    title: { ...t.typography.subheading, color: t.color.text.foreground },
    subtitle: { ...t.typography.caption, color: t.color.text.muted },
    done: { minHeight: 44, justifyContent: "center", paddingLeft: t.spacing.sm },
    doneLabel: { ...t.typography.label, color: t.color.brand.accent },
    content: { gap: t.spacing.md, paddingBottom: t.spacing.lg },
    field: {
      gap: 2,
      padding: t.spacing.md,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
    },
    fieldLabel: { ...t.typography.caption, color: t.color.text.muted, fontWeight: "700", textTransform: "uppercase" },
    fieldValue: { ...t.typography.body, color: t.color.text.foreground },
    revoke: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, backgroundColor: t.color.status.error, paddingHorizontal: t.spacing.lg },
    revokeLabel: { ...t.typography.label, color: t.color.text.onPrimary },
    pressed: { opacity: 0.7 },
  });
}
