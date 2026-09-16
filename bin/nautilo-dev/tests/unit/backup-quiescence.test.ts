import { describe, expect, test } from "bun:test";
import {
  BackupWriterRestorationError,
  dockerUnpauseReachedRestoredState,
  withQuiescedBackupSource,
  type BackupQuiescenceDeps,
} from "../../src/lib/backup-quiescence";

function deps(events: string[], overrides: Partial<BackupQuiescenceDeps> = {}): BackupQuiescenceDeps {
  return {
    findServerPid: () => 42,
    isNautiloServer: () => true,
    isServerPaused: () => false,
    isLogtoRunning: () => true,
    pauseServer: () => events.push("pause-server"),
    resumeServer: () => events.push("resume-server"),
    pauseLogto: () => events.push("pause-logto"),
    resumeLogto: () => events.push("resume-logto"),
    activeWriterCount: () => 0,
    sleep: () => Promise.resolve(),
    log: () => undefined,
    ...overrides,
  };
}

describe("backup quiescence", () => {
  test("accepts an idempotent concurrent Logto unpause only after verifying the restored state", () => {
    expect(dockerUnpauseReachedRestoredState(0, false)).toBe(true);
    expect(dockerUnpauseReachedRestoredState(1, true)).toBe(true);
    expect(dockerUnpauseReachedRestoredState(1, false)).toBe(false);
  });

  test("restores exactly the paused source writers after successful capture", async () => {
    const events: string[] = [];
    await withQuiescedBackupSource(deps(events), async (state) => {
      events.push("capture");
      expect(state).toEqual({
        nautiloWriterStopped: true,
        logtoWriterStopped: true,
      });
    });
    expect(events).toEqual([
      "pause-server",
      "pause-logto",
      "capture",
      "resume-logto",
      "resume-server",
    ]);
  });

  test("restores source writers when capture fails", async () => {
    const events: string[] = [];
    expect(
      withQuiescedBackupSource(deps(events), () => {
        events.push("capture");
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(events.slice(-2)).toEqual(["resume-logto", "resume-server"]);
  });

  test("preserves an already-paused Nautilo writer without claiming or resuming it", async () => {
    const events: string[] = [];
    await withQuiescedBackupSource(deps(events, { isServerPaused: () => true }), async (state) => {
      expect(state.nautiloWriterStopped).toBe(true);
      events.push("capture");
    });
    expect(events).toEqual(["pause-logto", "capture", "resume-logto"]);
  });

  test("restoration failure takes precedence over a simultaneous capture failure", async () => {
    const events: string[] = [];
    let error: unknown;
    try {
      await withQuiescedBackupSource(deps(events, {
        resumeLogto: () => { events.push("resume-logto"); throw new Error("unpause failed"); },
      }), async () => { throw new Error("capture failed"); });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BackupWriterRestorationError);
    expect((error as BackupWriterRestorationError).primaryError).toMatchObject({ message: "capture failed" });
    expect(events.slice(-2)).toEqual(["resume-logto", "resume-server"]);
  });

  test("refuses missing Logto and unknown server owners before pausing anything", async () => {
    const missingEvents: string[] = [];
    expect(
      withQuiescedBackupSource(
        deps(missingEvents, { isLogtoRunning: () => false }),
        () => Promise.resolve(),
      ),
    ).rejects.toThrow("Logto must be running");
    expect(missingEvents).toEqual([]);

    const foreignEvents: string[] = [];
    expect(
      withQuiescedBackupSource(
        deps(foreignEvents, { isNautiloServer: () => false }),
        () => Promise.resolve(),
      ),
    ).rejects.toThrow("unrecognized process");
    expect(foreignEvents).toEqual([]);
  });
});
