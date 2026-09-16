/**
 * Host-owned, device-local preferences for sandboxed mini-apps.
 *
 * This deliberately is not app document state: preferences work for Current
 * Folder targets, and a mini-app never receives the viewer/app storage scope.
 */

export const WRITER_SPELL_PREFERENCE_KEY = "writer.spellcheck" as const;
export const DESIGN_RECEIPTS_PREFERENCE_KEY = "design.agentReceipts" as const;
export const VIDEO_RECEIPTS_PREFERENCE_KEY = "video.agentReceipts" as const;
export const VIDEO_FRAME_RATE_PREFERENCE_KEY = "video.firstSourceRate" as const;
export type AppPreferenceKey =
  | typeof WRITER_SPELL_PREFERENCE_KEY
  | typeof DESIGN_RECEIPTS_PREFERENCE_KEY
  | typeof VIDEO_RECEIPTS_PREFERENCE_KEY
  | typeof VIDEO_FRAME_RATE_PREFERENCE_KEY;

export type WriterSpellPreference = {
  enabled: boolean;
  /** The provider is currently bundled with US English only. */
  language: "en-US";
  personalWords: string[];
};

export type DesignReceiptsPreference = { enabled: boolean };
export type VideoReceiptsPreference = { enabled: boolean };
export type VideoFrameRatePreference = { decision: "ask" | "keep-project-rate" | "adopt-source-rate" };

export type AppPreferenceValue =
  | WriterSpellPreference
  | DesignReceiptsPreference
  | VideoReceiptsPreference
  | VideoFrameRatePreference;

const STORAGE_PREFIX = "nautilo.app-preferences.v1";
const MAX_PERSONAL_WORDS = 256;
const MAX_WORD_LENGTH = 64;
const MAX_SERIALIZED_BYTES = 16 * 1024;
const listeners = new Set<
  (scope: string, key: AppPreferenceKey, value: AppPreferenceValue) => void
>();

function defaultAppPreference(
  key: AppPreferenceKey,
): AppPreferenceValue {
  switch (key) {
    case VIDEO_FRAME_RATE_PREFERENCE_KEY:
      return { decision: "ask" };
    case WRITER_SPELL_PREFERENCE_KEY:
      return { enabled: true, language: "en-US", personalWords: [] };
    case DESIGN_RECEIPTS_PREFERENCE_KEY:
    case VIDEO_RECEIPTS_PREFERENCE_KEY:
      return { enabled: true };
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function normalizeWord(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const word = value.normalize("NFC").trim().toLocaleLowerCase();
  // Words only; this keeps document text out of the preference store and makes
  // an accidentally-pasted paragraph harmless.
  if (word.length === 0 || word.length > MAX_WORD_LENGTH || /\s/.test(word))
    return null;
  return word;
}

function normalizeWriterSpellPreference(
  value: unknown,
): WriterSpellPreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) =>
        key !== "enabled" && key !== "language" && key !== "personalWords",
    )
  ) {
    return null;
  }
  if (typeof candidate.enabled !== "boolean") return null;
  if (candidate.language !== undefined && candidate.language !== "en-US")
    return null;
  if (
    !Array.isArray(candidate.personalWords) ||
    candidate.personalWords.length > MAX_PERSONAL_WORDS
  )
    return null;
  const personalWords: string[] = [];
  const seen = new Set<string>();
  for (const item of candidate.personalWords) {
    const word = normalizeWord(item);
    if (!word) return null;
    if (!seen.has(word)) {
      seen.add(word);
      personalWords.push(word);
    }
  }
  const normalized: WriterSpellPreference = {
    enabled: candidate.enabled,
    language: "en-US",
    personalWords,
  };
  return JSON.stringify(normalized).length <= MAX_SERIALIZED_BYTES
    ? normalized
    : null;
}

export function validateAppPreference(
  appId: string,
  key: unknown,
  value: unknown,
): AppPreferenceValue | null {
  if (appId === "nautilo-video" && key === VIDEO_FRAME_RATE_PREFERENCE_KEY) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).length !== 1) return null;
    const decision = candidate.decision;
    return decision === "ask" || decision === "keep-project-rate" || decision === "adopt-source-rate" ? { decision } : null;
  }
  if (appId === "nautilo-writer" && key === WRITER_SPELL_PREFERENCE_KEY)
    return normalizeWriterSpellPreference(value);
  if (appId === "nautilo-design" && key === DESIGN_RECEIPTS_PREFERENCE_KEY) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).length !== 1 || typeof candidate.enabled !== "boolean") return null;
    return { enabled: candidate.enabled };
  }
  if (appId === "nautilo-video" && key === VIDEO_RECEIPTS_PREFERENCE_KEY) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).length !== 1 || typeof candidate.enabled !== "boolean") return null;
    return { enabled: candidate.enabled };
  }
  return null;
}

function storageKey(
  viewerKey: string,
  appId: string,
  key: AppPreferenceKey,
): string {
  return `${STORAGE_PREFIX}.${viewerKey}.${appId}.${key}`;
}

function scope(viewerKey: string, appId: string): string {
  return `${viewerKey}\u0000${appId}`;
}

export function getAppPreference(
  viewerKey: string | null | undefined,
  appId: string,
  key: AppPreferenceKey,
): AppPreferenceValue {
  const fallback = defaultAppPreference(key);
  if (!viewerKey || !validateAppPreference(appId, key, fallback))
    return fallback;
  try {
    const raw =
      safeStorage()?.getItem(storageKey(viewerKey, appId, key)) ?? null;
    if (!raw) return fallback;
    return validateAppPreference(appId, key, JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setAppPreference(
  viewerKey: string | null | undefined,
  appId: string,
  key: AppPreferenceKey,
  value: unknown,
): AppPreferenceValue | null {
  if (!viewerKey) return null;
  const normalized = validateAppPreference(appId, key, value);
  if (!normalized) return null;
  try {
    safeStorage()?.setItem(
      storageKey(viewerKey, appId, key),
      JSON.stringify(normalized),
    );
  } catch {
    // Private mode / quota failure: the caller still receives a safe value for
    // this live surface, but persistence is intentionally best-effort.
  }
  const scopeKey = scope(viewerKey, appId);
  for (const listener of listeners) {
    try {
      listener(scopeKey, key, normalized);
    } catch {
      /* isolated listener */
    }
  }
  return normalized;
}

export function subscribeAppPreferences(
  viewerKey: string | null | undefined,
  appId: string,
  listener: (key: AppPreferenceKey, value: AppPreferenceValue) => void,
): () => void {
  if (!viewerKey) return () => {};
  const scopeKey = scope(viewerKey, appId);
  const wrapped = (
    changedScope: string,
    key: AppPreferenceKey,
    value: AppPreferenceValue,
  ) => {
    if (changedScope === scopeKey) listener(key, value);
  };
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}
