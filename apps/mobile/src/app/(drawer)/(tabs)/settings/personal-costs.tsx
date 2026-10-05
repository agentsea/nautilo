import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { PersonalCostsRangeKey } from "@nautilo/api-client/browser";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import { createPersonalCostsController, personalAccountErrorMessage, type PersonalCostsController } from "@/features/settings/personal-account-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

const RANGES: readonly PersonalCostsRangeKey[] = ["7d", "30d", "90d"];
const usd = (value: number): string => `$${value.toFixed(value >= 0.01 ? 2 : 6)}`;
const integer = (value: number): string => new Intl.NumberFormat().format(value);

export default function PersonalCostsScreen() {
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const serverRef = useRef(activeServer); serverRef.current = activeServer;
  const controllerRef = useRef<PersonalCostsController | null>(null);
  if (!controllerRef.current) controllerRef.current = createPersonalCostsController((scope) => {
    const server = serverRef.current;
    if (!server || server.id !== scope.serverId) throw new Error("The active server changed.");
    return getApiClient(server.serverUrl);
  });
  const controller = controllerRef.current;
  const subscribe = useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]);
  const snapshot = useCallback(() => controller.data.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, { status, viewerState, viewer }), [activeServer, status, viewer, viewerState]);
  useFocusEffect(useCallback(() => { controller.setScope(scope); if (scope) void controller.load(); return () => controller.setScope(null); }, [controller, scope]));
  const range = state.data?.range.key ?? state.draft?.range ?? "30d";
  const data = state.data;
  const unresolved = data ? data.recovery.pendingAttempts + data.recovery.unknownAttempts : 0;
  const goBack = (): void => router.canGoBack() ? router.back() : router.replace("/(drawer)/(tabs)/settings");

  return <View style={styles.container}>
    <Stack.Screen options={{ header: () => <AppBar title="Your costs" left={<AppBarBackButton onPress={goBack} />} /> }} />
    <Screen edgeTop={false} contentStyle={styles.content}>
      <Text style={styles.intro}>Charges and estimates for work paid with your personal provider keys. Server-funded work is kept separate.</Text>
      {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before viewing your costs.</SettingsStatus> : null}
      <View style={styles.ranges}>{RANGES.map((value) => <Pressable key={value} disabled={!scope || state.loading} onPress={() => void controller.setRange(value)} style={[styles.range, range === value && styles.rangeSelected]} accessibilityRole="button" accessibilityState={{ selected: range === value, disabled: !scope || state.loading }}><Text style={[styles.rangeText, range === value && styles.rangeTextSelected]}>{value}</Text></Pressable>)}</View>
      {state.loading ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading your personal costs" /> : null}
      {state.loadError ? <><SettingsStatus tone="error">{personalAccountErrorMessage(state.loadError)}</SettingsStatus><Pressable style={styles.button} onPress={() => void controller.retry()} accessibilityRole="button"><Text style={styles.buttonText}>Retry</Text></Pressable></> : null}
      {!state.loading && data && !data.entry.available ? <View style={styles.card}><Text style={styles.title}>No personal-key costs yet</Text><Text style={styles.help}>Add a supported key first. This panel will be available before your first paid request and will retain your history if the key is later removed.</Text><Pressable onPress={() => router.push("/settings/provider-keys")} style={styles.button} accessibilityRole="button"><Text style={styles.buttonText}>Manage personal keys</Text></Pressable></View> : null}
      {data?.entry.available ? <>
        <View style={styles.summary}><Metric label="Known personal-key cost" value={usd(data.totals.totalCostUsd)} detail={`${usd(data.totals.actualCostUsd)} actual · ${usd(data.totals.estimatedCostUsd)} estimated${unresolved > 0 ? " · unresolved charges excluded" : ""}`} /><Metric label="Model attempts" value={integer(data.totals.calls)} detail={`${integer(data.totals.totalTokens)} tokens`} /></View>
        {unresolved > 0 ? <SettingsStatus tone="warning">{`${integer(unresolved)} costs are unresolved. Pending ${integer(data.recovery.pendingAttempts)}, unknown ${integer(data.recovery.unknownAttempts)}. Of these, ${integer(data.recovery.retryableAttempts)} are retrying and ${integer(data.recovery.blockedAttempts)} are blocked.`}</SettingsStatus> : <SettingsStatus tone="success">All reported personal-key costs in this period are settled.</SettingsStatus>}
        {data.recovery.blockedAttempts > 0 ? <Text style={styles.warning}>A provider key cannot currently read cost receipts. Grant receipt-read permission to the key that created those requests, then use Check again in Personal API keys. Receipts from a removed or replaced key may remain unresolved.</Text> : null}
        <Text style={styles.sectionLabel}>MODELS PAID BY YOU</Text>
        {data.byModel.length === 0 ? <Text style={styles.help}>No personal-key model usage in this period.</Text> : data.byModel.map((row) => { const rowUnresolved = row.pendingAttempts + row.unknownAttempts; const costPending = row.totalCostUsd === 0 && rowUnresolved > 0; return <View key={`${row.provider}:${row.model}`} style={styles.card}><View style={styles.modelRow}><View style={styles.modelCopy}><Text style={styles.title}>{row.displayName}</Text><Text style={styles.help}>{row.provider} · {integer(row.calls)} attempts · {integer(row.inputTokens + row.outputTokens)} tokens</Text></View><Text style={styles.cost}>{costPending ? "Cost pending" : usd(row.totalCostUsd)}</Text></View><Text style={styles.help}>{costPending ? "Unknown or pending receipt" : row.hasActual ? "Includes actual provider charges" : "Estimated cost"}{rowUnresolved > 0 ? " · unresolved attempts remain" : ""}</Text></View>; })}
        <Text style={styles.sectionLabel}>PROVIDER ROUTES</Text>
        <Text style={styles.help}>The marketplace or direct provider that actually handled each operation.</Text>
        {data.byProvider.length === 0 ? <Text style={styles.help}>No personal-key provider usage in this period.</Text> : data.byProvider.map((row) => { const costPending = row.totalCostUsd === 0 && row.unknownOperations > 0; return <View key={`${row.provider}:${row.operation}`} style={styles.card}><View style={styles.modelRow}><View style={styles.modelCopy}><Text style={styles.title}>{row.provider} / {row.operation}</Text><Text style={styles.help}>{integer(row.operations)} operations{row.unknownOperations > 0 ? ` · ${integer(row.unknownOperations)} unresolved` : ""}</Text></View><Text style={styles.cost}>{costPending ? "Cost pending" : usd(row.totalCostUsd)}</Text></View><Text style={styles.help}>{costPending ? "Unknown or pending receipt" : `${usd(row.actualCostUsd)} actual · ${usd(row.estimatedCostUsd)} estimated`}{row.unknownOperations > 0 ? " · unresolved charges excluded" : ""}</Text></View>; })}
      </> : null}
    </Screen>
  </View>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { const t = useAppTheme(); const styles = useMemo(() => createStyles(t), [t]); return <View style={styles.metric}><Text style={styles.help}>{label}</Text><Text style={styles.metricValue}>{value}</Text><Text style={styles.help}>{detail}</Text></View>; }
function createStyles(t: AppTheme) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: t.color.surface.background }, content: { gap: t.spacing.lg }, intro: { ...t.typography.body, color: t.color.text.muted }, ranges: { flexDirection: "row", gap: t.spacing.sm }, range: { minHeight: 44, minWidth: 60, alignItems: "center", justifyContent: "center", paddingHorizontal: t.spacing.md, borderRadius: t.radii.pill, borderWidth: 1, borderColor: t.color.border.default }, rangeSelected: { borderColor: t.color.brand.accent, backgroundColor: t.color.surface.subtle }, rangeText: { ...t.typography.label, color: t.color.text.muted }, rangeTextSelected: { color: t.color.text.foreground },
  summary: { gap: t.spacing.md }, metric: { gap: t.spacing.xs, padding: t.spacing.lg, borderRadius: t.radii.lg, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, metricValue: { ...t.typography.heading, color: t.color.text.foreground },
  card: { gap: t.spacing.sm, padding: t.spacing.lg, borderRadius: t.radii.lg, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default }, title: { ...t.typography.subheading, color: t.color.text.foreground }, help: { ...t.typography.caption, color: t.color.text.muted }, warning: { ...t.typography.caption, color: t.color.status.warning }, sectionLabel: { ...t.typography.caption, color: t.color.text.muted, fontWeight: "700", letterSpacing: 0.7 }, modelRow: { flexDirection: "row", alignItems: "flex-start", gap: t.spacing.md }, modelCopy: { flex: 1, gap: 2 }, cost: { ...t.typography.bodyStrong, color: t.color.text.foreground },
  button: { alignSelf: "flex-start", minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.color.border.default }, buttonText: { ...t.typography.label, color: t.color.text.foreground },
}); }
