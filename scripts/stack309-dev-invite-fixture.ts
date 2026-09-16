#!/usr/bin/env bun
/**
 * Stack 309's deliberately narrow local acceptance invite fixture.
 *
 * This is not a product endpoint and it never changes redemption: it writes a
 * single canonical `kind=server` invite row, then keeps its full locator in a
 * private file owned by the named disposable instance. The only supported
 * instance namespace is Stack 309's agent-lab fixture namespace, and the only
 * creator is the already-authenticated delegated fixture operator.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { chmod, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  eq,
  groups,
  invites,
  resolveDirectDatabaseConnectionString,
  users,
} from "@nautilo/db";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import { SERVER_ROLE_TO_GROUP_TYPE, type ServerRoleSlug } from "@nautilo/trust";

const FIXTURE_INSTANCE = /^agent-lab-309-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIXTURE_CREATOR_HANDLE = "agent_tester";
const FIXTURE_DISPLAY_PREFIX = "stack309-fixture:";
const FIXTURE_DIRECTORY = ["fixtures", "stack309-invites"] as const;
const INVITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_TOKEN = /^inv_[A-Za-z0-9_-]{32}$/;

export type MintFixtureArgs = {
  command: "mint";
  instance: string;
  server: string;
  role: ServerRoleSlug;
  expiresInMinutes: number;
};

export type RevokeFixtureArgs = {
  command: "revoke";
  instance: string;
  inviteId: string;
};

export type FixtureArgs = MintFixtureArgs | RevokeFixtureArgs;

function usage(): never {
  throw new Error(
    "Usage: bun scripts/stack309-dev-invite-fixture.ts mint --instance <agent-lab-309-*> --server <local-instance-url> --role <server-role> --expires-in <1-60m> | revoke --instance <agent-lab-309-*> --invite-id <uuid>",
  );
}

function requireFixtureInstance(value: string | undefined): string {
  const instance = value?.trim() ?? "";
  if (!FIXTURE_INSTANCE.test(instance)) {
    throw new Error("Stack 309 fixture accepts only its named disposable agent-lab instance");
  }
  return instance;
}

function readFlags(args: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || result[flag] !== undefined) usage();
    result[flag] = value;
  }
  return result;
}

export function parseFixtureArgs(argv: readonly string[]): FixtureArgs {
  const [command, ...tail] = argv;
  const flags = readFlags(tail);
  if (command === "mint") {
    const allowed = new Set(["--instance", "--server", "--role", "--expires-in"]);
    if (Object.keys(flags).some((flag) => !allowed.has(flag))) usage();
    const instance = requireFixtureInstance(flags["--instance"]);
    const server = flags["--server"]?.trim() ?? "";
    const role = flags["--role"]?.trim() ?? "";
    const expiry = flags["--expires-in"]?.trim() ?? "";
    const match = /^(\d{1,2})m$/.exec(expiry);
    const expiresInMinutes = match ? Number(match[1]) : Number.NaN;
    if (!server || !(role in SERVER_ROLE_TO_GROUP_TYPE) || !Number.isInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 60) {
      usage();
    }
    return { command, instance, server, role: role as ServerRoleSlug, expiresInMinutes };
  }
  if (command === "revoke") {
    const allowed = new Set(["--instance", "--invite-id"]);
    if (Object.keys(flags).some((flag) => !allowed.has(flag))) usage();
    const instance = requireFixtureInstance(flags["--instance"]);
    const inviteId = flags["--invite-id"]?.trim() ?? "";
    if (!INVITE_ID.test(inviteId)) usage();
    return { command, instance, inviteId };
  }
  usage();
}

function normalizedOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Fixture server must be an exact local http origin");
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1") {
    throw new Error("Fixture server must be this disposable local instance");
  }
  return url.origin;
}

function scopedInstanceEnvironment(
  instance: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, NAUTILO_INSTANCE_ID: instance };
}

export function fixtureDirectoryForInstance(instance: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(
    resolveNautiloRootDir({ env: scopedInstanceEnvironment(instance, env) }),
    ...FIXTURE_DIRECTORY,
  );
}

export function fixtureLocatorPath(instance: string, inviteId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!INVITE_ID.test(inviteId)) throw new Error("Invalid fixture invite id");
  return join(fixtureDirectoryForInstance(instance, env), `invite-${inviteId}.locator`);
}

function mintInviteToken(): string {
  return `inv_${randomBytes(24).toString("base64url")}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function ensurePrivateFixtureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Fixture directory is not a private real directory");
  }
}

function resolvedScopedInstance(instance: string) {
  const env = scopedInstanceEnvironment(instance);
  const root = resolveNautiloRootDir({ env });
  if (!existsSync(join(root, "instance.json"))) {
    throw new Error("Fixture instance has not been created");
  }
  return { env, root, resolved: resolveInstance(env) };
}

async function mintFixture(args: MintFixtureArgs): Promise<{ inviteId: string; protectedPath: string }> {
  const { env, resolved } = resolvedScopedInstance(args.instance);
  const expectedOrigin = normalizedOrigin(resolved.server.url);
  if (normalizedOrigin(args.server) !== expectedOrigin) {
    throw new Error("Fixture server does not match the named instance");
  }
  const fixtureDirectory = fixtureDirectoryForInstance(args.instance, env);
  await ensurePrivateFixtureDirectory(fixtureDirectory);

  const sql = postgres(resolveDirectDatabaseConnectionString(env), { max: 1 });
  const db = drizzle(sql);
  try {
    const creatorRows = await db
      .select({ id: users.id, externalId: users.externalId })
      .from(users)
      .where(eq(users.handle, FIXTURE_CREATOR_HANDLE))
      .limit(2);
    if (creatorRows.length !== 1 || !creatorRows[0]?.externalId) {
      throw new Error("Delegated fixture creator is not an authenticated unique local Human");
    }
    const [canonicalGroup] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, SERVER_ROLE_TO_GROUP_TYPE[args.role]))
      .limit(1);
    if (!canonicalGroup) throw new Error("Canonical server role group is missing");

    const token = mintInviteToken();
    if (!INVITE_TOKEN.test(token)) throw new Error("Invite generator contract failed");
    const expiresAt = new Date(Date.now() + args.expiresInMinutes * 60_000);
    const [inserted] = await db
      .insert(invites)
      .values({
        tokenHash: sha256Hex(token),
        kind: "server",
        targetGroupId: canonicalGroup.id,
        targetRoomId: null,
        maxUses: 1,
        usedCount: 0,
        createdBy: creatorRows[0].id,
        displayName: `${FIXTURE_DISPLAY_PREFIX}${args.role}:${randomUUID()}`,
        expiresAt,
        revokedAt: null,
      })
      .returning({ id: invites.id });
    if (!inserted) throw new Error("Canonical invite insert returned no id");

    const protectedPath = fixtureLocatorPath(args.instance, inserted.id, env);
    const locator = new URL(`/redeem/${token}`, expectedOrigin).toString();
    try {
      await writeFile(protectedPath, locator, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(protectedPath, 0o600);
    } catch (error) {
      await db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, inserted.id));
      await unlink(protectedPath).catch(() => undefined);
      throw error;
    }
    return { inviteId: inserted.id, protectedPath };
  } finally {
    await sql.end({ timeout: 3 });
  }
}

async function revokeFixture(args: RevokeFixtureArgs): Promise<void> {
  const { env } = resolvedScopedInstance(args.instance);
  const protectedPath = fixtureLocatorPath(args.instance, args.inviteId, env);
  const sql = postgres(resolveDirectDatabaseConnectionString(env), { max: 1 });
  const db = drizzle(sql);
  try {
    const rows = await db
      .select({ id: invites.id, displayName: invites.displayName })
      .from(invites)
      .where(eq(invites.id, args.inviteId))
      .limit(1);
    const row = rows[0];
    if (!row || !row.displayName?.startsWith(FIXTURE_DISPLAY_PREFIX)) {
      throw new Error("Fixture revoke accepts only Stack 309 fixture invite ids");
    }
    await db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, args.inviteId));
    await unlink(protectedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  } finally {
    await sql.end({ timeout: 3 });
  }
}

async function main(): Promise<void> {
  const args = parseFixtureArgs(process.argv.slice(2));
  if (args.command === "mint") {
    const result = await mintFixture(args);
    // Intentionally bearer-free: the locator lives only in the protected file.
    process.stdout.write(`Minted Stack 309 invite ${result.inviteId}\nProtected locator: ${result.protectedPath}\n`);
    return;
  }
  await revokeFixture(args);
  process.stdout.write(`Revoked Stack 309 fixture invite ${args.inviteId}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Stack 309 invite fixture failed"}\n`);
    process.exitCode = 1;
  });
}

export { normalizedOrigin, mintInviteToken };
