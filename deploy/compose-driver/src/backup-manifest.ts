import { z } from "zod";

const sha256Hex = z.string().regex(
  /^[a-f0-9]{64}$/,
  "must be a SHA-256 hex digest",
);

const backupManifestV1Shape = {
  createdAt: z.string(),
  profileName: z.string(),
  instanceId: z.string(),
  transport: z.enum(["local", "remote"]),
  composeProjectName: z.string(),
  image: z.object({
    mode: z.enum(["registry", "source"]),
    repoDigest: z.string().optional(),
    imageId: z.string().optional(),
    backupTag: z.string().optional(),
    tag: z.string().optional(),
  }),
  contents: z.object({
    nautiloDb: z.boolean(),
    logtoDb: z.boolean(),
    artifacts: z.boolean(),
    // Added after v1 bundles existed. Default preserves restore compatibility
    // for old manifests that have no durable media archive.
    media: z.boolean().default(false),
    // Added after media volume backup. Default preserves restore compatibility
    // for old manifests that have no durable mini-app archive.
    apps: z.boolean().default(false),
    // Added for remote server-only rollback. Older bundles predate capture of
    // the remote root's compose template and restore with the current template.
    composeTemplate: z.boolean().default(false),
    instanceEnv: z.boolean(),
    operatorFiles: z.boolean(),
    caddyData: z.boolean(),
    caddyConfig: z.boolean(),
    localCaCerts: z.boolean(),
  }),
  https: z.enum(["off", "letsencrypt"]).optional(),
  sizesBytes: z.record(z.string(), z.number()).optional(),
};

export const backupManifestV1Schema = z.object({
  version: z.literal(1),
  ...backupManifestV1Shape,
});

/**
 * D427 Wave 1 (task 1.1.1) — per-file bundle integrity inventory. Each entry
 * is the sha256 + size of a bundle member file as written on disk. Presence
 * of `integrity` is what lets `nautilo backup verify` prove a recovery
 * bundle is intact before adoption. v1 bundles carry no inventory and
 * cannot establish verified provenance; they remain readable for restore.
 */
export const fileIntegritySchema = z.object({
  sha256: sha256Hex,
  sizeBytes: z.number().int().nonnegative(),
});

export const bundleIntegritySchema = z.object({
  nautiloDb: fileIntegritySchema.optional(),
  logtoDb: fileIntegritySchema.optional(),
  artifacts: fileIntegritySchema.optional(),
  media: fileIntegritySchema.optional(),
  apps: fileIntegritySchema.optional(),
  composeTemplate: fileIntegritySchema.optional(),
  instanceEnv: fileIntegritySchema.optional(),
  caddyData: fileIntegritySchema.optional(),
  caddyConfig: fileIntegritySchema.optional(),
  localCaCerts: fileIntegritySchema.optional(),
});

export const backupManifestV2Schema = backupManifestV1Schema.extend({
  version: z.literal(2),
  integrity: bundleIntegritySchema,
});

/**
 * Read schema accepting both v1 (no integrity inventory) and v2 (with
 * per-file integrity) recovery-bundle manifests. Restore keeps reading v1
 * bundles; `nautilo backup verify` and `adopt --confirm` require v2
 * provenance.
 */
export const backupManifestSchema = z.discriminatedUnion("version", [
  backupManifestV1Schema,
  backupManifestV2Schema,
]);

export type BackupManifestV1 = z.infer<typeof backupManifestV1Schema>;
export type BackupManifestV2 = z.infer<typeof backupManifestV2Schema>;
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type BundleIntegrity = z.infer<typeof bundleIntegritySchema>;
export type FileIntegrity = z.infer<typeof fileIntegritySchema>;

/**
 * Maps a `contents` flag to the on-disk bundle member filename and the
 * matching `integrity` inventory key. Operator files have no single
 * member file and are intentionally absent — image identity lives in
 * `manifest.image`.
 */
export const BUNDLE_INTEGRITY_FILES = {
  nautiloDb: "nautilo.sql.gz",
  logtoDb: "logto_nautilo.sql.gz",
  artifacts: "artifacts.tgz",
  media: "media.tgz",
  apps: "apps.tgz",
  composeTemplate: "docker-compose.yml",
  instanceEnv: "instance.env",
  caddyData: "caddy_data.tgz",
  caddyConfig: "caddy_config.tgz",
  localCaCerts: "certs.tgz",
} as const;

export type BundleIntegrityKey = keyof typeof BUNDLE_INTEGRITY_FILES;

/** Narrows a parsed manifest to its v2 variant (the only one with integrity). */
export function manifestHasIntegrity(
  manifest: BackupManifest,
): manifest is BackupManifestV2 {
  return manifest.version === 2;
}
