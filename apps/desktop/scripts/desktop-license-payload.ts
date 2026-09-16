import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import bunLicense from "../licenses/bun/manifest.json";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const licensePath = join(scriptDirectory, "../licenses/bun/LICENSE.txt");
const noticePath = resolve(scriptDirectory, "../../../THIRD_PARTY_NOTICES.md");

function pinnedBunLicense(version: string): Buffer {
  if (version !== bunLicense.version) {
    throw new Error("Bun license version differs from the vendored runtime; update its pinned provenance");
  }
  const bytes = readFileSync(licensePath);
  if (createHash("sha256").update(bytes).digest("hex") !== bunLicense.sha256) {
    throw new Error("Bun license bytes differ from their pinned upstream provenance");
  }
  return bytes;
}

/** Runs even when both runtime binaries are cached, repairing old notice stubs. */
export function vendorPinnedBunLicense(version: string, vendorDirectory: string): void {
  const bytes = pinnedBunLicense(version);
  mkdirSync(vendorDirectory, { recursive: true });
  writeFileSync(join(vendorDirectory, "LICENSE-bun.txt"), bytes);
}

/** Verify the copied files before either ad-hoc or official package signing. */
export function assertDesktopLicensePayload(resourcesDirectory: string): void {
  const notice = readFileSync(join(resourcesDirectory, "legal/THIRD_PARTY_NOTICES.md"));
  if (!notice.equals(readFileSync(noticePath))) {
    throw new Error("Packaged third-party notices differ from the canonical source");
  }
  const license = readFileSync(join(resourcesDirectory, "bun/LICENSE-bun.txt"));
  if (!license.equals(pinnedBunLicense(bunLicense.version))) {
    throw new Error("Packaged Bun license is missing, stale or incomplete");
  }
}

if (import.meta.main) {
  const resourcesDirectory = process.argv[2];
  if (!resourcesDirectory || process.argv.length !== 3) {
    throw new Error("Usage: bun desktop-license-payload.ts <resources-directory>");
  }
  assertDesktopLicensePayload(resourcesDirectory);
}
