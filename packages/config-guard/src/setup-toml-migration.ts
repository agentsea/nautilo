import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify } from "smol-toml";
import { SetupTemplateV1 } from "./setup-template-v1-for-migration";
import { appendAuditEntrySync } from "./audit-log";
import { DeployConfigV1ForMigration } from "./deploy-config-for-migration";

const ALLOWED_SETUP_TOP_LEVEL = new Set([
  "schemaVersion",
  "serverUrl",
  "admin",
  "claim",
  "providers",
  "genie",
]);

function m091IsoCompactStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function formatZodRefusal(err: import("zod").ZodError): string[] {
  return err.issues.map(
    (i) => `${i.path.join(".") || "root"}: ${i.message}`,
  );
}

export type MigrateSetupTomlStatus =
  | "no-op"
  | "converted"
  | "skipped-collision"
  | "refused-unrecognized-content";

export interface MigrateSetupTomlToDeployTomlResult {
  status: MigrateSetupTomlStatus;
  setupTomlPath: string;
  deployTomlPath: string;
  setupTomlBackup: string | null;
  warnings: string[];
}

export function migrateSetupTomlToDeployToml(
  rootDir: string,
  opts: {
    deployTomlPath?: string;
    bootstrapDir?: string;
    envLookup?: (k: string) => string | undefined;
    now?: Date;
  } = {},
): MigrateSetupTomlToDeployTomlResult {
  const now = opts.now ?? new Date();
  const envLookup = opts.envLookup ?? ((k: string) => process.env[k]);
  const setupTomlPath = join(rootDir, "setup.toml");
  const deployTomlPath =
    opts.deployTomlPath ?? join(homedir(), ".config", "nautilo", "deploy.toml");
  const bootstrapDir = opts.bootstrapDir ?? join(rootDir, ".bootstrap");

  const baseReturn = (
    status: MigrateSetupTomlStatus,
    setupTomlBackup: string | null,
    warnings: string[],
  ): MigrateSetupTomlToDeployTomlResult => ({
    status,
    setupTomlPath,
    deployTomlPath,
    setupTomlBackup,
    warnings,
  });

  if (!existsSync(setupTomlPath)) {
    return baseReturn("no-op", null, []);
  }

  if (existsSync(deployTomlPath)) {
    console.error(
      "[m091] setup.toml present alongside deploy.toml; reconcile manually (no auto-merge)",
    );
    return baseReturn("skipped-collision", null, []);
  }

  let rawUnknown: unknown;
  try {
    rawUnknown = parseToml(readFileSync(setupTomlPath, "utf8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const w = [`invalid TOML: ${msg}`];
    console.error(`[m091] setup.toml migration refused: ${w[0]}`);
    return baseReturn("refused-unrecognized-content", null, w);
  }

  if (rawUnknown === null || typeof rawUnknown !== "object" || Array.isArray(rawUnknown)) {
    const w = ["setup.toml must parse to a TOML table at the root"];
    console.error(`[m091] setup.toml migration refused: ${w[0]}`);
    return baseReturn("refused-unrecognized-content", null, w);
  }

  const raw = rawUnknown as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_SETUP_TOP_LEVEL.has(key)) {
      const w = [`unrecognized top-level key: ${key}`];
      console.error(`[m091] setup.toml migration refused: ${w[0]}`);
      return baseReturn("refused-unrecognized-content", null, w);
    }
  }

  if (raw["schemaVersion"] !== 1) {
    const w = [`schemaVersion must be 1 (got ${String(raw["schemaVersion"])})`];
    console.error(`[m091] setup.toml migration refused: ${w[0]}`);
    return baseReturn("refused-unrecognized-content", null, w);
  }

  const rawAdmin = raw["admin"];
  const rawAdminRecord =
    rawAdmin !== null && typeof rawAdmin === "object" && !Array.isArray(rawAdmin)
      ? (rawAdmin as Record<string, unknown>)
      : undefined;
  if (rawAdminRecord?.["forcePasswordChangeOnFirstSignIn"] === true) {
    const w = [
      "admin.forcePasswordChangeOnFirstSignIn=true cannot be migrated because first-sign-in password changes are not supported; remove forcePasswordChangeOnFirstSignIn and configure a permanent owner password before retrying",
    ];
    console.error(`[m091] setup.toml migration refused: ${w[0]}`);
    return baseReturn("refused-unrecognized-content", null, w);
  }

  const validated = SetupTemplateV1.safeParse(raw);
  if (!validated.success) {
    const warnings = formatZodRefusal(validated.error);
    for (const line of warnings) {
      console.error(`[m091] setup.toml migration refused: ${line}`);
    }
    return baseReturn("refused-unrecognized-content", null, warnings);
  }

  const v = validated.data;
  const warnings: string[] = [];
  if ("serverUrl" in raw && raw["serverUrl"] !== undefined) {
    warnings.push(
      "serverUrl from setup.toml was dropped (instance topology is not stored in deploy.toml)",
    );
  }

  const adminOut: Record<string, unknown> = {
    handle: v.admin.handle,
    displayName: v.admin.displayName,
    password: v.admin.password,
  };
  if (v.admin.pin !== undefined) {
    adminOut["pin"] = v.admin.pin;
  }
  if (rawAdminRecord?.["forcePasswordChangeOnFirstSignIn"] === false) {
    warnings.push(
      "forcePasswordChangeOnFirstSignIn=false was omitted from deploy.toml because owner passwords are permanent",
    );
  }

  const deployPayload: Record<string, unknown> = {
    schemaVersion: 1,
    admin: adminOut,
    providers: v.providers,
  };
  if (v.genie !== undefined) {
    deployPayload["genie"] = v.genie;
  }

  const invite = v.claim.inviteCode;
  let claimInviteContent: string | null = null;
  if ("value" in invite) {
    claimInviteContent = invite.value;
  } else {
    const resolved = envLookup(invite.fromEnv)?.trim();
    if (resolved) {
      claimInviteContent = resolved;
    } else {
      warnings.push(
        `claim invite from env var ${invite.fromEnv} was not resolvable; if you need it, write it to ${join(bootstrapDir, "claim-invite")} manually`,
      );
    }
  }

  let body: string;
  try {
    body = stringify(deployPayload as Parameters<typeof stringify>[0]);
    const reparsed = parseToml(body);
    const round = DeployConfigV1ForMigration.safeParse(reparsed);
    if (!round.success) {
      const zw = formatZodRefusal(round.error);
      for (const line of zw) {
        console.error(`[m091] setup.toml migration refused: emitted deploy failed validation: ${line}`);
      }
      return baseReturn("refused-unrecognized-content", null, zw);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const w = [`failed to serialize deploy.toml: ${msg}`];
    console.error(`[m091] setup.toml migration refused: ${w[0]}`);
    return baseReturn("refused-unrecognized-content", null, w);
  }

  mkdirSync(dirname(deployTomlPath), { recursive: true });
  writeFileSync(deployTomlPath, body, { mode: 0o600 });
  try {
    chmodSync(deployTomlPath, 0o600);
  } catch {
    /* Windows */
  }

  if (claimInviteContent !== null && claimInviteContent.length > 0) {
    mkdirSync(bootstrapDir, { mode: 0o700 });
    try {
      chmodSync(bootstrapDir, 0o700);
    } catch {
      /* Windows */
    }
    const claimPath = join(bootstrapDir, "claim-invite");
    writeFileSync(claimPath, claimInviteContent, { mode: 0o600 });
    try {
      chmodSync(claimPath, 0o600);
    } catch {
      /* Windows */
    }
  }

  const setupTomlBackup = join(
    rootDir,
    `setup.toml.bak-m091-${m091IsoCompactStamp(now)}`,
  );
  renameSync(setupTomlPath, setupTomlBackup);
  try {
    chmodSync(setupTomlBackup, 0o600);
  } catch {
    /* Windows */
  }

  console.error(
    `[m091] Converted ${setupTomlPath} → ${deployTomlPath} (one-time migration; setup.toml backed up)`,
  );

  try {
    appendAuditEntrySync(join(rootDir, "config-audit.jsonl"), {
      ts: new Date().toISOString(),
      actor: "boot-migration",
      reason: "m091.setup-toml-to-deploy-toml",
      ops: [{ type: "convert", key: "setup.toml" }],
      result: "applied",
    });
  } catch {
    /* best effort */
  }

  return {
    status: "converted",
    setupTomlPath,
    deployTomlPath,
    setupTomlBackup,
    warnings,
  };
}
