import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { MessageBubble } from "@/components/message-bubble";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import { ASSISTANT_RESPONSE_GFM_TABLE_FIXTURE } from "../../../../../../dev/fixtures/assistant-response-gfm-table";

const SMALL_TABLE = `A compact table should fit without horizontal movement.

| State | Count |
| --- | ---: |
| Ready | 2 |`;

/** Non-product, auth-independent D531 native layout and gesture surface. */
export default function AssistantMarkdownTableQualificationScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      accessibilityLabel="Assistant Markdown table qualification">
      <Text style={styles.title}>Assistant Markdown table qualification</Text>
      <Text style={styles.instructions}>
        The first message is compact. The second table scrolls horizontally inside its
        bubble while this transcript remains vertical.
      </Text>
      <View style={styles.transcript}>
        <MessageBubble
          role="assistant"
          outgoing={false}
          actionSurface="subthread"
          content={SMALL_TABLE}
          messageId="qualification-small-table"
        />
        <MessageBubble
          role="assistant"
          outgoing={false}
          actionSurface="subthread"
          content={ASSISTANT_RESPONSE_GFM_TABLE_FIXTURE}
          messageId="qualification-wide-table"
          grouped
          senderName="Moxie"
          showSenderName
        />
      </View>
    </ScrollView>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: t.color.surface.background,
    },
    content: {
      padding: t.spacing.lg,
      paddingBottom: t.spacing.xxl,
    },
    title: {
      color: t.color.text.foreground,
      marginBottom: t.spacing.sm,
      ...t.typography.heading,
    },
    instructions: {
      color: t.color.text.muted,
      marginBottom: t.spacing.lg,
      ...t.typography.body,
    },
    transcript: {
      alignSelf: "stretch",
      gap: t.spacing.lg,
    },
  });
}
