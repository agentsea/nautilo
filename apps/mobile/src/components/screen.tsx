// D369 — shared screen scaffold. One place that bakes in safe-area insets +
// robust keyboard handling so every screen resizes correctly when the soft
// keyboard opens, instead of each screen rolling its own (flaky) avoidance.
//
// Uses react-native-keyboard-controller's KeyboardAwareScrollView, which
// tracks the focused input and keeps it visible above the keyboard on both
// platforms (RN's built-in KeyboardAvoidingView is unreliable cross-platform).
//
// - `scroll` (default true): form screens — content scrolls + auto-avoids.
// - `scroll={false}`: static screens — plain padded container (no input, or a
//   screen that manages its own list, e.g. chat).
// Chat's conversation screen does NOT use this — it composes the
// keyboard-controller primitives directly (sticky composer + inverted list).
import { useMemo, type ReactNode } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

interface ScreenProps {
  children: ReactNode;
  /** Keyboard-aware scrolling container (forms). Default true. */
  scroll?: boolean;
  /** Apply top safe-area inset padding. Default true. */
  edgeTop?: boolean;
  /** Extra content-container styling. */
  contentStyle?: StyleProp<ViewStyle>;
  /** Extra clearance above the keyboard for a sticky footer outside this scroll view. */
  keyboardBottomOffset?: number;
}

export function Screen({ children, scroll = true, edgeTop = true, contentStyle, keyboardBottomOffset = 0 }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const safePadding = {
    paddingTop: (edgeTop ? insets.top : 0) + t.spacing.lg,
    paddingBottom: insets.bottom + t.spacing.xl,
  };

  if (scroll) {
    return (
      <KeyboardAwareScrollView
        style={styles.flex}
        contentContainerStyle={[styles.body, safePadding, contentStyle]}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        bottomOffset={t.spacing.xl + keyboardBottomOffset}
        showsVerticalScrollIndicator
      >
        {children}
      </KeyboardAwareScrollView>
    );
  }

  return <View style={[styles.flex, styles.body, safePadding, contentStyle]}>{children}</View>;
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: t.color.surface.background },
    body: {
      paddingHorizontal: t.spacing.xl,
      gap: t.spacing.md,
      flexGrow: 1,
    },
  });
}
