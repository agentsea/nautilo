/**
 * D424 Phase 1.2 — Memory API DTOs for the typed `@nautilo/api-client`
 * wrappers (`listMemories` / `searchMemories` / `getMemory`).
 *
 * No shared memory DTOs exist in `@nautilo/types` today, so these mirror the
 * desktop workbench Memory API response contracts
 * (`apps/workbench/src/lib/memory-api.ts`) and the server route envelopes
 * (`packages/server/src/routes/memory.ts` + `memory-routes.test.ts`). Wave 4
 * is read-only (decision D4): list / search / detail only — no edit/archive/
 * grant verbs, so those request/response shapes are intentionally absent.
 *
 * Fields are shaped to tolerate both memory modes the server returns:
 *  - `namespace` mode: rows carry `namespaceIds` + optional people-only
 *    `accessList` (D328).
 *  - `scope` mode: agent-private bag; `namespaceIds` may be empty and
 *    `accessList` is absent. `scopeOrigin` / `origin` appear when the server
 *    exposes the scope-junction origin (`seed` rows are read-only).
 *
 * `importance` / `tier` / `score` are numeric on the wire; `createdAt` /
 * `updatedAt` / `demotedAt` are ISO-8601 strings (or null for the demotion
 * fields when the memory was never demoted).
 */

/** D468 — shared Mobile push-installation wire types live in @nautilo/types. */
export type {
  MobilePushBindingState,
  MobilePushInstallationDisableRequest,
  MobilePushInstallationErrorCode,
  MobilePushInstallationProofRevokeRequest,
  MobilePushInstallationRegisterRequest,
  MobilePushInstallationStatus,
  MobilePushInstallationTestRequest,
  MobilePushInstallationTestResponse,
  MobilePushPermission,
  MobilePushPlatform,
  MobilePushRevokeTombstone,
} from "@nautilo/types";

/** Server-reported memory namespace model for the active envelope. */
export type MemoryMode = "namespace" | "scope";

/** D328 — a person who can read a memory (namespace-mode only). */
export interface MemoryAccessEntry {
  userHandle: string;
  displayName: string;
}

/** Row shape shared by list and detail envelopes. */
export interface MemoryListItem {
  id: string;
  type: string;
  content: string;
  importance: number;
  tier: number;
  createdAt: string;
  updatedAt: string;
  namespaceIds: string[];
  /**
   * D328 — people who can read this memory (server-computed, namespace-mode
   * only). Optional: absent on older servers / scope rows, in which case rows
   * fall back to the coarse `audienceState(namespaceIds)`.
   */
  accessList?: MemoryAccessEntry[];
  /** Present when the server exposes scope junction origin (seed = read-only). */
  scopeOrigin?: "seed" | "scope";
  origin?: "seed" | "scope";
}

/** Detail adds demotion audit fields to the list row. */
export interface MemoryDetail extends MemoryListItem {
  demotedAt: string | null;
  demotedFrom: number | null;
  accessList?: MemoryAccessEntry[];
}

/**
 * Server-projected mutation affordances for one memory in the current request
 * envelope. These are advisory UI facts only: mutation routes remain the
 * authorization source of truth.
 */
export interface MemoryActionAuthority {
  canEdit: boolean;
  canArchive: boolean;
  canHardDelete: boolean;
  canManageAccess: boolean;
}

/** Search hit — carries a relevance `score` and omits the access metadata. */
export interface MemorySearchResult {
  id: string;
  type: string;
  content: string;
  importance: number;
  tier: number;
  score: number;
  createdAt: string;
}

/** `GET /api/memory` envelope. */
export interface MemoryListResponse {
  items: MemoryListItem[];
  nextCursor: string | null;
  memoryMode: MemoryMode;
  /** D328 — true total for the active filter (banner count, not "loaded so far"). */
  total?: number;
}

/** `GET /api/memory/search` envelope. */
export interface MemorySearchResponse {
  results: MemorySearchResult[];
  memoryMode: MemoryMode;
}

/** `GET /api/memory/:id` envelope. */
export interface MemoryDetailResponse {
  memory: MemoryDetail;
  memoryMode: MemoryMode;
  /** Plaintext library read's exact server-authorized context, not mutation authority. */
  accessContext?: Readonly<{ roomId: string; label: string }>;
  /** D442 — never infer mutation authority from mode or client capability alone. */
  actionAuthority: MemoryActionAuthority;
}
