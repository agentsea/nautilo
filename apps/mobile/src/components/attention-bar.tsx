import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '@/providers/theme';
import type { AppTheme } from '@/theme/tokens';

type AttentionBarProps = {
  message: string;
  onPress: () => void;
  accessibilityHint?: string;
  compact?: boolean;
};

export function AttentionBar({ message, onPress, accessibilityHint = "Opens related action", compact = false }: AttentionBarProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();

  return (
    <Pressable
      style={[
        styles.bar,
        compact ? styles.compactBar : null,
        attentionBarSafeAreaStyle(insets.top, compact ? t.spacing.xs : t.spacing.md),
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}>
      <Text style={styles.message} numberOfLines={compact ? 1 : 2}>
        {message}
      </Text>
      <Ionicons name="chevron-forward" size={18} color={t.color.text.onPrimary} />
    </Pressable>
  );
}

/**
 * Root banners paint through the system inset but keep their readable content
 * below it. The negative margin returns the inset to the following AppBar,
 * whose own safe-area padding then occupies the same physical strip instead
 * of producing a second blank notch-height gap.
 */
function attentionBarSafeAreaStyle(topInset: number, contentPaddingTop: number) {
  return {
    paddingTop: topInset + contentPaddingTop,
    marginBottom: -topInset,
  } as const;
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      width: '100%',
      zIndex: 30,
      elevation: 30,
      paddingHorizontal: t.spacing.lg,
      paddingBottom: t.spacing.md,
      backgroundColor: t.color.status.warning,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    compactBar: {
      minHeight: 44,
      paddingHorizontal: t.spacing.md,
      paddingBottom: t.spacing.xs,
    },
    message: {
      flex: 1,
      ...t.typography.label,
      color: t.color.text.onPrimary,
    },
  });
}
