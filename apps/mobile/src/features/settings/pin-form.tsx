import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { PinDraft } from "@/features/settings/security-controller";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export function PinForm({ enrolled, busy, error, onSave, onCancel, onReset }: {
  enrolled: boolean;
  busy: boolean;
  error: string | null;
  onSave: (draft: PinDraft) => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  const [currentPin, setCurrentPin] = useState(""); const [newPin, setNewPin] = useState(""); const [confirmPin, setConfirmPin] = useState("");
  const clean = (value: string) => value.replace(/\D/g, "").slice(0, 8);
  return <View style={styles.form}>
    {enrolled ? <Field label="Current PIN" value={currentPin} onChange={setCurrentPin} disabled={busy} /> : null}
    <Field label="New PIN" value={newPin} onChange={setNewPin} disabled={busy} />
    <Field label="Confirm new PIN" value={confirmPin} onChange={setConfirmPin} disabled={busy} />
    <Text style={styles.help}>PINs are 6–8 digits and cannot be obvious sequences or repeats.</Text>
    {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
    <View style={styles.actions}>
      <Pressable style={styles.secondary} disabled={busy} onPress={onCancel} accessibilityRole="button"><Text style={styles.secondaryText}>Cancel</Text></Pressable>
      <Pressable style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => onSave({ currentPin, newPin, confirmPin })} accessibilityRole="button"><Text style={styles.primaryText}>{busy ? "Saving…" : enrolled ? "Save PIN" : "Set PIN"}</Text></Pressable>
    </View>
    {enrolled ? <Pressable disabled={busy} onPress={onReset} accessibilityRole="button"><Text style={styles.link}>Forgot PIN?</Text></Pressable> : null}
  </View>;
  function Field({ label, value, onChange, disabled }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean }) { return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={(next) => onChange(clean(next))} secureTextEntry textContentType="password" autoComplete="off" keyboardType="number-pad" maxLength={8} editable={!disabled} style={styles.input} accessibilityLabel={label} /></View>; }
}
function createStyles(t: AppTheme) { return StyleSheet.create({ form: { gap: t.spacing.md }, field: { gap: t.spacing.xs }, label: { ...t.typography.bodyStrong, color: t.color.text.foreground }, input: { ...t.typography.body, color: t.color.text.foreground, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, borderRadius: t.radii.md, padding: t.spacing.md }, help: { ...t.typography.caption, color: t.color.text.muted }, error: { ...t.typography.body, color: t.color.status.error }, actions: { flexDirection: "row", gap: t.spacing.sm, flexWrap: "wrap" }, primary: { alignSelf: "flex-start", padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent }, primaryText: { ...t.typography.bodyStrong, color: t.color.surface.background }, secondary: { alignSelf: "flex-start", padding: t.spacing.md, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, secondaryText: { ...t.typography.bodyStrong, color: t.color.text.foreground }, disabled: { opacity: 0.6 }, link: { ...t.typography.bodyStrong, color: t.color.brand.accent, paddingVertical: t.spacing.xs } }); }
