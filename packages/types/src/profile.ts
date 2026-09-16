import type { CapabilitySlug } from "./capabilities";

/**
 * M128 — extended to include the six canonical server-wide Role slugs
 * (`owner`, `admin`, `superuser`, `member`, `contributor`, `guest`).
 * The legacy slug `stranger` is kept for `getViewerRole`; `household`/
 * `teammate` were retired in M133. Server-side resolution post-M128
 * returns only the canonical six + `anonymous` (for unauthenticated
 * `buildAnonymousContext`).
 */
export type ViewerRole =
  | "owner"
  | "admin"
  | "superuser"
  | "member"
  | "contributor"
  | "guest"
  | "anonymous"
  | "stranger";

/** M128 — minimal Group chip projection consumed by the workbench header. */
export interface GroupChip {
  id: string;
  type: string;
  label: string;
  roleSlug: string;
}

export type AvatarRef =
  | { kind: "preset"; id: string }
  | { kind: "uploaded"; blobId: string }
  | { kind: "generated"; blobId: string };

/** M161 — canonical non-legacy server icon presets shared by DB + serving. */
export const SERVER_ICON_PRESET_IDS = [
  "preset-orbit",
  "preset-prism",
  "preset-kite",
  "preset-arch",
  "preset-crown",
  "preset-bloom",
  "preset-portal",
  "preset-pulse",
  "preset-cube",
  "preset-comet",
  "preset-lattice",
  "preset-beacon",
  "preset-ripple",
  "preset-nexus",
] as const;

export type ServerIconPresetId = (typeof SERVER_ICON_PRESET_IDS)[number];
export const LEGACY_SERVER_ICON_PRESET_ID = "server-default" as const;

/** D261 — a voice reference: raw ElevenLabs voice id + human-readable label. */
export type VoiceRef = { voiceId: string; voiceName: string };

/**
 * D261 — the Profile's per-language voice map. Key is the reserved
 * `"default"` (the primary/fallback voice — a ROLE, not a language) or a
 * BCP-47 primary subtag (`"es"`, `"fr"`, `"fr-CA"`). The agent speaks
 * untagged text in `voices.default` and switches to `voices[lang]` when it
 * emits a `<voice lang="…">` span. `{}` means unconfigured.
 */
export type ProfileVoices = Record<string, VoiceRef>;

/** D261 — reserved key for the primary/fallback voice. */
export const DEFAULT_VOICE_KEY = "default" as const;

/**
 * D261 — valid `voices` map key: the reserved `"default"` or a BCP-47
 * primary subtag with optional subtags. Used to validate writes.
 */
export const VOICE_LANG_KEY_REGEX = /^(default|[a-z]{2,3}(-[A-Za-z0-9]+)*)$/;

export const SHELL_AGENT_NAME = "Genie" as const;
export const SHELL_AVATAR_REF = { kind: "preset", id: "shell" } as const satisfies AvatarRef;
/**
 * The shipped Agent-avatar catalogue. This is deliberately a static product
 * catalogue rather than a directory listing: `avatar-08` has never shipped,
 * and a valid-looking filename is not evidence that it is a selectable
 * preset. `shell` is the fallback ref, not a selectable library preset.
 */
export const AGENT_AVATAR_PRESET_IDS = [
  ...Array.from({ length: 7 }, (_, index) => `avatar-0${index + 1}`),
  ...Array.from({ length: 33 }, (_, index) => `avatar-${String(index + 9).padStart(2, "0")}`),
] as const;
export const PRESET_AVATAR_ID_REGEX = /^avatar-[0-9]{2}$|^shell$/;
export const PROFILE_AVATAR_URL = "/api/profile/avatar" as const;

/**
 * Writable fields accepted by `PUT /api/profile` for the authenticated
 * caller's personal Agent. This is intentionally the wire shape rather than
 * a partial owner projection: persisted personality fields are flat on write
 * and nested under `personality` on read.
 */
export interface AgentProfileMutation {
  name?: string;
  soulFile?: string | null;
  language?: string;
  privacySpectrum?: number | null;
  workLifeMode?: string | null;
  personalityPrompt?: string | null;
  motherAnswer?: string | null;
  avatar?: AvatarRef | null;
  publicProfile?: boolean;
  personalityTone?: string | null;
  defaultModel?: string | null;
  onboardingCompleted?: boolean;
  welcomeMessageSent?: boolean;
  /** Account-level IANA timezone persisted alongside the profile mutation. */
  timezone?: string;
}

export interface AgentProfileFull {
  name: string;
  language: string;
  /** D261 — per-language voice map; primary is `voices.default`. */
  voices: ProfileVoices;
  avatar: AvatarRef;
  avatarUrl: typeof PROFILE_AVATAR_URL;
  defaultModel: string | null;
  personality: {
    prompt: string | null;
    tone: string | null;
    motherAnswer: string | null;
  };
  privacySpectrum: number | null;
  workLifeMode: "work" | "life" | "both" | null;
  soulFile: string | null;
  onboardingCompleted: boolean;
  welcomeMessageSent: boolean;
  agentIdentity: string;
  /**
   * M156 — the Agent's `@handle` on this Server (without the leading `@`).
   * Editable via `PATCH /api/profile/agent-handle`; auto-derives from the
   * name on rename until the user customizes it. Owner view only.
   */
  handle: string;
  publicProfile: boolean;
  /**
   * D141 P2 / LD-1 — per-user opt-in model fallback policy. Surfaced to
   * the owner view so the workbench chain-editor (Settings → Providers)
   * can render the current state without an extra fetch. Owner-only;
   * scoped / public viewer projections never carry this field. Default
   * for new users: `{ enabled: false, chain: [] }` per LD-4.
   */
  fallback: { enabled: boolean; chain: string[] };
}

export interface AgentProfileScoped {
  name: string;
  avatar: AvatarRef;
  avatarUrl: typeof PROFILE_AVATAR_URL;
  language: string;
  agentIdentity: string;
}

export interface AgentProfilePublic {
  name: typeof SHELL_AGENT_NAME;
  avatar: typeof SHELL_AVATAR_REF;
  avatarUrl: typeof PROFILE_AVATAR_URL;
}

/** Agents the authenticated viewer owns (owner-Role in each agent's ownership group). */
export interface OwnedAgentSummary {
  agentId: string;
  handle: string;
  displayName: string;
}

export type AgentProfileResponse =
  | { viewerRole: "owner"; agent: AgentProfileFull; ownedAgents: OwnedAgentSummary[] }
  | { viewerRole: "guest" | "stranger"; agent: AgentProfilePublic };

export interface WhoamiResponse {
  /** Authenticated human `users.id` (UUID). Null for guest or no session. */
  sessionUserId: string | null;
  /** Current session actor (`actors.id`). Null when unauthenticated or no actor. */
  sessionActorId: string | null;
  userIdentity: string | null;
  /** D112 Phase 11 — CLI/session surfaces (null when unauthenticated). */
  handle: string | null;
  displayName: string | null;
  externalId: string | null;
  instanceId: string;
  mustChangePassword: boolean;
  /**
   * M128 — canonical server-wide Group chips. One entry per Group the
   * authenticated viewer is a member of. Empty for guests / anonymous.
   * Workbench header shows chip(s) from this array
   * (see permission-model.md §4 / ISSUE-M128 §3.8).
   */
  groups: GroupChip[];
  /**
   * M129 — the authenticated caller's own server-wide Capability union
   * (across every Group they belong to). Empty for guest / anonymous.
   * ADVISORY UI-GATING ONLY — the server still enforces every gate.
   * See ISSUE-M129 §1.1.
   */
  capabilities: CapabilitySlug[];
  features?: {
    office: {
      enabled: boolean;
    };
  };
  /**
   * D219 — highest-rank server Role slug across the viewer's Groups
   * (one of owner / admin / superuser / member / contributor / guest), or
   * null when the viewer is in no Group. Replaces the retired
   * `serverRole` enum for CLI role display. Server-derived via
   * `findUserHighestRoleSlug` so clients don't recompute rank.
   */
  highestRole: string | null;
}

export type WebFingerCard =
  | { kind: "user"; handle: string; displayName: string; identity: string }
  | { kind: "agent"; handle: string; identity: string; profile?: AgentProfilePublic };
