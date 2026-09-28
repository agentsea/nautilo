import { dirname } from "node:path";
import { isCloudMode, resolveInstance } from "@nautilo/config";
import { resolveDotenvPath } from "@nautilo/config-guard";
import {
  createDirectDb, eq, getPersonalProviderCredentialCustodyEvidence,
  getServerProviderPolicy, nautiloInstanceIdentity,
} from "@nautilo/db";
import { PersonalProviderCustodyError, resetPersonalProviderCustodyFile } from "@nautilo/operator-secrets";

/** Explicit operator disaster recovery, never a startup or credential-CRUD path. */
export async function resetPersonalProviderCustody(options: {
  lostKeyId: string | undefined;
  confirmServer: string | undefined;
  confirmReset: boolean;
}): Promise<number> {
  if (!options.confirmReset || !options.lostKeyId || !options.confirmServer || isCloudMode()) {
    console.error("Reset requires --lost-key-id, --confirm-server and --confirm-reset. Cloud custody must be recovered through its hosting authority.");
    return 2;
  }
  const db = createDirectDb(1);
  try {
    const [identity] = await db.select().from(nautiloInstanceIdentity).where(eq(nautiloInstanceIdentity.id, "self"));
    if (identity?.serverInstanceId !== options.confirmServer || identity.instanceId !== resolveInstance().instanceId) {
      throw new PersonalProviderCustodyError("custody_unavailable");
    }
    if ((await getServerProviderPolicy(db)).allowPersonalProviderKeys) {
      console.error("Turn personal provider keys off and quiesce personal work before reset.");
      return 2;
    }
    const custody = await resetPersonalProviderCustodyFile({
      instanceRootDir: dirname(resolveDotenvPath()), instanceEnvPath: resolveDotenvPath(),
      lostKeyId: options.lostKeyId, confirmReset: true,
      hasLostKeyRecords: async (keyId) => (await getPersonalProviderCredentialCustodyEvidence(db)).keyIds.includes(keyId),
    });
    console.log(JSON.stringify({ status: "custody-persisted", keyId: custody.keyId, oldRecords: "retained-unavailable" }));
    return 0;
  } catch (error) {
    console.error(error instanceof PersonalProviderCustodyError ? error.message : "Personal provider custody reset failed; persisted state must be inspected before retry.");
    return 1;
  } finally { await db.end(); }
}
