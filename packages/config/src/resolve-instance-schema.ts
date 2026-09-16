import { z } from "zod";
import {
  INSTANCE_DEPLOYMENT_MODES,
  INSTANCE_JSON_SCHEMA_VERSION,
} from "./instance-defaults";

const ComposeContainerBundleSchema = z.object({
  legacyPostgres: z.string(),
  logtoPostgres: z.string(),
  logtoCore: z.string(),
  logtoSeed: z.string(),
});

const InstanceJsonDbSchema = z.object({
  directConnection: z.string(),
  postgresHostPort: z.number().int().positive().max(65535),
});

/** M215 — legacy disk field accepted at parse time only. */
const RetiredNeonProxyDbFieldSchema = z.object({
  neonProxyPort: z.number().int().positive().max(65535).optional(),
});

const InstanceJsonDbParseSchema = InstanceJsonDbSchema.merge(RetiredNeonProxyDbFieldSchema);

const InstanceJsonCoreShape = {
  schemaVersion: z.literal(INSTANCE_JSON_SCHEMA_VERSION),
  instanceId: z.string(),
  server: z.object({
    host: z.string(),
    port: z.number().int().positive().max(65535),
    url: z.string(),
  }),
  workbench: z.object({
    port: z.number().int().positive().max(65535),
    url: z.string(),
  }),
  logto: z.object({
    dbPort: z.number().int().positive().max(65535),
    corePort: z.number().int().positive().max(65535),
    adminPort: z.number().int().positive().max(65535),
  }),
  compose: z.object({
    projectName: z.string(),
    /** When absent on disk, `resolveInstance()` hydrates from `projectName`. */
    containers: ComposeContainerBundleSchema.optional(),
  }),
  hostname: z.object({
    federated: z.string(),
    mdns: z.string(),
    tlsSan: z.string(),
    caddyAuthHost: z.string(),
    caddyAuthAdminHost: z.string(),
  }),
  deploymentMode: z.enum(INSTANCE_DEPLOYMENT_MODES).optional(),
  /** M091 Phase 3 — ISO-8601 stamp when deploy.toml consumption completed. */
  deployConfigConsumedAt: z.string().datetime().optional(),
  /** D172 — last resolved Workbench SPA dist path (dev-tooling persistence). */
  workbenchDist: z.string().optional(),
} as const;

/** Disk / sibling parse shape — accepts retired M215 fields. */
export const InstanceJsonParseSchema = z
  .object({
    ...InstanceJsonCoreShape,
    db: InstanceJsonDbParseSchema,
  })
  .strict();

/** Public / write shape — proxy-free resolved output. */
export const InstanceJsonSchema = z
  .object({
    ...InstanceJsonCoreShape,
    db: InstanceJsonDbSchema,
  })
  .strict();

export type InstanceJsonParse = z.infer<typeof InstanceJsonParseSchema>;
export type InstanceJson = z.infer<typeof InstanceJsonSchema>;

/** Strip retired M215 fields after parse/overlays; never expose on `ResolvedInstance`. */
export function stripRetiredNeonProxyFields(data: InstanceJsonParse): InstanceJson {
  if (data.db.neonProxyPort === undefined) return data;
  const { neonProxyPort: _retired, ...db } = data.db;
  return { ...data, db };
}
