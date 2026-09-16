import type { EncryptionCoverageEntry } from "../src/model";

/** OS account custody is device-local, not a Nautilo namespace-key bridge. */
export const REVIEWED_DRAFT_RECOVERY_COVERAGE: readonly EncryptionCoverageEntry[] = [{
  id: "file.main-2026-09-12.desktop-mini-app-draft-recovery",
  surface: "file",
  locator: "apps/desktop/electron/mini-app-draft-recovery.ts#MiniAppDraftRecoveryStore",
  owner: "apps/desktop",
  readers: ["apps/desktop/electron/mini-app-draft-recovery.ts"],
  writers: ["apps/desktop/electron/mini-app-draft-recovery.ts"],
  classification: "device_local",
  migrationState: "not_applicable",
  deviceStorage: "Desktop userData mini-app-draft-recovery directory: a hashed owner/authority/app/target filename, mode-0700 directory and mode-0600 atomic files containing a fixed header plus Electron safeStorage ciphertext. Unavailable encryption and basic_text backends are rejected. This is OS-account custody, not namespace encryption or server backup protection.",
  retention: "Device-local drafts survive process restarts. A null draft writes a revisioned tombstone; authentication changes revoke access handles without claiming deletion of the durable file.",
  cleanupContract: "Writing a null draft replaces its content with an encrypted tombstone. Removing the owning Desktop userData recovery directory removes its local records; no automatic expiry, logout erasure, or synchronized server copy is claimed.",
  testEvidence: [
    "apps/desktop/tests/unit/mini-app-draft-recovery.test.ts",
    "packages/encryption-invariants/tests/integration/reviewed-draft-recovery-security.test.ts",
  ],
}];
