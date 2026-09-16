import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getApiClient } from "@/lib/api";
import { useAppTheme } from "@/providers/theme";
import { WorkspaceShareSession, type SharePerson } from "./workspace-share-session";

/** Parent keys this mounted session by server, viewer, file, and origin Room. */
export function WorkspaceShareSheet({ serverUrl, artifactId, path, roomId, viewerId, isCurrent, onClose, embedded = false }: {
  serverUrl: string; artifactId: string; path: string; roomId?: string; viewerId: string;
  isCurrent: () => boolean; onClose: () => void;
  embedded?: boolean;
}) {
  const t = useAppTheme();
  const insets = useSafeAreaInsets();
  const client = useMemo(() => getApiClient(serverUrl), [serverUrl]);
  const [session] = useState(() => new WorkspaceShareSession({ client, artifactId, roomId, isCurrent }));
  // Publish immutable render state; a mutable coordinator is not a React
  // dependency (including when the React Compiler memoizes derived values).
  const [deliveryState, setDeliveryState] = useState(() => ({ busy: false, attempted: false, deliveries: session.deliveries }));
  const publishDelivery = (): void => setDeliveryState({ busy: session.busy, attempted: session.attempted, deliveries: session.deliveries.map(item => ({ ...item })) });
  useEffect(() => { session.activate(); return () => session.dispose(); }, [session]);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<SharePerson[]>([]);
  const [selected, setSelected] = useState<SharePerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const searchGeneration = useRef(0);
  useEffect(() => {
    const generation = ++searchGeneration.current;
    setLoading(true); setError(false);
    void client.searchDirectory({ q: query, kind: "user", offset }).then(rows => {
      if (generation !== searchGeneration.current || !isCurrent()) return;
      const eligible = rows.filter(person => person.kind === "user" && person.id !== viewerId && person.actionable);
      setPeople(current => offset ? [...new Map([...current, ...eligible].map(person => [person.id, person])).values()] : eligible);
      // The API does not return a total; allow continuation until an empty page.
      setHasMore(rows.length > 0);
      loadedOffset.current = offset + rows.length;
    }).catch(() => {
      if (generation === searchGeneration.current && isCurrent()) setError(true);
    }).finally(() => {
      if (generation === searchGeneration.current && isCurrent()) setLoading(false);
    });
    return () => { searchGeneration.current++; };
  }, [client, isCurrent, offset, query, retry, viewerId]);
  const loadedOffset = useRef(0);
  const close = (): void => { if (!session.busy) onClose(); };
  const completed = deliveryState.deliveries.filter(item => item.status === "shared").length;
  const failed = deliveryState.deliveries.filter(item => item.status === "failed");
  const styles = useMemo(() => StyleSheet.create({
    root: { flex: 1, justifyContent: "flex-end", backgroundColor: t.color.surface.overlay },
    sheet: { maxHeight: "100%", flexShrink: 1, backgroundColor: t.color.surface.panel, padding: t.spacing.lg, paddingBottom: Math.max(insets.bottom, t.spacing.lg), borderTopLeftRadius: t.radii.lg, borderTopRightRadius: t.radii.lg, gap: t.spacing.md },
    body: { flexShrink: 1 },
    bodyContent: { gap: t.spacing.md },
    actions: { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: t.spacing.md },
    title: { color: t.color.text.foreground, ...t.typography.subheading },
    detail: { color: t.color.text.muted, ...t.typography.caption },
    row: { minHeight: 48, flexDirection: "row", alignItems: "center", paddingVertical: t.spacing.md, gap: t.spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default },
    text: { color: t.color.text.foreground, ...t.typography.body },
    action: { color: t.color.brand.accent, ...t.typography.label },
    input: { borderWidth: 1, borderColor: t.color.border.interactive, borderRadius: t.radii.md, padding: t.spacing.md, color: t.color.text.foreground, ...t.typography.body },
    primary: { flex: 1, backgroundColor: t.color.action.primaryBg, borderRadius: t.radii.md, padding: t.spacing.md, alignItems: "center" },
  }), [insets.bottom, t]);
  const content = <View style={styles.sheet} accessibilityViewIsModal>
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>Add file to workspace</Text>
        <Text style={styles.detail}>{path}</Text>
        {!deliveryState.attempted ? <>
          <TextInput accessibilityLabel="Search people by name or handle" placeholder="Search people by name or @handle" placeholderTextColor={t.color.text.dim}
            autoCapitalize="none" autoCorrect={false} value={query} style={styles.input} onChangeText={value => { setQuery(value); setOffset(0); setPeople([]); }} />
          {selected.length ? <ScrollView horizontal keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>{selected.map(person => <Pressable key={person.id} accessibilityRole="button" accessibilityLabel={`Remove ${person.displayName || person.handle} from selection`} onPress={() => setSelected(current => current.filter(item => item.id !== person.id))} style={{ padding: t.spacing.sm }}><Text style={styles.action}>{person.displayName || person.handle} ×</Text></Pressable>)}</ScrollView> : null}
          <View>
            {people.map(person => {
              const checked = selected.some(item => item.id === person.id);
              return <Pressable key={person.id} accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={person.displayName || person.handle} style={styles.row}
                onPress={() => setSelected(current => checked ? current.filter(item => item.id !== person.id) : [...current, person])}>
                <View style={{ flex: 1 }}><Text style={styles.text}>{person.displayName || person.handle}</Text><Text style={styles.detail}>@{person.handle}</Text></View>
                <Text style={styles.action}>{checked ? "✓" : "○"}</Text>
              </Pressable>;
            })}
            {loading ? <ActivityIndicator accessibilityLabel="Loading people" color={t.color.brand.accent} /> : error ? <>
              <Text accessibilityRole="alert" style={styles.detail}>Could not load people. Your selection is preserved.</Text>
              <Pressable accessibilityRole="button" onPress={() => setRetry(value => value + 1)} style={styles.row}><Text style={styles.action}>Retry search</Text></Pressable>
            </> : <>
              {!people.length ? <Text style={styles.detail}>No people found.</Text> : null}
              {hasMore ? <Pressable accessibilityRole="button" style={styles.row} onPress={() => setOffset(loadedOffset.current)}><Text style={styles.action}>Load more people</Text></Pressable> : null}
            </>}
          </View>
        </> : <View><Text accessibilityLiveRegion="polite" style={styles.text}>{completed} of {deliveryState.deliveries.length} shared{deliveryState.busy ? " · Adding…" : ""}</Text>
          {failed.map(item => <Text key={item.person.id} style={styles.detail}>{item.person.displayName}: {item.error}</Text>)}
        </View>}
        <Text style={styles.detail}>Adds the same file to their workspace, not a separate copy. No chat message is sent.</Text>
      </ScrollView>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" disabled={deliveryState.busy} onPress={close} style={{ padding: t.spacing.sm, alignItems: "center" }}><Text style={styles.action}>{deliveryState.attempted ? "Done" : "Cancel"}</Text></Pressable>
        {(!deliveryState.attempted || failed.length > 0 || deliveryState.busy) ? <Pressable accessibilityRole="button" disabled={deliveryState.busy || !selected.length}
          style={[styles.primary, (deliveryState.busy || !selected.length) && { opacity: 0.5 }]}
          onPress={() => void session.deliver(selected, publishDelivery)}>
          <Text style={{ color: t.color.text.onPrimary, ...t.typography.label }}>{deliveryState.busy ? "Adding…" : deliveryState.attempted ? "Retry failed deliveries" : selected.length === 1 ? `Add to ${selected[0].displayName || selected[0].handle}’s workspace` : "Add to workspaces"}</Text>
        </Pressable> : null}
      </View>
      </View>;
  if (embedded) return content;
  return <Modal transparent visible onRequestClose={close}>
    <KeyboardAvoidingView behavior="padding" style={[styles.root, { paddingTop: insets.top }]}>
      <Pressable style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel="Dismiss workspace sharing" disabled={session.busy} onPress={close} />
      {content}
    </KeyboardAvoidingView>
  </Modal>;
}
