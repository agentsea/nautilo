/**
 * D091 — shared type definitions for the onboarding wizard.
 *
 * Types live here so the renderer + screens + hooks all consume the
 * same contracts. Hosts provide the `OnboardingAPI` implementation at mount.
 */

import type {
  CatalogLanguageGroup as SharedCatalogLanguageGroup,
  CatalogQuery as SharedCatalogQuery,
  CatalogResponse as SharedCatalogResponse,
  CatalogVerifiedLanguage as SharedCatalogVerifiedLanguage,
  CatalogVoice as SharedCatalogVoice,
} from "@nautilo/types";

/**
 * Orb visual state. Maps to `uIntensity` lerp targets in the shader
 * (identical semantics to the legacy inline HTML at
 * `packages/server/src/setup/index.html` lines 1305–1323):
 *   - idle       : uIntensity 0   — slow breathe, minimal displacement
 *   - speaking   : uIntensity 0.5 — moderate pulse, voice-synced cue
 *   - compiling  : uIntensity 1.0 — max displacement, "thinking"
 *   - hidden     : canvas display:none, animation paused
 */
export type OrbState = "idle" | "speaking" | "compiling" | "hidden";

/**
 * Screen index — 0..10. The wizard's reducer treats `screen` as a
 * numeric ScreenId so reducers + ProgressDots can index uniformly.
 *
 * Names map (post-D091 KeysScreen removal, post-D215 language-step skip):
 *   0 Welcome · 1 Reserved/skipped · 2 Privacy · 3 WorkLife
 *   4 Owner · 5 Personality · 6 Name · 7 Compiling
 *   8 Avatar · 9 Voice · 10 Reveal
 *
 * Name intentionally precedes Compiling. Soul generation consumes the name;
 * compiling first forced every newly named Genie to regenerate again on the
 * final "Saving…" screen.
 */
export type ScreenId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * Total visible screens. Used by `ProgressDots` for dot count and by
 * `useWizardState` to clamp NEXT past the last index.
 */
export const TOTAL_SCREENS: number = 11;

/** Optional deep-link target when re-opening the wizard from Settings. */
export type OnboardingStartAt = "personality" | "avatar";

/**
 * Translate a re-customization target into the reducer's stable screen ID.
 *
 * A host owns the current `startAt` value, but malformed input must behave
 * like no target rather than becoming an invalid reducer jump.
 */
export function screenForOnboardingStartAt(startAt: unknown): ScreenId | null {
  switch (startAt) {
    case "personality":
      return 5;
    case "avatar":
      return 8;
    default:
      return null;
  }
}

/** Internal onboarding/profile language. The UI remains English-first for now. */
export type Language = "en" | "es";

/** WorkLife screen — three-option picker. null = unset. */
export type WorkLifeChoice = "work" | "life" | "both";

/**
 * Voice catalog item (matches the shape returned by GET /api/voices).
 * Slug is the curated pick name (e.g. "carolyn"); voiceId is the
 * upstream provider's voice id; soulLabel is the human-readable
 * label used in the persisted soul file.
 */
export interface VoiceSelection {
  slug: string;
  profileVoiceName: string;
  voiceId: string;
  soulLabel: string;
  /** Server-relative static sample for curated voices. */
  previewUrl?: string | undefined;
}

/**
 * The voice provider state observed during this wizard session. `unknown` is
 * only the short pre-hydration state; screens must not treat it as configured.
 */
export type VoiceCapability =
  | "unknown"
  | "configured"
  | "unconfigured"
  | "runtime-unavailable";

/** Canonical shared-voice contracts; do not fork them in host renderers. */
export type CatalogQuery = SharedCatalogQuery;
export type CatalogVerifiedLanguage = SharedCatalogVerifiedLanguage;
export type CatalogVoice = SharedCatalogVoice;
export type CatalogLanguageGroup = SharedCatalogLanguageGroup;
export type CatalogResponse = SharedCatalogResponse;

/**
 * Avatar choice. Presets come from the curated grid; generated
 * images carry both a display URL and a canonical `AvatarRef`.
 */
export type AvatarSource = "preset" | "generated";

export type AvatarRef =
  | { kind: "preset"; id: string }
  | { kind: "uploaded"; blobId: string }
  | { kind: "generated"; blobId: string };

/** A D487-owned selection. Custom photos are addressed only by entry id. */
export type AvatarSelectionTarget =
  | { kind: "preset"; presetId: string }
  | { kind: "entry"; entryId: string };

export type AvatarGenerationEvent =
  | { type: "partial"; avatarUrl: string; partialImageIndex: number; model?: string }
  | { type: "completed"; target: AvatarSelectionTarget; avatarUrl: string; model?: string }
  | { type: "error"; error: string; detail?: string };

export type SoulGenerationEvent =
  | { type: "started" }
  | { type: "delta"; text: string }
  | { type: "completed"; soulFile: string }
  | { type: "error"; error: string; fallback?: string };

/**
 * Server-side feature flags surfaced to the wizard at boot. Drives
 * conditional UI (e.g. avatar-gen requires OpenAI key, mother
 * easter egg requires a build-time flag).
 */
export interface OnboardingConfigFlags {
  /** True when the server's keystore has an OpenAI key configured —
   *  enables DALL·E avatar generation in AvatarScreen. */
  avatarGenAvail: boolean;
  /** Hidden ostranenie field on the personality screen. Optional. */
  motherEasterEgg: boolean;
}

/**
 * Viewer flags from `GET /api/setup/status` (D125). Hydrated once at wizard
 * mount; substeps gate on these instead of a client-side mode discriminator.
 */
export interface OnboardingViewerState {
  genieCustomized: boolean;
  pinEnrolled: boolean;
  handleAutoGenerated: boolean;
  displayNameSet: boolean;
  recoveryCodesAcknowledged: boolean;
}

/** Conservative defaults when setup/status viewer is not yet wired. */
export const DEFAULT_VIEWER_STATE: OnboardingViewerState = {
  genieCustomized: false,
  pinEnrolled: false,
  handleAutoGenerated: false,
  displayNameSet: false,
  recoveryCodesAcknowledged: false,
};

/**
 * Existing-profile snapshot returned by `loadExistingProfile`.
 *
 * Null when the user is in first-run mode (profile is 404 OR
 * `onboardingCompleted: false`); populated when re-triggering an
 * already-completed onboarding via Settings → Personalize your Genie
 * (or `NAUTILO_FORCE_ONBOARDING=1` in dev).
 *
 * Field names match the server's `/api/profile` response shape so
 * main can pass it through to the wizard with a single field-name
 * remap (we keep camelCase on the wire). Hydrating screens read
 * these and dispatch HYDRATE; reducer copies them onto WizardState.
 */
export interface ProfileSnapshot {
  name: string;
  language: Language;
  workLifeMode: WorkLifeChoice | null;
  privacySpectrum: number;
  personalityPrompt: string | null;
  motherAnswer: string | null;
  /** D261 — primary voice from `voices.default`. */
  defaultVoice: { voiceId: string; voiceName: string } | null;
  avatar: AvatarRef | null;
  avatarUrl: string | null;
  soulFile: string | null;
}

/**
 * Result envelope every API-proxy IPC channel returns. Discriminated
 * by `ok` so callers never have to unwrap a thrown rejection — main
 * catches the network/HTTP error and surfaces it as
 * `{ ok: false, error: "..." }`. Renderer code deals only with
 * structured envelopes.
 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Full onboarding IPC API surface. Every API-proxy channel
 * returns an `IpcResult<T>` so transport / HTTP errors surface
 * uniformly.
 *
 * Auth handling (main side): authenticated IPC calls attach the
 * Logto access token from the main-process token store (see
 * `showOnboardingWizard` in `main.ts`).
 *
 * Note on provider keys: the wizard does NOT manage LLM / TTS
 * provider keys. Keys are server-side configuration set via
 * `~/.nautilo/instance.env` or a future server admin UI. The
 * wizard assumes keys exist; CompilingScreen's `generateSoul`
 * call surfaces a clear error if they don't.
 */
export interface OnboardingAPI {
  // ── Window lifecycle ───────────────────────────────────────────
  getServerUrl: () => Promise<string>;
  complete: () => Promise<void>;
  cancel: () => Promise<void>;

  // ── Hydration channels (called once at wizard mount) ───────────
  /** Returns the existing profile snapshot if one is already
   *  populated + `onboardingCompleted: true`; null otherwise.
   *  Mode discriminator: null → first-run, populated → re-trigger. */
  loadExistingProfile: () => Promise<IpcResult<ProfileSnapshot | null>>;
  /** Build-time feature flags surfaced to conditional UI. */
  getConfigFlags: () => Promise<IpcResult<OnboardingConfigFlags>>;
  /** Re-trigger target supplied by Settings → My Agent actions. */
  getStartAt: () => Promise<OnboardingStartAt | null>;

  /** GET /api/voices — curated + upstream voice catalog. */
  getVoices: () => Promise<
    IpcResult<{
      curated: VoiceSelection[];
      voices: Array<{ id: string; name: string }>;
      elevenLabsConfigured: boolean;
    }>
  >;
  /** POST /api/voices/:id/preview — TTS sample using the
   *  agent's display name. Returns audio URL or base64. */
  previewVoice: (input: {
    voiceId: string;
    displayName: string;
    text?: string | undefined;
  }) => Promise<IpcResult<{ audioUrl: string }>>;
  /** GET /api/voices/catalog — emotion-compatible shared-voices proxy. */
  listVoiceCatalog: (
    query?: CatalogQuery,
  ) => Promise<IpcResult<CatalogResponse>>;

  /** POST /api/profile/generate-soul — ~5–15s LLM call. Body
   *  carries collected personality fields. Long-poll friendly;
   *  CompilingScreen drives the orb to "compiling" state during
   *  the call. */
  generateSoul: (input: {
    name?: string | undefined;
    language: Language;
    workLifeMode?: WorkLifeChoice | undefined;
    privacySpectrum?: number | undefined;
    personalityPrompt?: string | undefined;
    motherAnswer?: string | undefined;
  }) => Promise<IpcResult<{ soulFile: string }>>;
  onSoulGenerationEvent?: (
    handler: (event: SoulGenerationEvent) => void,
  ) => () => void;
  /** Canonical owned-photo generation. Conditional on the server's
   *  provider policy being configured. */
  generateAvatar: (input: {
    prompt: string;
  }) => Promise<IpcResult<{ target: AvatarSelectionTarget; avatarUrl: string }>>;
  onAvatarGenerationEvent?: (
    handler: (event: AvatarGenerationEvent) => void,
  ) => () => void;

  /** PUT /api/profile — final write. Sets onboardingCompleted=true
   *  and persists every collected field. Called by RevealScreen
   *  before dispatching `complete`. */
  putProfile: (
    input: ProfileWrite,
  ) => Promise<IpcResult<{ ok: true }>>;
  /** D261 — persist primary or per-language voice (not via PUT /api/profile). */
  upsertVoiceAssignment: (
    language: string,
    ref: { voiceId: string; voiceName: string },
  ) => Promise<IpcResult<{ voices: Record<string, { voiceId: string; voiceName: string }> }>>;
}

/**
 * Final profile-write payload — RevealScreen assembles this from
 * `WizardState`. Server-side `PUT /api/profile` accepts the same
 * shape as the legacy HTML wizard so the route doesn't need to
 * change between Phase 2 and a future clean-up pass.
 */
export interface ProfileWrite {
  name: string;
  language: Language;
  workLifeMode: WorkLifeChoice | null;
  privacySpectrum: number;
  personalityPrompt: string | null;
  motherAnswer: string | null;
  /**
   * Explicit nullable legacy bridge fields. Desktop's host splits these into
   * the canonical voice-assignment write; a skipped voice retains the
   * existing assignment rather than requesting deletion.
   */
  voiceName: string | null;
  voiceId: string | null;
  /** Omitted when the Human kept the existing photo. */
  avatarTarget?: AvatarSelectionTarget | null;
  avatarUrl: string | null;
  /**
   * Omitted while first-run soul generation is still finishing in the
   * Desktop main process. The final profile write must not erase a soul that
   * the detached generation request persists concurrently.
   */
  soulFile?: string | null;
  onboardingCompleted: true;
  /**
   * M087 — auto-detected IANA timezone (e.g. "Europe/Athens"). The server's
   * `PUT /api/profile` route persists it to `users.timezone` (account-level,
   * not stored on the profile row). Captured at wizard start.
   */
  timezone?: string;
}
