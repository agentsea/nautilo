import { useFocusEffect, router, type Href, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import {
  canToggleMobileSkill,
  createSkillsListController,
  formatMobileSkillTitle,
  MOBILE_MCP_SKILL_MESSAGE,
  mobileSkillKind,
  mobileSkillsProjection,
  skillSettingsErrorMessage,
  type SkillsListController,
} from "@/features/settings/skills-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { SkillListItem } from "@nautilo/api-client/browser";

/** Server catalogue only — the phone does not synthesize Skills or their authority. */
export default function SkillsScreen() {
  const { unavailable } = useLocalSearchParams<{ unavailable?: string }>();
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const serverRef = useRef(activeServer);
  serverRef.current = activeServer;
  const controllerRef = useRef<SkillsListController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createSkillsListController((scope) => {
      const server = serverRef.current;
      if (!server || server.id !== scope.serverId) throw new Error("The active server changed.");
      return getApiClient(server.serverUrl);
    });
  }
  const controller = controllerRef.current;
  const [query, setQuery] = useState("");
  const subscribe = useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]);
  const snapshot = useCallback(() => controller.data.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const scope = useMemo(
    () => settingsScopeForVerifiedViewer(activeServer, {
      status,
      viewerState,
      viewer: viewer && viewerState === "verified" ? viewer : null,
    }),
    [activeServer, status, viewer, viewerState],
  );

  useFocusEffect(useCallback(() => {
    controller.setScope(scope);
    if (scope) void controller.load();
    return () => controller.setScope(null);
  }, [controller, scope]));

  const projection = useMemo(() => state.data ? mobileSkillsProjection(state.data) : null, [state.data]);
  const retryDisabled = !scope || state.loading || state.mutating;
  const skills = projection?.skills ?? [];
  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return skills;
    return skills.filter((skill) =>
      skill.name.toLowerCase().includes(normalized) || skill.description.toLowerCase().includes(normalized),
    );
  }, [query, skills]);
  const goToSkill = (name: string): void => {
    router.push(`/settings/skills/${encodeURIComponent(name)}` as Href);
  };

  return (
    <View style={styles.container}>
      <Screen edgeTop={false} contentStyle={styles.content}>
        <Text style={styles.intro}>Skills add focused instructions to your Agent when they are relevant.</Text>
        {unavailable === "mcp" ? <SettingsStatus tone="warning">{MOBILE_MCP_SKILL_MESSAGE}</SettingsStatus> : null}
        {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before viewing Skills.</SettingsStatus> : null}
        {state.loading && !state.data ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading Skills" /> : null}
        {state.loadError ? <SettingsStatus tone="error">{skillSettingsErrorMessage(state.loadError)}</SettingsStatus> : null}
        {state.loadError && !state.data ? (
          <Pressable
            style={[styles.retryButton, retryDisabled && styles.disabled]}
            onPress={() => void controller.retry()}
            disabled={retryDisabled}
            accessibilityRole="button"
            accessibilityLabel="Try again loading Skills"
            accessibilityHint="Retries loading the Skills catalogue from this server."
            accessibilityState={{ disabled: retryDisabled }}
          >
            <Text style={styles.retryButtonText}>{state.loading ? "Retrying…" : "Try again"}</Text>
          </Pressable>
        ) : null}
        {state.mutationError ? <SettingsStatus tone="error">{skillSettingsErrorMessage(state.mutationError)}</SettingsStatus> : null}
        {projection ? (
          <>
            <View style={styles.summary} accessibilityRole="summary" accessibilityLabel={`${projection.summary.enabled} Skills enabled and ${projection.summary.disabled} disabled`}>
              <Text style={styles.summaryText}>{projection.summary.enabled} enabled · {projection.summary.disabled} disabled</Text>
              <View style={styles.summaryActions}>
                <Pressable
                  onPress={() => router.push("/settings/skills/new" as Href)}
                  disabled={!scope || state.loading || state.mutating}
                  accessibilityRole="button"
                  accessibilityLabel="Create new Skill"
                  accessibilityHint="Opens a form to create a custom Skill on this server."
                  accessibilityState={{ disabled: !scope || state.loading || state.mutating }}
                >
                  <Text style={styles.refresh}>New</Text>
                </Pressable>
                <Pressable
                  onPress={() => void controller.retry()}
                  disabled={state.loading || state.mutating}
                  accessibilityRole="button"
                  accessibilityLabel="Refresh Skills"
                  accessibilityState={{ disabled: state.loading || state.mutating }}
                >
                  <Text style={styles.refresh}>{state.loading ? "Refreshing…" : "Refresh"}</Text>
                </Pressable>
              </View>
            </View>
            <TextInput
              value={query}
              onChangeText={setQuery}
              style={styles.search}
              placeholder="Search Skills"
              placeholderTextColor={t.color.text.dim}
              accessibilityLabel="Search Skills"
              accessibilityHint="Filters the server Skills catalogue by name or description."
            />
            {filteredSkills.length === 0 ? (
              <View style={styles.empty} accessibilityLiveRegion="polite">
                <Text style={styles.emptyTitle}>{skills.length === 0 ? "No Skills available" : "No Skills match your search"}</Text>
                <Text style={styles.helper}>{skills.length === 0 ? "This Agent does not currently expose any Skills on this server." : "Try a different name or description."}</Text>
              </View>
            ) : (
              <View style={styles.list} accessibilityRole="summary" accessibilityLabel="Skills catalogue">
                {filteredSkills.map((item) => (
                  <SkillRow
                    key={item.name}
                    item={item}
                    busy={state.loading || state.mutating}
                    onOpen={() => goToSkill(item.name)}
                    onToggle={() => void controller.setEnabled(item.name, !item.enabled)}
                  />
                ))}
              </View>
            )}
          </>
        ) : null}
      </Screen>
    </View>
  );
}

function SkillRow({ item, busy, onOpen, onToggle }: {
  item: SkillListItem;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const mutable = canToggleMobileSkill(item);
  const kind = mobileSkillKind(item);
  const badge = kind === "official-untouched" ? "Official" : kind === "official-customized" ? "Official · customized" : "Your Skill";
  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.rowCopy, pressed && styles.pressed]}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${formatMobileSkillTitle(item.name)}, ${badge}`}
        accessibilityHint={mutable ? "Opens Skill details and configuration." : "Opens the official Skill and lets you customize a copy."}
      >
        <View style={styles.titleLine}>
          <Text style={styles.rowTitle} numberOfLines={2}>{formatMobileSkillTitle(item.name)}</Text>
          <Text style={styles.badge}>{badge}</Text>
        </View>
        <Text style={styles.description} numberOfLines={3}>{item.description}</Text>
        <Text style={styles.meta} numberOfLines={1}>{item.requiresTools.length ? `Needs ${item.requiresTools.length} ${item.requiresTools.length === 1 ? "capability" : "capabilities"}` : "Genie chooses capabilities"}</Text>
      </Pressable>
      <Pressable
        style={[styles.toggle, item.enabled && styles.toggleOn, (!mutable || busy) && styles.disabled]}
        onPress={onToggle}
        disabled={!mutable || busy}
        accessibilityRole="switch"
        accessibilityLabel={`${item.enabled ? "Disable" : "Enable"} ${item.name}`}
        accessibilityHint={mutable ? "Updates this Skill on the server." : "Customize this official Skill before changing its enabled state."}
        accessibilityState={{ checked: item.enabled, disabled: !mutable || busy }}
      >
        <View style={[styles.knob, item.enabled && styles.knobOn]} />
      </Pressable>
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    content: { gap: t.spacing.md },
    intro: { ...t.typography.body, color: t.color.text.muted },
    summary: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.spacing.md },
    summaryActions: { flexDirection: "row", alignItems: "center", gap: t.spacing.md },
    summaryText: { ...t.typography.caption, color: t.color.text.muted },
    refresh: { ...t.typography.label, color: t.color.brand.accent },
    retryButton: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.brand.accent },
    retryButtonText: { ...t.typography.label, color: t.color.brand.accent },
    search: { minHeight: 44, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, borderRadius: t.radii.sm, borderWidth: 1, borderColor: t.color.border.default, color: t.color.text.foreground, backgroundColor: t.color.surface.panel, ...t.typography.body },
    list: { overflow: "hidden", borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default },
    row: { flexDirection: "row", alignItems: "center", gap: t.spacing.md, minHeight: 88, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default },
    rowCopy: { flex: 1, gap: 4 },
    titleLine: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.spacing.sm },
    rowTitle: { ...t.typography.bodyStrong, color: t.color.text.foreground, flexShrink: 1 },
    badge: { ...t.typography.caption, color: t.color.brand.accent },
    description: { ...t.typography.caption, color: t.color.text.muted },
    meta: { ...t.typography.caption, color: t.color.text.dim },
    toggle: { width: 44, height: 26, padding: 3, borderRadius: t.radii.pill, backgroundColor: t.color.border.strong, justifyContent: "center" },
    toggleOn: { backgroundColor: t.color.status.success },
    knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: t.color.surface.background },
    knobOn: { alignSelf: "flex-end" },
    disabled: { opacity: 0.55 },
    empty: { gap: t.spacing.sm, padding: t.spacing.lg, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default },
    emptyTitle: { ...t.typography.subheading, color: t.color.text.foreground },
    helper: { ...t.typography.body, color: t.color.text.muted },
    pressed: { opacity: 0.7 },
  });
}
