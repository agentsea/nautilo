import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface DesktopCryptoAccountCoordinate {
  readonly serverScope: string;
  readonly userId: string;
  readonly humanActorId: string;
}

function identityPath(
  directory: string,
  account: DesktopCryptoAccountCoordinate,
): string {
  const digest = createHash("sha256")
    .update(account.serverScope)
    .update("\0")
    .update(account.userId)
    .update("\0")
    .update(account.humanActorId)
    .digest("hex");
  return path.join(directory, "installation-identities", `${digest}.json`);
}

function writeIdentity(filePath: string, installationId: string): void {
  if (!UUID.test(installationId)) {
    throw new Error("Desktop crypto installation identity is invalid");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filePath),
    `.${randomUUID()}.crypto-installation.tmp`,
  );
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({ formatVersion: 1, installationId }),
      { mode: 0o600, flag: "wx" },
    );
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The renamed temporary no longer exists; cleanup must not mask writes.
    }
  }
}

export function readOrCreateDesktopCryptoInstallationId(input: Readonly<{
  directory: string;
  account: DesktopCryptoAccountCoordinate;
  fallbackInstallationId: string;
}>): string {
  const filePath = identityPath(input.directory, input.account);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      formatVersion?: unknown;
      installationId?: unknown;
    };
    if (parsed.formatVersion !== 1
      || typeof parsed.installationId !== "string"
      || !UUID.test(parsed.installationId)) {
      throw new Error("Desktop crypto installation identity is corrupt");
    }
    return parsed.installationId;
  } catch (error) {
    if (!(error instanceof Error && "code" in error
      && error.code === "ENOENT")) throw error;
  }
  writeIdentity(filePath, input.fallbackInstallationId);
  return input.fallbackInstallationId;
}

export function activateFreshDesktopCryptoInstallationId(input: Readonly<{
  directory: string;
  account: DesktopCryptoAccountCoordinate;
  installationId: string;
}>): void {
  writeIdentity(
    identityPath(input.directory, input.account),
    input.installationId,
  );
}
