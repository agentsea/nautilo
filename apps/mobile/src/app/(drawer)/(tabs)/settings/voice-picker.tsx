import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { AppBar, AppBarBackButton } from "@/components/app-bar";
import { Screen } from "@/components/screen";
import { SettingsStatus } from "@/components/settings/settings-status";
import { createVoiceSettingsController, type VoiceSettingsController } from "@/features/settings/voice-settings-controller";
import { VoicePreviewSession } from "@/features/settings/voice-preview-session";
import { settingsScopeForVerifiedViewer } from "@/features/settings/settings-data-state";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

let previewFileSequence = 0;

/** Searchable, paginated, full-screen native picker for a primary or language voice slot. */
export default function VoicePickerScreen() {
  const params = useLocalSearchParams<{ role?: string | string[] }>();
  const initialRole = typeof params.role === "string" && params.role.trim() ? params.role : "default";
  const { activeServer } = useServers();
  const { status, viewer, viewerState } = useAuth();
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const activeServerRef = useRef(activeServer);
  activeServerRef.current = activeServer;
  const controllerRef = useRef<VoiceSettingsController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createVoiceSettingsController((scope) => {
      const server = activeServerRef.current;
      if (!server || server.id !== scope.serverId) throw new Error("The active server changed.");
      return getApiClient(server.serverUrl);
    });
  }
  const controller = controllerRef.current;
  const profileState = useSyncExternalStore(
    useCallback((listener: () => void) => controller.data.subscribe(listener), [controller]),
    useCallback(() => controller.data.getState(), [controller]),
    useCallback(() => controller.data.getState(), [controller]),
  );
  const subscribeCatalog = useCallback((listener: () => void) => controller.subscribeCatalog(listener), [controller]);
  const getCatalog = useCallback(() => controller.getCatalog(), [controller]);
  const catalog = useSyncExternalStore(subscribeCatalog, getCatalog, getCatalog);
  const previewRef = useRef<VoicePreviewSession | null>(null);
  if (!previewRef.current) previewRef.current = new VoicePreviewSession(nativePreviewPlatform());
  const preview = previewRef.current;
  const previewState = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [role, setRole] = useState(initialRole);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [filtersVisible, setFiltersVisible] = useState(false);
  const scope = useMemo(() => settingsScopeForVerifiedViewer(activeServer, {
    status, viewerState, viewer: viewer && viewerState === "verified" ? viewer : null,
  }), [activeServer, status, viewer, viewerState]);

  useEffect(() => {
    controller.setScope(scope);
    preview.stop();
    if (scope) {
      void controller.load();
      controller.setCatalogFilters({ language: initialRole === "default" ? null : initialRole });
      void controller.loadCatalog();
    }
  }, [controller, initialRole, preview, scope]);
  // Expo Router may reactivate a retained picker. Scope invalidation cancels
  // stale reads without permanently bricking that controller instance.
  useEffect(() => () => { preview.dispose(); controller.setScope(null); }, [controller, preview]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (controller.getCatalog().search === searchDraft) return;
      controller.setCatalogFilters({ search: searchDraft });
      setSelectedId(undefined);
      void controller.loadCatalog();
    }, 250);
    return () => clearTimeout(timer);
  }, [controller, searchDraft]);

  const selected = catalog.voices.find((voice) => voice.voiceId === selectedId) ?? null;
  const setLanguage = (language: string | null): void => {
    controller.setCatalogFilters({ language });
    if (role !== "default") setRole(language ?? "default");
    setSelectedId(undefined);
    void controller.loadCatalog();
  };
  const previewVoice = (voice: typeof selected): void => {
    if (!voice) return;
    void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldRouteThroughEarpiece: false });
    void preview.play(voice.voiceId, () => controller.preview(voice.voiceId, role === "default" ? voice.language : role));
  };
  const setFilter = (filters: Parameters<typeof controller.setCatalogFilters>[0]): void => {
    controller.setCatalogFilters(filters);
    setSelectedId(undefined);
    void controller.loadCatalog();
  };
  const assign = async (): Promise<void> => {
    if (!selected) return;
    const outcome = await controller.assign(selected, role);
    if (outcome.status === "applied") router.replace("/(drawer)/(tabs)/settings/voice");
    else if (outcome.status === "failed") setNotice(outcome.message);
  };
  const goBack = (): void => { if (router.canGoBack()) router.back(); else router.replace("/(drawer)/(tabs)/settings/voice"); };
  const languageLabel = role === "default" ? null : catalog.languageGroups.find((group) => group.language === role)?.label ?? displayLanguage(role);
  const catalogLanguageLabel = catalog.language ? catalog.languageGroups.find((group) => group.language === catalog.language)?.label ?? displayLanguage(catalog.language) : null;
  const title = role === "default" ? "Choose primary voice" : `Choose ${languageLabel} voice`;
  const loadErrors = uniqueMessages([
    catalog.error ? voiceLoadErrorMessage(catalog.error) : null,
    profileState.loadError ? voiceLoadErrorMessage(profileState.loadError) : null,
  ]);

  return (
    <View style={styles.container}>
      <AppBar title={title} left={<AppBarBackButton onPress={goBack} />} />
      {!scope ? <View style={styles.statusWrap}><SettingsStatus tone="warning">Sign in and reconnect before browsing voices.</SettingsStatus></View> : null}
      {catalog.loading && catalog.voices.length === 0 ? <ActivityIndicator style={styles.loading} color={t.color.brand.accent} accessibilityLabel="Loading voice catalog" /> : null}
      <Screen edgeTop={false} contentStyle={styles.content}>
        <TextInput value={searchDraft} onChangeText={setSearchDraft} placeholder="Search voices" placeholderTextColor={t.color.text.dim} style={styles.search} accessibilityLabel="Search voices" autoCorrect={false} />
        <Text style={styles.filterLabel}>Language</Text>
        <ScrollView horizontal style={styles.languageScroller} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalFilters} accessibilityRole="radiogroup" accessibilityLabel="Voice language filter">
          <FilterButton label="All" selected={catalog.language === null} onPress={() => setLanguage(null)} />
          {catalog.languageGroups.map((group) => <FilterButton key={`${group.language}:${group.locale ?? ""}`} label={`${group.label} (${group.count})`} selected={catalog.language === group.language} onPress={() => setLanguage(group.language)} />)}
        </ScrollView>
        <Pressable style={styles.filtersToggle} onPress={() => setFiltersVisible((value) => !value)} accessibilityRole="button" accessibilityLabel="Voice filters" accessibilityState={{ expanded: filtersVisible }}><Text style={styles.filtersToggleText}>Filters{activeFilterCount(catalog) ? ` (${activeFilterCount(catalog)})` : ""}</Text><Ionicons name={filtersVisible ? "chevron-up" : "chevron-down"} size={18} color={t.color.text.muted} /></Pressable>
        {filtersVisible ? <View style={styles.filterPanel}>
          <FilterGroup label="Category" values={[{ id: null, label: "All" }, { id: "professional", label: "Professional" }, { id: "high_quality", label: "High quality" }, { id: "famous", label: "Featured" }]} selected={catalog.category} onSelect={(category) => setFilter({ category: category as typeof catalog.category })} />
          <FilterGroup label="Gender" values={[{ id: null, label: "Any" }, { id: "female", label: "Female" }, { id: "male", label: "Male" }]} selected={catalog.gender} onSelect={(gender) => setFilter({ gender })} />
          <FilterGroup label="Age" values={[{ id: null, label: "Any" }, { id: "young", label: "Young" }, { id: "middle_aged", label: "Middle aged" }, { id: "old", label: "Older" }]} selected={catalog.age} onSelect={(age) => setFilter({ age })} />
          <FilterGroup label="Use case" values={[{ id: null, label: "Any" }, { id: "conversational", label: "Conversational" }, { id: "narration", label: "Narration" }, { id: "characters_animation", label: "Characters" }]} selected={catalog.useCase} onSelect={(useCase) => setFilter({ useCase })} />
          <Text style={styles.filterLabel}>Accent</Text>
          <TextInput value={catalog.accent} onChangeText={(accent) => setFilter({ accent })} placeholder="Any accent" placeholderTextColor={t.color.text.dim} style={styles.accentInput} accessibilityLabel="Accent filter" autoCorrect={false} />
        </View> : null}
        <View style={styles.catalogHeader}><Text style={styles.catalogTitle}>{catalogLanguageLabel ? `Voices for ${catalogLanguageLabel}` : "All voices"}</Text>{catalog.loading && catalog.voices.length > 0 ? <ActivityIndicator size="small" color={t.color.brand.accent} /> : null}</View>
        <View style={styles.voiceList} accessibilityRole="radiogroup" accessibilityLabel="Available voices">
          {catalog.voices.map((voice) => {
            const selectedRow = selectedId === voice.voiceId;
            const playing = previewState.voiceId === voice.voiceId;
            return <Pressable key={voice.voiceId} onPress={() => setSelectedId(voice.voiceId)} style={({ pressed }) => [styles.voiceRow, selectedRow && styles.voiceRowSelected, pressed && styles.pressed]} accessibilityRole="radio" accessibilityState={{ selected: selectedRow }} accessibilityLabel={`Select ${voice.name}`}>
              <View style={styles.voiceCopy}><Text style={styles.voiceName}>{voice.name}</Text><Text style={styles.voiceMeta}>{voiceMetadata(voice)}</Text><Text style={voice.source === "curated" ? styles.trustGood : styles.trustNeutral}>{voice.source === "curated" ? "★ Curated / tested" : providerTrust(voice, catalog.language)}</Text></View>
              <Pressable onPress={(event) => { event.stopPropagation(); previewVoice(voice); }} style={styles.previewButton} accessibilityRole="button" accessibilityLabel={`Preview ${voice.name}`}><Ionicons name={playing ? "stop" : "play"} size={18} color={t.color.brand.accent} /></Pressable>
              <Text style={styles.radio}>{selectedRow ? "●" : "○"}</Text>
            </Pressable>;
          })}
        </View>
        <View style={styles.footer}>
          {!catalog.elevenLabsConfigured && catalog.elevenLabsConfigured !== null ? <SettingsStatus tone="warning">Voice previews are not configured on this server.</SettingsStatus> : null}
          {loadErrors.map((message) => <SettingsStatus key={message} tone="error">{message}</SettingsStatus>)}
          {loadErrors.length ? <Pressable onPress={() => { void controller.load(); void controller.loadCatalog(); }} style={styles.retryButton} accessibilityRole="button" accessibilityLabel="Retry loading voices"><Text style={styles.secondaryButtonText}>Retry</Text></Pressable> : null}
          {notice ? <SettingsStatus tone="error">{notice}</SettingsStatus> : null}
          {previewState.error ? <SettingsStatus tone="warning">{previewState.error}</SettingsStatus> : null}
          {catalog.hasMore ? <Pressable onPress={() => void controller.loadMore()} disabled={catalog.loadingMore} style={styles.loadMore} accessibilityRole="button" accessibilityLabel="Load more voices"><Text style={styles.secondaryButtonText}>{catalog.loadingMore ? "Loading…" : "Load more voices"}</Text></Pressable> : null}
          {!catalog.loading && catalog.voices.length === 0 && catalog.elevenLabsConfigured ? <Text style={styles.empty}>No voices match these filters.</Text> : null}
        </View>
      </Screen>
      {selected ? <View style={styles.selectionBar}>
        <View style={styles.selectionCopy}><Text style={styles.selectionName} numberOfLines={1}>{selected.name}</Text><View style={styles.roleRow}><FilterButton label="Primary" selected={role === "default"} onPress={() => setRole("default")} />{catalog.language ? <FilterButton label={`${catalog.language} voice`} selected={role === catalog.language} onPress={() => setRole(catalog.language ?? "default")} /> : null}</View></View>
        <Pressable onPress={() => void assign()} disabled={profileState.mutating} style={[styles.useButton, profileState.mutating && styles.disabled]} accessibilityRole="button" accessibilityLabel={`Use ${selected.name}`}><Text style={styles.primaryButtonText}>{profileState.mutating ? "Saving…" : "Use voice"}</Text></Pressable>
      </View> : null}
    </View>
  );
}

function FilterGroup({ label, values, selected, onSelect }: { label: string; values: readonly { id: string | null; label: string }[]; selected: string | null | undefined; onSelect: (id: string | null) => void }) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return <View style={styles.filterGroup}><Text style={styles.filterLabel}>{label}</Text><View style={styles.filterValues}>{values.map((value) => <FilterButton key={value.id ?? "all"} label={value.label} selected={(selected ?? null) === value.id} onPress={() => onSelect(value.id)} />)}</View></View>;
}

function activeFilterCount(catalog: { category: unknown; gender: unknown; age: unknown; accent: string; useCase: unknown }): number { return [catalog.category, catalog.gender, catalog.age, catalog.accent.trim() || null, catalog.useCase].filter(Boolean).length; }
function uniqueMessages(messages: readonly (string | null)[]): string[] { return [...new Set(messages.filter((message): message is string => Boolean(message)))]; }
function voiceLoadErrorMessage(error: unknown): string {
  const status = error !== null && typeof error === "object" && "status" in error ? (error as { status?: unknown }).status : null;
  if (status === 503 || (error instanceof Error && /service unavailable/i.test(error.message))) return "Voice settings were briefly unavailable. Your existing choices are unchanged.";
  if (status === 401) return "Your session has expired. Sign in again to browse voices.";
  return error instanceof Error && error.message ? error.message : "Could not load voices.";
}
function displayLanguage(language: string): string { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(language.split("-")[0] ?? language) ?? language; } catch { return language; } }
function voiceMetadata(voice: { languageLabel: string; language: string; locale: string | null; accent: string; gender: string; age: string; descriptive: string; category: string }): string { return [voice.languageLabel || voice.language, voice.locale, voice.accent, voice.gender, voice.age, voice.descriptive, voice.category].filter(Boolean).join(" · "); }
function providerTrust(voice: { verifiedLanguages: readonly { language: string; modelId: string }[] }, language: string | null): string { const base = language?.toLowerCase().split("-")[0]; return base && voice.verifiedLanguages.some((item) => item.language.toLowerCase().split("-")[0] === base) ? "Provider language reference" : "Provider voice"; }

function FilterButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  return <Pressable onPress={onPress} style={[styles.filter, selected && styles.filterSelected]} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ selected }}><Text style={[styles.filterText, selected && styles.filterTextSelected]}>{label}</Text></Pressable>;
}

function nativePreviewPlatform() {
  return {
    createFile: () => { const file = new File(Paths.cache, `voice-preview-${Date.now()}-${previewFileSequence++}.mp3`); file.create(); return file; },
    createPlayer: (uri: string) => createAudioPlayer({ uri }),
  };
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface.background }, statusWrap: { paddingHorizontal: t.spacing.xl, paddingTop: t.spacing.md }, loading: { paddingTop: t.spacing.lg }, content: { gap: t.spacing.sm, paddingBottom: 120 }, search: { minHeight: 44, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md, color: t.color.text.foreground, ...t.typography.body }, footer: { gap: t.spacing.md }, filterLabel: { ...t.typography.label, color: t.color.text.foreground }, filterGroup: { gap: 6 }, filterValues: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, languageScroller: { flexGrow: 0, height: 44 }, horizontalFilters: { alignItems: "center", gap: t.spacing.sm, paddingRight: t.spacing.xl }, filter: { minHeight: 36, justifyContent: "center", paddingHorizontal: t.spacing.md, borderRadius: t.radii.pill, borderWidth: 1, borderColor: t.color.border.default }, filterSelected: { borderColor: t.color.brand.accent, backgroundColor: t.color.surface.subtle }, filterText: { ...t.typography.caption, color: t.color.text.foreground }, filterTextSelected: { color: t.color.brand.accent, fontWeight: "700" }, filtersToggle: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md }, filtersToggleText: { ...t.typography.bodyStrong, color: t.color.text.foreground }, filterPanel: { gap: t.spacing.md, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel, padding: t.spacing.md }, accentInput: { minHeight: 42, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, paddingHorizontal: t.spacing.md, color: t.color.text.foreground, ...t.typography.body }, catalogHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: t.spacing.sm }, catalogTitle: { ...t.typography.subheading, color: t.color.text.foreground }, voiceList: { overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: t.color.border.default, borderRadius: t.radii.md, backgroundColor: t.color.surface.panel }, voiceRow: { minHeight: 74, flexDirection: "row", alignItems: "center", gap: t.spacing.sm, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border.default }, voiceRowSelected: { backgroundColor: t.color.surface.subtle }, voiceCopy: { flex: 1, minWidth: 0, gap: 2 }, voiceName: { ...t.typography.bodyStrong, color: t.color.text.foreground }, voiceMeta: { ...t.typography.caption, color: t.color.text.muted }, trustGood: { ...t.typography.caption, color: t.color.status.success }, trustNeutral: { ...t.typography.caption, color: t.color.text.dim }, previewButton: { width: 40, height: 40, borderRadius: t.radii.pill, borderWidth: 1, borderColor: t.color.border.default, alignItems: "center", justifyContent: "center" }, radio: { ...t.typography.subheading, color: t.color.brand.accent }, selectionBar: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.color.border.default, backgroundColor: t.color.surface.panel, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm, flexDirection: "row", alignItems: "center", gap: t.spacing.sm }, selectionCopy: { flex: 1, minWidth: 0, gap: t.spacing.xs }, selectionName: { ...t.typography.bodyStrong, color: t.color.text.foreground }, roleRow: { flexDirection: "row", gap: t.spacing.xs }, useButton: { minWidth: 112, minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: t.radii.sm, backgroundColor: t.color.action.primaryBg, paddingHorizontal: t.spacing.md }, secondaryButtonText: { ...t.typography.bodyStrong, color: t.color.brand.accent }, primaryButtonText: { ...t.typography.bodyStrong, color: t.color.text.onPrimary }, retryButton: { minHeight: 44, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm }, loadMore: { minHeight: 44, alignItems: "center", justifyContent: "center" }, empty: { ...t.typography.caption, color: t.color.text.muted }, disabled: { opacity: 0.55 }, pressed: { opacity: 0.7 },
  });
}
