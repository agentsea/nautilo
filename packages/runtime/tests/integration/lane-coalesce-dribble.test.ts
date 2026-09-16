import { describe, test, expect } from "bun:test";
import { LaneCoalescer, type CoalescedInput } from "../../src/lane-coalescer";

describe("LaneCoalescer dribble (M074)", () => {
  test("10 spaced enqueues slide until 2s after last append → one flush", () => {
    let onFire: (() => void) | null = null;
    const flushed: string[] = [];
    const windowMs = 2000;

    const mk = (i: number): CoalescedInput =>
      ({
        message: `seg${i}`,
        attachmentTextBlocks: [],
        multimodalImages: [],
        ownerId: "o",
        requestorId: "o",
        agentId: "a",
        roomId: "",
        graphThreadId: "g",
        laneKey: "L",
        voiceMode: false,
        turnId: "t",
        actorRole: "owner",
        currentFolder: null,
        workspacePath: null,
        activeMiniApp: null,
        securityAuditIp: "",
        securityAuditUserAgent: "",
        threadId: "th",
        roomRoster: [],
      }) as CoalescedInput;

    const stubTimer = ((fn: (...args: unknown[]) => void, ms?: number) => {
      expect(ms).toBe(windowMs);
      onFire = fn as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    // Pin first-segment quiet to `windowMs` so this test only asserts sliding 2s
    // behaviour (production defaults to a shorter first segment).
    const c: LaneCoalescer = new LaneCoalescer(stubTimer, clearTimeout, (_lk, merged) => {
      flushed.push(merged.message);
    }, windowMs, windowMs);

    for (let i = 0; i < 10; i++) {
      c.enqueue(mk(i), `v${i}`);
    }

    expect(flushed.length).toBe(0);
    (onFire as (() => void) | null)?.();
    expect(flushed.length).toBe(1);
    const parts = Array.from({ length: 10 }, (_, i) => `seg${i}`);
    expect(flushed[0]).toBe(parts.join("\n\n"));
  });
});
