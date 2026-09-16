import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { parseBrowserMobileIntent } from "@/platform/browser-intent.web";
import { useAppTheme } from "@/providers/theme";

interface InboundIntentValue {
  readonly notice: { readonly message: string } | null;
  readonly dismissNotice: () => void;
}

const InboundIntentContext = createContext<InboundIntentValue | null>(null);

/** Browser intake observes URLs only; push, share, device, and file receipts do not exist here. */
export function InboundIntentProvider({ children }: { readonly children: ReactNode }) {
  const [notice, setNotice] = useState<InboundIntentValue["notice"]>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const inspect = () => {
      const intent = parseBrowserMobileIntent(window.location.href, window.location.origin);
      if (intent.kind === "rejected") {
        setNotice({ message: "This link is not a supported Mobile Web route." });
      } else {
        setNotice(null);
      }
    };
    inspect();
    window.addEventListener("popstate", inspect);
    return () => window.removeEventListener("popstate", inspect);
  }, []);
  const value = useMemo<InboundIntentValue>(() => ({
    notice,
    dismissNotice: () => setNotice(null),
  }), [notice]);
  return <InboundIntentContext.Provider value={value}>{children}</InboundIntentContext.Provider>;
}

export function InboundIntentNotice() {
  const context = useContext(InboundIntentContext);
  const theme = useAppTheme();
  if (!context?.notice) return null;
  return (
    <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: theme.color.surface.subtle, borderColor: theme.color.status.warning }]}>
      <Text style={[styles.text, { color: theme.color.text.foreground }]}>{context.notice.message}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss link warning" onPress={context.dismissNotice}>
        <Text style={[styles.dismiss, { color: theme.color.status.warning }]}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, paddingHorizontal: 16, paddingVertical: 10 },
  text: { flex: 1, fontSize: 14, fontWeight: "600" },
  dismiss: { fontSize: 14, fontWeight: "700" },
});
