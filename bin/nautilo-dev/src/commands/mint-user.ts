/**
 * `nautilo-dev mint-user` — quick-and-dirty second-user provisioning.
 *
 * Why this exists: Stack 3 (D124 P9) needs two real users on one server
 * to exercise cross-user H↔H bubble rendering, but the production user-
 * provisioning surfaces are still in flight (the planned D094 admin CLI;
 * D107 cloud workbench admin). The interactive invite flow adds a
 * multi-step ceremony (mint → switch sessions → redeem in incognito)
 * that gets in the way of fast iteration. This command collapses both
 * steps into one shell call:
 *
 *     bun bin/nautilo-dev/src/index.ts mint-user \\
 *         --handle alex --display-name Alex --yes
 *
 * Internally it inserts a single-use `kind=server` invite row directly
 * into Postgres, then calls `redeemInviteAtomically()` (the exact same
 * primitive `POST /api/invites/:token/redeem` calls) to provision the
 * Logto identity, the `users` row, the `actors` row, and the landing-
 * room membership atomically. No HTTP, no admin session required.
 *
 * Scope: dev-only. This command lives in `nautilo-dev` (the
 * developer-tools binary), NOT in `apps/cli` (the production `nautilo`
 * admin CLI which is the planned D094 surface). When D094's `nautilo users
 * add` lands this command can stay (different audience) or be retired
 * — both call the same `redeemInviteAtomically` primitive.
 *
 * Setup-state precondition: `claimed-needs-auth` or later. A fresh
 * unclaimed server has no `users` schema populated yet; mint the claim
 * invite via `/api/setup/claim-invite` first.
 */
import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import {
  exitUnlessSetupStateIn,
  SETUP_STATES_CLAIMED_OR_LATER,
} from "../lib/setup-state-precondition";
import { consoleMigrationLogger, type MigrationLogger } from "../lib/logto-migration";

const INV_PREFIX = "inv_";
const INVITE_TOKEN_BYTES = 24;

export interface MintUserArgs {
  handle?: string | undefined;
  displayName?: string | undefined;
  password?: string | undefined;
  pin?: string | undefined;
  email?: string | undefined;
  role?: string | undefined;
  yes?: boolean | undefined;
  print?: boolean | undefined;
  outputDir?: string | undefined;
  configEnvPath?: string | undefined;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function mintInviteToken(): string {
  return INV_PREFIX + randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
}

function generatePassword(): string {
  // 24 bytes base64url ≈ 32 chars, well over Logto's minimum + entropy.
  return randomBytes(24).toString("base64url");
}

function generatePin(): string {
  // 6 digits, zero-padded. RedeemInput requires `^\d{6,8}$`.
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function formatMintUserFile(input: {
  handle: string;
  displayName: string;
  email: string;
  pin: string;
  password: string;
  newUserId: string;
  newActorId: string;
  logtoSub: string | undefined;
  landingRoomId: string;
  recoveryCodes: string[];
  isoStamp: string;
}): string {
  return [
    "# Nautilo dev mint-user output",
    `# Created: ${input.isoStamp}`,
    "#",
    "# This is a dev-only credential file for a synthetic user provisioned via",
    "# `nautilo-dev mint-user`. Hand it to your test session, then delete.",
    "",
    `handle:           ${input.handle}`,
    `display_name:     ${input.displayName}`,
    `email:            ${input.email}`,
    `password:         ${input.password}`,
    `pin:              ${input.pin}`,
    "",
    `nautilo_user_id:  ${input.newUserId}`,
    `nautilo_actor_id: ${input.newActorId}`,
    `logto_sub:        ${input.logtoSub ?? "(none)"}`,
    `landing_room_id:  ${input.landingRoomId}`,
    "",
    `recovery_codes:`,
    ...input.recoveryCodes.map((c) => `  - ${c}`),
    "",
  ].join("\n");
}

function defaultWriteSecretFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
}

const LADDER_ROLE_SLUGS = [
  "owner",
  "admin",
  "superuser",
  "member",
  "contributor",
  "guest",
] as const;

type LadderRoleSlug = (typeof LADDER_ROLE_SLUGS)[number];

function resolveRoleSlug(raw: string | undefined): LadderRoleSlug {
  const slug = (raw?.trim().toLowerCase() || "member") as LadderRoleSlug;
  if ((LADDER_ROLE_SLUGS as readonly string[]).includes(slug)) {
    return slug;
  }
  return "member";
}

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function validateArgs(args: MintUserArgs, log: MigrationLogger): {
  handle: string;
  displayName: string;
  password: string;
  pin: string;
  email: string;
} | null {
  const handleRaw = args.handle?.trim().toLowerCase();
  if (!handleRaw) {
    log.error("mint-user: --handle is required (e.g. --handle alex).");
    return null;
  }
  if (!HANDLE_RE.test(handleRaw)) {
    log.error(
      `mint-user: --handle "${handleRaw}" is not a valid handle (lowercase alnum + . _ - , 1-64 chars).`,
    );
    return null;
  }

  const displayName = args.displayName?.trim();
  if (!displayName || displayName.length < 1 || displayName.length > 200) {
    log.error("mint-user: --display-name is required (1-200 chars).");
    return null;
  }

  const password = args.password?.trim() || generatePassword();
  const pin = args.pin?.trim() || generatePin();
  if (!/^\d{6,8}$/.test(pin)) {
    log.error("mint-user: --pin must be 6-8 digits.");
    return null;
  }

  const emailRaw = args.email?.trim();
  const email = emailRaw && emailRaw.length > 0 ? emailRaw : `${handleRaw}@nautilo.local`;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    log.error(`mint-user: synthesized email "${email}" is invalid; pass --email explicitly.`);
    return null;
  }

  return { handle: handleRaw, displayName, password, pin, email };
}

export async function mintUser(args: MintUserArgs): Promise<number> {
  loadConfigEnvIntoProcess({ path: args.configEnvPath });
  await exitUnlessSetupStateIn(SETUP_STATES_CLAIMED_OR_LATER, "mint-user");

  const log = consoleMigrationLogger();
  const apply = Boolean(args.yes);

  if (!apply) {
    log.error(
      "mint-user: dev-only — pass --yes to actually provision a synthetic user.",
    );
    log.error(
      "Usage: nautilo-dev mint-user --handle <h> --display-name <name> [--password <p>] [--pin <6-8 digits>] [--email <e>] [--role <slug>] --yes [--print]",
    );
    return 2;
  }

  const validated = validateArgs(args, log);
  if (!validated) return 2;
  const { handle, displayName, password, pin, email } = validated;
  const roleSlug = resolveRoleSlug(args.role);

  const { createDirectDb, invites, users, groups, asc, eq } = await import("@nautilo/db");
  const trustModule = await import("@nautilo/trust");
  const { getLogtoAdminClient, SERVER_ROLE_TO_GROUP_TYPE } = trustModule;
  type LogtoAdminClient = ReturnType<typeof getLogtoAdminClient>;
  const { redeemInviteAtomically } = await import("@nautilo/server");

  const logto: LogtoAdminClient | null = (() => {
    try {
      return getLogtoAdminClient();
    } catch (err) {
      log.error(
        `mint-user: Logto admin client init failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  })();
  if (!logto) {
    return 1;
  }

  const db = createDirectDb(1);
  // M066's `invites_claim_creator_chk` requires kind=server invites to
  // have a non-null `created_by`. Pre-merge mint-user set this to null
  // (the dev tool was authored before that constraint landed). Use the
  // earliest-created user as the synthetic creator — on a freshly-claimed
  // instance that's the admin who just redeemed the claim invite, which
  // is the right semantic ("the operator who's running this tool").
  const [creator] = await db
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!creator) {
    log.error(
      "mint-user: no users in the database. Claim the instance first " +
        "(redeem the bootstrap claim invite, e.g. via " +
        "`bun run dev:setup --config <deploy.toml>`) before running mint-user.",
    );
    await db.end();
    return 1;
  }
  const createdById = creator.id;

  const targetGroupType = SERVER_ROLE_TO_GROUP_TYPE[roleSlug];
  const [canonicalGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, targetGroupType))
    .limit(1);
  if (!canonicalGroup) {
    log.error(
      `mint-user: canonical group missing for role "${roleSlug}" (type=${targetGroupType}).`,
    );
    await db.end();
    return 1;
  }

  let token: string;
  try {
    token = mintInviteToken();
    const tokenHash = sha256Hex(token);
    const [inserted] = await db
      .insert(invites)
      .values({
        tokenHash,
        kind: "server",
        targetGroupId: canonicalGroup.id,
        targetRoomId: null,
        maxUses: 1,
        usedCount: 0,
        createdBy: createdById,
        displayName: `dev mint-user (${handle})`,
        expiresAt: null,
        revokedAt: null,
      })
      .returning({ id: invites.id });

    if (!inserted) {
      log.error("mint-user: invite insert returned no row.");
      return 1;
    }
    log.info(`  Minted dev server-kind invite ${inserted.id} (single-use).`);
  } catch (err) {
    log.error(
      `mint-user: invite insert failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    await db.end();
    return 1;
  }

  let result;
  try {
    result = await redeemInviteAtomically(
      token,
      { handle, displayName, password, pin, email },
      // The server's redeem-invite primitive imports `LogtoAdminClient`
      // from `@nautilo/trust`; this command does the same via dynamic
      // import. Both type identities resolve to the same module. Pass
      // the client through unchanged.
      { logto },
    );
  } catch (err) {
    log.error(
      `mint-user: redeem failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    await db.end();
    return 1;
  }

  await db.end();

  if (!result.ok) {
    log.error(
      `mint-user: redeem rejected (${result.error}${result.code ? `, code=${result.code}` : ""}${result.message ? `: ${result.message}` : ""}).`,
    );
    return 1;
  }

  const stamp = new Date().toISOString();
  const safeStamp = stamp.replaceAll(":", "-");
  const outputDir =
    args.outputDir?.trim() || join(homedir(), ".nautilo", "mint-user");
  const outPath = join(outputDir, `mint-user-${handle}-${safeStamp}.txt`);

  const file = formatMintUserFile({
    handle,
    displayName,
    email,
    pin,
    password,
    newUserId: result.newUserId,
    newActorId: result.newActorId,
    logtoSub: result.logtoSub,
    landingRoomId: result.landingRoomId,
    recoveryCodes: result.recoveryCodes,
    isoStamp: stamp,
  });

  try {
    defaultWriteSecretFile(outPath, file);
  } catch (err) {
    log.error(
      `mint-user: file write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    log.error(`  user_id=${result.newUserId}, password=${password} (record this NOW)`);
    return 1;
  }

  log.info("");
  log.info(`OK — minted user @${handle} (id=${result.newUserId}).`);
  log.info(`  Credentials written to ${outPath} (chmod 600).`);
  log.info(`  Logto sub: ${result.logtoSub ?? "(none)"}`);
  log.info(`  Landing room: ${result.landingRoomId}`);
  if (args.print) {
    log.warn(
      "--print: plaintext credentials echoed to stderr (sanitize scrollback).",
    );
    log.warn(`  handle:   @${handle}`);
    log.warn(`  email:    ${email}`);
    log.warn(`  password: ${password}`);
    log.warn(`  pin:      ${pin}`);
  }
  return 0;
}
