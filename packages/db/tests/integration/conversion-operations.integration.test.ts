import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDirectDb } from "../../src/config/direct-database";
import { conversionOperations } from "../../src/schema/conversion-operations";
import { users } from "../../src/schema/users";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";
import {
  conversionOperationTransitions as transitions,
  cancelConversionBeforeProviderDispatchWith,
  createConversionOperationWith,
  getConversionOperationByKeyWith,
  touchConversionRecoveryAttemptWith,
  type CreateConversionOperationInput,
} from "../../src/queries/conversion-operations";

let db: ReturnType<typeof createDirectDb>;
const human = randomUUID();
const digest = () => createHash("sha256").update(randomUUID()).digest("hex");

beforeAll(async () => {
  bootstrapTestDbInstance();
  process.env["NAUTILO_TEST_DB_AUTOHEAL"] = "0";
  db = createDirectDb(5);
  await db.insert(users).values({ id: human, name: "Conversion lifecycle fixture", email: `${human}@test.local` });
});

afterAll(async () => {
  if (!db) return;
  await db.delete(conversionOperations).where(eq(conversionOperations.causalHumanUserId, human));
  await db.delete(users).where(eq(users.id, human));
  await db.end();
});

function input(): CreateConversionOperationInput {
  const key = digest();
  return {
    operationKey: key,
    recoveryHandle: `cvr_${key.slice(0, 32)}`,
    causalHumanUserId: human,
    fundingKind: "personal",
    providerRoute: "cloudconvert",
    providerSandbox: true,
    providerRegion: "eu-central",
    credentialId: randomUUID(),
    credentialRevision: 1,
    credentialFingerprint: digest(),
    sourceKind: "inline",
    sourceSha256: digest(),
    sourceAuthorityDigest: digest(),
    destinationNamespaceId: randomUUID(),
    destinationPathDigest: digest(),
    destinationAuthorityDigest: digest(),
    inputFormat: "html",
    outputFormat: "pdf",
    maxOutputBytes: 1024,
    providerTag: `ntlo_cv_${key.slice(0, 32)}`,
  };
}

test("conversion recovery is product-owned with no agent or crypto role privileges", async () => {
  const rows = await db.execute(sql`SELECT
    has_table_privilege('nautilo', 'conversion_operations', 'SELECT, INSERT, UPDATE, DELETE') AS product_access,
    has_table_privilege('nautilo_agent', 'conversion_operations', 'SELECT, INSERT, UPDATE, DELETE') AS agent_access,
    has_table_privilege('nautilo_crypto', 'conversion_operations', 'SELECT, INSERT, UPDATE, DELETE') AS crypto_access,
    relrowsecurity AS rls, relforcerowsecurity AS force_rls
    FROM pg_class WHERE oid = 'public.conversion_operations'::regclass`);
  expect(rows[0]).toEqual({ product_access: true, agent_access: false, crypto_access: false, rls: true, force_rls: true });
});

test("concurrent submission has one winner and an active lease blocks recovery", async () => {
  const row = await createConversionOperationWith(db, input());
  const leaseId = digest();
  const claims = await Promise.all([leaseId, digest()].map((id) => transitions.claimSubmission(db, {
    operationKey: row.operationKey, leaseId: id, leaseExpiresAt: new Date(Date.now() + 60_000),
  })));
  const winner = claims.find((claim) => claim !== null)!;
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await transitions.expireSubmissionLease(db, { operationKey: row.operationKey, now: new Date() })).toBeNull();
  expect(await transitions.attachProviderJob(db, {
    operationKey: row.operationKey, providerJobId: "wrong-owner", submissionLeaseId: digest(),
  })).toBeNull();
  const attached = await transitions.attachProviderJob(db, {
    operationKey: row.operationKey, providerJobId: "one-provider-job", submissionLeaseId: winner.submissionLeaseId!,
  });
  expect(attached?.status).toBe("submitted");
  expect(attached?.submissionLeaseId).toBeNull();
});

test("lost submit response retains cancellation through expiry and account-bound attachment", async () => {
  const row = await createConversionOperationWith(db, input());
  const leaseId = digest();
  const expiration = new Date(Date.now() + 60_000);
  await transitions.claimSubmission(db, { operationKey: row.operationKey, leaseId, leaseExpiresAt: expiration });
  const cancelled = await transitions.requestCancellation(db, row.operationKey);
  expect(cancelled?.status).toBe("submitting");
  expect(cancelled?.cancellationRequestedAt).not.toBeNull();
  const expired = await transitions.expireSubmissionLease(db, { operationKey: row.operationKey, now: expiration });
  expect(expired?.status).toBe("submission_unknown");
  expect(await transitions.attachProviderJob(db, {
    operationKey: row.operationKey, providerJobId: "late-response", submissionLeaseId: leaseId,
  })).toBeNull();
  const recovered = await transitions.attachProviderJob(db, { operationKey: row.operationKey, providerJobId: "recovered-job" });
  expect(recovered?.status).toBe("cancel_requested");
  expect(recovered?.credentialId).toBe(row.credentialId);
  expect(await transitions.attachProviderJob(db, { operationKey: row.operationKey, providerJobId: "second-job" })).toBeNull();
});

test("completed conversion has one durable publication claim and rejects identity drift", async () => {
  const original = input();
  const row = await createConversionOperationWith(db, original);
  await Promise.resolve(expect(createConversionOperationWith(db, { ...original, credentialRevision: 2 })).rejects.toThrow("identity conflicts"));
  const leaseId = digest();
  await transitions.claimSubmission(db, { operationKey: row.operationKey, leaseId, leaseExpiresAt: new Date(Date.now() + 60_000) });
  await transitions.attachProviderJob(db, { operationKey: row.operationKey, providerJobId: "finished-job", submissionLeaseId: leaseId });
  await transitions.markProviderFinished(db, { operationKey: row.operationKey, providerCredits: "2.00000000" });
  await transitions.markReadyToPublish(db, { operationKey: row.operationKey, providerCredits: "2.00000000", outputSha256: digest(), outputBytes: 100 });
  const claims = await Promise.all([
    transitions.claimPublication(db, row.operationKey),
    transitions.claimPublication(db, row.operationKey),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const publicationRevisionId = randomUUID();
  await transitions.confirmPublished(db, { operationKey: row.operationKey, publicationArtifactId: "fixture-artifact", publicationRevisionId });
  const recovered = await getConversionOperationByKeyWith(db, row.operationKey);
  expect(recovered?.status).toBe("published");
  expect(recovered?.publicationRevisionId).toBe(publicationRevisionId);
  expect(recovered?.providerCredits).toBe("2.00000000");
  expect(await transitions.claimPublication(db, row.operationKey)).toBeNull();
  expect(await transitions.markTerminal(db, { operationKey: row.operationKey, status: "expired", failureCode: "provider_result_expired" })).toBeNull();
});

test("provider output can expire after settlement or an uncommitted publication claim", async () => {
  for (const phase of ["provider_finished", "ready_to_publish", "publication_committing"] as const) {
    const row = await createConversionOperationWith(db, input());
    const leaseId = digest();
    await transitions.claimSubmission(db, { operationKey: row.operationKey, leaseId, leaseExpiresAt: new Date(Date.now() + 60_000) });
    await transitions.attachProviderJob(db, { operationKey: row.operationKey, providerJobId: `expired-${phase}`, submissionLeaseId: leaseId });
    await transitions.markProviderFinished(db, { operationKey: row.operationKey, providerCredits: "2.00000000" });
    if (phase !== "provider_finished") {
      await transitions.markReadyToPublish(db, { operationKey: row.operationKey, providerCredits: "2.00000000", outputSha256: digest(), outputBytes: 100 });
    }
    if (phase === "publication_committing") await transitions.claimPublication(db, row.operationKey);
    const expired = await transitions.markTerminal(db, {
      operationKey: row.operationKey, status: "expired", failureCode: "provider_result_expired", providerCredits: "2.00000000",
    });
    expect(expired?.status).toBe("expired");
    expect(expired?.providerCredits).toBe("2.00000000");
    expect(await transitions.claimPublication(db, row.operationKey)).toBeNull();
  }
});

test("recovery scheduling advances without changing lifecycle and rejects a stale version", async () => {
  const row = await createConversionOperationWith(db, input());
  const oldDate = new Date("2020-01-01T00:00:00Z");
  await db.update(conversionOperations).set({ updatedAt: oldDate })
    .where(eq(conversionOperations.operationKey, row.operationKey));
  const touched = await touchConversionRecoveryAttemptWith(db, row);
  expect(touched?.updatedAt.getTime()).toBeGreaterThan(oldDate.getTime());
  expect(touched?.status).toBe(row.status);
  expect(touched?.version).toBe(row.version);
  await transitions.claimSubmission(db, {
    operationKey: row.operationKey, leaseId: digest(), leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  expect(await touchConversionRecoveryAttemptWith(db, row)).toBeNull();
});

test("known-zero cancellation requires a pre-dispatch phase and exact live lease", async () => {
  const row = await createConversionOperationWith(db, input());
  const invalidCancellation = await db.update(conversionOperations).set({ status: "cancelled" })
    .where(eq(conversionOperations.operationKey, row.operationKey))
    .then(() => null, (error: unknown) => error);
  expect(invalidCancellation).toMatchObject({ cause: { code: "23514", constraint_name: "conversion_operations_provider_job_phase" } });
  const leaseId = digest();
  await transitions.claimSubmission(db, {
    operationKey: row.operationKey, leaseId, leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  expect(await cancelConversionBeforeProviderDispatchWith(db, { operationKey: row.operationKey, phase: "prepared" })).toBeNull();
  expect(await cancelConversionBeforeProviderDispatchWith(db, {
    operationKey: row.operationKey, phase: "submitting", submissionLeaseId: digest(),
  })).toBeNull();
  const cancelled = await cancelConversionBeforeProviderDispatchWith(db, {
    operationKey: row.operationKey, phase: "submitting", submissionLeaseId: leaseId,
  });
  expect(cancelled?.status).toBe("cancelled");
  expect(cancelled?.failureCode).toBe("cancelled_before_provider_dispatch");
  expect(cancelled?.providerJobId).toBeNull();
  expect(cancelled?.providerCredits).toBe("0.00000000");
  expect(await transitions.attachProviderJob(db, {
    operationKey: row.operationKey, providerJobId: "late-job", submissionLeaseId: leaseId,
  })).toBeNull();
});

test("rejects format values outside the persisted 32-character bound before insert", async () => {
  const invalid = input();
  await Promise.resolve(expect(createConversionOperationWith(db, {
    ...invalid,
    outputFormat: "x".repeat(33),
  })).rejects.toThrow("Invalid conversion output format"));
});
