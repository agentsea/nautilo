import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CatalogLanguageGroup,
  CatalogQuery,
  CatalogResponse,
  CatalogVoice,
} from "@nautilo/types";

/** D261 — primary (`default`) or a BCP-47 language key written to `voices[lang]`. */
export type VoiceCatalogAssignRole = string;
const DEFAULT_VOICE_KEY: VoiceCatalogAssignRole = "default";

const PAGE_SIZE = 30;

export type VoiceCatalogPreviewSource = "provider" | "generated";

type CategoryFilter = "all" | "professional" | "high_quality" | "famous";
type CatalogSessionCacheEntry = {
  voices: CatalogVoice[];
  languageGroups: CatalogLanguageGroup[];
  page: number;
  hasMore: boolean;
};

const CATEGORY_FILTERS: ReadonlyArray<{ id: CategoryFilter; label: string }> = [
  { id: "all", label: "All categories" },
  { id: "professional", label: "Professional" },
  { id: "high_quality", label: "High quality" },
  { id: "famous", label: "Featured" },
];
const GENDER_FILTERS = [
  { id: "any", label: "Any gender" },
  { id: "female", label: "Female" },
  { id: "male", label: "Male" },
] as const;
const AGE_FILTERS = [
  { id: "any", label: "Any age" },
  { id: "young", label: "Young" },
  { id: "middle_aged", label: "Middle aged" },
  { id: "old", label: "Older" },
] as const;
const USE_CASE_FILTERS = [
  { id: "any", label: "Any use case" },
  { id: "conversational", label: "Conversational" },
  { id: "narration", label: "Narration" },
  { id: "characters_animation", label: "Characters" },
] as const;
const EXPRESSIVE_MODEL_IDS = new Set(["eleven_v3", "eleven_v4", "eleven_v4_hq"]);

export interface SharedVoiceCatalogModalProps {
  open: boolean;
  title?: string;
  subtitle?: string;
  missingKeyCopy?: string;
  emptyCopy?: string;
  onClose: () => void;
  loadCatalog: (query: CatalogQuery) => Promise<CatalogResponse>;
  previewVoice: (
    voice: CatalogVoice,
    source: VoiceCatalogPreviewSource,
  ) => Promise<string | null>;
  assignVoice: (voice: CatalogVoice, role: VoiceCatalogAssignRole) => Promise<void>;
  /**
   * D261 — language-first assign: pick a language, select a voice, choose
   * Primary vs language role, then Save. When false, "Use" assigns primary.
   */
  roleAtAssign?: boolean;
  /** Preselect the language sidebar filter when the modal opens. */
  initialLanguage?: string | null;
  /** Default role radio when `roleAtAssign` (falls back to filter language or primary). */
  defaultAssignRole?: VoiceCatalogAssignRole;
  generatedSampleLabel?: (voice: CatalogVoice) => {
    label: string;
    title?: string;
  };
}

function languageBase(lang: string): string {
  return lang.trim().toLowerCase().split("-")[0] ?? lang;
}

function isProviderVerifiedForLanguage(voice: CatalogVoice, lang: string | null): boolean {
  if (!lang) return false;
  const base = languageBase(lang);
  return voice.verifiedLanguages.some(
    (entry) =>
      EXPRESSIVE_MODEL_IDS.has(entry.modelId) &&
      (languageBase(entry.language) === base ||
        entry.language.toLowerCase() === lang.toLowerCase()),
  );
}

function roleLanguageLabel(
  role: VoiceCatalogAssignRole,
  selectedGroup: CatalogLanguageGroup | null,
): string {
  if (role === DEFAULT_VOICE_KEY) return "Primary";
  if (selectedGroup && selectedGroup.language === role) return selectedGroup.label;
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "language" });
    const name = dn.of(languageBase(role));
    return name ? `${name} voice` : `${role} voice`;
  } catch {
    return `${role} voice`;
  }
}

function groupKey(group: CatalogLanguageGroup): string {
  return `${group.language}:${group.locale ?? "all"}`;
}

function voiceMetaLine(v: CatalogVoice): string {
  const parts: string[] = [];
  if (v.languageLabel) parts.push(v.languageLabel);
  else if (v.language) parts.push(v.language);
  if (v.locale) parts.push(v.locale);
  if (v.accent) parts.push(v.accent);
  if (v.gender) parts.push(v.gender);
  if (v.age) parts.push(v.age);
  if (v.descriptive) parts.push(v.descriptive);
  if (v.category) parts.push(v.category);
  return parts.join(" · ");
}

function voiceTrustRank(voice: CatalogVoice, lang: string | null): number {
  if (voice.source === "curated") return 0;
  if (isProviderVerifiedForLanguage(voice, lang)) return 1;
  return 2;
}

function sortVoicesByTrust(voices: CatalogVoice[], lang: string | null): CatalogVoice[] {
  return voices
    .map((voice, index) => ({ voice, index }))
    .sort((a, b) => {
      const rankDiff = voiceTrustRank(a.voice, lang) - voiceTrustRank(b.voice, lang);
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.voice);
}

function buildQuery(args: {
  language: string | null;
  search: string;
  category: CategoryFilter;
  gender: string;
  age: string;
  accent: string;
  useCase: string;
  page: number;
}): CatalogQuery {
  const q: CatalogQuery = { page: args.page, page_size: PAGE_SIZE };
  if (args.language) q.language = args.language;
  if (args.search.trim()) q.search = args.search.trim();
  if (args.category !== "all") q.category = args.category;
  if (args.gender !== "any") q.gender = args.gender;
  if (args.age !== "any") q.age = args.age;
  if (args.accent.trim()) q.accent = args.accent.trim();
  if (args.useCase !== "any") q.use_cases = args.useCase;
  return q;
}

function catalogSessionKey(args: {
  language: string | null;
  search: string;
  category: CategoryFilter;
  gender: string;
  age: string;
  accent: string;
  useCase: string;
}): string {
  return JSON.stringify({
    language: args.language ?? "",
    search: args.search.trim(),
    category: args.category,
    gender: args.gender,
    age: args.age,
    accent: args.accent.trim(),
    useCase: args.useCase,
  });
}

function usePreviewPlayer() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [playingSource, setPlayingSource] = useState<VoiceCatalogPreviewSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    if (ref.current) {
      ref.current.pause();
      ref.current.currentTime = 0;
    }
    setPlayingVoiceId(null);
    setPlayingSource(null);
  }, []);

  useEffect(() => {
    return () => {
      if (ref.current) {
        ref.current.pause();
        ref.current.src = "";
      }
    };
  }, []);

  const play = useCallback(
    async (
      voiceId: string,
      source: VoiceCatalogPreviewSource,
      getUrl: () => Promise<string | null>,
    ) => {
      if (playingVoiceId === voiceId && playingSource === source) {
        stop();
        return;
      }
      stop();
      setError(null);
      setPlayingVoiceId(voiceId);
      setPlayingSource(source);
      try {
        const url = await getUrl();
        if (!url) throw new Error("No preview is available for this voice.");
        const audio = new Audio(url);
        ref.current = audio;
        audio.onended = () => {
          setPlayingVoiceId(null);
          setPlayingSource(null);
        };
        audio.onerror = () => {
          setPlayingVoiceId(null);
          setPlayingSource(null);
          setError("Could not play this voice preview.");
        };
        await audio.play();
      } catch (e) {
        setPlayingVoiceId(null);
        setPlayingSource(null);
        setError(e instanceof Error ? e.message : "Could not play this voice preview.");
      }
    },
    [playingSource, playingVoiceId, stop],
  );

  return { play, stop, playingVoiceId, playingSource, error, setError } as const;
}

export function SharedVoiceCatalogModal({
  open,
  title = "Browse voices and languages",
  subtitle = "Pick a voice for Genie. Verification badges show provider language metadata; curated voices may still work with expressive speech.",
  missingKeyCopy = "Configure your ElevenLabs API key in Providers to browse the full catalog.",
  emptyCopy = "No voices match. Try clearing a filter.",
  onClose,
  loadCatalog,
  previewVoice,
  assignVoice,
  roleAtAssign = false,
  initialLanguage = null,
  defaultAssignRole,
  generatedSampleLabel,
}: SharedVoiceCatalogModalProps) {
  const preview = usePreviewPlayer();
  const requestSeqRef = useRef(0);
  const loadCatalogRef = useRef(loadCatalog);
  const sessionCacheRef = useRef(new Map<string, CatalogSessionCacheEntry>());
  const voicesRef = useRef<CatalogVoice[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<CatalogLanguageGroup | null>(null);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [gender, setGender] = useState("any");
  const [age, setAge] = useState("any");
  const [accent, setAccent] = useState("");
  const [useCase, setUseCase] = useState("any");
  const [voices, setVoices] = useState<CatalogVoice[]>([]);
  const [languageGroups, setLanguageGroups] = useState<CatalogLanguageGroup[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [missingKey, setMissingKey] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [assignRole, setAssignRole] = useState<VoiceCatalogAssignRole>(DEFAULT_VOICE_KEY);
  const initialLanguageAppliedRef = useRef(false);

  useEffect(() => {
    loadCatalogRef.current = loadCatalog;
  }, [loadCatalog]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const allLanguageCount = useMemo(
    () => languageGroups.reduce((sum, group) => sum + group.count, 0),
    [languageGroups],
  );
  const currentQueryKey = useMemo(
    () =>
      catalogSessionKey({
        language: selectedGroup?.language ?? null,
        search: debouncedSearch,
        category,
        gender,
        age,
        accent,
        useCase,
      }),
    [accent, age, category, debouncedSearch, gender, selectedGroup?.language, useCase],
  );

  const fetchPage = useCallback(
    async (pageToLoad: number, append: boolean) => {
      if (!open) return;
      const seq = (requestSeqRef.current += 1);
      const cacheKey = currentQueryKey;
      const cached = sessionCacheRef.current.get(cacheKey);
      if (pageToLoad === 0) {
        if (cached) setRefreshing(true);
        else setLoading(true);
        setFetchError(null);
        setMissingKey(false);
      } else {
        setLoadingMore(true);
      }
      try {
        const response = await loadCatalogRef.current(
          buildQuery({
            language: selectedGroup?.language ?? null,
            search: debouncedSearch,
            category,
            gender,
            age,
            accent,
            useCase,
            page: pageToLoad,
          }),
        );
        if (seq !== requestSeqRef.current) return;
        const baseVoices = append ?
          (sessionCacheRef.current.get(cacheKey)?.voices ?? voicesRef.current)
        : [];
        const nextVoices = sortVoicesByTrust(
          append ? [...baseVoices, ...response.voices] : response.voices,
          selectedGroup?.language ?? null,
        );
        const nextEntry: CatalogSessionCacheEntry = {
          voices: nextVoices,
          languageGroups: response.languageGroups,
          page: response.page,
          hasMore: response.hasMore,
        };
        sessionCacheRef.current.set(cacheKey, nextEntry);
        voicesRef.current = nextVoices;
        setLanguageGroups(response.languageGroups);
        setVoices(nextVoices);
        setPage(response.page);
        setHasMore(response.hasMore);
        setFetchError(response.error ?? null);
        setMissingKey(!response.elevenLabsConfigured);
      } catch (e) {
        if (seq !== requestSeqRef.current) return;
        const message = e instanceof Error ? e.message : "Failed to load voice catalog";
        const lower = message.toLowerCase();
        if (lower.includes("elevenlabs") || lower.includes("eleven_labs")) {
          setMissingKey(true);
          setVoices([]);
          setLanguageGroups([]);
        } else {
          setFetchError(message);
        }
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
          setRefreshing(false);
        }
      }
    },
    [accent, age, category, currentQueryKey, debouncedSearch, gender, open, selectedGroup?.language, useCase],
  );

  useEffect(() => {
    if (!open) return;
    const cached = sessionCacheRef.current.get(currentQueryKey);
    if (cached) {
      voicesRef.current = cached.voices;
      setVoices(cached.voices);
      setLanguageGroups(cached.languageGroups);
      setPage(cached.page);
      setHasMore(cached.hasMore);
      setLoading(false);
      setFetchError(null);
      setMissingKey(false);
    } else {
      voicesRef.current = [];
      setVoices([]);
      setPage(0);
      setHasMore(false);
    }
    void fetchPage(0, false);
  }, [
    open,
    currentQueryKey,
    fetchPage,
  ]);

  useEffect(() => {
    if (open) return;
    preview.stop();
    setSearch("");
    setDebouncedSearch("");
    setSelectedGroup(null);
    setCategory("all");
    setGender("any");
    setAge("any");
    setAccent("");
    setUseCase("any");
    setMissingKey(false);
    setFetchError(null);
    setRefreshing(false);
    setGeneratingId(null);
    setSelectedVoiceId(null);
    setAssignRole(DEFAULT_VOICE_KEY);
    initialLanguageAppliedRef.current = false;
    sessionCacheRef.current.clear();
    voicesRef.current = [];
  }, [open, preview]);

  useEffect(() => {
    if (!open) return;
    const role =
      defaultAssignRole ??
      (initialLanguage && initialLanguage !== DEFAULT_VOICE_KEY ?
        initialLanguage
      : selectedGroup?.language ?? DEFAULT_VOICE_KEY);
    setAssignRole(role);
  }, [defaultAssignRole, initialLanguage, open, selectedGroup?.language]);

  useEffect(() => {
    if (!open || !initialLanguage || initialLanguageAppliedRef.current) return;
    if (languageGroups.length === 0) return;
    const match =
      languageGroups.find((g) => g.language === initialLanguage) ??
      languageGroups.find((g) => languageBase(g.language) === languageBase(initialLanguage));
    if (match) {
      setSelectedGroup(match);
      initialLanguageAppliedRef.current = true;
    }
  }, [initialLanguage, languageGroups, open]);

  const filterLanguage = selectedGroup?.language ?? null;
  const selectedVoice = useMemo(
    () => voices.find((v) => v.voiceId === selectedVoiceId) ?? null,
    [selectedVoiceId, voices],
  );

  if (!open) return null;

  const shownLabel = selectedGroup?.label ?? "All languages";
  const languageRequired = roleAtAssign && !filterLanguage;

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-catalog-title"
      data-testid="voice-catalog-modal"
    >
      <div style={styles.modal}>
        <header style={styles.header}>
          <div>
            <h2 id="voice-catalog-title" style={styles.title}>{title}</h2>
            <p style={styles.subtitle}>{subtitle}</p>
          </div>
          <button type="button" onClick={onClose} style={styles.closeButton}>Close</button>
        </header>

        <div style={styles.searchBar}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search voices..."
            aria-label="Search voices"
            style={styles.searchInput}
          />
        </div>

        {missingKey ? (
          <p style={styles.message} data-testid="voice-catalog-missing-key">
            {missingKeyCopy}
          </p>
        ) : (
          <div style={styles.body}>
            <aside style={styles.sidebar} aria-label="Languages">
              <div style={styles.sidebarTitle}>Languages</div>
              <div style={styles.sidebarHint}>
                Provider counts; badges show language verification metadata.
              </div>
              {!roleAtAssign ? (
                <button
                  type="button"
                  data-testid="voice-catalog-lang-all"
                  onClick={() => {
                    setSelectedGroup(null);
                    setSelectedVoiceId(null);
                  }}
                  style={{
                    ...styles.languageButton,
                    ...(selectedGroup === null ? styles.languageButtonActive : null),
                  }}
                >
                  <span style={styles.truncate}>All languages</span>
                  <span style={styles.count}>{allLanguageCount}</span>
                </button>
              ) : null}
              {languageGroups.map((group) => {
                const active =
                  selectedGroup?.language === group.language &&
                  selectedGroup?.locale === group.locale;
                return (
                  <button
                    type="button"
                    key={groupKey(group)}
                    data-testid={`voice-catalog-lang-${groupKey(group)}`}
                    onClick={() => {
                      setSelectedGroup(group);
                      setSelectedVoiceId(null);
                      if (roleAtAssign && assignRole !== DEFAULT_VOICE_KEY) {
                        setAssignRole(group.language);
                      }
                    }}
                    style={{
                      ...styles.languageButton,
                      ...(active ? styles.languageButtonActive : null),
                    }}
                  >
                    <span style={styles.truncate}>{group.label}</span>
                    <span style={styles.count}>{group.count}</span>
                  </button>
                );
              })}
            </aside>

            <section style={styles.content}>
              <div style={styles.filters}>
                <div style={styles.filterRow}>
                  {CATEGORY_FILTERS.map(({ id, label }) => (
                    <FilterChip
                      key={id}
                      active={category === id}
                      label={label}
                      onClick={() => setCategory(id)}
                    />
                  ))}
                </div>
                <div style={styles.filterRow}>
                  {GENDER_FILTERS.map(({ id, label }) => (
                    <FilterChip key={id} active={gender === id} label={label} onClick={() => setGender(id)} />
                  ))}
                </div>
                <div style={styles.filterRow}>
                  {AGE_FILTERS.map(({ id, label }) => (
                    <FilterChip key={id} active={age === id} label={label} onClick={() => setAge(id)} />
                  ))}
                </div>
                <div style={styles.filterRow}>
                  {USE_CASE_FILTERS.map(({ id, label }) => (
                    <FilterChip key={id} active={useCase === id} label={label} onClick={() => setUseCase(id)} />
                  ))}
                </div>
                <input
                  value={accent}
                  onChange={(event) => setAccent(event.target.value)}
                  placeholder="Accent filter"
                  aria-label="Accent filter"
                  style={styles.accentInput}
                />
              </div>

              <div style={styles.list}>
                <div style={styles.showing} data-testid="voice-catalog-showing">
                  Showing: {shownLabel}
                </div>
                {fetchError ?? preview.error ? (
                  <p style={styles.error}>{fetchError ?? preview.error}</p>
                ) : null}
                {refreshing && voices.length > 0 ? (
                  <p style={styles.refreshing} data-testid="voice-catalog-refreshing">
                    Refreshing...
                  </p>
                ) : null}
                {roleAtAssign && languageRequired ? (
                  <p style={styles.message} data-testid="voice-catalog-pick-language">
                    Step 1 — pick a language in the sidebar to browse voices for that language.
                  </p>
                ) : null}
                {loading && voices.length === 0 && !languageRequired ? (
                  <p style={styles.message}>Loading...</p>
                ) : voices.length === 0 && !languageRequired ? (
                  <p style={styles.message} data-testid="voice-catalog-empty">
                    {emptyCopy}
                  </p>
                ) : voices.length === 0 ? null : (
                  <ul style={styles.voiceList}>
                    {voices.map((voice) => {
                      const meta = voiceMetaLine(voice);
                      const isProvider =
                        preview.playingVoiceId === voice.voiceId &&
                        preview.playingSource === "provider";
                      const isGenerated =
                        preview.playingVoiceId === voice.voiceId &&
                        preview.playingSource === "generated";
                      const generatedLabel = generatedSampleLabel?.(voice) ?? {
                        label: "Generate Genie sample",
                      };
                      const providerVerified =
                        roleAtAssign && filterLanguage ?
                          isProviderVerifiedForLanguage(voice, filterLanguage)
                        : null;
                      const curated = voice.source === "curated";
                      const rowSelected = selectedVoiceId === voice.voiceId;
                      return (
                        <li
                          key={voice.voiceId}
                          style={{
                            ...styles.voiceRow,
                            ...(rowSelected ? styles.voiceRowSelected : null),
                          }}
                          data-testid={`voice-catalog-row-${voice.voiceId}`}
                        >
                          <div style={styles.voiceMain}>
                            <div style={styles.voiceName}>{voice.name}</div>
                            {meta ? <div style={styles.voiceMeta}>{meta}</div> : null}
                            {curated ? (
                              <div
                                style={styles.verifiedOk}
                                data-testid={`voice-catalog-curated-${voice.voiceId}`}
                              >
                                ★ Curated / tested
                              </div>
                            ) : providerVerified === true ? (
                              <div
                                style={styles.verifiedOk}
                                data-testid={`voice-catalog-verified-${voice.voiceId}`}
                              >
                                ✓ Provider v3-verified
                              </div>
                            ) : providerVerified === false ? (
                              <div
                                style={styles.verifiedWarn}
                                data-testid={`voice-catalog-unverified-${voice.voiceId}`}
                              >
                                ⚠ not provider v3-verified for {filterLanguage}
                              </div>
                            ) : (
                              <div style={styles.emotion}>Available</div>
                            )}
                          </div>
                          <div style={styles.voiceActions}>
                            <span data-testid={`voice-catalog-preview-${voice.voiceId}`}>
                              <button
                                type="button"
                                style={{
                                  ...styles.secondaryButton,
                                  ...(isProvider ? styles.secondaryButtonActive : null),
                                }}
                                aria-pressed={isProvider}
                                title={
                                  isProvider ?
                                    "Playing generated preview"
                                  : "Generate a sample with this exact voice"
                                }
                                onClick={() => {
                                  void preview.play(voice.voiceId, "provider", () =>
                                    previewVoice(voice, "provider"),
                                  );
                                }}
                              >
                                Preview voice
                              </button>
                            </span>
                            <span data-testid={`voice-catalog-genie-sample-${voice.voiceId}`}>
                              <button
                                type="button"
                                style={{
                                  ...styles.secondaryButton,
                                  ...(isGenerated || generatingId === voice.voiceId ?
                                    styles.secondaryButtonActive
                                  : null),
                                }}
                                title={
                                  generatingId === voice.voiceId ?
                                    "Generating Genie sample..."
                                  : isGenerated ? "Playing Genie sample"
                                  : generatedLabel.title
                                }
                                disabled={generatingId === voice.voiceId}
                                aria-pressed={isGenerated}
                                onClick={() => {
                                  setGeneratingId(voice.voiceId);
                                  void preview
                                    .play(voice.voiceId, "generated", () =>
                                      previewVoice(voice, "generated"),
                                    )
                                    .finally(() => setGeneratingId(null));
                                }}
                              >
                                {generatedLabel.label}
                              </button>
                            </span>
                            {roleAtAssign ? (
                              <span data-testid={`voice-catalog-select-${voice.voiceId}`}>
                                <button
                                  type="button"
                                  style={{
                                    ...styles.primaryButton,
                                    ...(rowSelected ? styles.primaryButtonActive : null),
                                  }}
                                  aria-pressed={rowSelected}
                                  onClick={() => setSelectedVoiceId(voice.voiceId)}
                                >
                                  {rowSelected ? "Selected" : "Select"}
                                </button>
                              </span>
                            ) : (
                              <span data-testid={`voice-catalog-use-${voice.voiceId}`}>
                                <button
                                  type="button"
                                  style={styles.primaryButton}
                                  disabled={assigningId === voice.voiceId}
                                  onClick={() => {
                                    setAssigningId(voice.voiceId);
                                    void assignVoice(voice, DEFAULT_VOICE_KEY)
                                      .then(() => {
                                        preview.stop();
                                        onClose();
                                      })
                                      .catch((e) =>
                                        preview.setError(
                                          e instanceof Error ? e.message : "Failed to save voice",
                                        ),
                                      )
                                      .finally(() => setAssigningId(null));
                                  }}
                                >
                                  {assigningId === voice.voiceId ? "Saving..." : "Use"}
                                </button>
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {hasMore && !loading ? (
                  <button
                    type="button"
                    style={styles.loadMore}
                    disabled={loadingMore}
                    onClick={() => {
                      void fetchPage(page + 1, true);
                    }}
                  >
                    <span data-testid="voice-catalog-load-more">
                      {loadingMore ? "Loading..." : "Load more"}
                    </span>
                  </button>
                ) : null}
              </div>
            </section>
          </div>
        )}

        {roleAtAssign && selectedVoice && filterLanguage ? (
          <footer style={styles.assignFooter} data-testid="voice-catalog-assign-footer">
            <div style={styles.assignFooterTitle}>Use this voice as:</div>
            <label style={styles.roleOption}>
              <input
                type="radio"
                name="voice-catalog-assign-role"
                checked={assignRole === DEFAULT_VOICE_KEY}
                onChange={() => setAssignRole(DEFAULT_VOICE_KEY)}
                data-testid="voice-catalog-assign-role-default"
              />
              Primary
            </label>
            <label style={styles.roleOption}>
              <input
                type="radio"
                name="voice-catalog-assign-role"
                checked={assignRole !== DEFAULT_VOICE_KEY}
                onChange={() => setAssignRole(filterLanguage)}
                data-testid="voice-catalog-assign-role-lang"
              />
              {roleLanguageLabel(filterLanguage, selectedGroup)}
            </label>
            <div style={styles.assignFooterActions}>
              <button type="button" style={styles.secondaryButton} onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                style={styles.primaryButton}
                disabled={assigningId === selectedVoice.voiceId}
                data-testid="voice-catalog-save-assign"
                onClick={() => {
                  setAssigningId(selectedVoice.voiceId);
                  const role =
                    assignRole === DEFAULT_VOICE_KEY ? DEFAULT_VOICE_KEY : filterLanguage;
                  void assignVoice(selectedVoice, role)
                    .then(() => {
                      preview.stop();
                      onClose();
                    })
                    .catch((e) =>
                      preview.setError(
                        e instanceof Error ? e.message : "Failed to save voice",
                      ),
                    )
                    .finally(() => setAssigningId(null));
                }}
              >
                {assigningId === selectedVoice.voiceId ? "Saving..." : "Save"}
              </button>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...styles.chip,
        ...(active ? styles.chipActive : null),
      }}
    >
      {label}
    </button>
  );
}

const styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    background: "rgba(0, 0, 0, 0.5)",
    backdropFilter: "blur(6px)",
    boxSizing: "border-box",
  } as React.CSSProperties,
  modal: {
    display: "flex",
    flexDirection: "column",
    width: "min(1024px, calc(100vw - 32px))",
    maxHeight: "min(760px, calc(100vh - 72px))",
    border: "1px solid var(--border-strong, var(--border))",
    borderRadius: "12px",
    background: "var(--background-panel, var(--bg-panel, #111827))",
    color: "var(--foreground, var(--text, white))",
    overflow: "hidden",
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.45)",
  } as React.CSSProperties,
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "12px 20px 10px",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  } as React.CSSProperties,
  title: { margin: 0, fontSize: 20, fontWeight: 700 } as React.CSSProperties,
  subtitle: { margin: "4px 0 0", color: "var(--foreground-muted, var(--text-muted, #9ca3af))", fontSize: 14 } as React.CSSProperties,
  closeButton: {
    alignSelf: "flex-start",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--background, var(--bg, transparent))",
    color: "var(--foreground-muted, var(--text-muted, #9ca3af))",
    padding: "8px 12px",
    cursor: "pointer",
  } as React.CSSProperties,
  searchBar: { padding: "10px 20px", borderBottom: "1px solid var(--border)" } as React.CSSProperties,
  searchInput: {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--background, var(--bg, #0b1020))",
    color: "var(--foreground, var(--text, white))",
    padding: "8px 10px",
  } as React.CSSProperties,
  body: { display: "flex", minHeight: 0, flex: 1 } as React.CSSProperties,
  sidebar: {
    width: 220,
    flexShrink: 0,
    borderRight: "1px solid var(--border)",
    padding: "12px 8px",
    overflowY: "auto",
  } as React.CSSProperties,
  sidebarTitle: {
    padding: "0 8px 8px",
    color: "var(--foreground-dim, var(--text-muted, #9ca3af))",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontSize: 12,
    fontWeight: 700,
  } as React.CSSProperties,
  sidebarHint: {
    padding: "0 8px 10px",
    color: "var(--foreground-dim, var(--text-muted, #7c8498))",
    fontSize: 11,
    lineHeight: 1.35,
  } as React.CSSProperties,
  languageButton: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    width: "100%",
    border: 0,
    borderRadius: 8,
    background: "transparent",
    color: "var(--foreground-muted, var(--text-muted, #9ca3af))",
    padding: "7px 8px",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 14,
  } as React.CSSProperties,
  languageButtonActive: {
    background: "var(--primary-muted, rgba(168, 132, 255, 0.14))",
    color: "var(--foreground, var(--text, white))",
    fontWeight: 700,
  } as React.CSSProperties,
  truncate: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  count: { flexShrink: 0, color: "var(--foreground-dim, var(--text-muted, #7c8498))", fontSize: 12 } as React.CSSProperties,
  content: { display: "flex", minWidth: 0, minHeight: 0, flex: 1, flexDirection: "column" } as React.CSSProperties,
  filters: { flexShrink: 0, borderBottom: "1px solid var(--border)", padding: "10px 12px" } as React.CSSProperties,
  filterRow: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 5 } as React.CSSProperties,
  chip: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 999,
    background: "transparent",
    color: "var(--foreground-muted, var(--text-muted, #9ca3af))",
    padding: "3px 10px",
    cursor: "pointer",
    fontSize: 12,
  } as React.CSSProperties,
  chipActive: {
    borderColor: "var(--accent, var(--primary, #a78bfa))",
    background: "var(--primary-muted, rgba(168, 132, 255, 0.14))",
    color: "var(--foreground, var(--text, white))",
  } as React.CSSProperties,
  accentInput: {
    width: "min(260px, 100%)",
    boxSizing: "border-box",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--background, var(--bg, #0b1020))",
    color: "var(--foreground, var(--text, white))",
    padding: "6px 10px",
  } as React.CSSProperties,
  list: { minHeight: 0, flex: 1, overflowY: "auto", padding: 16 } as React.CSSProperties,
  showing: { marginBottom: 12, fontSize: 14, fontWeight: 700 } as React.CSSProperties,
  message: { color: "var(--foreground-muted, var(--text-muted, #9ca3af))", fontSize: 14 } as React.CSSProperties,
  refreshing: { color: "var(--foreground-dim, var(--text-muted, #7c8498))", fontSize: 12 } as React.CSSProperties,
  error: { color: "var(--error, #f87171)", fontSize: 14 } as React.CSSProperties,
  voiceList: { display: "flex", flexDirection: "column", gap: 10, padding: 0, margin: 0, listStyle: "none" } as React.CSSProperties,
  voiceRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--background, var(--bg, #0b1020))",
    padding: 12,
  } as React.CSSProperties,
  voiceRowSelected: {
    borderColor: "var(--primary, #a78bfa)",
    boxShadow: "0 0 0 1px var(--primary, #a78bfa)",
  } as React.CSSProperties,
  verifiedOk: {
    marginTop: 4,
    color: "var(--success, #34d399)",
    fontSize: 12,
    fontWeight: 700,
  } as React.CSSProperties,
  verifiedWarn: {
    marginTop: 4,
    color: "var(--warning, #fbbf24)",
    fontSize: 12,
    fontWeight: 700,
  } as React.CSSProperties,
  voiceMain: { minWidth: 0, flex: 1 } as React.CSSProperties,
  voiceName: { fontWeight: 700, fontSize: 14 } as React.CSSProperties,
  voiceMeta: { marginTop: 3, color: "var(--foreground-muted, var(--text-muted, #9ca3af))", fontSize: 12 } as React.CSSProperties,
  emotion: { marginTop: 4, color: "var(--accent, var(--primary, #a78bfa))", fontSize: 12, fontWeight: 700 } as React.CSSProperties,
  voiceActions: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, flexShrink: 0 } as React.CSSProperties,
  secondaryButton: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderRadius: 8,
    background: "transparent",
    color: "var(--foreground-muted, var(--text-muted, #9ca3af))",
    padding: "7px 10px",
    cursor: "pointer",
    fontSize: 12,
  } as React.CSSProperties,
  secondaryButtonActive: {
    borderColor: "var(--primary, #a78bfa)",
    background: "var(--primary-muted, rgba(168, 132, 255, 0.14))",
    color: "var(--foreground, var(--text, white))",
  } as React.CSSProperties,
  primaryButton: {
    border: 0,
    borderRadius: 8,
    background: "var(--primary, var(--accent, #a78bfa))",
    color: "var(--on-primary, var(--on-accent, #111827))",
    padding: "6px 12px",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
    lineHeight: 1.2,
  } as React.CSSProperties,
  primaryButtonActive: {
    outline: "2px solid var(--on-primary, var(--on-accent, #111827))",
    outlineOffset: 1,
  } as React.CSSProperties,
  assignFooter: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
    padding: "12px 20px",
    borderTop: "1px solid var(--border)",
    flexShrink: 0,
  } as React.CSSProperties,
  assignFooterTitle: {
    width: "100%",
    fontSize: 13,
    fontWeight: 700,
    marginBottom: -4,
  } as React.CSSProperties,
  roleOption: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    cursor: "pointer",
  } as React.CSSProperties,
  assignFooterActions: {
    marginLeft: "auto",
    display: "flex",
    gap: 8,
  } as React.CSSProperties,
  loadMore: {
    display: "block",
    margin: "16px auto 0",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "transparent",
    color: "var(--foreground-muted, var(--text-muted, #9ca3af))",
    padding: "8px 14px",
    cursor: "pointer",
  } as React.CSSProperties,
};
