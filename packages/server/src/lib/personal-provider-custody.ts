import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isCloudMode } from "@nautilo/config";
import { resolveDotenvPath } from "@nautilo/config-guard";
import {
  getPersonalProviderCredential,
  getPersonalProviderCredentialCustodyEvidence,
  listPersonalProviderCredentialsForCustody,
  type PersonalProviderCredentialReceiptReadStatus,
} from "@nautilo/db";
import {
  PersonalProviderCustodyError,
  decryptPersonalProviderCredential, ensurePersonalProviderCustodyFile,
  parsePersonalProviderCustody, personalProviderCustodyFromEnvFile,
  readInjectedPersonalProviderCustody, type PersonalProviderCustody,
} from "@nautilo/operator-secrets";
import { getServerDirectDb } from "./server-direct-db";

function canonicalPath(): string {
  return resolveDotenvPath();
}

export async function readPersonalProviderCustody(): Promise<PersonalProviderCustody> {
  const injected = readInjectedPersonalProviderCustody();
  // A portable restore can recover custody on the protected volume when the
  // original launch workstation is gone. A present platform value is still
  // authoritative: blank/malformed injection must not fall through to a file.
  if (isCloudMode() && injected !== undefined) return parsePersonalProviderCustody(injected);
  try {
    return parsePersonalProviderCustody(personalProviderCustodyFromEnvFile(await readFile(canonicalPath(), "utf8")));
  } catch (error) {
    if (error instanceof PersonalProviderCustodyError) throw error;
    throw new PersonalProviderCustodyError("custody_unavailable");
  }
}

export type PersonalSurplusReceiptCredentialResult =
  | Readonly<{
      status: "available";
      apiKey: string;
      receiptReadStatus: PersonalProviderCredentialReceiptReadStatus;
      replacement: boolean;
    }>
  | Readonly<{
      status: "blocked_repair";
      reason: "missing" | "replaced" | "custody_unavailable";
    }>;

interface PersonalSurplusReceiptCredentialDeps {
  readonly getCredential?: typeof getPersonalProviderCredential;
  readonly getDb?: typeof getServerDirectDb;
  readonly readCustody?: typeof readPersonalProviderCustody;
}

/**
 * Resolves the payer-owned key for a read of an already bound exact receipt.
 * A replacement is only a lookup candidate: the provider must authorize access
 * to that original request before any financial settlement. This never admits
 * inference or changes the attempt's original credential provenance.
 */
export async function resolvePersonalSurplusReceiptCredential(
  input: Readonly<{
    userId: string;
    credentialId: string;
    credentialRevision: number;
  }>,
  overrides: PersonalSurplusReceiptCredentialDeps = {},
): Promise<PersonalSurplusReceiptCredentialResult> {
  const getCredential = overrides.getCredential ?? getPersonalProviderCredential;
  const getDb = overrides.getDb ?? getServerDirectDb;
  const readCustody = overrides.readCustody ?? readPersonalProviderCustody;

  // Database transport failures remain retryable at the reconciliation owner;
  // they must not be persisted as a credential repair requirement.
  const record = await getCredential(getDb(), input.userId, "surplus");
  if (!record) return { status: "blocked_repair", reason: "missing" };
  if (record.userId !== input.userId || record.provider !== "surplus") {
    return { status: "blocked_repair", reason: "missing" };
  }

  try {
    const custody = await readCustody();
    if (record.envelope.keyId === custody.resetFromKeyId
      || record.envelope.keyId !== custody.keyId) {
      return { status: "blocked_repair", reason: "custody_unavailable" };
    }
    return {
      status: "available",
      apiKey: decryptPersonalProviderCredential(
        custody,
        record.envelope,
        record,
      ),
      receiptReadStatus: record.receiptReadStatus,
      replacement: record.id !== input.credentialId
        || record.revision !== input.credentialRevision,
    };
  } catch {
    return { status: "blocked_repair", reason: "custody_unavailable" };
  }
}

/** Lightweight operator-report projection; the diagnostic route checks validity. */
export async function isPersonalProviderCustodyConfigured(): Promise<boolean> {
  const injected = readInjectedPersonalProviderCustody();
  if (isCloudMode() && injected !== undefined) return true;
  try {
    const raw = await readFile(canonicalPath(), "utf8");
    return /^\s*(?:export\s+)?NAUTILO_PERSONAL_PROVIDER_CUSTODY\s*=/m.test(raw);
  } catch {
    return false;
  }
}

/** Called after migrations; a failure disables only personal credential operations. */
export async function bootstrapPersonalProviderCustody(): Promise<void> {
  if (isCloudMode()) {
    await readPersonalProviderCustody();
    return;
  }
  const path = canonicalPath();
  // An explicitly mounted but missing file is not a fresh source instance.
  if (process.env["NAUTILO_DOTENV_PATH"]?.trim()) await readFile(path, "utf8");
  await ensurePersonalProviderCustodyFile({
    instanceRootDir: dirname(path),
    instanceEnvPath: path,
    hasCredentialRecords: async () => (await getPersonalProviderCredentialCustodyEvidence(getServerDirectDb())).recordCount > 0,
  });
  // The canonical file is the source authority. Never copy its master key into
  // process.env where repository tools and child processes could inherit it.
}

export interface PersonalProviderCustodyStatus {
  readonly status: "ready" | "degraded" | "unavailable";
  readonly recordsExist: boolean | null;
  readonly keyId?: string;
  readonly code?: string;
}

/** Explicit operator diagnostic: no secret prefixes, plaintext, or provider errors. */
export async function inspectPersonalProviderCustody(): Promise<PersonalProviderCustodyStatus> {
  let recordsExist: boolean | null = null;
  try {
    const db = getServerDirectDb();
    const evidence = await getPersonalProviderCredentialCustodyEvidence(db);
    recordsExist = evidence.recordCount > 0;
    const custody = await readPersonalProviderCustody();
    if (evidence.keyIds.some((keyId) => keyId !== custody.keyId && keyId !== custody.resetFromKeyId)) {
      return { status: "unavailable", recordsExist, keyId: custody.keyId, code: "custody_key_mismatch" };
    }
    let retainedLostKeyRows = false;
    let afterId: string | undefined;
    // Bounded working memory, not a credential-count ceiling. Read every page.
    const pageSize = 100;
    for (;;) {
      const rows = await listPersonalProviderCredentialsForCustody(db, { limit: pageSize, ...(afterId === undefined ? {} : { afterId }) });
      for (const row of rows) {
        if (row.envelope.keyId === custody.resetFromKeyId) {
          retainedLostKeyRows = true;
          continue;
        }
        decryptPersonalProviderCredential(custody, row.envelope, row);
      }
      if (rows.length < pageSize) break;
      afterId = rows.at(-1)!.id;
    }
    return retainedLostKeyRows
      ? { status: "degraded", recordsExist, keyId: custody.keyId, code: "credential_reenrollment_required" }
      : { status: "ready", recordsExist, keyId: custody.keyId };
  } catch (error) {
    return { status: "unavailable", recordsExist, code: error instanceof PersonalProviderCustodyError ? error.code : "custody_unavailable" };
  }
}
