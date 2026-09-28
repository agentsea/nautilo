import { createDirectDb, clearPersonalProviderCredentialsForClone } from "@nautilo/db";

/** Only invoked by the verified clone lifecycle after fresh identity rebinding. */
if (import.meta.main) {
  const [instanceId, serverInstanceId] = process.argv.slice(2);
  if (!instanceId || !serverInstanceId || process.env["NAUTILO_INSTANCE_ID"] !== instanceId) {
    throw new Error("Personal provider clone isolation requires the exact target identity");
  }
  const db = createDirectDb(1);
  try {
    await clearPersonalProviderCredentialsForClone(db, { instanceId, serverInstanceId });
  } finally { await db.end(); }
}
