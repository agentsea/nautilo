import { dirname } from "node:path";

import { getPersonalProviderCredentialCustodyEvidence } from "@nautilo/db";
import {
  PersonalProviderCustodyError,
  ensurePersonalProviderCustodyFile,
} from "@nautilo/operator-secrets";

import { inspectPersonalProviderCustody } from "./personal-provider-custody";
import { getServerDirectDb } from "./server-direct-db";

/**
 * One-shot maintenance proof used before a cloud runtime is started with new
 * custody. Success means either there is no encrypted authority to preserve,
 * or the injected custody validates every retained credential.
 */
export async function assertPersonalProviderCustodyMaintenanceEvidence(): Promise<void> {
  const status = await inspectPersonalProviderCustody();
  if (status.recordsExist === false || status.status === "ready" || status.status === "degraded") return;
  throw new PersonalProviderCustodyError("custody_unavailable");
}

/** Restore-only provisioning after the authenticated bundle has been applied. */
export async function ensureRestoredPersonalProviderCustodyMaintenanceEvidence(): Promise<void> {
  const status = await inspectPersonalProviderCustody();
  if (status.status === "ready" || status.status === "degraded") return;
  if (status.recordsExist !== false) throw new PersonalProviderCustodyError("custody_unavailable");
  const path = process.env["NAUTILO_DOTENV_PATH"]?.trim();
  if (!path) throw new PersonalProviderCustodyError("custody_unavailable");
  await ensurePersonalProviderCustodyFile({
    instanceRootDir: dirname(path),
    instanceEnvPath: path,
    hasCredentialRecords: async () => (
      await getPersonalProviderCredentialCustodyEvidence(getServerDirectDb())
    ).recordCount > 0,
  });
  const verified = await inspectPersonalProviderCustody();
  if (verified.status !== "ready") throw new PersonalProviderCustodyError("custody_unavailable");
}
