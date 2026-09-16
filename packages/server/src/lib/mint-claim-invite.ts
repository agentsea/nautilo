import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  hasUnredeemedClaimInvite,
  invites,
  type DirectDatabase,
} from "@nautilo/db";

const INV_PREFIX = "inv_";
const TOKEN_BYTES = 24;

export interface MintClaimInviteResult {
  token: string | null;
  alreadyExists: boolean;
}

export interface MintClaimInviteDeps {
  db: DirectDatabase;
  randomBytes?: (size: number) => Buffer;
  writeFile?: (path: string, contents: string, opts: { mode: number }) => void;
  chmod?: (path: string, mode: number) => void;
  mkdir?: (path: string, opts: { recursive: boolean; mode: number }) => void;
  instanceRootDir?: string;
  /** Test seam — defaults to the real `hasUnredeemedClaimInvite` from `@nautilo/db`. */
  hasUnredeemedClaimInviteFn?: (db: DirectDatabase) => Promise<boolean>;
}

function formatLegacyClaimInviteFile(token: string, isoStamp: string): string {
  return [
    "# Nautilo bootstrap claim invite",
    `# Created: ${isoStamp}`,
    "# Single-shot. Whoever redeems first becomes the server owner.",
    `redeem_input: ${token}`,
    `token: ${token}`,
    "",
  ].join("\n");
}

export async function mintClaimInvite(
  deps: MintClaimInviteDeps,
): Promise<MintClaimInviteResult> {
  const randomBytesFn = deps.randomBytes ?? nodeRandomBytes;
  const writeFileFn =
    deps.writeFile ??
    ((path: string, contents: string, opts: { mode: number }) => {
      writeFileSync(path, contents, { encoding: "utf-8", mode: opts.mode });
    });
  const chmodFn = deps.chmod ?? chmodSync;
  const mkdirFn =
    deps.mkdir ??
    ((path: string, opts: { recursive: boolean; mode: number }) => {
      mkdirSync(path, opts);
    });

  const hasUnredeemedFn = deps.hasUnredeemedClaimInviteFn ?? hasUnredeemedClaimInvite;
  if (await hasUnredeemedFn(deps.db)) {
    return { token: null, alreadyExists: true };
  }

  const token = INV_PREFIX + randomBytesFn(TOKEN_BYTES).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

  await deps.db.insert(invites).values({
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

  const instanceRootDir = deps.instanceRootDir?.trim();
  if (instanceRootDir && instanceRootDir.length > 0) {
    const bootstrapPath = join(instanceRootDir, ".bootstrap", "claim-invite");
    const legacyPath = join(instanceRootDir, "claim-invite.txt");

    mkdirFn(join(instanceRootDir, ".bootstrap"), { recursive: true, mode: 0o700 });
    writeFileFn(bootstrapPath, token, { mode: 0o600 });
    chmodFn(bootstrapPath, 0o600);

    const legacyContents = formatLegacyClaimInviteFile(token, new Date().toISOString());
    writeFileFn(legacyPath, legacyContents, { mode: 0o600 });
    chmodFn(legacyPath, 0o600);
  }

  return { token, alreadyExists: false };
}
