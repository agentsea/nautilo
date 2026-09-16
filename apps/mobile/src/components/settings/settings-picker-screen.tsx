import { useMemo, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Screen } from "@/components/screen";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export interface SettingsPickerOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

interface SettingsPickerScreenProps {
  searchLabel: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  options: readonly SettingsPickerOption[];
  selectedId?: string;
  pendingId?: string;
  interactionDisabled?: boolean;
  onSelect: (id: string) => void;
  footer?: ReactNode;
}

/** Full-screen, keyboard-aware single-choice picker for focused Settings flows. */
export function SettingsPickerScreen({
  searchLabel,
  searchValue,
  onSearchChange,
  options,
  selectedId,
  pendingId,
  interactionDisabled = false,
  onSelect,
  footer,
}: SettingsPickerScreenProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);

  return (
    <Screen edgeTop={false} contentStyle={styles.content}>
      <TextInput
        value={searchValue}
        onChangeText={onSearchChange}
        placeholder={searchLabel}
        placeholderTextColor={t.color.text.dim}
        style={styles.search}
        accessibilityLabel={searchLabel}
        accessibilityHint="Filters the available choices."
        autoCorrect={false}
      />
      <View style={styles.options} accessibilityRole="radiogroup" accessibilityLabel="Available choices">
        {options.map((option) => {
          const selected = option.id === selectedId;
          const pending = option.id === pendingId;
          const disabled = option.disabled === true || interactionDisabled;
          return (
            <Pressable
              key={option.id}
              disabled={disabled}
              onPress={() => onSelect(option.id)}
              style={({ pressed }) => [styles.option, option.disabled && styles.disabled, pressed && styles.pressed]}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityHint={option.description}
              accessibilityState={{ selected, disabled, busy: pending }}
            >
              <View style={styles.optionCopy}>
                <Text style={styles.optionLabel}>{option.label}</Text>
                {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
              </View>
              {pending ? <ActivityIndicator size="small" color={t.color.brand.accent} accessibilityLabel={`Saving ${option.label} as default`} /> : <Text style={styles.radio}>{selected ? "●" : "○"}</Text>}
            </Pressable>
          );
        })}
      </View>
      {footer}
    </Screen>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    content: { gap: t.spacing.md },
    search: {
      minHeight: 44,
      borderWidth: 1,
      borderColor: t.color.border.default,
      borderRadius: t.radii.sm,
      paddingHorizontal: t.spacing.md,
      color: t.color.text.foreground,
      ...t.typography.body,
    },
    options: {
      overflow: "hidden",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.border.default,
      borderRadius: t.radii.md,
      backgroundColor: t.color.surface.panel,
    },
    option: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    pressed: { backgroundColor: t.color.surface.subtle },
    disabled: { opacity: 0.55 },
    optionCopy: { flex: 1, minWidth: 0, gap: 2 },
    optionLabel: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    optionDescription: { ...t.typography.caption, color: t.color.text.muted },
    radio: { ...t.typography.subheading, color: t.color.brand.accent },
  });
}
