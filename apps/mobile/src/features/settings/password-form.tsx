import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export function PasswordForm({ busy, error, required, onSave, onCancel }: { busy: boolean; error: string | null; required: boolean; onSave: (value: { currentPassword: string; newPassword: string; confirmPassword: string }) => void; onCancel: () => void }) {
  const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]);
  const [currentPassword, setCurrentPassword] = useState(""); const [newPassword, setNewPassword] = useState(""); const [confirmPassword, setConfirmPassword] = useState("");
  return <View style={styles.form}>
    {required ? <Text style={styles.warning}>A new password is required before you continue.</Text> : null}
    <Field label="Current password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
    <Field label="New password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
    <Field label="Confirm new password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
    {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
    <View style={styles.actions}>
      {!required ? <Pressable style={styles.secondary} disabled={busy} onPress={onCancel} accessibilityRole="button"><Text style={styles.secondaryText}>Cancel</Text></Pressable> : null}
      <Pressable style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => onSave({ currentPassword, newPassword, confirmPassword })} accessibilityRole="button"><Text style={styles.primaryText}>{busy ? "Saving…" : "Save password"}</Text></Pressable>
    </View>
  </View>;
  function Field({ label, value, onChange, autoComplete }: { label: string; value: string; onChange: (value: string) => void; autoComplete: "current-password" | "new-password" }) { return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChange} secureTextEntry textContentType={autoComplete === "current-password" ? "password" : "newPassword"} autoComplete={autoComplete} autoCapitalize="none" autoCorrect={false} editable={!busy} style={styles.input} accessibilityLabel={label} /></View>; }
}
function createStyles(t: AppTheme) { return StyleSheet.create({ form: { gap: t.spacing.md }, field: { gap: t.spacing.xs }, label: { ...t.typography.bodyStrong, color: t.color.text.foreground }, input: { ...t.typography.body, color: t.color.text.foreground, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, borderRadius: t.radii.md, padding: t.spacing.md }, warning: { ...t.typography.body, color: t.color.status.warning }, error: { ...t.typography.body, color: t.color.status.error }, actions: { flexDirection: "row", gap: t.spacing.sm, flexWrap: "wrap" }, primary: { alignSelf: "flex-start", padding: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent }, primaryText: { ...t.typography.bodyStrong, color: t.color.surface.background }, secondary: { alignSelf: "flex-start", padding: t.spacing.md, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, secondaryText: { ...t.typography.bodyStrong, color: t.color.text.foreground }, disabled: { opacity: 0.6 } }); }
