import { describe, expect, mock, test } from "bun:test";
import { EMPTY_REFLECTION_SEMANTIC_LATENCY } from "@nautilo/types";
import { ReflectionSleepController } from "../../src/reflection/reflection-sleep-controller";

describe("ReflectionSleepController", () => {
  test("defaults off without constructing the runtime", async () => {
    const resolveWorker = mock(async () => ({
      start() {},
      async stop() {},
    }));
    const controller = new ReflectionSleepController({ resolveWorker });

    await controller.setEnabled(false);

    expect(resolveWorker).not.toHaveBeenCalled();
  });

  test("starts and stops one worker across live policy changes", async () => {
    const start = mock(() => undefined);
    const stop = mock(async () => undefined);
    const resolveWorker = mock(async () => ({ start, stop }));
    const controller = new ReflectionSleepController({ resolveWorker });

    await controller.setEnabled(true);
    await controller.setEnabled(false);
    await controller.setEnabled(true);

    expect(resolveWorker).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("projects health only after the dormant runtime has been constructed", async () => {
    const scheduler = {
      state: "cooldown" as const,
      pauseReason: null,
      recoveryIntervalMs: 15_000,
      nextEligiblePollAt: "2026-08-18T12:00:15.000Z",
      lastPoll: null,
      window: { polls: 0, admitted: 0, completed: 0, created: 0 },
      backlog: { size: 0, oldestAgeMs: 0 },
      latency: EMPTY_REFLECTION_SEMANTIC_LATENCY,
      amplification: "normal" as const,
    };
    const controller = new ReflectionSleepController({
      resolveWorker: async () => ({ start() {}, async stop() {}, getHealth: () => scheduler }),
    });

    expect(controller.getHealth()).toBeNull();
    await controller.setEnabled(true);
    expect(controller.getHealth()).toEqual(scheduler);
  });

  test("does not start when OFF arrives during runtime construction", async () => {
    let release!: (worker: { start(): void; stop(): Promise<void> }) => void;
    let began!: () => void;
    const start = mock(() => undefined);
    const stop = mock(async () => undefined);
    const pending = new Promise<{ start(): void; stop(): Promise<void> }>(
      (resolve) => { release = resolve; },
    );
    const resolving = new Promise<void>((resolve) => { began = resolve; });
    const controller = new ReflectionSleepController({
      resolveWorker: () => {
        began();
        return pending;
      },
    });

    const enabling = controller.setEnabled(true);
    await resolving;
    const disabling = controller.setEnabled(false);
    release({ start, stop });
    await Promise.all([enabling, disabling]);

    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });
});
