import { randomUUID } from "node:crypto";
import { installPersonalLlmAttemptOwner } from "@nautilo/agent";
import {
  interruptExpiredPersonalLlmAttempts,
  interruptPersonalLlmAttemptsByOwner,
  PERSONAL_LLM_ATTEMPT_BATCH_LIMIT,
  PERSONAL_LLM_ATTEMPT_TICK_MS,
  renewPersonalLlmAttemptLeases,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";

interface PersonalLlmAttemptOwnerDependencies {
  createOwnerToken(): string;
  installOwner(ownerToken: string): () => void;
  renew(input: { ownerToken: string; limit: number }): Promise<number>;
  recover(input: { limit: number }): Promise<number>;
  interruptOwned(input: { ownerToken: string; limit: number }): Promise<number>;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  yieldToRuntime(): Promise<void>;
}

const defaults: PersonalLlmAttemptOwnerDependencies = {
  createOwnerToken: randomUUID,
  installOwner: (ownerToken) => installPersonalLlmAttemptOwner({ ownerToken }),
  renew: renewPersonalLlmAttemptLeases,
  recover: interruptExpiredPersonalLlmAttempts,
  interruptOwned: interruptPersonalLlmAttemptsByOwner,
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval,
  yieldToRuntime: () => new Promise((resolve) => setImmediate(resolve)),
};

/**
 * Owns foreground direct-personal attempts for one server process. It only
 * renews or terminalizes durable rows; it never invokes a provider.
 */
export function createPersonalLlmAttemptOwnerRuntime(
  overrides: Partial<PersonalLlmAttemptOwnerDependencies> = {},
) {
  const deps = { ...defaults, ...overrides };
  const ownerToken = deps.createOwnerToken();
  let uninstallOwner: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let current: Promise<void> | null = null;
  let requested = false;
  let started = false;
  let stopped = false;

  const drain = async (page: () => Promise<number>): Promise<void> => {
    while (!stopped) {
      const count = await page();
      if (count < PERSONAL_LLM_ATTEMPT_BATCH_LIMIT) return;
      await deps.yieldToRuntime();
    }
  };
  const pump = (): void => {
    if (stopped || current !== null) return;
    requested = false;
    current = (async () => {
      await drain(() => deps.renew({
        ownerToken,
        limit: PERSONAL_LLM_ATTEMPT_BATCH_LIMIT,
      }));
      if (stopped) return;
      await drain(() => deps.recover({ limit: PERSONAL_LLM_ATTEMPT_BATCH_LIMIT }));
    })().catch(() => {
      warn("[nautilo/usage] personal attempt owner heartbeat remains pending", {
        failureCode: "attempt_owner_heartbeat_failed",
      });
    }).finally(() => {
      current = null;
      if (requested && !stopped) pump();
    });
  };
  const wake = (): void => {
    if (stopped) return;
    requested = true;
    pump();
  };

  return Object.freeze({
    ownerToken,
    start() {
      if (uninstallOwner !== null || stopped) return;
      const uninstall = deps.installOwner(ownerToken);
      try {
        timer = deps.setInterval(wake, PERSONAL_LLM_ATTEMPT_TICK_MS);
      } catch (error) {
        uninstall();
        throw error;
      }
      uninstallOwner = uninstall;
      started = true;
      timer.unref?.();
      wake();
    },
    wake,
    async stop() {
      if (stopped) return;
      // Close admission first. Any request already beyond prewire remains
      // fenced by this token and can contribute late evidence after shutdown.
      uninstallOwner?.();
      uninstallOwner = null;
      stopped = true;
      requested = false;
      if (timer !== null) deps.clearInterval(timer);
      timer = null;
      await current;
      if (!started) return;
      while (true) {
        const count = await deps.interruptOwned({
          ownerToken,
          limit: PERSONAL_LLM_ATTEMPT_BATCH_LIMIT,
        });
        if (count < PERSONAL_LLM_ATTEMPT_BATCH_LIMIT) return;
        await deps.yieldToRuntime();
      }
    },
  });
}
