// Bridge between room screens, which own their action handlers, and the shared
// chat app bar. The header renders a single room-scoped settings surface.
import { Ionicons } from "@expo/vector-icons";
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "@/components/bottom-sheet";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type MembersHandler = (() => void) | null;

type ChatHeaderActionsValue = {
  onMembersPress: MembersHandler;
  setOnMembersPress: (handler: MembersHandler) => void;
  onSearchPress: MembersHandler;
  setOnSearchPress: (handler: MembersHandler) => void;
  onRenamePress: MembersHandler;
  setOnRenamePress: (handler: MembersHandler) => void;
};

const ChatHeaderActionsContext = createContext<ChatHeaderActionsValue | null>(null);

export function ChatHeaderActionsProvider({ children }: { children: ReactNode }) {
  const [onMembersPress, setOnMembersPress] = useState<MembersHandler>(null);
  const [onSearchPress, setOnSearchPress] = useState<MembersHandler>(null);
  const [onRenamePress, setOnRenamePress] = useState<MembersHandler>(null);
  const value = useMemo<ChatHeaderActionsValue>(
    () => ({ onMembersPress, setOnMembersPress, onSearchPress, setOnSearchPress, onRenamePress, setOnRenamePress }),
    [onMembersPress, onSearchPress, onRenamePress],
  );
  return (
    <ChatHeaderActionsContext.Provider value={value}>
      {children}
    </ChatHeaderActionsContext.Provider>
  );
}

export function useChatHeaderActions(): ChatHeaderActionsValue {
  const ctx = useContext(ChatHeaderActionsContext);
  if (!ctx) {
    throw new Error(
      "useChatHeaderActions must be used within a ChatHeaderActionsProvider",
    );
  }
  return ctx;
}

/**
 * One explicit, room-scoped action surface. Chat routes must not inherit the
 * app-wide overflow menu: it contains account/theme actions that are unrelated
 * to the conversation and competes with the room title on narrow phones.
 */
export function ChatSettingsHeaderButton() {
  const t = useAppTheme();
  const sheetStyles = useMemo(() => createSheetStyles(t), [t]);
  const ctx = useContext(ChatHeaderActionsContext);
  const [visible, setVisible] = useState(false);
  const pendingHandlerRef = useRef<Exclude<MembersHandler, null> | null>(null);
  if (!ctx || (!ctx.onSearchPress && !ctx.onRenamePress && !ctx.onMembersPress)) return null;

  const invoke = (handler: MembersHandler): void => {
    if (!handler) return;
    pendingHandlerRef.current = handler;
    setVisible(false);
  };

  const handleDismiss = (): void => {
    const handler = pendingHandlerRef.current;
    pendingHandlerRef.current = null;
    handler?.();
  };

  return (
    <>
      <Pressable
        style={sheetStyles.trigger}
        onPress={() => setVisible(true)}
        accessibilityRole="button"
        accessibilityLabel="Chat settings">
        <Ionicons name="options-outline" size={18} color={t.color.text.foreground} />
        <Text style={sheetStyles.triggerLabel}>Chat</Text>
      </Pressable>
      <BottomSheet
        visible={visible}
        onClose={() => setVisible(false)}
        onDismiss={handleDismiss}
        snapPoints={["42%"]}
        scrollable
        backdrop>
        <View style={sheetStyles.sheet} accessibilityViewIsModal>
          <Text style={sheetStyles.title}>Chat</Text>
          {ctx.onSearchPress ? (
            <ChatActionRow icon="search-outline" label="Search in chat" onPress={() => invoke(ctx.onSearchPress)} />
          ) : null}
          {ctx.onRenamePress ? (
            <ChatActionRow icon="pencil-outline" label="Rename chat" onPress={() => invoke(ctx.onRenamePress)} />
          ) : null}
          {ctx.onMembersPress ? (
            <ChatActionRow icon="people-outline" label="People" onPress={() => invoke(ctx.onMembersPress)} />
          ) : null}
        </View>
      </BottomSheet>
    </>
  );
}

function ChatActionRow({ icon, label, onPress }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const t = useAppTheme();
  const sheetStyles = useMemo(() => createSheetStyles(t), [t]);
  return (
    <Pressable
      style={({ pressed }) => [sheetStyles.action, pressed && sheetStyles.actionPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}>
      <Ionicons name={icon} size={20} color={t.color.text.foreground} />
      <Text style={sheetStyles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

function createSheetStyles(t: AppTheme) {
  return StyleSheet.create({
    trigger: {
      minHeight: 40,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: t.spacing.xs,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.sm,
      backgroundColor: t.color.surface.subtle,
    },
    triggerLabel: { color: t.color.text.foreground, ...t.typography.label },
    sheet: { gap: t.spacing.xs },
    title: {
      marginBottom: t.spacing.sm,
      color: t.color.text.foreground,
      ...t.typography.subheading,
    },
    action: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      gap: t.spacing.md,
      paddingHorizontal: t.spacing.sm,
      borderRadius: t.radii.sm,
    },
    actionPressed: { backgroundColor: t.color.surface.subtle },
    actionLabel: { color: t.color.text.foreground, ...t.typography.body },
  });
}
