/**
 * D091 Phase 2 — wizard state machine.
 *
 * Single `useReducer` driving the entire 12-screen flow. Each screen
 * dispatches typed actions; the reducer is the only place that
 * mutates wizard state. Callers in screen components read the
 * current `state` and dispatch the action they need.
 *
 * Design notes:
 *   - One reducer over twelve screens. Per-screen sub-reducers
 *     would force every action union to be discriminated by screen
 *     too, multiplying types without simplifying logic.
 *   - Errors are per-field (`state.errors[fieldName]`). Screens
 *     surface their own field's error inline; the
 *     `SET_ERROR` / `CLEAR_ERROR` actions are screen-agnostic.
 *   - Navigation actions (NEXT, BACK, JUMP) clamp to valid screen
 *     range and never advance past the final screen — RevealScreen
 *     calls `onboarding:complete` directly at end-of-flow.
 *   - The reducer is pure. Side effects (fetch, audio, IPC) live
 *     in the screens themselves; reducer only updates state.
 */

import { useReducer, type Dispatch } from "react";
import type {
  AvatarRef,
  AvatarSource,
  Language,
  OnboardingConfigFlags,
  OnboardingViewerState,
  ProfileSnapshot,
  ScreenId,
  VoiceCapability,
  VoiceSelection,
  WorkLifeChoice,
} from "../types";
import { DEFAULT_VIEWER_STATE, TOTAL_SCREENS } from "../types";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/**
 * Phase of the soul-compile request. Drives `CompilingScreen`'s
 * orb-state + progress UI: idle (haven't started), running (request
 * in flight while visible), background (request in flight after the
 * timed screen advanced), done (server returned a soul file), error
 * (try again).
 */
export type CompilingPhase = "idle" | "running" | "background" | "done" | "error";

/** Genie-customization screens gated on `viewer.genieCustomized`. */
const GENIE_SCREEN_IDS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  5, 6, 7, 8, 9, 10,
]);

export interface WizardState {
  /** Current screen index (0..11). Reducer clamps to range; never
   *  out of bounds even if a buggy NEXT fires past the end. */
  screen: ScreenId;

  /** Server-derived viewer flags from setup/status (or derived at HYDRATE). */
  viewer: OnboardingViewerState;

  /** Frozen copy of the post-HYDRATE state, captured BEFORE any
   *  user input. `shouldRunCompile` reads this to detect "did the
   *  user change a material profile field" — when nothing changed,
   *  Compiling screen is skipped. Null when no profile was hydrated. */
  hydratedSnapshot: WizardState | null;

  /** Server-side feature flags. Populated at HYDRATE; drives
   *  conditional UI on KeysScreen + AvatarScreen + PersonalityScreen. */
  flags: OnboardingConfigFlags;

  // ── Internal profile language (screen 1 is skipped) ────────────
  language: Language;

  // ── Privacy (screen 2) ─────────────────────────────────────────
  /** 0..100 privacy slider. 0 = closed-book, 100 = open-book.
   *  Persisted as `privacySpectrum` on the profile. */
  privacySlider: number;

  // ── WorkLife (screen 3) ────────────────────────────────────────
  workLifeChoice: WorkLifeChoice | null;

  // ── Personality (screen 5) ─────────────────────────────────────
  personalityPrompt: string;
  /** "Mother answer" — optional easter-egg field surfaced when
   *  the server reports `motherEasterEgg=true`. Personality screen
   *  hides it otherwise. */
  motherAnswer: string;

  // ── Name (screen 6) ────────────────────────────────────────────
  /** Agent's display name. Defaults to "Genie" (the generic
   *  species, not a specific picked name) if user skips. */
  name: string;

  // ── Compiling (screen 7) ───────────────────────────────────────
  /** Current phase of the soul-generation call.
   *  Transitions: idle → running → (done | error). Reducer caps a
   *  generation counter so a JUMP-back-then-retry doesn't race
   *  against a stale in-flight response. */
  compilingPhase: CompilingPhase;
  /** Monotonically-incrementing generation counter. Each new
   *  `START_COMPILE` bumps it; in-flight responses check the
   *  current generation matches before applying the result. */
  compilingGeneration: number;
  /** Soul file content returned by `generateSoul`. Persisted as
   *  `soulFile` in the final profile write. Cleared on
   *  RESTART_COMPILE so a re-run isn't shadowed by a stale file. */
  soulFile: string | null;

  // ── Avatar (screen 8) ──────────────────────────────────────────
  avatarSource: AvatarSource | null;
  avatarChoice: string | null;
  avatarRef: AvatarRef | null;
  /** Pending D487 selection; null means keep the canonical current photo. */
  avatarTarget: import("../types").AvatarSelectionTarget | null;

  // ── Voice (screen 9) ───────────────────────────────────────────
  voiceSelection: VoiceSelection | null;
  /** True when the user explicitly chose "skip voice" — the
   *  Reveal screen suppresses the TTS greeting playback in this
   *  case. */
  voiceSkipped: boolean;
  /** Capability observed by VoiceScreen. A provider failure must never make a
   * stale selection look usable to Reveal or a targeted re-customization. */
  voiceCapability: VoiceCapability;

  // ── Cross-cutting ──────────────────────────────────────────────
  /** Per-field error messages. Screens write into this map via
   *  SET_ERROR; screen UI reads back and renders inline. Keyed by
   *  a stable string the screen owns (e.g. "compile.soul"). */
  errors: Record<string, string>;
}

/** Initial state — defaults match the legacy HTML wizard's
 *  `wizardState` initializer at `setup/index.html` line 999.
 *  HYDRATE merges either a profile or `null` over this baseline. */
const INITIAL_WIZARD_STATE: WizardState = {
  screen: 0,
  viewer: DEFAULT_VIEWER_STATE,
  hydratedSnapshot: null,
  flags: { avatarGenAvail: false, motherEasterEgg: false },
  language: "en",
  privacySlider: 50,
  workLifeChoice: null,
  personalityPrompt: "",
  motherAnswer: "",
  compilingPhase: "idle",
  compilingGeneration: 0,
  soulFile: null,
  avatarSource: null,
  avatarChoice: null,
  avatarRef: null,
  avatarTarget: null,
  name: "",
  voiceSelection: null,
  voiceSkipped: false,
  voiceCapability: "unknown",
  errors: {},
};

// ---------------------------------------------------------------------------
// Action union
// ---------------------------------------------------------------------------

export type WizardAction =
  // Hydration
  | {
      type: "HYDRATE";
      profile: ProfileSnapshot | null;
      flags: OnboardingConfigFlags;
      viewer?: OnboardingViewerState | null;
    }
  // Navigation
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "JUMP"; screen: ScreenId }
  // Per-screen field setters
  | { type: "SET_LANGUAGE"; lang: Language }
  | { type: "SET_PRIVACY"; value: number }
  | { type: "SET_WORK_LIFE"; choice: WorkLifeChoice }
  | { type: "UPDATE_VIEWER"; viewer: Partial<OnboardingViewerState> }
  | { type: "SET_PERSONALITY"; value: string }
  | { type: "SET_MOTHER_ANSWER"; value: string }
  | { type: "START_COMPILE" }
  | { type: "DEFER_COMPILE"; generation: number }
  | { type: "FINISH_COMPILE"; generation: number; soulFile: string }
  | { type: "ERROR_COMPILE"; generation: number; message: string }
  | { type: "RESTART_COMPILE" }
  | {
      type: "SET_AVATAR";
      source: AvatarSource;
      url: string;
      avatar?: AvatarRef | null;
      target?: import("../types").AvatarSelectionTarget | null;
    }
  | { type: "SET_NAME"; value: string }
  | { type: "SET_VOICE"; selection: VoiceSelection }
  | { type: "SKIP_VOICE" }
  | { type: "SET_VOICE_CAPABILITY"; capability: VoiceCapability }
  // Cross-cutting
  | { type: "SET_ERROR"; field: string; message: string }
  | { type: "CLEAR_ERROR"; field: string }
  | { type: "RESET" };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function clampScreen(n: number): ScreenId {
  if (n < 0) return 0;
  if (n >= TOTAL_SCREENS) return (TOTAL_SCREENS - 1) as ScreenId;
  return n as ScreenId;
}

/** Profile re-customization session (Settings → Personalize Genie). */
export function isGenieRecustomizeSession(state: WizardState): boolean {
  return state.hydratedSnapshot !== null;
}

/**
 * Genie substeps render when the agent is not yet customized, or when the
 * user re-opened the wizard with a hydrated profile to tweak Genie fields.
 */
export function shouldVisitGenieSubstep(state: WizardState): boolean {
  if (state.viewer.genieCustomized === false) return true;
  return state.hydratedSnapshot !== null;
}

export function shouldVisitOwnerScreen(state: WizardState): boolean {
  void state;
  return false;
}

/**
 * What a final save may do to the canonical default voice assignment.
 *
 * The server's current contract supports assignment but not deletion. A
 * skipped first customization therefore writes no voice, while a skipped
 * re-customization deliberately retains the already persisted assignment.
 */
export type VoicePersistenceIntent = "skip" | "retain" | "replace";

export function voicePersistenceIntent(state: WizardState): VoicePersistenceIntent {
  const existingVoice = state.hydratedSnapshot?.voiceSelection ?? null;
  if (state.voiceSkipped || state.voiceSelection === null) {
    return existingVoice ? "retain" : "skip";
  }
  return existingVoice?.voiceId === state.voiceSelection.voiceId ? "retain" : "replace";
}

/** The only selection that may be written or greeted in this session. */
export function usableNewVoiceSelection(state: WizardState): VoiceSelection | null {
  if (state.voiceCapability !== "configured") return null;
  return voicePersistenceIntent(state) === "replace" ? state.voiceSelection : null;
}

/** Legacy profile fields stay nullable for Desktop compatibility. Null means
 * "do not alter the voice assignment", never "clear it". */
export function voiceProfileWriteFields(state: WizardState): Pick<
  import("../types").ProfileWrite,
  "voiceName" | "voiceId"
> {
  const selection = usableNewVoiceSelection(state);
  return {
    voiceName: selection?.profileVoiceName ?? null,
    voiceId: selection?.voiceId ?? null,
  };
}

/**
 * M128 D6 (2026-05-28): the wizard runs for every non-guest invitee.
 * A user whose ONLY Group is `guests` skips wizard entry entirely —
 * they have a Personal Genie they're free to customize, but the
 * default flow doesn't prompt them through the personalization steps.
 *
 * Returns `true` when the wizard should be SKIPPED at entry.
 *
 * Production hookup (P5 / follow-up): Electron main reads `groups`
 * from `/api/auth/whoami` before deciding to open the wizard window;
 * if `shouldSkipWizardForGuestOnly(groups)` returns true, main jumps
 * straight to the workbench instead. The hookup is one line at the
 * `showOnboardingWizard` call site.
 */
export interface WizardGroupChip {
  readonly type: string;
}

export function shouldSkipWizardForGuestOnly(
  groups: readonly WizardGroupChip[],
): boolean {
  return groups.length === 1 && groups[0]?.type === "guests";
}

function shouldVisitScreen(state: WizardState, screenId: ScreenId): boolean {
  // Full product / onboarding localization is not in this wizard. The Genie's
  // speaking language is now chosen in VoiceScreen's catalog browser.
  if (screenId === 1) return false;
  // Human account setup (name / handle / PIN / recovery codes) happens in
  // invite/admin setup surfaces, not in Genie customization.
  if (screenId === 4) return false;
  if (screenId === 7) {
    return shouldVisitGenieSubstep(state) && shouldVisitCompile(state);
  }
  if (GENIE_SCREEN_IDS.has(screenId)) {
    return shouldVisitGenieSubstep(state);
  }
  return true;
}

function deriveViewerFromHydration(
  profile: ProfileSnapshot | null,
  explicit: OnboardingViewerState | null | undefined,
): OnboardingViewerState {
  if (explicit) return explicit;
  if (profile === null) return { ...DEFAULT_VIEWER_STATE };
  // Signed-in re-entry with an existing agent profile — human account setup
  // lives in invite/admin/account-security surfaces, not this Genie wizard.
  return {
    genieCustomized: true,
    pinEnrolled: true,
    handleAutoGenerated: false,
    displayNameSet: true,
    recoveryCodesAcknowledged: true,
  };
}

/**
 * Predicate: does the Compiling screen (7) need to run on this NEXT?
 *
 * First-run: always yes (we're generating the soul for the first time).
 * Re-trigger: only when a material profile field has changed since the
 * frozen `hydratedSnapshot` baseline. Otherwise the existing soul file
 * is still authoritative — re-running soul-gen would just burn an LLM
 * call without changing the output.
 *
 * Material fields = the inputs the soul-gen prompt actually consumes:
 *   personalityPrompt, motherAnswer, privacySlider, workLifeChoice, name.
 *   Language technically influences the soul too but a language switch alone
 *   without other changes is rare; including it would push us toward re-running
 *   soul-gen on every language toggle. Punt; revisit if a user reports drift.
 */
function shouldRunCompile(state: WizardState): boolean {
  if (!shouldVisitGenieSubstep(state)) return false;
  const baseline = state.hydratedSnapshot;
  if (!baseline) return true;
  return (
    state.personalityPrompt !== baseline.personalityPrompt ||
    state.motherAnswer !== baseline.motherAnswer ||
    state.privacySlider !== baseline.privacySlider ||
    state.workLifeChoice !== baseline.workLifeChoice ||
    state.name !== baseline.name
  );
}

function shouldVisitCompile(state: WizardState): boolean {
  if (!shouldRunCompile(state)) return false;
  return state.compilingPhase === "idle" || state.compilingPhase === "error";
}

/**
 * Walk forward from `from`, skipping any screen that the current state
 * shouldn't visit. Returns the first reachable screen index, clamped
 * to the wizard's range.
 */
function nextReachable(state: WizardState, from: number): ScreenId {
  let n = from;
  for (let guard = 0; guard <= TOTAL_SCREENS; guard++) {
    if (n < 0) return 0;
    if (n >= TOTAL_SCREENS) return (TOTAL_SCREENS - 1) as ScreenId;
    if (!shouldVisitScreen(state, n as ScreenId)) {
      n += 1;
      continue;
    }
    return n as ScreenId;
  }
  return clampScreen(n);
}

/** Test seam for navigation-gating regressions. Runtime uses NEXT/BACK actions. */
export function nextReachableForTests(state: WizardState, from: number): ScreenId {
  return nextReachable(state, from);
}

/**
 * Walk backward from `from`, skipping any screen that the current
 * state shouldn't visit.
 */
function previousReachable(state: WizardState, from: number): ScreenId {
  let n = from;
  for (let guard = 0; guard <= TOTAL_SCREENS; guard++) {
    if (n < 0) return 0;
    if (n >= TOTAL_SCREENS) return (TOTAL_SCREENS - 1) as ScreenId;
    if (!shouldVisitScreen(state, n as ScreenId)) {
      n -= 1;
      continue;
    }
    return n as ScreenId;
  }
  return clampScreen(n);
}

/**
 * Hydrate a fresh state from an existing-profile snapshot. Returns
 * the new state; reducer wraps this in a HYDRATE case + computes
 * the immutable hydratedSnapshot on top.
 */
function hydrateState(
  current: WizardState,
  profile: ProfileSnapshot | null,
  flags: OnboardingConfigFlags,
  viewerInput?: OnboardingViewerState | null,
): WizardState {
  const viewer = deriveViewerFromHydration(profile, viewerInput);

  if (profile === null) {
    return {
      ...current,
      viewer,
      flags,
      hydratedSnapshot: null,
    };
  }
  const next: WizardState = {
    ...current,
    viewer,
    flags,
    name: profile.name || current.name,
    language: profile.language ?? current.language,
    workLifeChoice: profile.workLifeMode,
    privacySlider:
      typeof profile.privacySpectrum === "number"
        ? profile.privacySpectrum
        : current.privacySlider,
    personalityPrompt: profile.personalityPrompt ?? "",
    motherAnswer: profile.motherAnswer ?? "",
    soulFile: profile.soulFile,
    avatarChoice: profile.avatarUrl,
    avatarRef: profile.avatar,
    avatarTarget: null,
    avatarSource: profile.avatarUrl ? "preset" : null,
    voiceSelection:
      profile.defaultVoice
        ? {
            slug: profile.defaultVoice.voiceName,
            profileVoiceName: profile.defaultVoice.voiceName,
            voiceId: profile.defaultVoice.voiceId,
            soulLabel: profile.defaultVoice.voiceName,
          }
        : null,
  };
  const snapshot: WizardState = { ...next, hydratedSnapshot: null };
  return { ...next, hydratedSnapshot: snapshot };
}

function clearCompileError(errors: WizardState["errors"]): WizardState["errors"] {
  const { ["compile.soul"]: _drop, ...rest } = errors;
  void _drop;
  return rest;
}

function invalidateSoulCompile(state: WizardState): Pick<
  WizardState,
  "compilingPhase" | "compilingGeneration" | "soulFile" | "errors"
> {
  return {
    compilingPhase: "idle",
    // Bump immediately so any in-flight background compile cannot write a stale
    // soul after the user edits one of the fields that feeds generation.
    compilingGeneration: state.compilingGeneration + 1,
    soulFile: null,
    errors: clearCompileError(state.errors),
  };
}

function wizardReducer(
  state: WizardState,
  action: WizardAction,
): WizardState {
  switch (action.type) {
    case "HYDRATE":
      return hydrateState(
        state,
        action.profile,
        action.flags,
        action.viewer,
      );

    case "NEXT":
      return { ...state, screen: nextReachable(state, state.screen + 1) };

    case "BACK":
      return { ...state, screen: previousReachable(state, state.screen - 1) };

    case "JUMP":
      // JUMP bypasses skip rules at the reducer level — the
      // orchestrator uses it to land on a specific target (e.g.
      // a future "edit voice only" deep-link from Settings).
      // Screen-specific input gates live in the screen UI.
      return { ...state, screen: clampScreen(action.screen) };

    case "SET_LANGUAGE":
      return { ...state, language: action.lang };

    case "SET_PRIVACY":
      if (state.privacySlider === action.value) return state;
      return {
        ...state,
        privacySlider: Math.max(0, Math.min(100, action.value)),
        ...invalidateSoulCompile(state),
      };

    case "SET_WORK_LIFE":
      if (state.workLifeChoice === action.choice) return state;
      return {
        ...state,
        workLifeChoice: action.choice,
        ...invalidateSoulCompile(state),
      };

    case "UPDATE_VIEWER":
      return {
        ...state,
        viewer: { ...state.viewer, ...action.viewer },
      };

    case "SET_PERSONALITY":
      if (state.personalityPrompt === action.value) return state;
      return {
        ...state,
        personalityPrompt: action.value,
        ...invalidateSoulCompile(state),
      };

    case "SET_MOTHER_ANSWER":
      if (state.motherAnswer === action.value) return state;
      return {
        ...state,
        motherAnswer: action.value,
        ...invalidateSoulCompile(state),
      };

    case "START_COMPILE":
      return {
        ...state,
        compilingPhase: "running",
        compilingGeneration: state.compilingGeneration + 1,
        soulFile: null,
      };

    case "DEFER_COMPILE":
      if (action.generation !== state.compilingGeneration) return state;
      return {
        ...state,
        compilingPhase: "background",
      };

    case "FINISH_COMPILE":
      // Stale-response guard: only apply if generation matches.
      // Without this, a JUMP-back-then-restart could see the older
      // request's response shadow the newer one.
      if (action.generation !== state.compilingGeneration) return state;
      return {
        ...state,
        compilingPhase: "done",
        soulFile: action.soulFile,
      };

    case "ERROR_COMPILE":
      if (action.generation !== state.compilingGeneration) return state;
      return {
        ...state,
        compilingPhase: "error",
        errors: { ...state.errors, "compile.soul": action.message },
      };

    case "RESTART_COMPILE": {
      return {
        ...state,
        compilingPhase: "idle",
        soulFile: null,
        errors: clearCompileError(state.errors),
      };
    }

    case "SET_AVATAR":
      return {
        ...state,
        avatarSource: action.source,
        avatarChoice: action.url,
        avatarRef: action.avatar ?? null,
        avatarTarget: action.target ?? null,
      };

    case "SET_NAME":
      if (state.name === action.value) return state;
      return {
        ...state,
        name: action.value,
        ...invalidateSoulCompile(state),
      };

    case "SET_VOICE":
      return {
        ...state,
        voiceSelection: action.selection,
        voiceSkipped: false,
      };

    case "SKIP_VOICE":
      return { ...state, voiceSelection: null, voiceSkipped: true };

    case "SET_VOICE_CAPABILITY":
      return { ...state, voiceCapability: action.capability };

    case "SET_ERROR":
      return {
        ...state,
        errors: { ...state.errors, [action.field]: action.message },
      };

    case "CLEAR_ERROR": {
      const { [action.field]: _drop, ...rest } = state.errors;
      void _drop;
      return { ...state, errors: rest };
    }

    case "RESET":
      return INITIAL_WIZARD_STATE;
  }
}

/** Test seam for reducer regressions. Runtime uses `useWizardState`. */
export function wizardReducerForTests(
  state: WizardState,
  action: WizardAction,
): WizardState {
  return wizardReducer(state, action);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseWizardStateReturn {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
}

export function useWizardState(
  initial: WizardState = INITIAL_WIZARD_STATE,
): UseWizardStateReturn {
  const [state, dispatch] = useReducer(wizardReducer, initial);
  return { state, dispatch };
}
