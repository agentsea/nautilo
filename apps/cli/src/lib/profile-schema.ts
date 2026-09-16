import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { NAUTILO_INSTANCE_ID_PATTERN, PASSWORD_RECOVERY_DRIVERS } from "@nautilo/config";
import { profilesRootDir } from "./api-client.ts";

export const INSTANCE_ID_RE = NAUTILO_INSTANCE_ID_PATTERN;
export const LOCAL_COMPOSE_ENDPOINT_AUTHORITY_ERROR =
  "Local Compose profiles must not set host or port: the named instance allocates the canonical collision-safe bundle.";
const passwordRecoverySchema = z.enum(PASSWORD_RECOVERY_DRIVERS);

const localProfileSchema = z.object({
  name: z.string().min(1),
  transport: z.literal("local"),
  lifecycle: z.enum(["compose", "external"]),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  instance_id: z.string().regex(INSTANCE_ID_RE).optional(),
  retention: z.enum(["durable", "disposable"]).optional(),
  office: z.boolean().default(false).optional(),
  /** Never accepted; retained only so old read-only callers type-check. */
  tag: z.never().optional(),
  compose_dir: z.string().optional(),
  https: z.literal("off").default("off").optional(),
  password_recovery: passwordRecoverySchema.optional(),
}).strict().superRefine((v, ctx) => {
  if (v.lifecycle === "external") {
    if (v.instance_id !== undefined) ctx.addIssue({ code: "custom", message: "instance_id is only meaningful when lifecycle=compose", path: ["instance_id"] });
  }
  if (v.lifecycle !== "compose" && v.retention !== undefined) {
    ctx.addIssue({ code: "custom", message: "retention is only meaningful when lifecycle=compose", path: ["retention"] });
  }
});

const remoteProfileSchema = z.object({
  name: z.string().min(1),
  transport: z.literal("remote"),
  lifecycle: z.enum(["compose", "external"]),
  domain: z.string().min(1).optional(),
  ssh: z.object({
    host: z.string().min(1),
    user: z.string().min(1),
    identity_file: z.string().optional(),
    known_hosts_file: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
  }).optional(),
  remote_path: z.string().optional(),
  base_url: z.string().url().optional(),
  instance_id: z.string().regex(INSTANCE_ID_RE).optional(),
  office: z.boolean().default(false).optional(),
  /** Never accepted; retained only so old read-only callers type-check. */
  tag: z.never().optional(),
  https: z.enum(["off", "letsencrypt"]).default("off").optional(),
  acme_email: z.string().email().optional(),
  acme_staging: z.boolean().optional(),
  password_recovery: passwordRecoverySchema.optional(),
}).strict().superRefine((v, ctx) => {
  if (v.lifecycle === "compose") {
    if (v.ssh === undefined) ctx.addIssue({
      code: "custom",
      message: "ssh block is required when lifecycle=compose",
      path: ["ssh"],
    });
  }
  if (v.lifecycle === "external" && v.ssh !== undefined) ctx.addIssue({
    code: "custom",
    message: "ssh block only meaningful when lifecycle=compose",
    path: ["ssh"],
  });
  if (v.lifecycle === "external" && (v.domain === undefined || v.domain.trim() === "")) {
    ctx.addIssue({
      code: "custom",
      message: "domain is required when lifecycle=external",
      path: ["domain"],
    });
  }
  if (v.https === "letsencrypt" && (v.domain === undefined || v.domain.trim() === "")) {
    ctx.addIssue({
      code: "custom",
      message: "https=letsencrypt requires a domain",
      path: ["domain"],
    });
  }
  if (v.https === "letsencrypt" && v.lifecycle !== "compose") {
    ctx.addIssue({
      code: "custom",
      message: "https=letsencrypt requires lifecycle=compose",
      path: ["https"],
    });
  }
});

export const profileSchema = z.discriminatedUnion("transport", [
  localProfileSchema,
  remoteProfileSchema,
]);

export type Profile = z.infer<typeof profileSchema>;

const REMOTE_MIGRATION_DROP_KEYS = new Set(["compose_dir", "host", "port"]);

function stripLocalComposeEndpointAuthority(
  out: Record<string, unknown>,
  fallbackName: string,
): void {
  if (
    out["transport"] !== "local" || out["lifecycle"] !== "compose"
    || (out["host"] === undefined && out["port"] === undefined)
  ) return;
  delete out["host"];
  delete out["port"];
  const name = typeof out["name"] === "string" && out["name"].trim() !== ""
    ? out["name"]
    : fallbackName;
  process.stderr.write(
    `[profile] warning: local Compose profile '${name}' contained obsolete host/port; they were ignored because the named instance allocates the canonical collision-safe bundle.\n`,
  );
}

function migrateLegacyProfile(raw: Record<string, unknown>, fallbackName: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  // D420: artifact strategy is invocation-scoped (`nautilo upgrade`), not
  // profile state. Strip the legacy `from_source` field from any persisted
  // profile so existing toml files keep loading without changing location,
  // credentials, or instance. D490 also removes the mutable/private `tag`
  // selector: it must never become new deployment authority after the public
  // digest cutover. Runtime images are now invocation-scoped too; old
  // image_ref values remain loadable but never retain deployment authority.
  delete out["from_source"];
  delete out["tag"];
  delete out["image_ref"];
  if ("transport" in out) {
    stripLocalComposeEndpointAuthority(out, fallbackName);
    if (out["transport"] === "local" && out["lifecycle"] === "compose" && out["retention"] === undefined) {
      out["retention"] = "durable";
    }
    return out;
  }
  const target = out["target"];
  delete out["target"];
  if (target === "local") {
    out["transport"] = "local";
    out["lifecycle"] = "compose";
    out["retention"] = "durable";
    // Legacy target=local profiles predate named instance allocation. Keep
    // them loadable, but strip obsolete endpoint authority so resolution must
    // use the instance's canonical collision-safe bundle.
    stripLocalComposeEndpointAuthority(out, fallbackName);
  } else if (target === "docker-compose" || target === "gcp-cloud-run") {
    out["transport"] = "remote";
    out["lifecycle"] = "external";
    for (const k of REMOTE_MIGRATION_DROP_KEYS) delete out[k];
  }
  return out;
}

export function loadProfileFromObject(raw: Record<string, unknown>, fallbackName: string): Profile {
  const migrated = migrateLegacyProfile(raw, fallbackName);
  const rawName = migrated["name"];
  if (typeof rawName !== "string" || rawName.trim() === "") {
    migrated["name"] = fallbackName;
  } else if (rawName.trim() !== fallbackName) {
    process.stderr.write(
      `[profile] warning: name field '${rawName}' differs from filename '${fallbackName}'; using filename.\n`,
    );
    migrated["name"] = fallbackName;
  }
  const result = profileSchema.safeParse(migrated);
  if (!result.success) {
    const first = result.error.issues[0];
    const detail = first
      ? `${first.path.join(".") || "(root)"}: ${first.message}`
      : "validation failed";
    throw new Error(`Invalid profile '${fallbackName}': ${detail}`);
  }
  return result.data;
}

export function loadProfile(name: string, home: string): Profile {
  const path = join(profilesRootDir(home), `${name}.toml`);
  if (!existsSync(path)) throw new Error(`Unknown profile '${name}'`);
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return loadProfileFromObject(raw, name);
}
