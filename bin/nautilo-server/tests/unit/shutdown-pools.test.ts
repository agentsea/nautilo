/**
 * M210 Phase 4 — shutdown pool orchestration unit tests.
 */

import { describe, expect, it } from "bun:test";
import {
  closeRegisteredDbPoolsOnShutdown,
  DB_POOL_CLOSE_TIMEOUT_MS,
  remainingShutdownDeadlineMs,
} from "../../src/shutdown-pools";

describe("closeRegisteredDbPoolsOnShutdown (M210 Phase 4)", () => {
  it("derives the pool deadline from the remaining shutdown budget", () => {
    expect(remainingShutdownDeadlineMs(2_000, 1_250)).toBe(750);
    expect(remainingShutdownDeadlineMs(2_000, 2_500)).toBe(0);
  });

  it("invokes every closer, logs safe failure labels only, and uses bounded timeout", async () => {
    const closed: string[] = [];
    const warnings: string[] = [];
    const receivedTimeouts: number[] = [];

    const closePools = async (options: {
      timeoutMs: number;
      onError?: (name: string, error: unknown) => void;
    }) => {
      receivedTimeouts.push(options.timeoutMs);
      const pools = [
        {
          name: "direct:nautilo",
          close: async () => {
            closed.push("direct:nautilo");
          },
        },
        {
          name: "checkpoint:langgraph",
          close: async () => {
            closed.push("checkpoint:langgraph");
            throw new Error("postgres://secret:password@host/db");
          },
        },
        {
          name: "direct:nautilo-agent",
          close: async () => {
            closed.push("direct:nautilo-agent");
          },
        },
      ];

      for (const pool of pools) {
        try {
          await pool.close();
        } catch (error) {
          options.onError?.(pool.name, error);
        }
      }
    };

    await closeRegisteredDbPoolsOnShutdown({
      totalDeadlineMs: 2000,
      closePools,
      warn: (message) => warnings.push(message),
    });

    expect(closed).toEqual([
      "direct:nautilo",
      "checkpoint:langgraph",
      "direct:nautilo-agent",
    ]);
    expect(receivedTimeouts).toEqual([DB_POOL_CLOSE_TIMEOUT_MS]);
    expect(warnings).toEqual([
      "[server] db pool close failed pool=checkpoint:langgraph",
    ]);
    expect(warnings.join(" ")).not.toMatch(/postgres|secret|password|Error/i);
  });
});
