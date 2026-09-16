import { join } from "node:path";

import type { NautiloRuntimePaths } from "@nautilo/config";

/** Canonical Connection vault ciphertext file beneath the configured vault zone (`~/.nautilo/vault/vault.enc` by default). */
export function resolveVaultEncryptedFilePath(paths: NautiloRuntimePaths): string {
  return join(paths.vaultDir, "vault.enc");
}
