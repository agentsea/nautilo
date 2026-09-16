import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsConfirmation } from "@/components/settings/settings-confirmation";
import { SettingsStatus } from "@/components/settings/settings-status";
import {
  canDeleteMobileSkill,
  canConfigureMobileSkill,
  canResetMobileSkill,
  createSkillDetailController,
  formatMobileSkillTitle,
  isMobileVisibleSkill,
  MOBILE_MCP_SKILL_MESSAGE,
  mobileSkillKind,
  mobileSkillRequirementsMessage,
  mobileSkillToolOptions,
  skillSettingsErrorMessage,
  type SkillDetailController,
} from "@/features/settings/skills-controller";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";
import type { SkillToolOption } from "@nautilo/api-client/browser";

/** Read an official Skill or configure a server-created custom copy. */
export default function SkillDetailScreen() {
  const { name: rawName } = useLocalSearchParams<{ name: string }>();
  const name = typeof rawName === "string" ? rawName : "";
  const isNew = name === "new";
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const serverRef = useRef(activeServer);
  serverRef.current = activeServer;
  const controllerRef = useRef<SkillDetailController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createSkillDetailController((scope) => {
      const server = serverRef.current;
      if (!server || server.id !== scope.serverId) throw new Error("The active server changed.");
      return getApiClient(server.serverUrl);
    });
  }
  const controller = controllerRef.current;
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
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [requiresTools, setRequiresTools] = useState<string[]>([]);
  const [toolOptions, setToolOptions] = useState<SkillToolOption[]>([]);
  const [toolOptionsLoading, setToolOptionsLoading] = useState(false);
  const [toolOptionsError, setToolOptionsError] = useState<string | null>(null);
  const [toolSearch, setToolSearch] = useState("");
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [newName, setNewName] = useState("");
  const [confirmation, setConfirmation] = useState<"reset" | "delete" | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    controller.setScope(scope);
    if (scope && name && !isNew) void controller.load(name);
    let active = true;
    if (scope && activeServer) {
      setToolOptions([]);
      setToolOptionsLoading(true);
      setToolOptionsError(null);
      void getApiClient(activeServer.serverUrl).listSkillToolOptions()
        .then((options) => { if (active) setToolOptions(mobileSkillToolOptions(options)); })
        .catch((cause: unknown) => {
          if (active) setToolOptionsError(skillSettingsErrorMessage(cause));
        })
        .finally(() => { if (active) setToolOptionsLoading(false); });
    }
    return () => {
      active = false;
      controller.setScope(null);
    };
  }, [activeServer, controller, isNew, name, scope]));

  useEffect(() => {
    const skill = state.data;
    if (!skill) return;
    setDescription(skill.description);
    setBody(skill.body);
    setRequiresTools(skill.requiresTools);
    setEnabled(skill.enabled);
  }, [state.data]);

  // Keep a previous route's retained response from being editable while the
  // detail request for the new route is still in flight.
  const skill = !isNew && state.data?.name === name ? state.data : null;
  const unavailableOnMobile = !!skill && !isMobileVisibleSkill(skill);
  useEffect(() => {
    if (unavailableOnMobile) {
      router.replace({ pathname: "/settings/skills", params: { unavailable: "mcp" } });
    }
  }, [unavailableOnMobile]);
  const kind = skill ? mobileSkillKind(skill) : null;
  const editable = !unavailableOnMobile && (isNew || (skill ? canConfigureMobileSkill(skill) : false));
  const busy = state.loading || state.mutating;
  const retryDisabled = !scope || busy;
  const visibleToolOptions = useMemo(() => {
    const query = toolSearch.trim().toLocaleLowerCase();
    const known = new Set(toolOptions.map((option) => option.name));
    const unavailable = !toolOptionsLoading && !toolOptionsError ? requiresTools
      .filter((toolName) => !known.has(toolName))
      .map((toolName): SkillToolOption => ({
        name: toolName,
        label: "Unavailable capability",
        description: "This saved requirement is no longer available. Remove it before saving.",
        category: "unavailable",
      })) : [];
    return [...toolOptions, ...unavailable].filter((option) =>
      !query || option.label.toLocaleLowerCase().includes(query));
  }, [requiresTools, toolOptions, toolOptionsError, toolOptionsLoading, toolSearch]);
  const toggleRequiredTool = (toolName: string): void => {
    setRequiresTools((current) => current.includes(toolName)
      ? current.filter((name) => name !== toolName)
      : [...current, toolName]);
    setPolicyError(null);
  };
  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/(drawer)/(tabs)/settings/skills");
  };
  const save = (): void => {
    if (!skill || !editable) return;
    const input = {
      name: skill.name,
      description: description.trim(),
      body: body.trim(),
      enabled,
      requiresTools,
    };
    const rejection = mobileSkillRequirementsMessage(input);
    if (rejection) {
      setPolicyError(rejection);
      return;
    }
    setPolicyError(null);
    void controller.save(input);
  };
  const create = (): void => {
    const input = {
      name: newName.trim(),
      description: description.trim(),
      body: body.trim(),
      enabled,
      requiresTools,
    };
    const rejection = mobileSkillRequirementsMessage(input);
    if (rejection) {
      setPolicyError(rejection);
      return;
    }
    setPolicyError(null);
    void controller.create(input).then((result) => {
      if (result.status === "applied") {
        router.replace(`/settings/skills/${encodeURIComponent(result.data.name)}`);
      }
    });
  };
  const confirmMutation = (): void => {
    if (confirmation === "reset") {
      void controller.reset().then((result) => {
        if (result.status === "applied") setConfirmation(null);
      });
      return;
    }
    if (confirmation === "delete") {
      void controller.delete().then((result) => {
        if (result.status === "applied") {
          setConfirmation(null);
          goBack();
        }
      });
    }
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ header: () => <AppBar title={isNew ? "New Skill" : skill ? formatMobileSkillTitle(skill.name) : "Skill"} left={<AppBarBackButton onPress={goBack} />} /> }} />
      <Screen edgeTop={false} contentStyle={styles.content}>
        {!scope ? <SettingsStatus tone="warning">Sign in and reconnect before managing this Skill.</SettingsStatus> : null}
        {state.loading && !skill ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading Skill" /> : null}
        {state.loadError ? <SettingsStatus tone="error">{skillSettingsErrorMessage(state.loadError)}</SettingsStatus> : null}
        {state.loadError && !skill && !isNew ? (
          <Pressable
            style={[styles.secondaryButton, retryDisabled && styles.disabled]}
            onPress={() => void controller.retry(name)}
            disabled={retryDisabled}
            accessibilityRole="button"
            accessibilityLabel="Try again loading this Skill"
            accessibilityHint="Retries loading this Skill from this server."
            accessibilityState={{ disabled: retryDisabled }}
          >
            <Text style={styles.secondaryButtonText}>{state.loading ? "Retrying…" : "Try again"}</Text>
          </Pressable>
        ) : null}
        {state.mutationError ? <SettingsStatus tone="error">{skillSettingsErrorMessage(state.mutationError)}</SettingsStatus> : null}
        {policyError ? <SettingsStatus tone="warning">{policyError}</SettingsStatus> : null}
        {unavailableOnMobile ? <SettingsStatus tone="warning">{MOBILE_MCP_SKILL_MESSAGE}</SettingsStatus> : null}
        {(skill || isNew) && !unavailableOnMobile ? (
          <>
            <View style={styles.identity}>
              <Text style={styles.slug}>{isNew ? "Create a custom Skill" : skill!.name}</Text>
              <Text style={styles.meta}>{isNew ? "Stored and enabled by this server" : `${skill!.official ? (skill!.forked ? "Official Skill · customized" : "Official Skill") : "Your Skill"} · ${skill!.tokenEstimate} tokens`}</Text>
            </View>
            {kind === "official-untouched" ? (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>Official Skills are read-only. Customize this Skill to create your server-managed copy, then configure or disable it.</Text>
                <Pressable
                  style={[styles.primaryButton, (state.loading || state.mutating) && styles.disabled]}
                  onPress={() => void controller.customize()}
                  disabled={!scope || state.loading || state.mutating}
                  accessibilityRole="button"
                  accessibilityLabel={`Customize ${skill?.name ?? "Skill"}`}
                  accessibilityHint="Creates your editable server copy of this official Skill."
                  accessibilityState={{ disabled: !scope || state.loading || state.mutating }}
                >
                  <Text style={styles.primaryButtonText}>{state.mutating ? "Customizing…" : "Customize"}</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.form}>
              {isNew ? (
                <View style={styles.field}>
                  <Text style={styles.label}>Name</Text>
                  <TextInput
                    value={newName}
                    onChangeText={setNewName}
                    editable={!busy}
                    autoCapitalize="none"
                    style={styles.input}
                    placeholder="meeting-notes"
                    placeholderTextColor={t.color.text.dim}
                    accessibilityLabel="Skill name"
                    accessibilityHint="The server name used to identify this Skill."
                  />
                </View>
              ) : null}
              <View style={styles.field}>
                <Text style={styles.label}>Description</Text>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  editable={editable && !busy}
                  style={[styles.input, !editable && styles.readOnly]}
                  accessibilityLabel="Skill description"
                  accessibilityHint="Shown in the Agent's Skill catalogue."
                />
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>Needed capabilities</Text>
                <Pressable
                  style={[styles.capabilitySummary, busy && styles.disabled]}
                  onPress={() => setShowCapabilities((value) => !value)}
                  disabled={busy || toolOptionsLoading}
                  accessibilityRole="button"
                  accessibilityLabel="Choose needed capabilities"
                  accessibilityHint="Opens a list of capabilities this Skill may require."
                  accessibilityState={{ expanded: showCapabilities, disabled: busy || toolOptionsLoading }}
                  accessibilityValue={{
                    text: requiresTools.length === 0
                      ? "Genie chooses from available capabilities"
                      : `${requiresTools.length} selected`,
                  }}
                >
                  <Text style={styles.capabilitySummaryText}>
                    {requiresTools.length === 0 ? "Let Genie use what is available" : `${requiresTools.length} selected`}
                  </Text>
                  <Text style={styles.capabilityChevron}>{showCapabilities ? "⌃" : "⌄"}</Text>
                </Pressable>
                <Text style={styles.helper}>Usually leave this empty—Genie chooses what to use. Select only capabilities this Skill cannot work without.</Text>
                {showCapabilities ? (
                  <View style={styles.capabilityPicker}>
                    <TextInput
                      value={toolSearch}
                      onChangeText={setToolSearch}
                      editable={editable && !busy}
                      style={styles.input}
                      placeholder="Search capabilities"
                      placeholderTextColor={t.color.text.dim}
                      accessibilityLabel="Search capabilities"
                    />
                    {toolOptionsLoading ? <ActivityIndicator color={t.color.brand.accent} accessibilityLabel="Loading capabilities" /> : null}
                    {toolOptionsError ? <SettingsStatus tone="error">{toolOptionsError}</SettingsStatus> : null}
                    {visibleToolOptions.map((option) => {
                      const selected = requiresTools.includes(option.name);
                      return (
                        <Pressable
                          key={option.name}
                          style={[styles.capabilityOption, selected && styles.capabilityOptionSelected]}
                          onPress={() => toggleRequiredTool(option.name)}
                          disabled={!editable || busy || toolOptionsLoading}
                          accessibilityRole="checkbox"
                          accessibilityLabel={option.label}
                          accessibilityHint={selected ? "Removes this required capability." : "Adds this required capability."}
                          accessibilityState={{ checked: selected, disabled: !editable || busy || toolOptionsLoading }}
                        >
                          <View style={styles.capabilityCopy}>
                            <Text style={styles.capabilityLabel}>{option.label}</Text>
                          </View>
                          <View style={[styles.capabilityCheck, selected && styles.capabilityCheckSelected]}>
                            {selected ? <Text style={styles.capabilityCheckMark}>✓</Text> : null}
                          </View>
                        </Pressable>
                      );
                    })}
                    {!toolOptionsLoading && !toolOptionsError && visibleToolOptions.length === 0 ? (
                      <Text style={styles.helper}>No matching capabilities.</Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>Instructions</Text>
                <TextInput
                  value={body}
                  onChangeText={setBody}
                  editable={editable && !busy}
                  multiline
                  scrollEnabled
                  textAlignVertical="top"
                  style={[styles.input, styles.bodyInput, !editable && styles.readOnly]}
                  accessibilityLabel="Skill instructions"
                  accessibilityHint="The SKILL.md instructions sent to your Agent when this Skill is selected."
                />
              </View>
              <View style={styles.enabledRow}>
                <View style={styles.enabledCopy}>
                  <Text style={styles.label}>Enabled</Text>
                  <Text style={styles.helper}>Available to your Agent when relevant.</Text>
                </View>
                <Pressable
                  style={[styles.toggle, enabled && styles.toggleOn, (!editable || busy) && styles.disabled]}
                  onPress={() => setEnabled((current) => !current)}
                  disabled={!editable || busy}
                  accessibilityRole="switch"
                  accessibilityLabel="Skill enabled"
                  accessibilityState={{ checked: enabled, disabled: !editable || busy }}
                >
                  <View style={[styles.knob, enabled && styles.knobOn]} />
                </Pressable>
              </View>
              {editable ? (
                <Pressable
                  style={[styles.primaryButton, (!scope || busy) && styles.disabled]}
                  onPress={isNew ? create : save}
                  disabled={!scope || busy || toolOptionsLoading}
                  accessibilityRole="button"
                  accessibilityLabel={isNew ? "Create Skill" : "Save Skill configuration"}
                  accessibilityHint={isNew ? "Creates this custom Skill on the server." : "Saves this Skill, then refreshes the server copy."}
                  accessibilityState={{ disabled: !scope || busy || toolOptionsLoading }}
                >
                  <Text style={styles.primaryButtonText}>{state.mutating ? (isNew ? "Creating…" : "Saving…") : (isNew ? "Create Skill" : "Save changes")}</Text>
                </Pressable>
              ) : null}
              {!isNew && skill && canResetMobileSkill(skill) ? (
                <Pressable
                  style={[styles.secondaryButton, busy && styles.disabled]}
                  onPress={() => setConfirmation("reset")}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Reset ${skill.name} to official`}
                  accessibilityHint="Shows confirmation before discarding this customized official copy."
                >
                  <Text style={styles.secondaryButtonText}>Reset to official</Text>
                </Pressable>
              ) : null}
              {!isNew && skill && canDeleteMobileSkill(skill) ? (
                <Pressable
                  style={[styles.deleteButton, busy && styles.disabled]}
                  onPress={() => setConfirmation("delete")}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${skill.name}`}
                  accessibilityHint="Shows confirmation before permanently removing this custom Skill."
                >
                  <Text style={styles.deleteButtonText}>Delete Skill</Text>
                </Pressable>
              ) : null}
            </View>
          </>
        ) : null}
      </Screen>
      <SettingsConfirmation
        visible={confirmation !== null}
        title={confirmation === "delete" ? `Delete “${skill?.name ?? ""}”?` : `Reset “${skill?.name ?? ""}”?`}
        message={confirmation === "delete"
          ? `Delete the custom Skill “${skill?.name ?? ""}” from this server? This cannot be undone.`
          : `Discard your customized copy of “${skill?.name ?? ""}” and restore the official Skill?`}
        confirmLabel={confirmation === "delete" ? "Delete Skill" : "Reset to official"}
        destructive={confirmation === "delete"}
        busy={busy}
        onCancel={() => { if (!busy) setConfirmation(null); }}
        onConfirm={confirmMutation}
      />
    </View>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background },
    content: { gap: t.spacing.lg },
    identity: { gap: 4 },
    slug: { ...t.typography.subheading, color: t.color.text.foreground },
    meta: { ...t.typography.caption, color: t.color.text.muted },
    notice: { gap: t.spacing.md, padding: t.spacing.lg, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, backgroundColor: t.color.surface.panel },
    noticeText: { ...t.typography.body, color: t.color.text.muted },
    form: { gap: t.spacing.lg, padding: t.spacing.lg, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, backgroundColor: t.color.surface.panel },
    field: { gap: t.spacing.sm },
    label: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    helper: { ...t.typography.caption, color: t.color.text.muted },
    capabilitySummary: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.spacing.md, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, backgroundColor: t.color.surface.background },
    capabilitySummaryText: { ...t.typography.body, flex: 1, color: t.color.text.foreground },
    capabilityChevron: { ...t.typography.heading, color: t.color.text.muted },
    capabilityPicker: { gap: t.spacing.sm, padding: t.spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, borderRadius: t.radii.sm },
    capabilityOption: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: t.spacing.md, padding: t.spacing.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, borderRadius: t.radii.sm },
    capabilityOptionSelected: { borderColor: t.color.brand.accent, backgroundColor: t.color.surface.subtle },
    capabilityCopy: { flex: 1, gap: 2 },
    capabilityLabel: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    capabilityCheck: { width: 24, height: 24, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: t.color.border.strong, borderRadius: t.radii.sm },
    capabilityCheckSelected: { borderColor: t.color.brand.accent, backgroundColor: t.color.brand.accent },
    capabilityCheckMark: { ...t.typography.label, color: t.color.text.onPrimary },
    input: { minHeight: 44, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, ...t.typography.body, color: t.color.text.foreground, backgroundColor: t.color.surface.background },
    bodyInput: { height: 260, fontFamily: "monospace", fontSize: 14, lineHeight: 20 },
    readOnly: { opacity: 0.72, backgroundColor: t.color.surface.subtle },
    enabledRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.spacing.md },
    enabledCopy: { flex: 1, gap: 2 },
    toggle: { width: 44, height: 26, padding: 3, borderRadius: t.radii.pill, backgroundColor: t.color.border.strong, justifyContent: "center" },
    toggleOn: { backgroundColor: t.color.status.success },
    knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: t.color.surface.background },
    knobOn: { alignSelf: "flex-end" },
    primaryButton: { minHeight: 46, alignItems: "center", justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, backgroundColor: t.color.brand.accent },
    primaryButtonText: { ...t.typography.label, color: t.color.text.onPrimary },
    secondaryButton: { minHeight: 46, alignItems: "center", justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.color.border.default },
    secondaryButtonText: { ...t.typography.label, color: t.color.text.foreground },
    deleteButton: { minHeight: 46, alignItems: "center", justifyContent: "center", paddingHorizontal: t.spacing.lg, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.color.status.error },
    deleteButtonText: { ...t.typography.label, color: t.color.status.error },
    disabled: { opacity: 0.55 },
  });
}
