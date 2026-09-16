import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAttention } from "@/providers/attention";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { HostChoiceEvent } from "@nautilo/types";

export function HostChoiceCard({ choice }: { choice: HostChoiceEvent }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { replyToHostChoice } = useAttention();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const select = async (selector: string) => {
    if (pending) return;
    setPending(selector);
    setError(null);
    const result = await replyToHostChoice(choice, selector);
    if (!result.ok) {
      setPending(null);
      setError("That computer is no longer available. Try the request again.");
    }
  };

  return (
    <View style={styles.card} accessibilityLabel="Choose a computer">
      <Text style={styles.eyebrow}>Choose a computer</Text>
      <Text style={styles.detail}>
        Choose which paired computer your agent should use for this request.
      </Text>
      <View style={styles.options}>
        {choice.options.map((option) => (
          <Pressable
            key={option.selector}
            style={styles.option}
            disabled={pending !== null}
            onPress={() => void select(option.selector)}
            accessibilityRole="button"
            accessibilityLabel={`Use ${option.label}`}
          >
            {pending === option.selector ? (
              <ActivityIndicator size="small" color={theme.color.text.foreground} />
            ) : (
              <Text style={styles.optionText}>{option.label}</Text>
            )}
          </Pressable>
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    card: {
      marginHorizontal: t.spacing.md,
      marginBottom: t.spacing.sm,
      padding: t.spacing.md,
      borderRadius: t.radii.md,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.element,
      gap: t.spacing.sm,
    },
    eyebrow: { color: t.color.text.foreground, fontSize: 16, fontWeight: "700" },
    detail: { color: t.color.text.muted, fontSize: 14 },
    options: { gap: t.spacing.xs },
    option: {
      minHeight: 48,
      justifyContent: "center",
      paddingHorizontal: t.spacing.md,
      borderRadius: t.radii.sm,
      borderWidth: 1,
      borderColor: t.color.border.default,
      backgroundColor: t.color.surface.panel,
    },
    optionText: { color: t.color.text.foreground, fontSize: 16, fontWeight: "600" },
    error: { color: t.color.status.error, fontSize: 14 },
  });
}
