/**
 * D416 / D429 Phase 7.4 — safe, signed explainer-video catalog contract.
 *
 * Mirrors the canonical JSON Schema in
 * `nautilo-catalogs/schemas/explainer-catalog.schema.json` and the signed
 * release-pointer contract in `nautilo-catalogs/scripts/publish-explainer-catalog.mjs`.
 * The manifest carries only opaque provider asset identity plus display
 * metadata and the exact content hash/length needed to bind a release to
 * verified public bytes. It MUST NOT contain playback URLs, signing
 * material, tokens, credentials, HLS fields, or any future field until its
 * security semantics have been explicitly reviewed. All objects are strict:
 * unknown properties are rejected.
 *
 * The release pointer is the minimal signed document CI republishes on each
 * release: exactly `{ catalogVersion, artifactSha256, signature, signingKeyId }`
 * under the `nautilo-explainer-catalog-v1` signing domain. The immutable
 * manifest URL is always derived from the pointer URL's own `catalog/`
 * directory plus the validated `catalogVersion` — never read from the pointer
 * body. The canonical signing payload is exactly:
 *
 *   nautilo-explainer-catalog-v1\ncatalogVersion=<v>\nartifactSha256=<hex>\n
 *
 * Verification order (enforced by the remote loader): strict pointer shape →
 * trusted signingKeyId → Ed25519 signature over the canonical payload → exact
 * immutable artifact SHA-256 → strict manifest schema → atomic snapshot
 * replace. Unknown key / signature / hash / schema / transport failures
 * retain the last-known-good or checked-in seed; the loader never accepts
 * unsigned or unknown-key content.
 */
import { z } from "zod";

export const EXPLAINER_CATALOG_VERSION = 1;
export const EXPLAINER_CATALOG_MAX_ENTRIES = 200;
export const EXPLAINER_CATALOG_DEFAULT_PAGE_SIZE = 10;
export const EXPLAINER_CATALOG_MAX_PAGE_SIZE = 20;
/** Global media cap mirrored from the canonical schema (512 MiB). */
export const EXPLAINER_MEDIA_MAX_BYTES = 536_870_912;

const catalogText = (maximum: number) => z.string().trim().min(1).max(maximum);
const catalogSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "must be a lowercase slug");
const catalogDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date");
const catalogReleaseVersion = z
  .string()
  .regex(/^\d{4}\.\d{2}\.\d{2}\.[1-9]\d*$/, "must use YYYY.MM.DD.N format with a positive revision")
  .refine((value) => {
    const [yearText, monthText, dayText] = value.split(".");
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "must contain a valid calendar date");
const catalogPublishedAt = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "must be a UTC timestamp");

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

/**
 * Contained provider-side object key. Relative non-empty path segments only:
 * rejects a leading slash, backslash, query/hash, control characters, empty
 * segments, and dot/dot-dot segments. The publisher reads live bytes from
 * the official public origin using this key; it is never published as a
 * permanent URL and never carries a scheme.
 */
const catalogAssetKey = catalogText(256).refine(
  (value) => {
    if (value.startsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#")) {
      return false;
    }
    if (containsAsciiControlCharacter(value)) return false;
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return false;
    }
    return true;
  },
  "must be an opaque contained provider asset key, not a URL or traversing path",
);

/**
 * Stable tool metadata used to find explainers relevant to an active tool.
 * This deliberately mirrors only safe, descriptive tool-catalog fields.
 */
export const ExplainerToolMetadataSchema = z
  .object({
    name: catalogText(128),
    description: z.string().trim().max(1_000).optional(),
    category: catalogText(64).optional(),
    tags: z.array(catalogText(48)).max(20).default([]),
  })
  .strict();

/** A catalog-side relation between an explainer and a Nautilo tool. */
export const ExplainerToolReferenceSchema = z
  .object({
    name: catalogText(128),
    category: catalogText(64).optional(),
    tags: z.array(catalogText(48)).max(12).default([]),
  })
  .strict();

/**
 * Canonical, repository-tracked explainer asset identity plus the exact
 * content hash and length binding the entry to verified public bytes.
 *
 * `provider` and `key` together identify media immutably; `contentSha256`
 * and `byteLength` bind the entry to the exact bytes served from the official
 * public origin. The asset never carries a playback URL, token, signature, or
 * HLS field — playback is a separately authorized, server-issued concern.
 */
export const ExplainerCatalogAssetSchema = z
  .object({
    /** Provider namespace. Bunny Storage is the only accepted provider. */
    provider: z.literal("bunny-storage"),
    /** Opaque contained provider-side object key; never a playback URL. */
    key: catalogAssetKey,
    /** Delivery representation. MP4 is the only accepted format. */
    format: z.literal("mp4"),
    /** Lowercase SHA-256 hex of the exact published asset bytes. */
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/, "must be lowercase SHA-256 hex"),
    /** Exact byte length of the published asset (1 .. 512 MiB). */
    byteLength: z.number().int().min(1).max(EXPLAINER_MEDIA_MAX_BYTES),
  })
  .strict();

export const ExplainerCatalogEntrySchema = z
  .object({
    id: catalogSlug,
    asset: ExplainerCatalogAssetSchema,
    title: catalogText(160),
    summary: catalogText(320),
    description: catalogText(1_200),
    tags: z.array(catalogText(48)).min(1).max(12),
    toolReferences: z.array(ExplainerToolReferenceSchema).min(1).max(12),
    durationSeconds: z.number().int().positive().max(14_400),
    publishedAt: catalogDate,
    captionsAvailable: z.boolean(),
  })
  .strict();

/**
 * The JSON manifest parsed before it is used. Strict objects reject secrets,
 * playback envelopes, arbitrary embed URLs, HLS fields, and all future fields
 * until their security semantics are explicitly reviewed.
 */
export const ExplainerCatalogSchema = z
  .object({
    version: z.literal(EXPLAINER_CATALOG_VERSION),
    /** Immutable publish revision for correlating repository and provider copies. */
    catalogVersion: catalogReleaseVersion,
    /** UTC ISO 8601 timestamp for the catalog release, not a video's publish date. */
    publishedAt: catalogPublishedAt,
    entries: z.array(ExplainerCatalogEntrySchema).max(EXPLAINER_CATALOG_MAX_ENTRIES),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const ids = new Set<string>();
    for (const [index, entry] of catalog.entries.entries()) {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate explainer id "${entry.id}"`,
          path: ["entries", index, "id"],
        });
      }
      ids.add(entry.id);
    }
  });

/** Bounded input to local catalog discovery. */
export const ExplainerCatalogSearchInputSchema = z
  .object({
    query: z.string().trim().max(160).optional(),
    tool: ExplainerToolMetadataSchema.optional(),
    page: z.number().int().positive().default(1),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(EXPLAINER_CATALOG_MAX_PAGE_SIZE)
      .default(EXPLAINER_CATALOG_DEFAULT_PAGE_SIZE),
  })
  .strict();

/**
 * Safe, narrowly typed list-DTO provenance. `source` is the only origin
 * information ever exposed to discovery callers: `"remote"` means the served
 * catalog was fetched from the official Nautilo origin (within or past its
 * freshness window), and `"local"` means the checked-in seed was served. The
 * raw pointer/manifest URL, host, headers, signing keys, and provider
 * credentials are intentionally never represented here.
 *
 * `stale` is true when the served payload is past its fresh TTL (a stale
 * remote cache or the local seed). It is optional only so hand-built
 * fixtures remain valid; runtime results always populate it.
 */
export const ExplainerCatalogListSourceSchema = z.enum(["local", "remote"]);
export type ExplainerCatalogListSource = z.infer<typeof ExplainerCatalogListSourceSchema>;

/** Bounded metadata safe to return from a catalog list/search tool. */
export const ExplainerCatalogSummarySchema = z
  .object({
    id: catalogSlug,
    title: catalogText(160),
    summary: catalogText(320),
    tags: z.array(catalogText(48)).max(12),
    durationSeconds: z.number().int().positive().max(14_400),
    captionsAvailable: z.boolean(),
  })
  .strict();

export const ExplainerCatalogListResultSchema = z
  .object({
    version: z.literal(EXPLAINER_CATALOG_VERSION),
    catalogVersion: catalogReleaseVersion,
    publishedAt: catalogPublishedAt,
    source: ExplainerCatalogListSourceSchema,
    /** True when the served catalog is past its fresh TTL or fell back to local. */
    stale: z.boolean().optional(),
    items: z.array(ExplainerCatalogSummarySchema).max(EXPLAINER_CATALOG_MAX_PAGE_SIZE),
    page: z.number().int().positive(),
    pageSize: z.number().int().min(1).max(EXPLAINER_CATALOG_MAX_PAGE_SIZE),
    total: z.number().int().nonnegative().max(EXPLAINER_CATALOG_MAX_ENTRIES),
    hasMore: z.boolean(),
  })
  .strict();

/**
 * Bounded detail DTO. Its opaque `asset` identity is metadata only; no client
 * may derive or receive a playback URL from this result. Playback bytes are
 * issued only by the authenticated verified-byte server route.
 */
export const ExplainerCatalogDetailSchema = z
  .object({
    id: catalogSlug,
    asset: ExplainerCatalogAssetSchema,
    title: catalogText(160),
    summary: catalogText(320),
    description: catalogText(1_200),
    tags: z.array(catalogText(48)).max(12),
    toolReferences: z.array(ExplainerToolReferenceSchema).max(12),
    durationSeconds: z.number().int().positive().max(14_400),
    publishedAt: catalogDate,
    captionsAvailable: z.boolean(),
  })
  .strict();

/**
 * `play_explainer` result envelope. It carries the stable catalog id and
 * display metadata the Workbench needs to request verified media — and NOTHING
 * else. There is deliberately NO `src`/CDN/media URL, no provider identity,
 * no token, and no signature: the Workbench fetches verified bytes through
 * the authenticated server route (`GET /api/explainers/:id/media`) using only
 * `id`, and plays a revocable Blob URL.
 *
 * `requiresApproval` is a mechanical marker that explicit user consent was
 * captured before this playback was resolved (the catalog registration gates
 * `play_explainer` with `requiresApproval`/`confirm`). It is a literal `true`
 * so a forged envelope without it cannot parse.
 */
export const ExplainerPlaybackEnvelopeSchema = z
  .object({
    id: catalogSlug,
    title: catalogText(160),
    summary: catalogText(320),
    description: catalogText(1_200),
    tags: z.array(catalogText(48)).max(12),
    durationSeconds: z.number().int().positive().max(14_400),
    publishedAt: catalogDate,
    captionsAvailable: z.boolean(),
    format: z.literal("mp4"),
    requiresApproval: z.literal(true),
  })
  .strict();

/** 64 lowercase hex characters. */
export const EXPLAINER_ARTIFACT_SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** 1-64 safe lowercase characters (mirrors publish-explainer-catalog.mjs KEY_ID). */
export const EXPLAINER_SIGNING_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Strict signed release-pointer schema. Exactly the four fields CI publishes
 * under the `nautilo-explainer-catalog-v1` domain: `catalogVersion`,
 * `artifactSha256` (lowercase hex), `signature` (base64, 64 bytes once
 * decoded), `signingKeyId`. No path, URL, headers, token, or manifest
 * reference is ever read from the pointer body — the immutable manifest URL is
 * always derived from the pointer URL's own directory plus the validated
 * `catalogVersion`.
 */
export const ExplainerCatalogReleasePointerSchema = z
  .object({
    catalogVersion: catalogReleaseVersion,
    artifactSha256: z.string().regex(EXPLAINER_ARTIFACT_SHA256_PATTERN, "must be lowercase SHA-256 hex"),
    signature: z.string().base64(),
    signingKeyId: z.string().regex(EXPLAINER_SIGNING_KEY_ID_PATTERN, "must be 1-64 safe lowercase characters"),
  })
  .strict()
  // 64 bytes encode as exactly 86 base64 data characters plus `==`.
  .refine(
    (pointer) => /^[A-Za-z0-9+/]{86}==$/.test(pointer.signature),
    "signature must decode to 64 bytes",
  );

/**
 * Build the exact canonical signing payload the loader verifies. This MUST
 * stay byte-identical to `canonicalSigningPayload` in
 * `nautilo-catalogs/scripts/catalog-signing.mjs` under the
 * `nautilo-explainer-catalog-v1` domain:
 *
 *   nautilo-explainer-catalog-v1\ncatalogVersion=<v>\nartifactSha256=<hex>\n
 */
export function canonicalExplainerCatalogSigningPayload(
  catalogVersion: string,
  artifactSha256: string,
): string {
  return (
    "nautilo-explainer-catalog-v1\n" +
    `catalogVersion=${catalogVersion}\n` +
    `artifactSha256=${artifactSha256}\n`
  );
}

/**
 * Filename pattern for the derived immutable manifest inside the pointer's
 * own `catalog/` directory. The version is regex-bound to `YYYY.MM.DD.N` so
 * it can carry no path, traversal, query, or fragment.
 */
export function immutableExplainerCatalogFilename(catalogVersion: string): string {
  return `catalog-${catalogVersion}.json`;
}

/**
 * Safe, narrowly typed provenance exposed to discovery callers for the runtime
 * loader. This is the only catalog-origin information ever surfaced: the raw
 * pointer/manifest URL, host, headers, signing keys, and provider credentials
 * are never represented here. `catalogVersion` and `source`/`stale` give
 * operators a non-secret diagnostic without leaking delivery internals.
 */
export const EXPLAINER_CATALOG_RESULT_SOURCE_VALUES = [
  "remote-fresh",
  "remote-stale",
  "checked-in-fallback",
] as const;
export type ExplainerCatalogResultSource =
  (typeof EXPLAINER_CATALOG_RESULT_SOURCE_VALUES)[number];

export type ExplainerToolMetadata = z.infer<typeof ExplainerToolMetadataSchema>;
export type ExplainerToolReference = z.infer<typeof ExplainerToolReferenceSchema>;
export type ExplainerCatalogAsset = z.infer<typeof ExplainerCatalogAssetSchema>;
export type ExplainerCatalogEntry = z.infer<typeof ExplainerCatalogEntrySchema>;
export type ExplainerCatalog = z.infer<typeof ExplainerCatalogSchema>;
export type ExplainerCatalogSearchInput = z.input<typeof ExplainerCatalogSearchInputSchema>;
export type ParsedExplainerCatalogSearchInput = z.output<typeof ExplainerCatalogSearchInputSchema>;
export type ExplainerCatalogSummary = z.infer<typeof ExplainerCatalogSummarySchema>;
export type ExplainerCatalogListResult = z.infer<typeof ExplainerCatalogListResultSchema>;
export type ExplainerCatalogDetail = z.infer<typeof ExplainerCatalogDetailSchema>;
export type ExplainerPlaybackEnvelope = z.infer<typeof ExplainerPlaybackEnvelopeSchema>;
export type ExplainerCatalogReleasePointer = z.infer<typeof ExplainerCatalogReleasePointerSchema>;
