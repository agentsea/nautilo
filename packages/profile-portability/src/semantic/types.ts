/**
 * Semantic records for `GenieLiveV1` — the portable meaning of a personal
 * Genie, with NO source DB IDs, NO source UUIDs, NO filesystem paths, NO
 * embeddings, NO credentials, NO server-bound identity. Binary bytes (avatar
 * media, artifact blobs) live in the container as encrypted frames and are
 * referenced by manifest entry name, never inlined here.
 *
 * Conflict groups (R8/R9): identity, soul, personality, voices, modelPolicy,
 * avatar, preferences are whole-group `source` | `target` choices — never
 * text/JSON/media auto-merges. Memories, artifacts, and skills carry their
 * own record kinds and are populated in later waves (P3/P4/P2); their types
 * are declared here so the contract is complete, but Wave 0 validators only
 * enforce the structural boundary (no forbidden fields, correct shapes).
 */

export type ProfileConflictGroup =
  | "identity"
  | "soul"
  | "personality"
  | "voices"
  | "modelPolicy"
  | "avatar"
  | "preferences";

export type ProfileConflictChoice = {
  readonly group: ProfileConflictGroup;
  readonly choice: "source" | "target";
};

/** Scopes a bundle may carry. Unknown scopes are rejected before mutation. */
export type PortableScope =
  | "profile"
  | "avatar"
  | "skills"
  | "privateMemories"
  | "privateArtifacts";

export const ALL_PORTABLE_SCOPES: readonly PortableScope[] = [
  "profile",
  "avatar",
  "skills",
  "privateMemories",
  "privateArtifacts",
];

export type VoiceMapEntry = {
  /**
   * Target profile voice slot: `"default"` or a language tag such as `"de"`
   * / `"es"`. Optional only for pre-slot Wave 1 bundles, which restore their
   * first entry as the default voice.
   */
  readonly slot?: string;
  readonly voiceId: string;
  readonly label: string;
  readonly provider: string | null;
  readonly voiceUri: string | null;
};

export type ModelPolicy = {
  readonly primaryModel: string | null;
  readonly fallbackModel: string | null;
  readonly temperature: number | null;
};

/**
 * Avatar reference into the container manifest. `mediaEntry` is a bundle-
 * internal manifest path (e.g. `media/avatar.bin`), never an absolute or
 * source-filesystem path. `sha256` is the hex digest of the avatar bytes for
 * provenance/verification; the bytes themselves are encrypted frames.
 */
export type AvatarRef = {
  readonly mediaEntry: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
};

export type IdentityRecord = {
  readonly recordKind: "identity";
  readonly name: string;
  readonly handleIntent: string | null;
};

export type SoulRecord = { readonly recordKind: "soul"; readonly text: string | null };
export type PersonalityRecord = { readonly recordKind: "personality"; readonly text: string | null };
export type VoicesRecord = { readonly recordKind: "voices"; readonly voices: readonly VoiceMapEntry[] };
export type ModelPolicyRecord = { readonly recordKind: "modelPolicy"; readonly policy: ModelPolicy };
export type AvatarRecord = { readonly recordKind: "avatar"; readonly avatar: AvatarRef | null };

export type PreferenceValue = string | number | boolean | null;
export type PreferencesRecord = {
  readonly recordKind: "preferences";
  readonly preferences: Readonly<Record<string, PreferenceValue>>;
};

/**
 * Private memory record. `scope` is always `private` — shared memories never
 * enter a bundle (R3/R7). `content` is logical memory text only; no
 * embeddings, no source IDs, no transcripts, no namespace IDs.
 */
export const MEMORY_RECORD_TYPE_MAX_UTF8_BYTES = 256;

export type LegacyMemoryRecordV1_0 = {
  readonly recordKind: "memory";
  readonly scope: "private";
  readonly content: string;
  readonly createdAt: string | null;
  readonly type?: never;
};

export type MemoryRecordV1_1 = {
  readonly recordKind: "memory";
  readonly scope: "private";
  /** Confidential MemoryPayloadV1 type, preserved exactly across portability. */
  readonly type: string;
  readonly content: string;
  readonly createdAt: string | null;
};

/** Explicit versioned union; callers must handle the absent legacy type. */
export type MemoryRecord = LegacyMemoryRecordV1_0 | MemoryRecordV1_1;

/**
 * Portable private artifact. `path` is a logical, human-readable artifact
 * path (never a source-filesystem path; never a manifest entry name).
 * `bytesEntry` is the opaque bundle-internal media location of the artifact
 * bytes and MUST be exactly `media/artifacts/<opaque-id>.bin` (format v2).
 * `sha256` and `size` cover the artifact bytes and MUST agree 1:1 with the
 * matching `ArtifactMediaEntry` in `GenieLiveV1.artifactMedia`. Export must
 * prove no shared namespace edge (R7, Wave 3).
 */
export type PortableArtifact = {
  readonly recordKind: "artifact";
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytesEntry: string;
};

/**
 * Format v2 artifact media format version. v1 (avatar-only) bundles omit
 * `artifactMedia` entirely and remain readable; v2 bundles carry an explicit
 * `ArtifactMediaManifest` whose entries are 1:1 with `PortableArtifact`
 * records by `bytesEntry` path.
 */
export const ARTIFACT_MEDIA_FORMAT_VERSION = 2 as const;
export type ArtifactMediaFormatVersion = typeof ARTIFACT_MEDIA_FORMAT_VERSION;

/**
 * Opaque artifact media id charset/length. The `<opaque-id>` segment of a
 * `media/artifacts/<opaque-id>.bin` path is an opaque, plan-local token
 * (never a mutable source path or DB ID). It is bound to the plan and
 * rejected if duplicated, unknown, or missing at commit.
 */
export const ARTIFACT_OPAQUE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Maximum logical byte size of a single artifact media entry. Matches the
 * archive per-entry ceiling; storage preflight and write-time ENOSPC are
 * enforced elsewhere (not in this contract slice).
 */
export const ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * One artifact media entry — the explicit, strictly-validated logical
 * metadata for one artifact's bytes. `path` is the opaque bundle-internal
 * location `media/artifacts/<opaque-id>.bin`. `size` is the logical artifact
 * byte length (non-negative, bounded by `ARTIFACT_MAX_BYTES`). `sha256` is
 * the hex64 digest of the artifact bytes. Each entry is associated 1:1 with
 * exactly one `PortableArtifact.bytesEntry`.
 *
 * The bytes themselves are NOT inlined here and are NOT carried by the
 * current one-shot JSON/hex envelope. In the shipped format v2 they are
 * authenticated chunk-framed encrypted frames inside the container. This
 * slice declares the logical metadata + validation ONLY.
 *
 * ── STREAMING BOUNDARY ────────────────────────────────────────────────
 * Chunk-framed streaming serialization of artifact bytes (frame ordinals,
 * per-chunk AAD, frame-count/total-bytes manifest binding, AEAD) is a LATER
 * slice. This slice deliberately does NOT declare chunk-frame types, does
 * NOT validate frame structure, and does NOT pretend the existing one-shot
 * JSON/hex envelope is streamable. Do not add chunk fields here without
 * also implementing the framed transport in the container layer.
 * ──────────────────────────────────────────────────────────────────────
 */
export type ArtifactMediaEntry = {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
};

/**
 * Format v2 artifact media manifest. Optional on `GenieLiveV1`: v1
 * (avatar-only) bundles omit it and stay readable. When present,
 * `mediaVersion` MUST be `ARTIFACT_MEDIA_FORMAT_VERSION` and `entries`
 * MUST be exactly 1:1 with the `PortableArtifact` records by `bytesEntry`
 * path — no duplicates, no missing, no orphans, and matching size/sha256.
 */
export type ArtifactMediaManifest = {
  readonly mediaVersion: ArtifactMediaFormatVersion;
  readonly entries: readonly ArtifactMediaEntry[];
};

/**
 * Optional skill/command reference. Content migration is Wave 2; here we only
 * declare the shape and the invariant that imported skills are disabled until
 * the target user enables them (R6).
 */
export type SkillRef = {
  readonly recordKind: "skill";
  readonly kind: "command" | "skill";
  readonly name: string;
  readonly disabledByDefault: true;
};

type NonMemorySemanticRecord =
  | IdentityRecord
  | SoulRecord
  | PersonalityRecord
  | VoicesRecord
  | ModelPolicyRecord
  | AvatarRecord
  | PreferencesRecord
  | PortableArtifact
  | SkillRef;

export type SemanticRecordV1_0 =
  | NonMemorySemanticRecord
  | LegacyMemoryRecordV1_0;

export type SemanticRecordV1_1 =
  | NonMemorySemanticRecord
  | MemoryRecordV1_1;

export type SemanticRecord = SemanticRecordV1_0 | SemanticRecordV1_1;

export type SemanticRecordKind = SemanticRecord["recordKind"];

export const SEMANTIC_RECORD_KINDS: readonly SemanticRecordKind[] = [
  "identity",
  "soul",
  "personality",
  "voices",
  "modelPolicy",
  "avatar",
  "preferences",
  "memory",
  "artifact",
  "skill",
];

/**
 * The full semantic payload. `bundleId` is an opaque bundle identifier (not a
 * source DB ID). `records` is the ordered set of semantic records; the
 * terminal manifest binds them by per-record hash and semantic root.
 * `artifactMedia` is the optional format v2 artifact media manifest; v1
 * (avatar-only) bundles omit it and remain readable. When present it is
 * strictly validated and bound 1:1 to the `PortableArtifact` records.
 */
type GenieLiveBase<
  Version extends Readonly<{ major: 1; minor: 0 | 1 }>,
  RecordValue extends SemanticRecord,
> = {
  readonly semanticVersion: Version;
  readonly bundleId: string;
  readonly scopes: readonly PortableScope[];
  readonly records: readonly RecordValue[];
  readonly artifactMedia?: ArtifactMediaManifest;
};

export type GenieLiveV1_0 = GenieLiveBase<
  Readonly<{ major: 1; minor: 0 }>,
  SemanticRecordV1_0
>;

export type GenieLiveV1_1 = GenieLiveBase<
  Readonly<{ major: 1; minor: 1 }>,
  SemanticRecordV1_1
>;

export type GenieLiveV1 = GenieLiveV1_0 | GenieLiveV1_1;

/**
 * Field names that must never appear on a semantic record. The allowed-key
 * allowlist below is the primary enforcement; this explicit denylist is a
 * defense-in-depth check so a smuggled `id`/`agentId`/`userId`/`namespaceId`
 * is rejected even if a future record kind widens its allowed set.
 */
export const FORBIDDEN_FIELD_NAMES: readonly string[] = [
  "id",
  "agentId",
  "agent_id",
  "userId",
  "user_id",
  "sourceId",
  "source_id",
  "dbId",
  "namespaceId",
  "namespace_id",
  "connectionId",
  "vaultRef",
  "embedding",
  "embeddings",
  "session",
  "sessionId",
  "token",
  "secret",
  "password",
  "pin",
  "recovery",
];
