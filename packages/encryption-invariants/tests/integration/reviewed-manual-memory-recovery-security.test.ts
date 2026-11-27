import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BASELINE_REGISTRY,
  CURRENT_FROZEN_BASELINE_DEBT,
} from "../../baseline/existing-debt";
import {
  MANUAL_MEMORY_RECOVERY_DATABASE_LOCATORS,
  REVIEWED_MANUAL_MEMORY_RECOVERY_COVERAGE,
  REVIEWED_MANUAL_RECOVERY_DTO_DECLARATIONS,
} from "../../baseline/reviewed-manual-memory-recovery";
import { validateCoverageEntry } from "../../src/model";

const repoRoot = resolve(import.meta.dir, "../../../..");

async function source(path: string): Promise<string> {
  return Bun.file(resolve(repoRoot, path)).text();
}

describe("manual Memory recovery encryption review", () => {
  test("classifies only the exact new operational metadata surfaces", () => {
    expect(MANUAL_MEMORY_RECOVERY_DATABASE_LOCATORS).toHaveLength(33);
    expect(new Set(MANUAL_MEMORY_RECOVERY_DATABASE_LOCATORS).size).toBe(33);
    expect(REVIEWED_MANUAL_MEMORY_RECOVERY_COVERAGE).toHaveLength(35);

    for (const entry of REVIEWED_MANUAL_MEMORY_RECOVERY_COVERAGE) {
      expect(validateCoverageEntry(entry)).toEqual({ ok: true });
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
      expect(CURRENT_FROZEN_BASELINE_DEBT.some((debt) =>
        debt.locator === entry.locator
      )).toBe(false);
    }

    const checkpoint = REVIEWED_MANUAL_MEMORY_RECOVERY_COVERAGE.find((entry) =>
      entry.locator === "public.reflection_record_semantic_work.organizer_proposal_checkpoint"
    );
    expect(checkpoint?.classification).toBe("server_encrypted");
    if (checkpoint?.classification !== "server_encrypted") throw new Error("Missing checkpoint coverage");
    expect(checkpoint).toMatchObject({
      surface: "db",
      migrationState: "ciphertext_only",
      representationScope: "ordinary_only",
      supportsEncryptedMode: false,
      keyCustody: "server_instance_commitment_key",
      algorithm: "AES-256-GCM",
      envelopeVersion: 1,
      nonceBytes: 12,
      authenticationTagBytes: 16,
      additionalAuthenticatedData: "nautilo-reflection-authority-checkpoint-v1",
      maximumStoredBytes: 3_407_872,
    });
    expect(REVIEWED_MANUAL_MEMORY_RECOVERY_COVERAGE.filter((entry) =>
      entry !== checkpoint
    ).every((entry) => entry.classification === "bounded_metadata")).toBe(true);

    const allowlist = REVIEWED_MANUAL_MEMORY_RECOVERY_COVERAGE.flatMap(
      (entry) => entry.classification === "bounded_metadata"
        ? entry.metadataAllowlist
        : [],
    );
    for (const forbidden of [
      "content",
      "prompt",
      "output",
      "providerResponse",
      "credentialValue",
      "commitmentKey",
    ]) {
      expect(allowlist).not.toContain(forbidden);
    }
  });

  test("declares the exact closed GET and POST wire shapes", () => {
    expect(REVIEWED_MANUAL_RECOVERY_DTO_DECLARATIONS).toHaveLength(4);
    expect(REVIEWED_MANUAL_RECOVERY_DTO_DECLARATIONS.map((entry) =>
      entry.locator
    )).toEqual([
      "http:request_response:GET /api/admin/memory-recovery",
      "http:request_response:POST /api/admin/memory-recovery",
      "http:request_response:GET /api/admin/reflection-status",
      "http:request_response:GET /api/admin/stenographer-status",
    ]);
    for (const declaration of REVIEWED_MANUAL_RECOVERY_DTO_DECLARATIONS) {
      expect(declaration.arbitraryPayloads).toEqual([]);
      if (declaration.locator.endsWith("-status")) {
        expect(declaration.structuralSignatures).toContain("request.query:{recovery?:string}");
        continue;
      }
      expect(declaration.structuralSignatures?.join("\n")).toContain(
        "derivedRepair?:{retired:number;sourcesQueued:number;summariesQueued?:number}",
      );
      expect(declaration.structuralSignatures?.join("\n")).toContain(
        "observedThrough:string",
      );
      expect(declaration.structuralSignatures?.join("\n")).toContain(
        "held:number;queued:number;state:\"assessed\"",
      );
      expect(declaration.structuralSignatures?.join("\n")).not.toContain(
        "unknown",
      );
    }
  });

  test("gates status and billable recovery behind separate capabilities", async () => {
    const route = await source("packages/server/src/routes/memory-status.ts");
    const getRoute = route.slice(
      route.indexOf('app.get("/api/admin/memory-recovery"'),
      route.indexOf('app.post("/api/admin/memory-recovery"'),
    );
    const postRoute = route.slice(
      route.indexOf('app.post("/api/admin/memory-recovery"'),
      route.indexOf('app.post("/api/admin/memory-review-recovery"'),
    );
    expect(getRoute).toContain('authorize(request, reply, "read_server_settings")');
    expect(postRoute).toContain('authorize(request, reply, "manage_server_operations")');
    expect(postRoute).toContain("confirmBillableRerun: z.literal(true)");
  });

  test("keeps recovery receipts product-only in schema, migration, and grant repair", async () => {
    const runSchema = await source("packages/db/src/schema/memory-recovery-runs.ts");
    expect(runSchema).toContain('pgPolicy("memory_recovery_runs_product"');
    expect(runSchema).toContain('to: pgRole("nautilo").existing()');
    expect(runSchema).not.toContain("nautilo_agent");

    const journalSchema = await source("packages/db/src/schema/room-journal.ts");
    const recoverySchema = journalSchema.slice(
      journalSchema.indexOf('"room_journal_model_recoveries"'),
      journalSchema.indexOf("export const roomEvents"),
    );
    expect(recoverySchema).toContain('productPolicy("room_journal_model_recoveries")');
    expect(recoverySchema).not.toContain("nautilo_agent");

    const grantRepair = await source("packages/db/src/utils/agent-role-grants.ts");
    for (const table of ["memory_recovery_runs", "room_journal_model_recoveries"]) {
      expect(grantRepair).toContain(`"${table}"`);
    }

    const migrationDirectory = resolve(repoRoot, "packages/db/src/migrations");
    const migrationNames = (await readdir(migrationDirectory))
      .filter((name) => /^[0-9]{4}_.+[.]sql$/u.test(name));
    const migrations = await Promise.all(migrationNames.map(async (name) => ({
      name,
      text: await Bun.file(resolve(migrationDirectory, name)).text(),
    })));
    const matching = migrations.filter(({ text }) =>
      text.includes('CREATE TABLE "memory_recovery_runs"')
      && text.includes('CREATE TABLE "room_journal_model_recoveries"')
    );
    expect(matching.map(({ name }) => name)).toHaveLength(1);
    const migration = matching[0]!.text;
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "memory_recovery_runs", "room_journal_model_recoveries" FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "memory_recovery_runs", "room_journal_model_recoveries" TO "nautilo"',
    );
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "memory_recovery_runs", "room_journal_model_recoveries" TO "nautilo_agent"',
    );
  });

  test("anchors ordinary checkpoint coverage to the authenticated server-keyed implementation", async () => {
    const runtime = await source(
      "packages/runtime/src/reflection/production-reflection-memory.ts",
    );
    expect(runtime).toContain("Only ordinary execution is admitted to this server-keyed store");
    expect(runtime).toContain('update("nautilo-reflection-organizer-proposal-v1")');
    expect(runtime).toContain("ORGANIZER_BATCH_MAX_ITEMS\n    * CROSS_ROOM_EXECUTION_PLAN_LIMITS.applicationPlanTokenBytes\n    + CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputBytes\n    + CROSS_ROOM_EXECUTION_PLAN_LIMITS.outputBytes");
    expect(runtime).toContain("if (ciphertext.byteLength > organizerCheckpointMaxBytes)");
    expect(runtime).toContain("checkpointIdentity(claim, admitted.binding)");

    const seal = await source(
      "packages/reflection-bridge/src/server/authority-commitment.ts",
    );
    expect(seal).toContain('"nautilo-reflection-authority-checkpoint-key-v1"');
    expect(seal).toContain('"nautilo-reflection-authority-checkpoint-v1"');
    expect(seal).toContain('createCipheriv("aes-256-gcm", encryptionKey, nonce)');
    expect(seal).toContain("const nonce = randomBytes(12)");
    expect(seal).toContain("Buffer.from([1])");
    expect(seal).toContain("const tag = cipher.getAuthTag()");

    const schema = await source("packages/db/src/schema/reflection-records.ts");
    expect(schema).toContain('organizerProposalCheckpoint: bytea("organizer_proposal_checkpoint")');
  });
});
