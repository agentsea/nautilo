import { describe, expect, test } from "bun:test";
import { gateCheckpointMaintenanceApply, CheckpointMaintenanceGateError } from "../../src/lib/checkpoint-maintenance-gate";
import { BackupWriterRestorationError, type BackupQuiescenceDeps } from "../../src/lib/backup-quiescence";
import type { VerifiedFullBackup } from "../../src/lib/full-dev-backup";

const backup = { dir: "/private/recovery", manifest: {} } as VerifiedFullBackup;
function quiescence(events: string[], overrides: Partial<BackupQuiescenceDeps> = {}): BackupQuiescenceDeps {
  return { findServerPid: () => 7, isNautiloServer: () => true, isServerPaused: () => false, isLogtoRunning: () => true,
    pauseServer: () => events.push("pause-server"), resumeServer: () => events.push("resume-server"),
    pauseLogto: () => events.push("pause-logto"), resumeLogto: () => events.push("resume-logto"),
    activeWriterCount: () => 0, sleep: () => Promise.resolve(), log: () => undefined, ...overrides };
}
function deps(events: string[]) {
  return { assertConsent: () => events.push("consent"), captureSourceEvidence: async () => { events.push("evidence"); return {}; },
    publishVerifiedRecoveryBackup: async () => { events.push("backup"); return backup; },
    assertSourceEvidenceUnchanged: async () => { events.push("verify"); }, quiescence: quiescence(events),
    afterWritersQuiesced: async () => { events.push("no-delete-boundary"); } };
}
describe("checkpoint maintenance apply gate", () => {
  test("publishes verified backup before quiescence and restores exact writer state without a delete", async () => {
    const events: string[] = []; const result = await gateCheckpointMaintenanceApply(deps(events));
    expect(result.backup).toBe(backup);
    expect(events).toEqual(["consent", "evidence", "backup", "verify", "pause-server", "pause-logto", "no-delete-boundary", "resume-logto", "resume-server"]);
  });
  test("fails before quiescence at consent, backup, and source proof boundaries", async () => {
    const consentEvents: string[] = [];
    await gateCheckpointMaintenanceApply({ ...deps(consentEvents), assertConsent: () => { throw new Error("consent"); } }).catch((error: unknown) => expect(error).toBeInstanceOf(CheckpointMaintenanceGateError));
    const backupEvents: string[] = [];
    await gateCheckpointMaintenanceApply({ ...deps(backupEvents), publishVerifiedRecoveryBackup: async () => { throw new Error("backup"); } }).catch((error: unknown) => expect(error).toBeInstanceOf(CheckpointMaintenanceGateError));
    const proofEvents: string[] = [];
    await gateCheckpointMaintenanceApply({ ...deps(proofEvents), assertSourceEvidenceUnchanged: async () => { throw new Error("proof"); } }).catch((error: unknown) => expect(error).toBeInstanceOf(CheckpointMaintenanceGateError));
    expect([...consentEvents, ...backupEvents, ...proofEvents]).not.toContain("pause-server");
  });
  test("rejects foreign writers and restores writers when post-quiescence work fails", async () => {
    const foreign: string[] = []; await gateCheckpointMaintenanceApply({ ...deps(foreign), quiescence: quiescence(foreign, { isNautiloServer: () => false }) }).catch((error: unknown) => expect(error).toMatchObject({ code: "writer-quiescence" }));
    const events: string[] = []; await gateCheckpointMaintenanceApply({ ...deps(events), afterWritersQuiesced: async () => { throw new Error("stop"); } }).catch((error: unknown) => expect(error).toMatchObject({ code: "writer-quiescence", writerState: { restoration: "restored", paused: { nautiloWriterStopped: true, logtoWriterStopped: true } } }));
    expect(events.slice(-2)).toEqual(["resume-logto", "resume-server"]);
  });
  test("classifies a resume failure even when post-quiescence work also failed", async () => {
    const events: string[] = [];
    await gateCheckpointMaintenanceApply({
      ...deps(events),
      quiescence: quiescence(events, { resumeLogto: () => { throw new Error("resume"); } }),
      afterWritersQuiesced: async () => { throw new Error("primary"); },
    }).catch((error: unknown) => expect(error).toMatchObject({ code: "resume" }));
    expect(events).toContain("resume-server");
  });
  test("preserves a writer restoration failure from the inner recovery-backup capture", async () => {
    const events: string[] = [];
    await gateCheckpointMaintenanceApply({
      ...deps(events),
      publishVerifiedRecoveryBackup: async () => {
        throw new BackupWriterRestorationError(new Error("capture"), {
          nautiloWriterStopped: true,
          logtoWriterStopped: true,
        });
      },
    }).catch((error: unknown) => expect(error).toMatchObject({
      code: "resume",
      writerState: { restoration: "failed" },
    }));
    expect(events).not.toContain("pause-server");
  });
});
