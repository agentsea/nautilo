import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import { bootstrapDirForInstance, writeBootstrapClaimInvite } from "@nautilo/operator-secrets";
import {
  createDirectDb,
  eq,
  findClaimedOwnerIdWithDb,
  hasUnredeemedClaimInvite,
  invites,
  invitesTableExists,
  users,
} from "@nautilo/db";

export const CLAIM_INVITE_FILENAME = "claim-invite.txt";

const INV_PREFIX = "inv_";
const TOKEN_BYTES = 24;

export type BootstrapClaimInviteOutcome =
  | {
      kind: "minted";
      token: string;
      redeemInput: string;
      filePath: string;
      bootstrapClaimInvitePath: string;
    }
  | { kind: "already-claimed"; firstUserHandle: string }
  /**
   * Unredeemed claim row already in DB (no duplicate mint).
   * When `reprintRedeemInput` is set, `claim-invite.txt` was read successfully
   * and the redeem input can be shown again on stdout (plaintext is not
   * recoverable from `token_hash` alone).
   */
  | { kind: "preserved-existing"; filePath: string; reprintRedeemInput?: string }
  | { kind: "skipped-no-table" };

export interface BootstrapClaimInviteResult {
  outcome: BootstrapClaimInviteOutcome;
}

/**
 * Mirrors `packages/server/src/app.ts` → `invitesRoutes` `publicInviteBaseUrl`.
 */
export function resolveDefaultPublicInviteBaseUrl(): string {
  const raw = process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim();
  if (raw && raw.length > 0) {
    return raw.replace(/\/$/, "");
  }
  return resolveInstance().server.url.replace(/\/$/, "");
}

function defaultAtomicWriter(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${nodeRandomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export type ClaimInviteFileInput = {
  redeemInput: string;
  token: string;
};

export function formatClaimInviteFile(input: ClaimInviteFileInput, isoStamp: string): string {
  return [
    "# Nautilo bootstrap claim invite",
    `# Created: ${isoStamp}`,
    "# Single-shot. Whoever redeems first becomes the server owner.",
    `redeem_input: ${input.redeemInput}`,
    `token: ${input.token}`,
    "",
    "# Redeem from Workbench or the Desktop app:",
    "#   open the redeem_input URL above",
    "#",
    "# Safe to delete after first successful redemption (the row is",
    "# auto-marked used in the DB).",
    "",
  ].join("\n");
}

export type ClaimInviteBannerInput = {
  redeemInput: string;
  filePath: string;
  /** Single-line `.bootstrap/claim-invite` path (Phase 5); optional for legacy-only banners. */
  bootstrapClaimInvitePath?: string | undefined;
  /** Same boxed shape as first mint, but copy reflects an existing unredeemed invite. */
  reprint?: boolean;
};

export function formatClaimInviteBanner(input: ClaimInviteBannerInput): string {
  const headline = input.reprint
    ? "Nautilo bootstrap claim invite — STILL UNREDEEMED — SAVE THIS LINK"
    : "Nautilo bootstrap claim invite — SAVE THIS LINK";
  return [
    "========================================================",
    headline,
    "========================================================",
    "",
    `  Redeem input : ${input.redeemInput}`,
    `  Written to   : ${input.filePath} (chmod 600)`,
    ...(input.bootstrapClaimInvitePath
      ? [`  Bootstrap dir : ${input.bootstrapClaimInvitePath}`]
      : []),
    "  Redeem       : open the redeem input in Workbench or the Desktop app",
    "",
    "========================================================",
    "",
  ].join("\n");
}

/**
 * Parses our written `claim-invite.txt` body — exported for unit tests.
 * Expects a line `redeem_input: <inv_...>` (and optionally `token:`).
 * Also accepts legacy `url:` files so existing unredeemed invites can still
 * be reprinted without revoking the hash-only DB row.
 */
export function parseClaimInviteFileContent(contents: string): {
  redeemInput: string;
  token?: string;
} | null {
  let redeemInput: string | undefined;
  let token: string | undefined;
  for (const line of contents.split(/\r?\n/u)) {
    const input = /^redeem_input:\s*(.+)$/u.exec(line.trim());
    if (input?.[1]) {
      redeemInput = input[1].trim();
      continue;
    }
    const u = /^url:\s*(.+)$/u.exec(line.trim());
    if (u?.[1]) {
      redeemInput = u[1].trim();
      continue;
    }
    const t = /^token:\s*(.+)$/u.exec(line.trim());
    if (t?.[1]) {
      token = t[1].trim();
    }
  }
  if (!redeemInput || redeemInput.length === 0) return null;
  return token && token.length > 0 ? { redeemInput, token } : { redeemInput };
}

function tryReadReprintRedeemInput(
  filePath: string,
  readFile: (path: string) => string,
  pathExists: (path: string) => boolean,
): string | undefined {
  if (!pathExists(filePath)) return undefined;
  try {
    const body = readFile(filePath);
    return parseClaimInviteFileContent(body)?.redeemInput;
  } catch {
    return undefined;
  }
}

export interface BootstrapClaimInviteDeps {
  db?: ReturnType<typeof createDirectDb>;
  resolvePublicInviteBaseUrl?: () => string;
  resolveClaimInvitePath?: () => string;
  /**
   * Instance id for `~/.nautilo-<id>/.bootstrap/` dual-write (defaults to
   * `resolveInstance().instanceId`).
   */
  currentInstanceId?: () => string;
  /**
   * Override for `os.homedir()` when resolving `~/.nautilo…` (tests; CI
   * workers sometimes ignore `process.env.HOME` for `homedir()`).
   */
  operatorHomeDir?: string;
  writeFile?: (path: string, contents: string) => void;
  readFile?: (path: string) => string;
  existsSync?: (path: string) => boolean;
  /** Remove claim file after a failed DB insert (best-effort). */
  unlinkFile?: (path: string) => void;
  log?: (msg: string) => void;
  isoStamp?: () => string;
  randomBytes?: (size: number) => Buffer;
}

export async function bootstrapClaimInvite(
  deps: BootstrapClaimInviteDeps = {},
): Promise<BootstrapClaimInviteResult> {
  const log = deps.log ?? console.log;
  const resolvePath =
    deps.resolveClaimInvitePath ??
    (() => join(resolveNautiloRootDir(), CLAIM_INVITE_FILENAME));
  const writeFile = deps.writeFile ?? defaultAtomicWriter;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const pathExists = deps.existsSync ?? existsSync;
  const unlinkFile = deps.unlinkFile ?? ((p: string) => unlinkSync(p));
  const isoStamp = deps.isoStamp ?? (() => new Date().toISOString());
  const randomBytesFn = deps.randomBytes ?? nodeRandomBytes;

  const instanceId = (deps.currentInstanceId ?? (() => resolveInstance().instanceId))();
  const bootstrapDir = bootstrapDirForInstance(
    instanceId,
    deps.operatorHomeDir !== undefined && deps.operatorHomeDir.trim().length > 0
      ? { home: deps.operatorHomeDir.trim() }
      : undefined,
  );
  const bootstrapClaimInvitePath = join(bootstrapDir, "claim-invite");

  const db = deps.db ?? createDirectDb(1);
  const ownDb = deps.db === undefined;

  try {
    if (!(await invitesTableExists(db))) {
      log(
        "[bootstrap-claim-invite] invites table missing — run `bun run db:migrate` against your Nautilo DB, then retry.",
      );
      return { outcome: { kind: "skipped-no-table" } };
    }

    // Check unredeemed claim invites BEFORE `users` count. Migrations seed a
    // bootstrap owner user row before first redemption; an unredeemed claim
    // row can coexist with that row — that is not "already claimed".
    const hasClaim = await hasUnredeemedClaimInvite(db);

    const targetPath = resolvePath();
    if (hasClaim) {
      const reprintRedeemInput = tryReadReprintRedeemInput(targetPath, readFile, pathExists);
      if (reprintRedeemInput) {
        log(
          `[bootstrap-claim-invite] un-redeemed claim invite already in DB — repeating redeem input from ${targetPath}`,
        );
        return {
          outcome: {
            kind: "preserved-existing",
            filePath: targetPath,
            reprintRedeemInput,
          },
        };
      }
      log(
        `[bootstrap-claim-invite] un-redeemed claim invite already exists in DB; ${targetPath} is missing or has no redeem_input/url line — cannot recover plaintext without revoking the row (hash-only in DB).`,
      );
      return { outcome: { kind: "preserved-existing", filePath: targetPath } };
    }

    // Use `findClaimedOwnerIdWithDb` (credentials-presence) rather than
    // a naive `count(users)` so the `seedDefaultOwner` placeholder
    // (`name="user"`, no credentials, inserted by `bin/nautilo-server`'s
    // boot path) doesn't masquerade as a claim. Before this check we
    // started from a populated `users` table after a `server:start →
    // infra:start` ordering — the count was > 0 but no claim had ever
    // happened, so the operator ended up with the placeholder, no
    // claim invite, and no recovery path. See find-claimed-owner.ts
    // for the canonical predicate.
    const claimedOwnerId = await findClaimedOwnerIdWithDb(db);
    if (claimedOwnerId !== null) {
      const [claimed] = await db
        .select({ handle: users.handle })
        .from(users)
        .where(eq(users.id, claimedOwnerId))
        .limit(1);
      const handle =
        claimed?.handle && claimed.handle.length > 0
          ? claimed.handle
          : "unknown";
      log(
        `[bootstrap-claim-invite] first user @${handle} already claimed (credentials present); skipping claim mint`,
      );
      return { outcome: { kind: "already-claimed", firstUserHandle: handle } };
    }

    const token = INV_PREFIX + randomBytesFn(TOKEN_BYTES).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const redeemInput = token;

    const contents = formatClaimInviteFile(
      { redeemInput, token },
      isoStamp(),
    );
    writeFile(targetPath, contents);
    writeBootstrapClaimInvite(bootstrapDir, token);
    try {
      await db.insert(invites).values({
        tokenHash,
        kind: "claim",
        targetGroupId: null,
        targetRoomId: null,
        maxUses: 1,
        usedCount: 0,
        createdBy: null,
        displayName: "Bootstrap claim invite",
        expiresAt: null,
        revokedAt: null,
      });
    } catch (err) {
      try {
        unlinkFile(targetPath);
      } catch {
        /* best-effort: drop partial file so the next run can mint DB + file together */
      }
      try {
        unlinkFile(bootstrapClaimInvitePath);
      } catch {
        /* best-effort */
      }
      throw err;
    }
    log(
      `[bootstrap-claim-invite] claim invite written to ${targetPath} (chmod 600)`,
    );

    return {
      outcome: {
        kind: "minted",
        token,
        redeemInput,
        filePath: targetPath,
        bootstrapClaimInvitePath,
      },
    };
  } finally {
    if (ownDb) {
      await db.end();
    }
  }
}
