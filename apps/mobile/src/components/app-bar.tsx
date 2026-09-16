// D383 Stage 1 — standardized top app-bar (design-map §3.5).
// Left = contextual slot, center = title, right = search + overflow (+ optional extra).
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "expo-router";
import { DrawerActions } from "expo-router/build/react-navigation/routers";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { OverflowSheet } from "@/components/overflow-sheet";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

export type AppBarProps = {
  /** Center title (optional on screens where context carries the label, e.g. Chats). */
  title?: string;
  /** Left contextual slot — server chip, back affordance, etc. */
  left?: ReactNode;
  /** Opens the ancestor Drawer (☰); rendered before `left` when set. */
  onMenuPress?: () => void;
  /** Optional icon/actions before search (e.g. compose on Chats). */
  rightExtra?: ReactNode;
  /** Search tap handler; when omitted, no search affordance is rendered. */
  onSearchPress?: () => void;
  /** When false, parent owns the overflow sheet (e.g. shared layout state). */
  embedOverflowSheet?: boolean;
  onOverflowPress?: () => void;
  overflowVisible?: boolean;
  onOverflowClose?: () => void;
  /** Hide overflow on focused editor routes. */
  showOverflow?: boolean;
};

/** Tab screens sit under Tabs, not Drawer — dispatch bubbles to the Drawer ancestor. */
export function useOpenAppDrawer(): () => void {
  const navigation = useNavigation();
  return useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);
}

export function AppBar({
  title,
  left,
  onMenuPress,
  rightExtra,
  onSearchPress,
  embedOverflowSheet = true,
  onOverflowPress,
  overflowVisible: overflowVisibleProp,
  onOverflowClose,
  showOverflow = true,
}: AppBarProps) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const [internalOverflowOpen, setInternalOverflowOpen] = useState(false);

  const overflowVisible =
    overflowVisibleProp ?? (embedOverflowSheet ? internalOverflowOpen : false);
  const closeOverflow =
    onOverflowClose ?? (embedOverflowSheet ? () => setInternalOverflowOpen(false) : undefined);

  const openOverflow = (): void => {
    if (onOverflowPress) {
      onOverflowPress();
      return;
    }
    if (embedOverflowSheet) setInternalOverflowOpen(true);
  };

  const menuButton = onMenuPress ? (
    <Pressable
      style={styles.iconButton}
      onPress={onMenuPress}
      accessibilityRole="button"
      accessibilityLabel="Open menu"
    >
      <Ionicons name="menu-outline" size={24} color={t.color.text.foreground} />
    </Pressable>
  ) : null;

  return (
    <>
      <View style={[styles.bar, { paddingTop: insets.top + t.spacing.sm }]}>
        <View style={styles.left}>
          {menuButton}
          {left ?? (onMenuPress ? null : <View style={styles.sideSpacer} />)}
        </View>
        <View style={styles.center}>
          {title ? (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
        </View>
        <View style={styles.right}>
          {rightExtra}
          {onSearchPress ? <Pressable
            style={styles.iconButton}
            onPress={onSearchPress}
            accessibilityRole="button"
            accessibilityLabel="Search"
          >
            <Ionicons name="search-outline" size={22} color={t.color.text.foreground} />
          </Pressable> : null}
          {showOverflow ? <Pressable
            style={styles.iconButton}
            onPress={openOverflow}
            accessibilityRole="button"
            accessibilityLabel="More options"
          >
            <Ionicons name="ellipsis-horizontal" size={22} color={t.color.text.foreground} />
          </Pressable> : null}
        </View>
      </View>
      {showOverflow && embedOverflowSheet && closeOverflow ? (
        <OverflowSheet visible={overflowVisible} onClose={closeOverflow} />
      ) : null}
    </>
  );
}

/** Back chevron sized for the app-bar left slot. */
export function AppBarBackButton({ onPress }: { onPress: () => void }) {
  const t = useAppTheme();
  return (
    <Pressable
      style={stylesBack.button}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Go back"
    >
      <Ionicons name="chevron-back" size={24} color={t.color.text.foreground} />
    </Pressable>
  );
}

const stylesBack = StyleSheet.create({
  button: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: t.spacing.lg,
      paddingBottom: t.spacing.sm + 2,
      backgroundColor: t.color.surface.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.border.default,
    },
    left: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-start",
      minHeight: 36,
      gap: t.spacing.xs,
    },
    center: {
      flex: 2,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: t.spacing.xs,
    },
    title: {
      color: t.color.text.foreground,
      ...t.typography.subheading,
      textAlign: "center",
    },
    right: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: t.spacing.xs,
    },
    sideSpacer: { width: 36 },
    iconButton: { padding: t.spacing.sm },
  });
}
