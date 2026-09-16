import { describe, expect, test } from "bun:test";
import type { AgentProgressEvent } from "@nautilo/types";
import {
  AgentProgressHeartbeat,
  noteAgentProgressFromStreamEvent,
  resolveAgentProgressIntervalMs,
  resolveAgentProgressQuietMs,
} from "../../src/utils/agent-progress-heartbeat";

function makeHeartbeat(config?: {
  now?: () => number;
  quietMs?: number;
  emitted?: AgentProgressEvent[];
}): { heartbeat: AgentProgressHeartbeat; tick: () => void; emitted: AgentProgressEvent[] } {
  let tickFn: (() => void) | undefined;
  const emitted = config?.emitted ?? [];
  const heartbeat = new AgentProgressHeartbeat({
    laneKey: "room:1",
    turnId: "turn-1",
    authorAgentId: "agent-a",
    intervalMs: 50,
    quietMs: config?.quietMs ?? 100,
    ...(config?.now ? { now: config.now } : {}),
    emit: (e) => emitted.push(e),
    setIntervalFn: (fn: () => void) => {
      tickFn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => undefined,
  });
  return {
    heartbeat,
    tick: () => {
      if (!tickFn) throw new Error("heartbeat was not started");
      tickFn();
    },
    emitted,
  };
}

describe("resolveAgentProgressIntervalMs", () => {
  test("defaults when unset or invalid", () => {
    expect(resolveAgentProgressIntervalMs(undefined)).toBe(1500);
    expect(resolveAgentProgressIntervalMs("")).toBe(1500);
    expect(resolveAgentProgressIntervalMs("nope")).toBe(1500);
    expect(resolveAgentProgressIntervalMs("0")).toBe(1500);
  });

  test("parses positive integer", () => {
    expect(resolveAgentProgressIntervalMs("2000")).toBe(2000);
  });
});

describe("resolveAgentProgressQuietMs", () => {
  test("defaults when unset or invalid", () => {
    expect(resolveAgentProgressQuietMs(undefined)).toBe(1000);
    expect(resolveAgentProgressQuietMs("-1")).toBe(1000);
  });

  test("parses positive integer", () => {
    expect(resolveAgentProgressQuietMs("750")).toBe(750);
  });
});

describe("AgentProgressHeartbeat", () => {
  test("does not emit while visible tokens are recent", () => {
    let now = 0;
    const { heartbeat, tick, emitted } = makeHeartbeat({
      quietMs: 500,
      now: () => now,
    });

    heartbeat.start();
    heartbeat.noteVisibleToken();
    now = 200;
    tick();
    expect(emitted.length).toBe(0);
    heartbeat.dispose();
  });

  test("emits agent.progress after quiet window", () => {
    let now = 0;
    const { heartbeat, tick, emitted } = makeHeartbeat({
      now: () => now,
    });

    heartbeat.start();
    now = 101;
    tick();
    heartbeat.dispose();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "agent.progress",
      laneKey: "room:1",
      turnId: "turn-1",
      authorAgentId: "agent-a",
      phase: "thinking",
    });
  });

  test("selects preparing_tool after message done until tools phase", () => {
    let now = 0;
    const { heartbeat, tick, emitted } = makeHeartbeat({
      quietMs: 0,
      now: () => now,
    });

    heartbeat.start();
    heartbeat.noteMessageDone();
    now = 1;
    tick();
    heartbeat.noteToolsPhaseStart();
    heartbeat.dispose();
    expect(emitted.some((e) => e.phase === "preparing_tool")).toBe(true);
  });

  test("does not emit when suppressed", () => {
    const emitted: AgentProgressEvent[] = [];
    let tickFn: (() => void) | undefined;
    const heartbeat = new AgentProgressHeartbeat({
      laneKey: "room:1",
      turnId: "turn-1",
      suppressed: true,
      intervalMs: 10,
      quietMs: 0,
      emit: (e) => emitted.push(e),
      setIntervalFn: (fn: () => void) => {
        tickFn = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => undefined,
    });

    heartbeat.start();
    tickFn?.();
    heartbeat.dispose();
    expect(emitted).toHaveLength(0);
  });
});

describe("noteAgentProgressFromStreamEvent", () => {
  test("tracks post_model chain phase", () => {
    let now = 0;
    const { heartbeat, tick, emitted } = makeHeartbeat({
      quietMs: 0,
      now: () => now,
    });
    heartbeat.start();

    noteAgentProgressFromStreamEvent(
      { event: "on_chain_start", name: "post_model" },
      heartbeat,
    );
    now = 1;
    tick();

    noteAgentProgressFromStreamEvent(
      { event: "on_chain_end", name: "post_model" },
      heartbeat,
    );
    heartbeat.dispose();
    expect(emitted.some((e) => e.phase === "post_model")).toBe(true);
  });
});
