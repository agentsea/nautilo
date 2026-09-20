import { genieVoiceSampleTextForLanguage, type AgentProfileFull, type AgentProfileResponse, type CatalogLanguageGroup, type CatalogQuery, type CatalogResponse, type CatalogVoice } from "@nautilo/types";

import {
  createSettingsDataState,
  sameSettingsDataScope,
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsLoadResult,
} from "./settings-data-state";
import { requireAgentProfile } from "./agent-profile-access";

export type VoiceSettingsApi = {
  getProfile(options?: { fresh?: boolean }): Promise<AgentProfileResponse>;
  listVoiceCatalog(query: CatalogQuery): Promise<CatalogResponse>;
  previewVoice(voiceId: string, input?: { text?: string }): Promise<Blob>;
  upsertVoiceAssignment(language: string, ref: { voiceId: string; voiceName: string }): Promise<unknown>;
  removeVoiceAssignment(language: string): Promise<unknown>;
};

export interface VoiceCatalogState {
  readonly scope: SettingsDataScope | null;
  readonly voices: readonly CatalogVoice[];
  readonly languageGroups: readonly CatalogLanguageGroup[];
  readonly search: string;
  readonly language: string | null;
  readonly category: CatalogQuery["category"] | null;
  readonly gender: string | null;
  readonly age: string | null;
  readonly accent: string;
  readonly useCase: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: Error | null;
  readonly hasMore: boolean;
  readonly elevenLabsConfigured: boolean | null;
}

export type VoiceSettingsOutcome =
  | { status: "applied" }
  | { status: "ignored" }
  | { status: "failed"; message: string };

export interface VoiceSettingsController {
  readonly data: SettingsDataStateController<AgentProfileFull, null>;
  getCatalog(): Readonly<VoiceCatalogState>;
  subscribeCatalog(listener: () => void): () => void;
  setScope(scope: SettingsDataScope | null): void;
  dispose(): void;
  load(): Promise<SettingsLoadResult<AgentProfileFull>>;
  setCatalogFilters(filters: {
    search?: string;
    language?: string | null;
    category?: CatalogQuery["category"] | null;
    gender?: string | null;
    age?: string | null;
    accent?: string;
    useCase?: string | null;
  }): void;
  loadCatalog(): Promise<void>;
  loadMore(): Promise<void>;
  assign(voice: CatalogVoice, role: string): Promise<VoiceSettingsOutcome>;
  makePrimary(language: string): Promise<VoiceSettingsOutcome>;
  removeLanguage(language: string): Promise<VoiceSettingsOutcome>;
  preview(voiceId: string, language: string): Promise<Blob>;
}

const PAGE_SIZE = 30;

export function createVoiceSettingsController(
  apiForScope: (scope: SettingsDataScope) => VoiceSettingsApi,
): VoiceSettingsController {
  const data = createSettingsDataState<AgentProfileFull, null>();
  let disposed = false;
  let catalogGeneration = 0;
  let catalog: VoiceCatalogState = emptyCatalog(null);
  const catalogCache = new Map<string, Pick<VoiceCatalogState, "voices" | "languageGroups" | "hasMore" | "elevenLabsConfigured">>();
  const listeners = new Set<() => void>();
  const emit = (): void => { for (const listener of listeners) listener(); };
  const replaceCatalog = (next: VoiceCatalogState): void => { catalog = next; emit(); };
  const loadProfile = async (scope: SettingsDataScope): Promise<AgentProfileFull> => {
    const response = await apiForScope(scope).getProfile({ fresh: true });
    return requireAgentProfile(response);
  };
  const validCatalog = (scope: SettingsDataScope, generation: number): boolean =>
    !disposed && generation === catalogGeneration && sameSettingsDataScope(catalog.scope, scope);
  const requestCatalog = async (append: boolean): Promise<void> => {
    const scope = catalog.scope;
    if (disposed || !scope || (append && (!catalog.hasMore || catalog.loading || catalog.loadingMore))) return;
    const generation = ++catalogGeneration;
    replaceCatalog({ ...catalog, loading: !append, loadingMore: append, error: null });
    const query: CatalogQuery = { page: append ? pageFor(catalog.voices.length) : 0, page_size: PAGE_SIZE };
    if (catalog.search.trim()) query.search = catalog.search.trim();
    if (catalog.language) query.language = catalog.language;
    if (catalog.category) query.category = catalog.category;
    if (catalog.gender) query.gender = catalog.gender;
    if (catalog.age) query.age = catalog.age;
    if (catalog.accent.trim()) query.accent = catalog.accent.trim();
    if (catalog.useCase) query.use_cases = catalog.useCase;
    try {
      const response = await apiForScope(scope).listVoiceCatalog(query);
      if (!validCatalog(scope, generation)) return;
      const voices = sortVoicesByTrust(
        append ? dedupe([...catalog.voices, ...response.voices]) : response.voices,
        catalog.language,
      );
      replaceCatalog({
        ...catalog, voices, languageGroups: response.languageGroups, loading: false, loadingMore: false,
        error: response.error ? new Error(response.error) : null, hasMore: response.hasMore,
        elevenLabsConfigured: response.elevenLabsConfigured,
      });
      catalogCache.set(catalogKey(catalog), {
        voices,
        languageGroups: response.languageGroups,
        hasMore: response.hasMore,
        elevenLabsConfigured: response.elevenLabsConfigured,
      });
    } catch (error) {
      if (!validCatalog(scope, generation)) return;
      replaceCatalog({ ...catalog, loading: false, loadingMore: false, error: toError(error) });
    }
  };
  const mutation = async (fn: (api: VoiceSettingsApi, profile: AgentProfileFull) => Promise<void>): Promise<VoiceSettingsOutcome> => {
    const profile = data.getState().data;
    if (!profile) return { status: "ignored" };
    const result = await data.mutate(async (scope) => fn(apiForScope(scope), profile), loadProfile);
    if (result.status === "applied") return { status: "applied" };
    if (result.status === "ignored") return { status: "ignored" };
    return { status: "failed", message: voiceSettingsErrorMessage(result.error) };
  };

  return {
    data,
    getCatalog: () => catalog,
    subscribeCatalog(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setScope(scope) {
      if (disposed) return;
      const changed = !sameSettingsDataScope(catalog.scope, scope);
      data.setScope(scope);
      if (changed) {
        ++catalogGeneration;
        replaceCatalog(emptyCatalog(scope));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ++catalogGeneration;
      data.dispose();
      catalog = emptyCatalog(null);
      listeners.clear();
    },
    load: () => data.load(loadProfile),
    setCatalogFilters(filters) {
      if (disposed || !catalog.scope) return;
      const search = filters.search ?? catalog.search;
      const language = filters.language === undefined ? catalog.language : filters.language;
      const category = filters.category === undefined ? catalog.category : filters.category;
      const gender = filters.gender === undefined ? catalog.gender : filters.gender;
      const age = filters.age === undefined ? catalog.age : filters.age;
      const accent = filters.accent ?? catalog.accent;
      const useCase = filters.useCase === undefined ? catalog.useCase : filters.useCase;
      if (search === catalog.search && language === catalog.language &&
        category === catalog.category && gender === catalog.gender && age === catalog.age &&
        accent === catalog.accent && useCase === catalog.useCase) return;
      ++catalogGeneration;
      const next = { ...emptyCatalog(catalog.scope), search, language, category, gender, age, accent, useCase };
      const cached = catalogCache.get(catalogKey(next));
      replaceCatalog(cached ? { ...next, ...cached } : next);
    },
    loadCatalog: () => requestCatalog(false),
    loadMore: () => requestCatalog(true),
    assign: (voice, role) => {
      if (!role.trim()) return Promise.resolve({ status: "failed", message: "Choose a language before assigning this voice." });
      return mutation((api) => api.upsertVoiceAssignment(role, { voiceId: voice.voiceId, voiceName: voice.name }).then(() => undefined));
    },
    makePrimary: (language) => mutation(async (api, profile) => {
      const ref = profile.voices[language];
      if (!ref) throw new Error("That language voice is no longer assigned. Refresh and try again.");
      await api.upsertVoiceAssignment("default", ref);
    }),
    removeLanguage: (language) => {
      if (language === "default") return Promise.resolve({ status: "failed", message: "Your primary voice cannot be removed. Choose another primary voice instead." });
      return mutation((api) => api.removeVoiceAssignment(language).then(() => undefined));
    },
    preview: async (voiceId, language) => {
      const scope = data.getState().scope;
      if (!scope) throw new Error("Sign in and reconnect before previewing voices.");
      return apiForScope(scope).previewVoice(voiceId, { text: genieVoiceSampleTextForLanguage(language) });
    },
  };
}

function voiceSettingsErrorMessage(error: unknown): string {
  const status = statusOf(error);
  if (status === 401) return "Your session has expired. Sign in again before changing voices.";
  if (status === 429) return "Voice previews are temporarily limited. Please try again shortly.";
  if (status === 503) return "Voice service is unavailable on this server right now.";
  return error instanceof Error && error.message ? error.message : "Could not update your voice settings.";
}

function emptyCatalog(scope: SettingsDataScope | null): VoiceCatalogState {
  return { scope, voices: [], languageGroups: [], search: "", language: null, category: null, gender: null, age: null, accent: "", useCase: null, loading: false, loadingMore: false, error: null, hasMore: false, elevenLabsConfigured: null };
}
function catalogKey(catalog: Pick<VoiceCatalogState, "search" | "language" | "category" | "gender" | "age" | "accent" | "useCase">): string {
  return JSON.stringify([
    catalog.search.trim().toLowerCase(), catalog.language, catalog.category, catalog.gender,
    catalog.age, catalog.accent.trim().toLowerCase(), catalog.useCase,
  ]);
}
// The API pages are zero-based. A short final/filtered page still advances to
// the next page; deriving this from `floor(count / size)` would request page 0
// again whenever a provider returned fewer than the requested page size.
function pageFor(count: number): number { return Math.ceil(count / PAGE_SIZE); }
function dedupe(voices: readonly CatalogVoice[]): CatalogVoice[] {
  const ids = new Set<string>();
  return voices.filter((voice) => !ids.has(voice.voiceId) && (ids.add(voice.voiceId), true));
}
function languageBase(language: string): string { return language.trim().toLowerCase().split("-")[0] ?? language; }
function trustRank(voice: CatalogVoice, language: string | null): number {
  if (voice.source === "curated") return 0;
  if (!language) return 2;
  const base = languageBase(language);
  return voice.verifiedLanguages.some((entry) =>
    (languageBase(entry.language) === base || entry.language.toLowerCase() === language.toLowerCase())
  ) ? 1 : 2;
}
function sortVoicesByTrust(voices: readonly CatalogVoice[], language: string | null): CatalogVoice[] {
  return voices
    .map((voice, index) => ({ voice, index }))
    .sort((a, b) => trustRank(a.voice, language) - trustRank(b.voice, language) || a.index - b.index)
    .map(({ voice }) => voice);
}
function toError(value: unknown): Error { return value instanceof Error ? value : new Error("Could not load the voice catalog."); }
function statusOf(value: unknown): number | null { return value !== null && typeof value === "object" && "status" in value && typeof (value as { status?: unknown }).status === "number" ? (value as { status: number }).status : null; }
