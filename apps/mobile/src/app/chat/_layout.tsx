// D383 Stage 1 — chat stack with shared AppBar headers for conversation routes.
// Dynamic room titles: chat/[roomId].tsx should call navigation.setOptions({ title })
// once the label loads (owned by the conversation agent — do not duplicate inline headers).
// Room actions remain screen-owned, but the header exposes them through one
// explicit Chat surface so narrow titles never compete with an icon cluster.
import { Stack, router } from "expo-router";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import {
  ChatHeaderActionsProvider,
  ChatSettingsHeaderButton,
} from "@/components/chat-header-actions";

export default function ChatLayout() {
  return (
    <ChatHeaderActionsProvider>
      <Stack
        screenOptions={{
          headerShown: true,
          header: ({ options }) => (
            <AppBar
              title={typeof options.title === "string" ? options.title : "Chat"}
              left={<AppBarBackButton onPress={() => router.back()} />}
              rightExtra={<ChatSettingsHeaderButton />}
              showOverflow={false}
            />
          ),
        }}
      >
        <Stack.Screen name="[roomId]" options={{ title: "Chat" }} />
        <Stack.Screen name="thread/[threadRoomId]" options={{ title: "Thread" }} />
        <Stack.Screen name="new" options={{ title: "New chat" }} />
      </Stack>
    </ChatHeaderActionsProvider>
  );
}
